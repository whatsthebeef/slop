import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { EnvironmentService } from '../src/app/environment-service.js';
import { TestRunService } from '../src/app/test-run-service.js';
import type { AtfBatchAnswer } from '../src/app/test-run-service.js';
import * as testRuns from '../src/domain/test-runs.js';
import type { Board } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { board as baseBoard, glob } from './fixtures.js';

const board: Board = {
  ...baseBoard,
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'staging', allowBranchDeploy: false, role: 'integration' },
  ],
  atf: { provider: 'codebuild', region: 'us-east-1', project: 'atf', mode: 'pull' },
};

const DEV = 'dev@example.com';
const D1 = 'aaaaaaa1111';
const D2 = 'bbbbbbb2222';
const D3 = 'ccccccc3333';

const plan = (specs: string[], grep?: string): string =>
  `| Name | Status | Location | Description |\n|---|---|---|---|\n\n\`\`\`atf-specs\nspecs:\n${specs.map((s) => `  - ${s}`).join('\n')}\n${grep === undefined ? '' : `grep: "${grep}"\n`}\`\`\`\n`;

const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 5, 10, minutes)).toISOString();

const ready = (answer: Awaited<ReturnType<TestRunService['atfBatch']>>) => {
  if (!answer.ok || answer.value.status !== 'ready')
    throw new Error(`not ready: ${JSON.stringify(answer)}`);
  return answer.value.batch;
};
const status = (
  answer: Awaited<ReturnType<TestRunService['atfBatch']>>,
): AtfBatchAnswer['status'] | 'error' => (answer.ok ? answer.value.status : 'error');

