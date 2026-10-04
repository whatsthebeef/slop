import { GlobService } from '@slop/core';
import type { Result } from '@slop/core';
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

  it('returns the same glob for a repeated idempotency key', async () => {
    const first = unwrap(await create('same-key'));
    const again = unwrap(await create('same-key'));
    expect(again.id).toBe(first.id);
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
});
