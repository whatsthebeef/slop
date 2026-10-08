import { beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentService } from '../src/app/environment-service.js';
import { TestRunService } from '../src/app/test-run-service.js';
import type { ReportedAtfRun } from '../src/app/test-run-service.js';
import type { GlobPresence } from '../src/domain/environments.js';
import * as testRuns from '../src/domain/test-runs.js';
import type { TestRun } from '../src/domain/test-runs.js';
import type { Board } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board as baseBoard, glob } from './fixtures.js';

const board: Board = {
  ...baseBoard,
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'staging', allowBranchDeploy: false, role: 'integration' },
    { name: 'prod', allowBranchDeploy: false, role: 'release', production: true },
  ],
};

const HEAD = 'aaaaaaa1111';
const OLD_HEAD = 'bbbbbbb2222';
const DEPLOYED = 'ccccccc3333';
const NEWER = 'ddddddd4444';

const run = (patch: Partial<TestRun> = {}): TestRun => ({
  id: 1,
  boardId: board.id,
  kind: 'atf',
  globId: null,
  environment: 'staging',
  sha: DEPLOYED,
  passed: 10,
  failed: 0,
  skipped: 0,
  url: null,
  finishedAt: NOW,
  eventId: 'aws:r1',
  ...patch,
});

const presence = (patch: Partial<GlobPresence> = {}): GlobPresence => ({
  boardId: board.id,
  globId: 's1t1',
  environment: 'staging',
  mergeSha: 'm1',
  contained: true,
  checkedSha: DEPLOYED,
  checkedAt: NOW,
  since: NOW,
  ...patch,
});

describe('ATF rules', () => {
  const g = { id: 's1t1', pr: { number: 7, state: 'ready' as const, headSha: HEAD } };

  it('fails a run on any failing test', () => {
    expect(testRuns.testRunFailed({ failed: 0 })).toBe(false);
    expect(testRuns.testRunFailed({ failed: 1 })).toBe(true);
  });

  it("shows the glob's latest branch run, stale when it tested an older commit than the PR head", () => {
    const older = run({ id: 1, globId: 's1t1', sha: HEAD.slice(0, 7), finishedAt: '2026-10-05T10:00:00.000Z' });
    const latest = run({ id: 2, globId: 's1t1', sha: OLD_HEAD, failed: 3, finishedAt: '2026-10-05T11:00:00.000Z' });
    expect(testRuns.atfIndicators(g, [older], [])).toEqual([
      expect.objectContaining({ scope: 'branch', sha: HEAD.slice(0, 7), failing: false }),
    ]);
    expect(testRuns.atfIndicators(g, [older], [])[0]?.stale).toBeUndefined();
    expect(testRuns.atfIndicators(g, [older, latest], [])).toEqual([
      expect.objectContaining({ scope: 'branch', sha: OLD_HEAD, failed: 3, failing: true, stale: true }),
    ]);
    // Another glob's branch run is not this glob's.
    expect(testRuns.atfIndicators(g, [run({ globId: 's1t2' })], [])).toEqual([]);
  });

  it("shows an environment run only at the commit the environment was checked at, while it holds the glob", () => {
    const atDeploy = run({ id: 1, sha: DEPLOYED.slice(0, 7), failed: 2 });
    expect(testRuns.atfIndicators(g, [atDeploy], [presence()])).toEqual([
      expect.objectContaining({ scope: 'environment', environment: 'staging', failing: true }),
    ]);
    // Not held, another environment's run, or another commit: nothing.
    expect(testRuns.atfIndicators(g, [atDeploy], [presence({ contained: false })])).toEqual([]);
    expect(testRuns.atfIndicators(g, [run({ environment: 'prod' })], [presence()])).toEqual([]);
    expect(testRuns.atfIndicators(g, [run({ sha: NEWER })], [presence()])).toEqual([]);
  });

  it('shows the latest run per environment, newest first, after the branch run', () => {
    const runs = [
      run({ id: 1, finishedAt: '2026-10-05T10:00:00.000Z', failed: 4 }),
      run({ id: 2, finishedAt: '2026-10-05T11:00:00.000Z' }),
      run({ id: 3, environment: 'prod', sha: NEWER }),
      run({ id: 4, globId: 's1t1', environment: 'dev', sha: HEAD }),
    ];
    const presences = [presence(), presence({ environment: 'prod', checkedSha: NEWER })];
    expect(testRuns.atfIndicators(g, runs, presences).map((i) => [i.scope, i.environment, i.failed])).toEqual([
      ['branch', 'dev', 0],
      ['environment', 'prod', 0],
      ['environment', 'staging', 0],
    ]);
    // The glob view lists every one of them.
    expect(testRuns.globTestRuns(g, runs, presences)).toHaveLength(4);
  });

  it('takes the glob ID from a full branch ref', () => {
    expect(testRuns.branchGlobId('refs/heads/s1t1')).toBe('s1t1');
    expect(testRuns.branchGlobId('s1t1')).toBe('s1t1');
  });
});

