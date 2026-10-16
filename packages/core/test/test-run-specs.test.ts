import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { DeployService } from '../src/app/deploy-service.js';
import { TestRunService } from '../src/app/test-run-service.js';
import * as testRuns from '../src/domain/test-runs.js';
import type { StoredRunSpec, TestRun, TestRunSpec } from '../src/domain/test-runs.js';
import type { Board } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board as baseBoard, glob } from './fixtures.js';

const board: Board = {
  ...baseBoard,
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'qa', allowBranchDeploy: true },
  ],
};

const HEAD = 'aaaaaaa1111';
const OLD_HEAD = 'bbbbbbb2222';
const DEPLOYED = 'ccccccc3333';

const run = (patch: Partial<TestRun> = {}): TestRun => ({
  id: 1,
  boardId: board.id,
  kind: 'atf',
  globId: 's1t1',
  environment: 'qa',
  sha: DEPLOYED,
  passed: 10,
  failed: 0,
  skipped: 0,
  url: null,
  finishedAt: NOW,
  eventId: 'aws:r1',
  runnerId: null,
  ...patch,
});

const row = (testRunId: number, spec: string, status: TestRunSpec['status']): StoredRunSpec => ({
  testRunId,
  spec,
  status,
  tests: 1,
  failedTests: status === 'failed' ? 1 : 0,
  durationMs: null,
});

/** A succeeded branch deploy of the glob's commit, as the rules read it. */
const deployed = (patch: { globId?: string; environment?: string; sha?: string } = {}) => ({
  globId: 's1t1',
  environment: 'qa',
  sha: DEPLOYED,
  ...patch,
});

