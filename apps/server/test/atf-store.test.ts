import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AtfIntegration, NewTestRun } from '@slop/core';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const AT = '2026-10-05T12:00:00.000Z';
const run = (boardId: number, patch: Partial<NewTestRun> = {}): NewTestRun => ({
  boardId,
  kind: 'atf',
  globId: 's1t1',
  environment: 'staging',
  sha: 'abc1234',
  passed: 1,
  failed: 1,
  skipped: 0,
  url: null,
  finishedAt: AT,
  eventId: 'r1',
  ...patch,
});

describe('ATF storage in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;

  beforeAll(async () => {
    const test = await createTestDatabase('atf_store');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const board = (name: string) =>
      store.transaction((tx) =>
        tx.insertBoard({
          name,
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        }),
      );
    boardId = (await board('a')).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('persists the board ATF setting next to deploy, and reads null by default', async () => {
    const found = await store.transaction((tx) => tx.getBoard(boardId));
    if (found === null) throw new Error('No board');
    expect(found.atf).toBeNull();
    const atf: AtfIntegration = {
      provider: 'codebuild',
      region: 'us-east-1',
      project: 'atf',
      roleArn: 'arn:aws:iam::1:role/r',
      mode: 'push',
    };
    expect(
      await store.transaction((tx) =>
        tx.updateBoard({ ...found, atf, version: found.version + 1 }, found.version),
      ),
    ).toBe(true);
    const saved = await store.transaction((tx) => tx.getBoard(boardId));
    expect(saved?.atf).toEqual(atf);
    expect(saved?.deploy).toBeNull();
  });

  it('writes spec rows with the run in one transaction and lists them by run', async () => {
    const specs = [
      { spec: 'e2e/a.spec.ts', status: 'passed', tests: 2, failedTests: 0, durationMs: 1500 },
      { spec: 'e2e/b.spec.ts', status: 'failed', tests: 3, failedTests: 1, durationMs: null },
      { spec: 'e2e/c.spec.ts', status: 'missing', tests: 0, failedTests: 0, durationMs: null },
    ] as const;
    expect(await store.transaction((tx) => tx.insertTestRun(run(boardId, { specs })))).toBe(true);
    expect(await store.transaction((tx) => tx.insertTestRun(run(boardId, { eventId: 'r2' })))).toBe(
      true,
    );
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(boardId, { globIds: ['s1t1'] }),
    );
    expect(runs).toHaveLength(2);
    const withSpecs = runs.find((r) => r.eventId === 'r1');
    if (withSpecs === undefined) throw new Error('No run');
    const rows = await store.transaction((tx) => tx.listTestRunSpecs(runs.map((r) => r.id)));
    expect(rows).toEqual(specs.map((s) => ({ ...s, testRunId: withSpecs.id })));
    expect(await store.transaction((tx) => tx.listTestRunSpecs([]))).toEqual([]);
  });

  it('records a redelivered run once and writes its rows once', async () => {
    const specs = [
      { spec: 'e2e/a.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    expect(
      await store.transaction((tx) => tx.insertTestRun(run(boardId, { eventId: 'dup', specs }))),
    ).toBe(true);
    expect(
      await store.transaction((tx) => tx.insertTestRun(run(boardId, { eventId: 'dup', specs }))),
    ).toBe(false);
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(boardId, { globIds: ['s1t1'] }),
    );
    const dup = runs.find((r) => r.eventId === 'dup');
    expect((await store.transaction((tx) => tx.listTestRunSpecs([dup?.id ?? 0]))).length).toBe(1);
  });

  it('keeps one row per spec in a run', async () => {
    const same = {
      spec: 'e2e/same.spec.ts',
      status: 'passed',
      tests: 1,
      failedTests: 0,
      durationMs: null,
    } as const;
    await store.transaction((tx) =>
      tx.insertTestRun(
        run(boardId, { eventId: 'twice', specs: [same, { ...same, status: 'failed' }] }),
      ),
    );
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(boardId, { globIds: ['s1t1'] }),
    );
    const rows = await store.transaction((tx) =>
      tx.listTestRunSpecs([runs.find((r) => r.eventId === 'twice')?.id ?? 0]),
    );
    expect(rows.map((r) => [r.spec, r.status])).toEqual([['e2e/same.spec.ts', 'passed']]);
  });

  it('reads the spec rows of a branch run', async () => {
    const specs = [
      { spec: 'e2e/x.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction((tx) =>
      tx.insertTestRun(
        run(boardId, { eventId: 'branch', globId: 's1t2', environment: null, specs }),
      ),
    );
    const runs = await store.transaction((tx) => tx.listTestRuns(boardId, { globIds: ['s1t2'] }));
    expect(runs).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listTestRunSpecs([runs[0]?.id ?? 0]))).toHaveLength(
      1,
    );
  });
});