describe('TestRunService', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: TestRunService;
  let environments: EnvironmentService;
  let now = NOW;

  const report = (patch: Partial<ReportedAtfRun> = {}): ReportedAtfRun => ({
    repo: 'Acme/App',
    sha: DEPLOYED,
    environment: 'staging',
    branch: null,
    passed: 12,
    failed: 0,
    skipped: 1,
    url: 'https://ci.example/report/1',
    at: null,
    eventId: 'aws:a1',
    ...patch,
  });

  const deploy = async (sha: string, eventId: string, at: string) => {
    await environments.recordDeploy({ repo: 'acme/app', environment: 'staging', sha, ref: null, succeeded: true, url: null, at, eventId });
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = NOW;
    const clock = { now: () => now };
    service = new TestRunService({ store, notifier, clock });
    environments = new EnvironmentService({ store, notifier, clock });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      await tx.insertGlob(glob({ id: 's1t1', status: 'reviewing', environment: 'dev', pr: { number: 7, state: 'ready', headSha: HEAD } }), null);
      await tx.insertGlob(glob({ id: 's1t2', status: 'reviewing' }), null);
      await tx.upsertMember({ boardId: board.id, email: 'dev@example.com', role: 'dev' });
    });
  });

  it("records a branch run on the glob once, logs ATFCompleted and drives no transition", async () => {
    const before = await store.transaction((tx) => tx.getGlob('s1t1'));
    const branchRun = report({ branch: 'refs/heads/s1t1', environment: null, sha: HEAD, failed: 2 });
    expect(await service.recordAtf(branchRun)).toEqual([board.id]);
    expect(await service.recordAtf(branchRun)).toEqual([]);
    expect(store.state.testRuns).toEqual([
      expect.objectContaining({ globId: 's1t1', environment: 'dev', sha: HEAD, passed: 12, failed: 2, skipped: 1, finishedAt: NOW }),
    ]);
    expect(store.state.events.map((e) => [e.type, e.globId, e.data])).toEqual([
      ['ATFCompleted', 's1t1', { sha: HEAD, environment: 'dev', passed: 12, failed: 2, skipped: 1, url: 'https://ci.example/report/1' }],
    ]);
    expect(notifier.hints).toEqual([{ kind: 'glob.deploys', boardId: board.id, globId: 's1t1' }]);
    expect(await store.transaction((tx) => tx.getGlob('s1t1'))).toEqual(before);
    const state = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect([...state.keys()]).toEqual(['s1t1']);
    expect(state.get('s1t1')).toEqual([expect.objectContaining({ scope: 'branch', failing: true })]);
  });

  it("ignores a glob branch's run without a commit, on another repo, or for a glob that is gone", async () => {
    expect(await service.recordAtf(report({ branch: 's1t1', sha: null }))).toEqual([]);
    expect(await service.recordAtf(report({ branch: 's1t1', repo: 'acme/other' }))).toEqual([]);
    // A glob's branch is never taken for an environment run, even with an observed environment named.
    expect(await service.recordAtf(report({ branch: 's1t9' }))).toEqual([]);
    expect(store.state.testRuns).toEqual([]);
  });

  it('ignores an environment run without an observed environment, or without a commit and a deploy', async () => {
    expect(await service.recordAtf(report({ environment: null }))).toEqual([]);
    expect(await service.recordAtf(report({ environment: 'dev' }))).toEqual([]);
    expect(await service.recordAtf(report({ sha: null }))).toEqual([]);
    expect(await service.recordAtf(report({ repo: 'acme/other' }))).toEqual([]);
    expect(store.state.testRuns).toEqual([]);
  });

  it("records an environment run once, at the environment's latest deploy when it names no commit", async () => {
    await deploy(DEPLOYED, 'aws:d1', '2026-10-05T11:00:00.000Z');
    expect(await service.recordAtf(report({ sha: null, branch: 'main' }))).toEqual([board.id]);
    expect(await service.recordAtf(report({ sha: null }))).toEqual([]);
    expect(store.state.testRuns).toEqual([expect.objectContaining({ globId: null, environment: 'staging', sha: DEPLOYED })]);
    // Logged once in the table, not on each glob, and the board refreshes once.
    expect(store.state.events).toEqual([]);
    expect(notifier.hints).toEqual([{ kind: 'board.tests', boardId: board.id }]);
  });

  it('shows an environment run on every glob the commit holds', async () => {
    await deploy(DEPLOYED, 'aws:d1', '2026-10-05T11:00:00.000Z');
    await environments.recordContainment(board.id, 'staging', DEPLOYED, [
      { globId: 's1t1', mergeSha: 'm1', contained: true },
      { globId: 's1t2', mergeSha: 'm2', contained: true },
    ]);
    await service.recordAtf(report({ failed: 1 }));
    const state = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect([...state.keys()]).toEqual(['s1t1', 's1t2']);
    expect(state.get('s1t2')).toEqual([expect.objectContaining({ scope: 'environment', environment: 'staging', failing: true })]);
    const view = await service.forGlob('dev@example.com', 's1t2');
    expect(view.ok && view.value.map((r) => [r.scope, r.sha])).toEqual([['environment', DEPLOYED]]);
    expect((await service.forGlob('stranger@example.com', 's1t2')).ok).toBe(false);
  });

  it("shows a run reported before its deploy's check once the check stores presence at that commit", async () => {
    await service.recordAtf(report());
    expect((await service.boardState(board.id, ['s1t1'])).size).toBe(0);
    await deploy(DEPLOYED, 'aws:d1', '2026-10-05T11:00:00.000Z');
    notifier.hints.length = 0;
    await environments.recordContainment(board.id, 'staging', DEPLOYED, [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    // One board refresh shows the run on every glob held, moved or not.
    expect(notifier.hints).toEqual([{ kind: 'board.tests', boardId: board.id }]);
    expect((await service.boardState(board.id, ['s1t1'])).get('s1t1')).toEqual([
      expect.objectContaining({ scope: 'environment', sha: DEPLOYED }),
    ]);
  });

  it('keeps a run for an older commit that arrives after a newer deploy, but shows it on no glob', async () => {
    await deploy(DEPLOYED, 'aws:d1', '2026-10-05T11:00:00.000Z');
    await environments.recordContainment(board.id, 'staging', DEPLOYED, [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    now = '2026-10-05T13:00:00.000Z';
    await deploy(NEWER, 'aws:d2', '2026-10-05T12:30:00.000Z');
    await environments.recordContainment(board.id, 'staging', NEWER, [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    expect(await service.recordAtf(report({ eventId: 'aws:late' }))).toEqual([board.id]);
    expect(store.state.testRuns).toHaveLength(1);
    expect((await service.boardState(board.id, ['s1t1'])).size).toBe(0);
  });

  it("removes a glob's branch runs with it, not the environment's", async () => {
    await service.recordAtf(report({ branch: 's1t1', sha: HEAD, eventId: 'aws:b1' }));
    await service.recordAtf(report({ eventId: 'aws:e1' }));
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect(store.state.testRuns.map((r) => r.globId)).toEqual([null]);
  });
});