describe('per-spec attribution', () => {
  const g = { id: 's1t1', pr: { number: 7, state: 'ready' as const, headSha: HEAD } };
  const planned = ['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/c.spec.ts'];

  it("takes each planned spec's newest result from the runs that apply to the glob, in plan order", () => {
    const runs = [
      run({ id: 1, finishedAt: '2026-10-05T10:00:00.000Z', url: 'https://ci/1' }),
      run({ id: 2, finishedAt: '2026-10-05T12:00:00.000Z', url: 'https://ci/2' }),
    ];
    const rows = [
      row(1, 'e2e/a.spec.ts', 'failed'),
      row(1, 'e2e/b.spec.ts', 'passed'),
      row(2, 'e2e/a.spec.ts', 'passed'),
      row(2, 'e2e/other.spec.ts', 'failed'),
    ];
    expect(testRuns.globSpecResults(g, planned, runs, rows, [deployed()])).toEqual([
      expect.objectContaining({
        spec: 'e2e/a.spec.ts',
        status: 'passed',
        runId: 2,
        url: 'https://ci/2',
        environment: 'qa',
        sha: DEPLOYED,
      }),
      expect.objectContaining({ spec: 'e2e/b.spec.ts', status: 'passed', runId: 1 }),
      { spec: 'e2e/c.spec.ts', status: null },
    ]);
  });

  it('counts a run for the glob whose deploy it tested only, and a missing row as a result', () => {
    const rows = [
      row(1, 'e2e/a.spec.ts', 'passed'),
      row(1, 'e2e/b.spec.ts', 'missing'),
      row(1, 'e2e/d.spec.ts', 'failed'),
    ];
    const other = { id: 's1t2', pr: null };
    const both = [deployed(), deployed({ globId: 's1t2' })];
    const mine = testRuns.globSpecResults(g, ['e2e/b.spec.ts'], [run()], rows, both);
    expect(mine).toEqual([expect.objectContaining({ spec: 'e2e/b.spec.ts', status: 'missing' })]);
    // The run belongs to s1t1, whatever another glob's deploy of the same commit says.
    expect(testRuns.globSpecResults(other, ['e2e/d.spec.ts'], [run()], rows, both)).toEqual([{ spec: 'e2e/d.spec.ts', status: null }]);
  });

  it("ignores a run against a commit the glob's branch was not deployed at, or deployed to another environment", () => {
    const rows = [row(1, 'e2e/a.spec.ts', 'passed')];
    expect(testRuns.globSpecResults(g, ['e2e/a.spec.ts'], [run()], rows, [deployed({ sha: 'ddddddd4444' })])).toEqual([
      { spec: 'e2e/a.spec.ts', status: null },
    ]);
    expect(testRuns.globSpecResults(g, ['e2e/a.spec.ts'], [run()], rows, [deployed({ environment: 'dev' })])).toEqual([
      { spec: 'e2e/a.spec.ts', status: null },
    ]);
  });

  it("counts the glob's own branch run, but not one of an older commit than the PR head", () => {
    const rows = [row(1, 'e2e/a.spec.ts', 'failed'), row(2, 'e2e/a.spec.ts', 'passed')];
    const stale = run({
      id: 1,
      globId: 's1t1',
      environment: 'dev',
      sha: OLD_HEAD,
      finishedAt: '2026-10-05T13:00:00.000Z',
    });
    const current = run({
      id: 2,
      globId: 's1t1',
      environment: 'dev',
      sha: HEAD,
      finishedAt: '2026-10-05T11:00:00.000Z',
    });
    expect(testRuns.globSpecResults(g, ['e2e/a.spec.ts'], [stale, current], rows, [])).toEqual([
      expect.objectContaining({ status: 'passed', runId: 2 }),
    ]);
  });

  it('counts the glob’s own planned specs on a chip, only when the run reported per-spec rows for them', () => {
    const rows = [
      row(1, 'e2e/a.spec.ts', 'passed'),
      row(1, 'e2e/b.spec.ts', 'failed'),
      row(1, 'e2e/unplanned.spec.ts', 'failed'),
    ];
    const [chip] = testRuns.atfIndicators(g, [run({ failed: 2 })], [deployed()], { planned, rows });
    expect(chip).toEqual(
      expect.objectContaining({
        scope: 'environment',
        failed: 2,
        plannedSpecs: { total: 3, passed: 1, failed: 1, skipped: 0, missing: 0, unreported: 1 },
      }),
    );
    // A run with counts only, or with rows for other specs only, has no own counts.
    expect(
      testRuns.atfIndicators(g, [run()], [deployed()], { planned, rows: [] })[0]?.plannedSpecs,
    ).toBeUndefined();
    expect(
      testRuns.atfIndicators(g, [run()], [deployed()], {
        planned,
        rows: [row(1, 'e2e/unplanned.spec.ts', 'failed')],
      })[0]?.plannedSpecs,
    ).toBeUndefined();
    // No test plan: the indicator is what it was.
    expect(testRuns.atfIndicators(g, [run()], [deployed()])[0]?.plannedSpecs).toBeUndefined();
  });
});

