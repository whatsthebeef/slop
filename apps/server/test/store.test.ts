import { GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, PgStore, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

/** Runs against a throwaway database next to the dev one: `docker compose up -d postgres`. */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const TEST_DB = `slop_test_${process.pid}`;
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('PgStore', () => {
  let admin: Database;
  let database: Database;
  let store: PgStore;
  let globs: GlobService;

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${TEST_DB}`));
    await runMigrations(TEST_URL, new URL('../drizzle', import.meta.url).pathname);
    database = connect(TEST_URL);
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: 'dev@example.com', name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: 'dev@example.com', role: 'admin' });
    });
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${TEST_DB} with (force)`));
    await admin.close();
  });

  const create = (key: string | null = null) =>
    globs.create('dev@example.com', {
      boardId: 1,
      title: 'Concurrent',
      summary: '',
      type: 'same',
      category: 'task',
      group: null,
      environment: null,
      autoTrigger: false,
      idempotencyKey: key,
    });

  it('hands out unique IDs to concurrent creates', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, () => create()));
    const ids = created.map((r) => unwrap(r).id);
    expect(new Set(ids).size).toBe(20);
  });

  it('lets exactly one of two writes from the same version win', async () => {
    const glob = unwrap(await create());
    const results = await Promise.all([
      globs.update('dev@example.com', glob.id, glob.version, { group: 'A' }),
      globs.update('dev@example.com', glob.id, glob.version, { group: 'B' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => (r.ok ? [] : [r.error.code]))).toEqual(['version_conflict']);
  });

  it('reads several globs at once, ignoring duplicate and unknown IDs', async () => {
    const first = unwrap(await create());
    const second = unwrap(await create());
    const read = (ids: readonly string[]) => store.transaction((tx) => tx.getGlobs(ids));
    expect(await read([])).toEqual([]);
    const found = await read([first.id, second.id, first.id, 's1t999999']);
    expect(found.map((g) => g.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('returns the same glob for a repeated idempotency key', async () => {
    const first = unwrap(await create('same-key'));
    const again = unwrap(await create('same-key'));
    expect(again.id).toBe(first.id);
  });

  it('versions artifacts per glob, kind and label, and lists the latest of each', async () => {
    const glob = unwrap(await create());
    const provenance = { by: 'human' as const, actor: 'dev@example.com', runId: null, agentSetVersion: null };
    const put = (kind: 'plan' | 'attachment', label: string, content: string) =>
      store.transaction((tx) =>
        tx.insertArtifact({ globId: glob.id, kind, label, content, link: null, commitSha: null, provenance, createdAt: new Date().toISOString() }),
      );
    await Promise.all([put('plan', '', 'v1'), put('plan', '', 'v2')]);
    await put('attachment', 'Notes', 'n1');
    const latest = await store.transaction((tx) => tx.listArtifacts(glob.id));
    expect(latest.map((a) => `${a.kind}:${a.version}`).sort()).toEqual(['attachment:1', 'plan:2']);
    const versions = await store.transaction((tx) => tx.artifactVersions(glob.id, 'plan', ''));
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('backfills plan.md v1 from the summary only where a glob has none, and again changes nothing', async () => {
    const backfill = readFileSync(new URL('../drizzle/0023_plan_backfill.sql', import.meta.url), 'utf8');
    const bare = unwrap(await create());
    const planned = unwrap(await create());
    const blank = unwrap(await create());
    const setSummary = (id: string, summary: string) =>
      database.db.execute(sql`update globs set data = jsonb_set(data, '{summary}', to_jsonb(${summary}::text)) where id = ${id}`);
    await setSummary(bare.id, 'Old summary');
    await setSummary(planned.id, 'Summary of a planned glob');
    await setSummary(blank.id, '  ');
    await database.db.execute(sql`delete from artifacts where glob_id in (${bare.id}, ${planned.id}, ${blank.id})`);
    const provenance = { by: 'human' as const, actor: 'dev@example.com', runId: null, agentSetVersion: null };
    await store.transaction((tx) =>
      tx.insertArtifact({ globId: planned.id, kind: 'plan', label: '', content: 'Real plan', link: null, commitSha: null, provenance, createdAt: new Date().toISOString() }),
    );
    await database.db.execute(sql.raw(backfill));
    await database.db.execute(sql.raw(backfill));
    const plans = (id: string) => store.transaction((tx) => tx.artifactVersions(id, 'plan', ''));
    const [v1, ...more] = await plans(bare.id);
    expect(more).toEqual([]);
    expect(v1).toMatchObject({ version: 1, content: 'Old summary', provenance: { by: 'backfill' } });
    expect((await plans(planned.id)).map((a) => [a.version, a.content])).toEqual([[1, 'Real plan']]);
    expect(await plans(blank.id)).toEqual([]);
    const summary = await store.transaction((tx) => tx.getGlob(bare.id));
    expect(summary?.summary).toBe('Old summary');
  });

  it('summarises artifacts per glob on a board: latest version per kind, version count, no content', async () => {
    const first = unwrap(await create());
    const second = unwrap(await create());
    const elsewhere = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'other',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      const glob = { ...first, id: `s${String(board.id)}t1`, boardId: board.id, version: 1 };
      await tx.insertGlob(glob, null);
      return glob;
    });
    const put = (globId: string, kind: 'local_review' | 'postplan', commitSha: string | null, by: 'sessionator' | 'routine' = 'sessionator') =>
      store.transaction((tx) =>
        tx.insertArtifact({
          globId,
          kind,
          label: '',
          content: `${kind} at ${commitSha ?? '-'}`,
          link: null,
          commitSha,
          provenance: { by, actor: 'dev@example.com', runId: null, agentSetVersion: 2 },
          createdAt: new Date().toISOString(),
        }),
      );
    await put(first.id, 'local_review', 'aaa');
    await put(first.id, 'local_review', 'bbb');
    await put(first.id, 'postplan', 'bbb');
    await put(second.id, 'local_review', null, 'routine');
    await put(elsewhere.id, 'local_review', 'zzz');

    const summaries = await store.transaction((tx) => tx.listArtifactSummaries(1, [first.id, second.id, elsewhere.id]));
    const rows = summaries
      .map((a) => `${a.globId}:${a.kind}:v${String(a.version)}/${String(a.versions)}:${a.commitSha ?? '-'}:${a.by}`)
      .sort();
    expect(rows).toEqual(
      [
        `${first.id}:local_review:v2/2:bbb:sessionator`,
        `${first.id}:postplan:v1/1:bbb:sessionator`,
        `${second.id}:local_review:v1/1:-:routine`,
      ].sort(),
    );
    expect(summaries[0]).not.toHaveProperty('content');
    expect(summaries.every((a) => typeof a.createdAt === 'string' && a.actor === 'dev@example.com')).toBe(true);

    const one = await store.transaction((tx) => tx.listArtifactSummaries(1, [second.id]));
    expect(one.map((a) => a.globId)).toEqual([second.id]);
    expect(await store.transaction((tx) => tx.listArtifactSummaries(1, []))).toEqual([]);

    const view = unwrap(await globs.get('dev@example.com', first.id));
    expect(view.artifacts.map((a) => a.kind)).toEqual(['postplan', 'local_review']);
    const board = unwrap(await globs.listWithArtifacts('dev@example.com', 1, {}));
    expect(board.find((g) => g.glob.id === second.id)?.artifacts.map((a) => a.kind)).toEqual(['local_review']);
  });

  it('keeps earlier knowledge versions as history', async () => {
    const doc = {
      boardId: 1,
      kind: 'doc' as const,
      name: 'build',
      area: 'build',
      audience: ['implementer'],
      description: '',
      content: 'one',
      layer: 'file' as const,
      version: 1,
      source: 'upload',
      updatedBy: 'dev@example.com',
      updatedAt: new Date().toISOString(),
    };
    await store.transaction((tx) => tx.saveKnowledge(doc));
    await store.transaction((tx) => tx.saveKnowledge({ ...doc, content: 'two', version: 2 }));
    expect((await store.transaction((tx) => tx.getKnowledge(1, 'doc', 'build')))?.content).toBe('two');
    const history = await database.db.execute(sql`select version from knowledge_history where name = 'build'`);
    expect(history.map((r) => r.version)).toEqual([1]);
  });

  it('rolls back everything a failed transaction wrote', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.upsertUser({ email: 'ghost@example.com', name: 'Ghost', active: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.transaction((tx) => tx.getUser('ghost@example.com'))).toBeNull();
  });

  it('keeps a personal dismissal per person and drops it with the notification', async () => {
    const n = {
      id: '1/readiness', boardId: 1, source: 'readiness', severity: 'info' as const, title: 't', detail: 'd', link: null, action: null,
      since: '2026-10-08T10:00:00.000Z', clears: { kind: 'personal' as const }, items: ['build_doc'],
    };
    await store.transaction(async (tx) => {
      await tx.saveNotification(n);
      await tx.saveNotificationDismissal(n.id, 'dev@example.com', ['build_doc']);
    });
    expect((await store.transaction((tx) => tx.getNotification(n.id)))?.items).toEqual(['build_doc']);
    expect(await store.transaction((tx) => tx.listNotificationDismissals('dev@example.com', [n.id]))).toEqual([{ id: n.id, items: ['build_doc'] }]);
    expect(await store.transaction((tx) => tx.listNotificationDismissals('other@example.com', [n.id]))).toEqual([]);
    await store.transaction((tx) => tx.deleteNotification(n.id));
    expect(await store.transaction((tx) => tx.listNotificationDismissals('dev@example.com', [n.id]))).toEqual([]);
  });
});
