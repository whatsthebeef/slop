import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CodeViewUsage } from '@slop/core';
import * as schema from './db/schema.js';
import type { Db } from './db/store.js';

/** One board's index at one commit of its base branch. */
export interface CodeSnapshot {
  readonly sha: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly language: string | null }[];
  readonly imports: readonly { readonly from: string; readonly to: string }[];
  readonly history: readonly { readonly path: string; readonly sha: string; readonly subject: string; readonly date: Date; readonly seq: number; readonly globId: string | null }[];
}

export interface IndexedCommit {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly globId: string | null;
  readonly change: { readonly title: string; readonly url: string | null } | null;
}

const CHUNK = 2000;

const chunks = <T>(rows: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
};

/** `%`, `_` and `\` are LIKE's own characters: a path is matched literally. */
const likeEscape = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The code view's index in Postgres (see `code_*` in the schema). Reads never touch the clone. */
export class CodeIndex implements CodeViewUsage {
  constructor(private readonly db: Db) {}

  async commitOf(boardId: number): Promise<string | null> {
    const [row] = await this.db.select({ sha: schema.codeIndex.commitSha }).from(schema.codeIndex).where(eq(schema.codeIndex.boardId, boardId));
    return row?.sha ?? null;
  }

  /** Swaps a board's whole index for the snapshot in one transaction, so a reader sees the old commit or the new one. */
  async replace(boardId: number, snapshot: CodeSnapshot, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.codeFiles).where(eq(schema.codeFiles.boardId, boardId));
      await tx.delete(schema.codeImports).where(eq(schema.codeImports.boardId, boardId));
      await tx.delete(schema.codePathCommits).where(eq(schema.codePathCommits.boardId, boardId));
      for (const rows of chunks(snapshot.files)) await tx.insert(schema.codeFiles).values(rows.map((f) => ({ boardId, ...f })));
      for (const rows of chunks(snapshot.imports)) await tx.insert(schema.codeImports).values(rows.map((i) => ({ boardId, fromPath: i.from, toPath: i.to })));
      for (const rows of chunks(snapshot.history)) {
        await tx.insert(schema.codePathCommits).values(rows.map((h) => ({ boardId, path: h.path, sha: h.sha, subject: h.subject, committedAt: h.date, seq: h.seq, globId: h.globId })));
      }
      await tx
        .insert(schema.codeIndex)
        .values({ boardId, commitSha: snapshot.sha, fileCount: snapshot.files.length, indexedAt: now })
        .onConflictDoUpdate({ target: schema.codeIndex.boardId, set: { commitSha: snapshot.sha, fileCount: snapshot.files.length, indexedAt: now } });
    });
  }

  async importsOf(boardId: number, path: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: schema.codeImports.toPath })
      .from(schema.codeImports)
      .where(and(eq(schema.codeImports.boardId, boardId), eq(schema.codeImports.fromPath, path)))
      .orderBy(schema.codeImports.toPath);
    return rows.map((r) => r.path);
  }

  async importedBy(boardId: number, path: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: schema.codeImports.fromPath })
      .from(schema.codeImports)
      .where(and(eq(schema.codeImports.boardId, boardId), eq(schema.codeImports.toPath, path)))
      .orderBy(schema.codeImports.fromPath);
    return rows.map((r) => r.path);
  }

  /** Files outside `paths` that import any of them, with the path they import. */
  async importersOf(boardId: number, paths: readonly string[]): Promise<{ from: string; to: string }[]> {
    if (paths.length === 0) return [];
    const rows = await this.db
      .select({ from: schema.codeImports.fromPath, to: schema.codeImports.toPath })
      .from(schema.codeImports)
      .where(and(eq(schema.codeImports.boardId, boardId), inArray(schema.codeImports.toPath, [...paths])));
    const inside = new Set(paths);
    return rows.filter((r) => !inside.has(r.from));
  }

  /** The indexed files at or under each path (a folder expands to its files; a file is itself). */
  async filesUnder(boardId: number, path: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: schema.codeFiles.path })
      .from(schema.codeFiles)
      .where(and(eq(schema.codeFiles.boardId, boardId), sql`(${schema.codeFiles.path} = ${path} or ${schema.codeFiles.path} like ${`${likeEscape(path)}/%`} escape '\\')`))
      .limit(2000);
    return rows.map((r) => r.path);
  }

  /** Newest commits that changed a file or anything under a folder, each with its merged change's title when slop has one. */
  async history(boardId: number, path: string, limit: number): Promise<IndexedCommit[]> {
    const p = schema.codePathCommits;
    const rows = await this.db
      .select({ sha: p.sha, subject: p.subject, date: p.committedAt, globId: p.globId })
      .from(p)
      .where(and(eq(p.boardId, boardId), sql`(${p.path} = ${path} or ${p.path} like ${`${likeEscape(path)}/%`} escape '\\')`))
      .groupBy(p.sha, p.subject, p.committedAt, p.seq, p.globId)
      .orderBy(p.seq)
      .limit(limit);
    const k = schema.knowledgeItems;
    const changes =
      rows.length === 0
        ? []
        : await this.db
            .select({ ref: k.externalRef, title: k.title, url: k.externalUrl })
            .from(k)
            .where(and(eq(k.boardId, boardId), eq(k.sourceType, 'change_summary'), inArray(k.externalRef, rows.map((r) => `change:${r.sha}`))));
    const byRef = new Map(changes.map((c) => [c.ref, { title: c.title, url: c.url }]));
    return rows.map((r) => ({ sha: r.sha, subject: r.subject, date: r.date.toISOString(), globId: r.globId, change: byRef.get(`change:${r.sha}`) ?? null }));
  }

  async record(boardId: number, consumer: string, op: string, empty: boolean): Promise<void> {
    const now = new Date();
    await this.db
      .insert(schema.codeViewUsage)
      .values({ boardId, consumer, op, calls: 1, emptyResults: empty ? 1 : 0, lastAt: now })
      .onConflictDoUpdate({
        target: [schema.codeViewUsage.boardId, schema.codeViewUsage.consumer, schema.codeViewUsage.op],
        set: {
          calls: sql`${schema.codeViewUsage.calls} + 1`,
          emptyResults: sql`${schema.codeViewUsage.emptyResults} + ${empty ? 1 : 0}`,
          lastAt: now,
        },
      });
  }
}
