import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import type { NewTestRun } from '../src/domain/test-runs.js';
import type { AtfIntegration } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';

const run = (patch: Partial<NewTestRun> = {}): NewTestRun => ({
  boardId: 1,
  kind: 'atf',
  globId: null,
  environment: 'staging',
  sha: 'abc1234',
  passed: 3,
  failed: 1,
  skipped: 0,
  url: null,
  finishedAt: NOW,
  eventId: 'e1',
  ...patch,
});

describe('per-spec test results in the store', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('writes the spec rows with the run and reads them back by run', async () => {
    const specs = [
      { spec: 'e2e/a.spec.ts', status: 'passed', tests: 2, failedTests: 0, durationMs: 1200 },
      { spec: 'e2e/b.spec.ts', status: 'failed', tests: 2, failedTests: 1, durationMs: null },
      { spec: 'e2e/c.spec.ts', status: 'missing', tests: 0, failedTests: 0, durationMs: null },
    ] as const;
    expect(await store.transaction((tx) => tx.insertTestRun(run({ specs })))).toBe(true);
    await store.transaction((tx) => tx.insertTestRun(run({ eventId: 'e2' })));
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(1, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
    );
    expect(runs).toHaveLength(2);
    // The run itself carries no spec rows.
    expect(runs.every((r) => !('specs' in r))).toBe(true);
    const rows = await store.transaction((tx) => tx.listTestRunSpecs(runs.map((r) => r.id)));
    expect(rows.map((r) => [r.testRunId, r.spec, r.status])).toEqual(
      specs.map((s) => [runs.find((r) => r.eventId === 'e1')?.id, s.spec, s.status]),
    );
    expect(await store.transaction((tx) => tx.listTestRunSpecs([]))).toEqual([]);
  });

  it('records a redelivered event once, rows included', async () => {
    const specs = [
      { spec: 'a.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction((tx) => tx.insertTestRun(run({ specs })));
    expect(await store.transaction((tx) => tx.insertTestRun(run({ specs })))).toBe(false);
    expect(await store.transaction((tx) => tx.listTestRunSpecs([1, 2, 3]))).toHaveLength(1);
  });

  it('drops a deleted glob’s branch runs with their spec rows', async () => {
    const specs = [
      { spec: 'a.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction(async (tx) => {
      await tx.insertTestRun(run({ globId: 's1t1', environment: null, specs }));
    });
    expect(store.state.testRunSpecs).toHaveLength(1);
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect(store.state.testRunSpecs).toEqual([]);
  });
});

describe('ATF batches in the store', () => {
  it('stores one batch per board, environment and commit and returns the first on a repeat', async () => {
    const store = new MemoryStore();
    const batch = {
      boardId: 1,
      environment: 'staging',
      sha: 'abc1234',
      specs: [{ spec: 'a.spec.ts', globIds: ['s1t1'] }],
      greps: [{ grep: '@x', globIds: ['s1t1'] }],
      createdAt: NOW,
    };
    const first = await store.transaction((tx) => tx.insertAtfBatch(batch));
    const again = await store.transaction((tx) =>
      tx.insertAtfBatch({ ...batch, specs: [], createdAt: '2026-10-06T00:00:00.000Z' }),
    );
    expect(again).toEqual(first);
    expect(await store.transaction((tx) => tx.getAtfBatch(1, 'staging', 'abc1234'))).toEqual(first);
    expect(await store.transaction((tx) => tx.getAtfBatch(1, 'staging', 'other'))).toBeNull();
    expect(await store.transaction((tx) => tx.getAtfBatch(2, 'staging', 'abc1234'))).toBeNull();
    const later = await store.transaction((tx) =>
      tx.insertAtfBatch({ ...batch, sha: 'def5678', createdAt: '2026-10-06T00:00:00.000Z' }),
    );
    expect(await store.transaction((tx) => tx.latestAtfBatch(1, 'staging'))).toEqual(later);
    expect(await store.transaction((tx) => tx.latestAtfBatch(1, 'prod'))).toBeNull();
  });
});

describe('the board ATF setting', () => {
  const ADMIN = 'admin@example.com';
  const atf: AtfIntegration = {
    provider: 'codebuild',
    region: 'us-east-1',
    project: 'atf',
    roleArn: 'arn:aws:iam::1:role/r',
    mode: 'push',
  };
  let boards: BoardService;
  let boardId: number;
  let version: number;

  beforeEach(async () => {
    const store = new MemoryStore();
    boards = new BoardService({ store, notifier: new RecordingNotifier() });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    const created = await boards.create(ADMIN, {
      name: 'b',
      repo: null,
      baseBranch: 'main',
      timeZone: 'UTC',
      environments: [],
    });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
    version = created.value.version;
    expect(created.value.atf).toBeNull();
  });

  it('is saved next to deploy, and cleared with null', async () => {
    const saved = await boards.updateSettings(ADMIN, boardId, version, { atf });
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.atf).toEqual(atf);
    expect(saved.value.deploy).toBeNull();
    const cleared = await boards.updateSettings(ADMIN, boardId, saved.value.version, { atf: null });
    expect(cleared.ok && cleared.value.atf).toBeNull();
  });

  it('needs a region and a project', async () => {
    const refused = await boards.updateSettings(ADMIN, boardId, version, {
      atf: { ...atf, project: ' ' },
    });
    expect(!refused.ok && refused.error.code).toBe('invalid_input');
  });
});
