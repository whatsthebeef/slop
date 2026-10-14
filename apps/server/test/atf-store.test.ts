import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AtfIntegration, NewEnvironmentDeploy, NewTestRun } from '@slop/core';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const AT = '2026-10-05T12:00:00.000Z';
const LATER = '2026-10-06T12:00:00.000Z';

const deploy = (
  boardId: number,
  patch: Partial<NewEnvironmentDeploy> = {},
): NewEnvironmentDeploy => ({
  boardId,
  environment: 'staging',
  sha: 'abc1234',
  ref: null,
  succeeded: true,
  url: null,
  at: AT,
  eventId: 'd1',
  ...patch,
});
const run = (boardId: number, patch: Partial<NewTestRun> = {}): NewTestRun => ({
  boardId,
  kind: 'atf',
  globId: null,
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
  let otherBoardId: number;

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
    otherBoardId = (await board('b')).id;
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
      tx.listTestRuns(boardId, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
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
      tx.listTestRuns(boardId, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
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
      tx.listTestRuns(boardId, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
    );
    const rows = await store.transaction((tx) =>
      tx.listTestRunSpecs([runs.find((r) => r.eventId === 'twice')?.id ?? 0]),
    );
    expect(rows.map((r) => [r.spec, r.status])).toEqual([['e2e/same.spec.ts', 'passed']]);
  });

  it('lists an environment’s deploys newest first and stamps checked_at on the commit’s rows', async () => {
    await store.transaction(async (tx) => {
      await tx.insertEnvironmentDeploy(deploy(boardId));
      await tx.insertEnvironmentDeploy(
        deploy(boardId, { sha: 'def5678', eventId: 'd2', at: LATER }),
      );
      await tx.insertEnvironmentDeploy(
        deploy(boardId, {
          sha: 'bad0000',
          eventId: 'd3',
          at: '2026-10-07T00:00:00.000Z',
          succeeded: false,
        }),
      );
      await tx.insertEnvironmentDeploy(deploy(otherBoardId, { eventId: 'd1' }));
    });
    const listed = await store.transaction((tx) =>
      tx.listEnvironmentDeploys(boardId, 'staging', 10),
    );
    expect(listed.map((d) => [d.sha, d.succeeded, d.checkedAt])).toEqual([
      ['bad0000', false, null],
      ['def5678', true, null],
      ['abc1234', true, null],
    ]);
    expect(
      await store.transaction((tx) => tx.listEnvironmentDeploys(boardId, 'staging', 2)),
    ).toHaveLength(2);
    await store.transaction((tx) =>
      tx.markEnvironmentDeployChecked(boardId, 'staging', 'def5678', '2026-10-06T12:05:00.000Z'),
    );
    const after = await store.transaction((tx) =>
      tx.listEnvironmentDeploys(boardId, 'staging', 10),
    );
    expect(after.map((d) => [d.sha, d.checkedAt])).toEqual([
      ['bad0000', null],
      ['def5678', '2026-10-06T12:05:00.000Z'],
      ['abc1234', null],
    ]);
    // The latest succeeded deploy carries the stamp; other boards are untouched.
    expect(
      (await store.transaction((tx) => tx.latestEnvironmentDeploy(boardId, 'staging')))?.checkedAt,
    ).toBe('2026-10-06T12:05:00.000Z');
    expect(
      (await store.transaction((tx) => tx.latestEnvironmentDeploy(otherBoardId, 'staging')))
        ?.checkedAt,
    ).toBeNull();
  });

  it('stores one batch per board, environment and commit and returns the stored one on a repeat', async () => {
    const batch = {
      boardId,
      environment: 'staging',
      sha: 'def5678',
      specs: [{ spec: 'e2e/a.spec.ts', globIds: ['s1t1', 's1t2'] }],
      greps: [{ grep: '@x', globIds: ['s1t1'] }],
      createdAt: LATER,
    };
    const first = await store.transaction((tx) => tx.insertAtfBatch(batch));
    expect(first).toMatchObject(batch);
    const again = await store.transaction((tx) =>
      tx.insertAtfBatch({ ...batch, specs: [], createdAt: '2026-10-08T00:00:00.000Z' }),
    );
    expect(again).toEqual(first);
    expect(await store.transaction((tx) => tx.getAtfBatch(boardId, 'staging', 'def5678'))).toEqual(
      first,
    );
    expect(
      await store.transaction((tx) => tx.getAtfBatch(otherBoardId, 'staging', 'def5678')),
    ).toBeNull();
    const newer = await store.transaction((tx) =>
      tx.insertAtfBatch({ ...batch, sha: 'fff9999', createdAt: '2026-10-09T00:00:00.000Z' }),
    );
    expect(await store.transaction((tx) => tx.latestAtfBatch(boardId, 'staging'))).toEqual(newer);
    expect(await store.transaction((tx) => tx.latestAtfBatch(boardId, 'prod'))).toBeNull();
  });

  it('reads the spec rows of a branch run', async () => {
    const specs = [
      { spec: 'e2e/x.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction((tx) =>
      tx.insertTestRun(
        run(boardId, { eventId: 'branch', globId: 's1t1', environment: null, specs }),
      ),
    );
    const runs = await store.transaction((tx) => tx.listTestRuns(boardId, { globIds: ['s1t1'] }));
    expect(runs).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listTestRunSpecs([runs[0]?.id ?? 0]))).toHaveLength(
      1,
    );
  });
});