describe('the ATF batch for a deploy', () => {
  let store: MemoryStore;
  let service: TestRunService;
  let environments: EnvironmentService;
  let artifacts: ArtifactService;
  let now = at(0);

  const deploy = (sha: string, eventId: string, minute: number) =>
    environments.recordDeploy({
      repo: 'acme/app',
      environment: 'staging',
      sha,
      ref: null,
      succeeded: true,
      url: null,
      at: at(minute),
      eventId,
    });
  const check = (sha: string, globIds: string[]) =>
    environments.recordContainment(
      board.id,
      'staging',
      sha,
      globIds.map((globId) => ({ globId, mergeSha: `m-${globId}`, contained: true })),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    now = at(0);
    const clock = { now: () => now };
    const notifier = new RecordingNotifier();
    service = new TestRunService({ store, notifier, clock });
    environments = new EnvironmentService({ store, notifier, clock });
    artifacts = new ArtifactService({ store, clock, notifier });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      for (const id of ['s1t1', 's1t2', 's1t3'])
        await tx.insertGlob(glob({ id, status: 'reviewing' }), null);
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
    });
    await artifacts.putTestPlan(DEV, 's1t1', plan(['e2e/a.spec.ts', 'e2e/b.spec.ts']));
    await artifacts.putTestPlan(DEV, 's1t2', plan(['e2e/b.spec.ts', 'e2e/c.spec.ts'], '@smoke'));
    await artifacts.putTestPlan(DEV, 's1t3', plan(['e2e/d.spec.ts']));
  });

  it('is pending until the deploy is reported and its containment check has run', async () => {
    expect(status(await service.atfBatch(board.id, 'staging', D1))).toBe('pending');
    now = at(1);
    await deploy(D1, 'aws:1', 1);
    expect(status(await service.atfBatch(board.id, 'staging', D1))).toBe('pending');
    now = at(2);
    await check(D1, ['s1t1']);
    expect(status(await service.atfBatch(board.id, 'staging', D1))).toBe('ready');
  });

  it('answers the union of the globs a deploy burst newly holds, once, with each spec and grep attributed', async () => {
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t1', 's1t2']);
    const batch = ready(await service.atfBatch(board.id, 'staging', D1));
    expect(batch.specs).toEqual([
      { spec: 'e2e/a.spec.ts', globIds: ['s1t1'] },
      { spec: 'e2e/b.spec.ts', globIds: ['s1t1', 's1t2'] },
      { spec: 'e2e/c.spec.ts', globIds: ['s1t2'] },
    ]);
    expect(batch.greps).toEqual([{ grep: '@smoke', globIds: ['s1t2'] }]);
    // A later plan change doesn't alter the stored answer: a second call returns the same batch.
    now = at(3);
    await artifacts.putTestPlan(DEV, 's1t1', plan(['e2e/z.spec.ts']));
    expect(ready(await service.atfBatch(board.id, 'staging', D1))).toEqual(batch);
    expect(store.state.atfBatches).toHaveLength(1);
  });

  it('spans deploys nobody asked about: the later deploy runs everything newly held since the previous one', async () => {
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t1']);
    now = at(3);
    await deploy(D2, 'aws:2', 3);
    now = at(4);
    await check(D2, ['s1t1', 's1t3']);
    // D1's check came after the previous deploy's time, so the burst D1+D2 runs what both newly hold, once.
    expect(status(await service.atfBatch(board.id, 'staging', D1))).toBe('superseded');
    const batch = ready(await service.atfBatch(board.id, 'staging', D2));
    expect(batch.specs).toEqual([
      { spec: 'e2e/a.spec.ts', globIds: ['s1t1'] },
      { spec: 'e2e/b.spec.ts', globIds: ['s1t1'] },
      { spec: 'e2e/d.spec.ts', globIds: ['s1t3'] },
    ]);
  });

  it('stops at the previous batch: globs already run are not run again', async () => {
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t1']);
    now = at(3);
    ready(await service.atfBatch(board.id, 'staging', D1));
    now = at(4);
    await deploy(D2, 'aws:2', 4);
    now = at(5);
    await check(D2, ['s1t1', 's1t2']);
    const batch = ready(await service.atfBatch(board.id, 'staging', D2));
    // s1t1 is still held but was newly held at D1 (before the previous batch): only s1t2's specs run now.
    expect(batch.specs.map((s) => s.spec)).toEqual(['e2e/b.spec.ts', 'e2e/c.spec.ts']);
    expect(batch.specs.every((s) => s.globIds.length === 1 && s.globIds[0] === 's1t2')).toBe(true);
  });

  it('is empty (the default suite) when no newly held glob has a list, and for a glob without a test plan', async () => {
    await store.transaction((tx) => tx.insertGlob(glob({ id: 's1t9', status: 'reviewing' }), null));
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t9']);
    const batch = ready(await service.atfBatch(board.id, 'staging', D1));
    expect(batch.specs).toEqual([]);
    expect(batch.greps).toEqual([]);
  });

  it('says superseded for an older commit, pending for one it has not heard of, and refuses unobserved environments', async () => {
    await deploy(D1, 'aws:1', 1);
    await deploy(D2, 'aws:2', 2);
    const old = await service.atfBatch(board.id, 'staging', D1);
    expect(old.ok && old.value).toEqual({ status: 'superseded', latestSha: D2 });
    expect(status(await service.atfBatch(board.id, 'staging', D3))).toBe('pending');
    const dev = await service.atfBatch(board.id, 'dev', D1);
    expect(!dev.ok && dev.error.code).toBe('invalid_input');
    const nobody = await service.atfBatch(99, 'staging', D1);
    expect(!nobody.ok && nobody.error.code).toBe('not_found');
  });

  it('matches an abbreviated commit to the deploy', async () => {
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t1']);
    expect(ready(await service.atfBatch(board.id, 'staging', D1.slice(0, 8))).sha).toBe(D1);
  });

  it('adds a missing row for each batch spec the run did not report, and none when it reported no specs', async () => {
    await deploy(D1, 'aws:1', 1);
    now = at(2);
    await check(D1, ['s1t1', 's1t2']);
    ready(await service.atfBatch(board.id, 'staging', D1));
    const passed = {
      spec: 'e2e/a.spec.ts',
      status: 'passed',
      tests: 3,
      failedTests: 0,
      durationMs: 10,
    } as const;
    const report = {
      repo: 'acme/app',
      sha: D1,
      environment: 'staging',
      branch: null,
      passed: 3,
      failed: 0,
      skipped: 0,
      url: null,
      at: null,
    };
    await service.recordAtf({ ...report, eventId: 'aws:r1', specs: [passed] });
    await service.recordAtf({ ...report, eventId: 'aws:r2' });
    const [first, second] = store.state.testRuns;
    const rows = await store.transaction((tx) =>
      tx.listTestRunSpecs([first?.id ?? 0, second?.id ?? 0]),
    );
    expect(rows.map((r) => [r.testRunId === first?.id, r.spec, r.status])).toEqual([
      [true, 'e2e/a.spec.ts', 'passed'],
      [true, 'e2e/b.spec.ts', 'missing'],
      [true, 'e2e/c.spec.ts', 'missing'],
    ]);
  });

  it('computes missing rows without a batch as none, and the pure helper skips reported specs', () => {
    expect(
      testRuns.missingSpecs(
        [
          { spec: 'a', globIds: ['g'] },
          { spec: 'b', globIds: ['g'] },
        ],
        [{ spec: 'a', status: 'failed', tests: 1, failedTests: 1, durationMs: null }],
      ),
    ).toEqual([{ spec: 'b', status: 'missing', tests: 0, failedTests: 0, durationMs: null }]);
  });

  it('bounds the window by the recent-merge days', () => {
    const now2 = '2026-10-31T00:00:00.000Z';
    expect(testRuns.batchWindowStart(null, null, now2, 30)).toBe('2026-10-01T00:00:00.000Z');
    expect(testRuns.batchWindowStart('2026-09-01T00:00:00.000Z', null, now2, 30)).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(
      testRuns.batchWindowStart('2026-10-20T00:00:00.000Z', '2026-10-25T00:00:00.000Z', now2, 30),
    ).toBe('2026-10-20T00:00:00.000Z');
    expect(testRuns.batchWindowStart(null, '2026-10-25T00:00:00.000Z', now2, 30)).toBe(
      '2026-10-25T00:00:00.000Z',
    );
  });

  it('queues start_atf with the containment check for a push board only', async () => {
    await deploy(D1, 'aws:1', 1);
    store.state.outbox.length = 0;
    now = at(2);
    await check(D1, ['s1t1']);
    expect(store.state.outbox).toEqual([]);
    await store.transaction(async (tx) => {
      const current = (await tx.getBoard(board.id)) ?? board;
      await tx.updateBoard(
        {
          ...current,
          atf: { provider: 'codebuild', region: 'us-east-1', project: 'atf', mode: 'push' },
        },
        current.version,
      );
    });
    await deploy(D2, 'aws:2', 3);
    store.state.outbox.length = 0;
    now = at(4);
    await check(D2, ['s1t1']);
    expect(store.state.outbox).toEqual([
      {
        kind: 'start_atf',
        globId: `board-${String(board.id)}`,
        boardId: board.id,
        environment: 'staging',
        sha: D2,
      },
    ]);
  });
});
