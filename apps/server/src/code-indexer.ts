import { CODE_HISTORY_KEPT, globIdOfSubject, hasImports, importSpecifiers, languageOf, resolveImport } from '@slop/core';
import type { Store } from '@slop/core';
import type { CodeClones } from './code-clones.js';
import type { CodeIndex, CodeSnapshot } from './code-index.js';
import { repoOf } from './codehost.js';

/** The commits whose files the path history reads; older changes stay in git and in slop's change summaries. */
const HISTORY_COMMITS = 500;
const RECORD = '\u001e';
const FIELD = '\u001f';

/**
 * Builds a board's index from its clone: the file tree, the import graph (a light, line-based reader, see
 * `importSpecifiers`) and the path history of the base branch, then swaps it into Postgres in one go. It reads the clone
 * with `git ls-tree`, `git grep` and `git log` only, so nothing from the repository is ever checked out or executed.
 */
export class CodeIndexer {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly clones: CodeClones;
      readonly index: CodeIndex;
      readonly now?: () => Date;
    },
  ) {}

  /** Fetches the board's base branch and re-indexes it when it moved (or was never indexed). Returns whether it indexed. */
  async syncBoard(boardId: number): Promise<boolean> {
    const board = await this.deps.store.transaction((tx) => tx.getBoard(boardId));
    const repo = board === null ? null : repoOf(board);
    if (repo === null) return false;
    const { sha } = await this.deps.clones.sync(boardId, repo);
    if ((await this.deps.index.commitOf(boardId)) === sha) return false;
    await this.deps.index.replace(boardId, await this.snapshot(boardId, sha), (this.deps.now ?? (() => new Date()))());
    return true;
  }

  /** Every board with a repository; one failing board doesn't stop the rest (the first failure is thrown at the end). */
  async syncAll(): Promise<void> {
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    let failure: Error | null = null;
    for (const board of boards) {
      try {
        await this.syncBoard(board.id);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure !== null) throw failure;
  }

  private async snapshot(boardId: number, sha: string): Promise<CodeSnapshot> {
    const files = await this.files(boardId, sha);
    const known = new Set(files.map((f) => f.path));
    return { sha, files, imports: await this.imports(boardId, sha, known), history: await this.history(boardId, known) };
  }

  /** `<mode> <type> <object> <size>\t<path>` for every blob (submodules and symlinks to them are not files here). */
  private async files(boardId: number, sha: string): Promise<CodeSnapshot['files'][number][]> {
    const out = await this.deps.clones.git(boardId, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-l', '-z', sha]);
    const files: CodeSnapshot['files'][number][] = [];
    for (const row of out.split('\0')) {
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, type, , size] = row.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;
      const path = row.slice(tab + 1);
      files.push({ path, size: Number(size) || 0, language: languageOf(path) });
    }
    return files;
  }

  private async imports(boardId: number, sha: string, known: ReadonlySet<string>): Promise<CodeSnapshot['imports'][number][]> {
    const edges = new Map<string, { from: string; to: string }>();
    const line = /^[0-9a-f]{40}:(.+?):\d+:(.*)$/;
    // One streamed search for every line that could hold an import, then a per-line read; the repo is never opened file by file.
    await this.deps.clones.lines(
      boardId,
      ['-c', 'core.quotepath=off', 'grep', '-n', '-I', '-E', '--no-color', '--no-recurse-submodules', '-e', '(from|import|require)', sha],
      (row) => {
        const m = line.exec(row);
        if (m?.[1] === undefined || m[2] === undefined) return;
        const language = languageOf(m[1]);
        if (!hasImports(language)) return;
        for (const specifier of importSpecifiers(language, m[2])) {
          const to = resolveImport(m[1], specifier, known);
          if (to !== null) edges.set(`${m[1]}\0${to}`, { from: m[1], to });
        }
      },
    );
    return [...edges.values()];
  }

  private async history(boardId: number, known: ReadonlySet<string>): Promise<CodeSnapshot['history'][number][]> {
    const perPath = new Map<string, number>();
    const rows: CodeSnapshot['history'][number][] = [];
    let commit: { sha: string; subject: string; date: Date; seq: number } | null = null;
    let seq = -1;
    await this.deps.clones.lines(
      boardId,
      ['-c', 'core.quotepath=off', 'log', '--first-parent', '--no-renames', '--name-only', `-n${String(HISTORY_COMMITS)}`, `--pretty=format:${RECORD}%H${FIELD}%cI${FIELD}%s`, 'refs/slop/base'],
      (row) => {
        if (row.startsWith(RECORD)) {
          const [sha, date, ...subject] = row.slice(1).split(FIELD);
          const when = new Date(date ?? '');
          seq += 1;
          commit = sha === undefined || Number.isNaN(when.getTime()) ? null : { sha, subject: subject.join(FIELD), date: when, seq };
          return;
        }
        if (commit === null || row === '' || !known.has(row)) return;
        const seen = perPath.get(row) ?? 0;
        if (seen >= CODE_HISTORY_KEPT) return;
        perPath.set(row, seen + 1);
        rows.push({ path: row, sha: commit.sha, subject: commit.subject, date: commit.date, seq: commit.seq, globId: globIdOfSubject(commit.subject) });
      },
    );
    return rows;
  }
}