describe('per-spec attribution with several runners', () => {
  const g = { id: 's1t1', pr: { number: 7, state: 'ready' as const, headSha: HEAD } };
  const planned = ['e2e/a.spec.ts', 'e2e/b.spec.ts'];
  const A = 1;
  const B = 2;
  const at = (hour: number): string => `2026-10-05T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const results = (runs: TestRun[], rows: StoredRunSpec[]) =>
    Object.fromEntries(testRuns.globSpecResults(g, planned, runs, rows, [deployed()]).map((r) => [r.spec, r.status]));

  it('lets a failure from any runner win, whichever reported last', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: B, finishedAt: at(12) })];
    const rows = [row(1, 'e2e/a.spec.ts', 'failed'), row(2, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/b.spec.ts', 'passed')];
    expect(results(runs, rows)).toEqual({ 'e2e/a.spec.ts': 'failed', 'e2e/b.spec.ts': 'passed' });
    const failing = testRuns.globSpecResults(g, planned, runs, rows, [deployed()])[0];
    expect(failing).toMatchObject({ runId: 1, status: 'failed' });
  });

  it('never lets one runner’s missing row hide another runner’s result', () => {
    // B ran later and has a missing row for the spec only A ran (slop derives these from the batch).
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: B, finishedAt: at(12) })];
    const rows = [row(1, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/a.spec.ts', 'missing'), row(2, 'e2e/b.spec.ts', 'passed')];
    expect(results(runs, rows)).toEqual({ 'e2e/a.spec.ts': 'passed', 'e2e/b.spec.ts': 'passed' });
  });

  it('shows a spec missing only when no runner has another row for it, and unreported when none has a row', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: B, finishedAt: at(12) })];
    expect(results(runs, [row(1, 'e2e/a.spec.ts', 'missing'), row(2, 'e2e/a.spec.ts', 'missing')])).toEqual({
      'e2e/a.spec.ts': 'missing',
      'e2e/b.spec.ts': null,
    });
  });

  it('ranks skipped under passed, and lets the newest of equal rows speak', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10), url: 'https://ci/a' }), run({ id: 2, runnerId: B, finishedAt: at(12), url: 'https://ci/b' })];
    const rows = [row(1, 'e2e/a.spec.ts', 'skipped'), row(2, 'e2e/a.spec.ts', 'passed'), row(1, 'e2e/b.spec.ts', 'passed'), row(2, 'e2e/b.spec.ts', 'passed')];
    const found = testRuns.globSpecResults(g, planned, runs, rows, [deployed()]);
    expect(found[0]).toMatchObject({ status: 'passed', url: 'https://ci/b' });
    expect(found[1]).toMatchObject({ status: 'passed', url: 'https://ci/b' });
  });

  it('takes each runner’s newest run with a row, so a runner’s later pass replaces its own earlier failure', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: A, finishedAt: at(12) })];
    expect(results(runs, [row(1, 'e2e/a.spec.ts', 'failed'), row(2, 'e2e/a.spec.ts', 'passed')])['e2e/a.spec.ts']).toBe('passed');
  });

  it('still counts a legacy run (no runner) beside a registered runner’s', () => {
    const runs = [run({ id: 1, runnerId: null, finishedAt: at(10) }), run({ id: 2, runnerId: B, finishedAt: at(12) })];
    const rows = [row(1, 'e2e/a.spec.ts', 'failed'), row(2, 'e2e/b.spec.ts', 'passed')];
    expect(results(runs, rows)).toEqual({ 'e2e/a.spec.ts': 'failed', 'e2e/b.spec.ts': 'passed' });
  });

  it('shows the newest run of each runner on the card, not of each run, and combines the runners’ planned specs', () => {
    const runs = [
      run({ id: 1, runnerId: A, finishedAt: at(9), failed: 1 }),
      run({ id: 2, runnerId: A, finishedAt: at(10) }),
      run({ id: 3, runnerId: B, finishedAt: at(12) }),
    ];
    const rows = [
      row(1, 'e2e/a.spec.ts', 'failed'),
      row(2, 'e2e/a.spec.ts', 'passed'),
      row(3, 'e2e/a.spec.ts', 'missing'),
      row(3, 'e2e/b.spec.ts', 'passed'),
    ];
    const found = testRuns.atfIndicators(g, runs, [deployed()], { planned, rows });
    expect(found.map((i) => i.id)).toEqual([3, 2]);
    // Both show one combined result: A passed a, B passed b, nothing missing, nothing failing.
    for (const i of found) expect(i.plannedSpecs).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0, missing: 0, unreported: 0 });
  });

  it('turns every indicator of the group red when any runner failed a planned spec, amber when only missing', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: B, finishedAt: at(12) })];
    const failed = testRuns.atfIndicators(g, runs, [deployed()], {
      planned,
      rows: [row(1, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/b.spec.ts', 'failed')],
    });
    for (const i of failed) expect(i.plannedSpecs).toMatchObject({ failed: 1, passed: 1, missing: 0 });
    const amber = testRuns.atfIndicators(g, runs, [deployed()], {
      planned,
      rows: [row(1, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/a.spec.ts', 'missing'), row(2, 'e2e/b.spec.ts', 'missing')],
    });
    for (const i of amber) expect(i.plannedSpecs).toMatchObject({ failed: 0, passed: 1, missing: 1 });
  });

  it('keeps a stale branch run out of the current group’s counts', () => {
    const branch = (id: number, runnerId: number, sha: string, hour: number) => run({ id, runnerId, globId: 's1t1', environment: null, sha, finishedAt: at(hour) });
    const runs = [branch(1, A, OLD_HEAD, 9), branch(2, B, HEAD, 10)];
    const rows = [row(1, 'e2e/a.spec.ts', 'failed'), row(2, 'e2e/a.spec.ts', 'passed'), row(2, 'e2e/b.spec.ts', 'passed')];
    const found = testRuns.atfIndicators(g, runs, [], { planned, rows });
    expect(found.find((i) => i.id === 2)?.plannedSpecs).toMatchObject({ failed: 0, passed: 2 });
    expect(found.find((i) => i.id === 1)).toMatchObject({ stale: true, plannedSpecs: { failed: 1 } });
  });

  it('names the runner of each indicator and run only when names are given', () => {
    const runs = [run({ id: 1, runnerId: A, finishedAt: at(10) }), run({ id: 2, runnerId: null, finishedAt: at(12) })];
    expect(testRuns.atfIndicators(g, runs, [deployed()]).map((i) => i.runnerName)).toEqual([undefined, undefined]);
    const names = new Map<number | null, string>([[A, 'GitHub Actions'], [null, 'Legacy runner']]);
    expect(testRuns.atfIndicators(g, runs, [deployed()], undefined, names).map((i) => i.runnerName)).toEqual(['Legacy runner', 'GitHub Actions']);
    expect(testRuns.globTestRuns(g, runs, [deployed()], undefined, names).map((i) => i.runnerName)).toEqual(['Legacy runner', 'GitHub Actions']);
  });
});

describe('TestRunService with per-spec results', () => {
  let store: MemoryStore;
  let service: TestRunService;
  let deploys: DeployService;
  let n = 0;
  const DEV = 'dev@example.com';
  const PLAN =
    '| Name | Status | Location | Description |\n|---|---|---|---|\n\n```atf-specs\nspecs:\n  - e2e/a.spec.ts\n  - e2e/b.spec.ts\n```\n';

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    service = new TestRunService({ store, notifier, clock });
    n = 0;
    deploys = new DeployService({ store, notifier, clock, newDeployId: () => `d${String(++n)}` });
    const artifacts = new ArtifactService({ store, clock, notifier });
    store.state.boards.set(board.id, { ...board, environments: [...board.environments], sensitivePaths: [] });
    await store.transaction(async (tx) => {
      await tx.insertGlob(glob({ id: 's1t1', status: 'reviewing', environment: 'qa' }), null);
      await tx.insertGlob(glob({ id: 's1t2', status: 'reviewing', environment: 'dev' }), null);
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
    });
    await artifacts.putTestPlan(DEV, 's1t1', PLAN);
    // s1t1's branch deploy put DEPLOYED in qa.
    const requested = await deploys.requestFromPush('s1t1', DEPLOYED);
    if (!requested.ok || requested.value === null) throw new Error('no deploy');
    await deploys.finished(requested.value.id, { succeeded: true, error: null });
  });

  const report = (specs?: TestRunSpec[]) =>
    service.recordAtf({
      repo: 'acme/app',
      sha: DEPLOYED,
      environment: 'qa',
      branch: null,
      passed: 3,
      failed: 1,
      skipped: 0,
      url: 'https://ci/9',
      at: null,
      eventId: 'aws:a1',
      ...(specs === undefined ? {} : { specs }),
    });

  it('returns the runs with their spec rows and each planned spec’s result, with the missing one derived by slop', async () => {
    await report([
      { spec: 'e2e/a.spec.ts', status: 'failed', tests: 3, failedTests: 1, durationMs: 40 },
    ]);
    const view = await service.forGlob(DEV, 's1t1');
    if (!view.ok) throw new Error(view.error.message);
    expect(view.value.specs).toEqual([
      expect.objectContaining({ spec: 'e2e/a.spec.ts', status: 'failed', url: 'https://ci/9' }),
      expect.objectContaining({ spec: 'e2e/b.spec.ts', status: 'missing' }),
    ]);
    expect(view.value.runs[0]?.specs?.map((s) => [s.spec, s.status])).toEqual([
      ['e2e/a.spec.ts', 'failed'],
      ['e2e/b.spec.ts', 'missing'],
    ]);
    expect(view.value.runs[0]?.plannedSpecs).toEqual({
      total: 2,
      passed: 0,
      failed: 1,
      skipped: 0,
      missing: 1,
      unreported: 0,
    });
  });

  it('serves the card chip’s own counts to the glob whose deploy was tested, and nothing to another glob', async () => {
    await report([
      { spec: 'e2e/a.spec.ts', status: 'passed', tests: 3, failedTests: 0, durationMs: null },
    ]);
    const state = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect(state.get('s1t1')?.[0]?.plannedSpecs).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 0,
      missing: 1,
      unreported: 0,
    });
    expect(state.get('s1t1')?.[0]).toEqual(expect.objectContaining({ passed: 3, failed: 1 }));
    // The run belongs to the glob whose deploy it tested: another glob shows nothing.
    expect(state.has('s1t2')).toBe(false);
  });

  it('shows "no result yet" for planned specs of a run that sent counts only, and stays closed to non-members', async () => {
    await report();
    const view = await service.forGlob(DEV, 's1t1');
    expect(view.ok && view.value.specs).toEqual([
      { spec: 'e2e/a.spec.ts', status: null },
      { spec: 'e2e/b.spec.ts', status: null },
    ]);
    expect(view.ok && view.value.runs[0]?.specs).toBeUndefined();
    expect((await service.forGlob('stranger@example.com', 's1t1')).ok).toBe(false);
  });

  it('records each runner’s run with its own missing rows, and a missing row of one never hides the other’s pass', async () => {
    const batch = await service.atfBatch(board.id, 'qa', DEPLOYED);
    expect(batch.ok && batch.value.status === 'ready' && batch.value.specs.map((s) => s.spec)).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts']);
    const post = (runnerId: number, eventId: string, spec: string, finishedAt: string) =>
      service.recordAtf(
        {
          repo: '',
          sha: DEPLOYED,
          environment: 'qa',
          branch: null,
          passed: 1,
          failed: 0,
          skipped: 0,
          url: `https://ci/${String(runnerId)}`,
          at: finishedAt,
          eventId,
          specs: [{ spec, status: 'passed', tests: 1, failedTests: 0, durationMs: null }],
        },
        { boardId: board.id, runnerId },
      );
    expect(await post(1, 'runner:1:x', 'e2e/a.spec.ts', '2026-10-05T11:00:00.000Z')).toEqual([board.id]);
    expect(await post(2, 'runner:2:x', 'e2e/b.spec.ts', '2026-10-05T12:00:00.000Z')).toEqual([board.id]);
    // Each run carries a missing row for the listed spec it didn't report.
    const rows = store.state.testRunSpecs.map((r) => [r.testRunId, r.spec, r.status]);
    expect(rows).toHaveLength(4);
    expect(rows).toContainEqual([expect.any(Number), 'e2e/a.spec.ts', 'missing']);
    const view = await service.forGlob(DEV, 's1t1');
    expect(view.ok && view.value.specs.map((s) => [s.spec, s.status])).toEqual([
      ['e2e/a.spec.ts', 'passed'],
      ['e2e/b.spec.ts', 'passed'],
    ]);
    const state = await service.boardState(board.id, ['s1t1']);
    expect(state.get('s1t1')?.map((i) => i.plannedSpecs)).toEqual([
      expect.objectContaining({ passed: 2, missing: 0 }),
      expect.objectContaining({ passed: 2, missing: 0 }),
    ]);
  });
});

