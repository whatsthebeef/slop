import { beforeEach, describe, expect, it } from 'vitest';
import { TestRunService } from '../src/app/test-run-service.js';
import type { ReportedAtfRun } from '../src/app/test-run-service.js';
import type { Deploy } from '../src/domain/deploys.js';
import * as testRuns from '../src/domain/test-runs.js';
import type { TestRun } from '../src/domain/test-runs.js';
import type { Board } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board as baseBoard, glob } from './fixtures.js';

const board: Board = {
  ...baseBoard,
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'qa', allowBranchDeploy: true },
    { name: 'prod', allowBranchDeploy: true },
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

/** A branch deploy of the glob's commit that succeeded (the shape the run-finding rules read). */
const deployed = (patch: Partial<Pick<Deploy, 'globId' | 'environment' | 'sha'>> = {}) => ({
  globId: 's1t1',
  environment: 'qa',
  sha: DEPLOYED,
  ...patch,
});

describe('ATF rules', () => {
  const g = { id: 's1t1', pr: { number: 7, state: 'ready' as const, headSha: HEAD } };

  it('fails a run on any failing test', () => {
    expect(testRuns.testRunFailed({ failed: 0 })).toBe(false);
    expect(testRuns.testRunFailed({ failed: 1 })).toBe(true);
  });

  it("shows the glob's latest branch run, stale when it tested an older commit than the PR head", () => {
    const older = run({ id: 1, environment: null, sha: HEAD.slice(0, 7), finishedAt: '2026-10-05T10:00:00.000Z' });
    const latest = run({ id: 2, environment: null, sha: OLD_HEAD, failed: 3, finishedAt: '2026-10-05T11:00:00.000Z' });
    expect(testRuns.atfIndicators(g, [older], [])).toEqual([
      expect.objectContaining({ scope: 'branch', sha: HEAD.slice(0, 7), failing: false }),
    ]);
    expect(testRuns.atfIndicators(g, [older], [])[0]?.stale).toBeUndefined();
    expect(testRuns.atfIndicators(g, [older, latest], [])).toEqual([
      expect.objectContaining({ scope: 'branch', sha: OLD_HEAD, failed: 3, failing: true, stale: true }),
    ]);
    // Another glob's run is not this glob's.
    expect(testRuns.atfIndicators(g, [run({ globId: 's1t2' })], [deployed({ globId: 's1t2' })])).toEqual([]);
  });

  it('shows a run against a commit the glob\'s branch deploy put in the environment, as an environment run', () => {
    const atDeploy = run({ id: 1, sha: DEPLOYED.slice(0, 7), failed: 2 });
    expect(testRuns.atfIndicators(g, [atDeploy], [deployed()])).toEqual([
      expect.objectContaining({ scope: 'environment', environment: 'qa', failing: true }),
    ]);
    // Another glob's deploy, another environment, or another commit is no deploy of this run.
    expect(testRuns.atfIndicators(g, [atDeploy], [deployed({ globId: 's1t2' })])).toEqual([
      expect.objectContaining({ scope: 'branch' }),
    ]);
    expect(testRuns.atfIndicators(g, [run({ environment: 'prod' })], [deployed()]).map((i) => i.scope)).toEqual(['branch']);
    expect(testRuns.atfIndicators(g, [run({ sha: NEWER })], [deployed()]).map((i) => i.scope)).toEqual(['branch']);
  });

  it('shows the latest run per environment, newest first, after the branch run', () => {
    const runs = [
      run({ id: 1, finishedAt: '2026-10-05T10:00:00.000Z', failed: 4 }),
      run({ id: 2, finishedAt: '2026-10-05T11:00:00.000Z' }),
      run({ id: 3, environment: 'prod', sha: NEWER }),
      run({ id: 4, environment: 'dev', sha: HEAD }),
    ];
    const deploys = [deployed(), deployed({ environment: 'prod', sha: NEWER })];
    expect(testRuns.atfIndicators(g, runs, deploys).map((i) => [i.scope, i.environment, i.failed])).toEqual([
      ['branch', 'dev', 0],
      ['environment', 'prod', 0],
      ['environment', 'qa', 0],
    ]);
    // The glob view lists every one of them.
    expect(testRuns.globTestRuns(g, runs, deploys)).toHaveLength(4);
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
  let now = NOW;

  const report = (patch: Partial<ReportedAtfRun> = {}): ReportedAtfRun => ({
    repo: 'Acme/App',
    sha: DEPLOYED,
    environment: 'qa',
    branch: null,
    passed: 12,
    failed: 0,
    skipped: 1,
    url: 'https://ci.example/report/1',
    at: null,
    eventId: 'aws:a1',
    ...patch,
  });

  let deployCount = 0;
  /** A succeeded branch deploy of the glob's commit (newest request first, as the store lists them). */
  const deploy = async (sha: string, at: string, globId = 's1t1', environment = 'qa') => {
    deployCount += 1;
    await store.transaction((tx) =>
      tx.saveDeploys([
        {
          id: `dep${String(deployCount)}`,
          boardId: board.id,
          environment,
          globId,
          sha,
          state: 'succeeded',
          trigger: 'push',
          requestedBy: null,
          requestedAt: at,
          runningSince: at,
          startedAt: at,
          finishedAt: at,
          providerRef: null,
          url: null,
          error: null,
        },
      ]),
    );
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = NOW;
    const clock = { now: () => now };
    service = new TestRunService({ store, notifier, clock });
    deployCount = 0;
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

  it("ignores an environment run without a board environment, without a deploy of its commit, or on another repo", async () => {
    expect(await service.recordAtf(report({ environment: null }))).toEqual([]);
    expect(await service.recordAtf(report({ environment: 'nowhere' }))).toEqual([]);
    expect(await service.recordAtf(report({ sha: null }))).toEqual([]);
    // A deploy, but not of this commit, and one that never succeeded.
    await deploy(NEWER, '2026-10-05T11:00:00.000Z');
    await store.transaction((tx) =>
      tx.saveDeploys([
        {
          id: 'failed1',
          boardId: board.id,
          environment: 'qa',
          globId: 's1t1',
          sha: DEPLOYED,
          state: 'failed',
          trigger: 'push',
          requestedBy: null,
          requestedAt: NOW,
          runningSince: NOW,
          startedAt: NOW,
          finishedAt: NOW,
          providerRef: null,
          url: null,
          error: 'exit 1',
        },
      ]),
    );
    expect(await service.recordAtf(report())).toEqual([]);
    expect(await service.recordAtf(report({ repo: 'acme/other', sha: NEWER }))).toEqual([]);
    expect(store.state.testRuns).toEqual([]);
  });

  it("records an environment run once on the deploy's glob, at the environment's latest deploy when it names no commit", async () => {
    await deploy(DEPLOYED, '2026-10-05T11:00:00.000Z');
    expect(await service.recordAtf(report({ sha: null, branch: 'main' }))).toEqual([board.id]);
    expect(await service.recordAtf(report({ sha: null }))).toEqual([]);
    expect(store.state.testRuns).toEqual([expect.objectContaining({ globId: 's1t1', environment: 'qa', sha: DEPLOYED })]);
    // Not logged as a branch run; the glob's deploys refresh.
    expect(store.state.events).toEqual([]);
    expect(notifier.hints).toEqual([{ kind: 'glob.deploys', boardId: board.id, globId: 's1t1' }]);
  });

  it('shows an environment run on the glob whose deploy it tested, and on no other', async () => {
    await deploy(DEPLOYED, '2026-10-05T11:00:00.000Z');
    await service.recordAtf(report({ failed: 1 }));
    const state = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect([...state.keys()]).toEqual(['s1t1']);
    expect(state.get('s1t1')).toEqual([expect.objectContaining({ scope: 'environment', environment: 'qa', failing: true })]);
    const view = await service.forGlob('dev@example.com', 's1t1');
    expect(view.ok && view.value.runs.map((r) => [r.scope, r.sha])).toEqual([['environment', DEPLOYED]]);
    expect((await service.forGlob('stranger@example.com', 's1t1')).ok).toBe(false);
  });

  it('keeps a run for an older commit of the glob while its deploy is among the glob\'s succeeded ones', async () => {
    await deploy(DEPLOYED, '2026-10-05T11:00:00.000Z');
    now = '2026-10-05T13:00:00.000Z';
    await deploy(NEWER, '2026-10-05T12:30:00.000Z');
    expect(await service.recordAtf(report({ eventId: 'aws:late' }))).toEqual([board.id]);
    expect(store.state.testRuns).toHaveLength(1);
    expect((await service.boardState(board.id, ['s1t1'])).get('s1t1')).toEqual([
      expect.objectContaining({ scope: 'environment', sha: DEPLOYED }),
    ]);
  });

  it("removes a glob's runs with it", async () => {
    await deploy(DEPLOYED, '2026-10-05T11:00:00.000Z');
    await service.recordAtf(report({ branch: 's1t1', sha: HEAD, eventId: 'aws:b1' }));
    await service.recordAtf(report({ eventId: 'aws:e1' }));
    expect(store.state.testRuns).toHaveLength(2);
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect(store.state.testRuns).toEqual([]);
  });

  describe('bound to a runner', () => {
    let otherBoardId: number;
    let runnerA: number;
    let runnerB: number;

    beforeEach(async () => {
      [otherBoardId, runnerA, runnerB] = await store.transaction(async (tx) => {
        // A second board on the same repo, as a team might have for another product line.
        const other = await tx.insertBoard({ ...board, name: 'other', environments: [...board.environments], sensitivePaths: [] });
        await tx.insertGlob(glob({ id: `s${String(other.id)}t1`, boardId: other.id, status: 'reviewing', environment: 'dev', pr: { number: 9, state: 'ready', headSha: HEAD } }), null);
        const make = async (name: string) => {
          const runner = await tx.insertAtfRunner({
            boardId: board.id,
            name,
            method: 'oidc',
            config: {},
            environments: ['qa'],
            enabled: true,
            createdBy: 'admin@example.com',
            createdAt: NOW,
          });
          if (runner === null) throw new Error('runner not inserted');
          return runner.id;
        };
        return [other.id, await make('GitHub Actions'), await make('CodeBuild')];
      });
      await deploy(DEPLOYED, '2026-10-05T11:00:00.000Z');
      // The other board's glob was deployed at the same commit, so an unbound report fans out to it too.
      await store.transaction((tx) =>
        tx.saveDeploys([
          {
            id: 'other-dep',
            boardId: otherBoardId,
            environment: 'qa',
            globId: `s${String(otherBoardId)}t1`,
            sha: DEPLOYED,
            state: 'succeeded',
            trigger: 'push',
            requestedBy: null,
            requestedAt: NOW,
            runningSince: NOW,
            startedAt: NOW,
            finishedAt: NOW,
            providerRef: null,
            url: null,
            error: null,
          },
        ]),
      );
    });

    it('records on the runner’s board only, whatever repo the report names, and keeps the runner', async () => {
      // Unbound, a report fans out to every board on the repo.
      expect(await service.recordAtf(report({ eventId: 'aws:fan' }))).toEqual([board.id, otherBoardId]);
      store.state.testRuns = [];
      expect(await service.recordAtf(report({ repo: '', eventId: 'runner:1:a' }), { boardId: board.id, runnerId: runnerA })).toEqual([board.id]);
      expect(store.state.testRuns).toEqual([expect.objectContaining({ boardId: board.id, runnerId: runnerA, environment: 'qa', sha: DEPLOYED })]);
    });

    it('stamps the runner’s last result, and records the legacy board token with no runner', async () => {
      await service.recordAtf(report({ repo: '', eventId: 'runner:1:a' }), { boardId: board.id, runnerId: runnerA });
      const stamped = await store.transaction((tx) => tx.getAtfRunner(board.id, runnerA));
      expect(stamped?.lastResultAt).toBe(NOW);
      expect((await store.transaction((tx) => tx.getAtfRunner(board.id, runnerB)))?.lastResultAt).toBeNull();
      await service.recordAtf(report({ eventId: 'runner:legacy:a' }), { boardId: board.id, runnerId: null });
      expect(store.state.testRuns.map((r) => r.runnerId)).toEqual([runnerA, null]);
    });

    it('records a redelivery once, and a second runner’s run beside the first’s', async () => {
      const post = (runnerId: number, eventId: string) => service.recordAtf(report({ eventId }), { boardId: board.id, runnerId });
      expect(await post(runnerA, `runner:${String(runnerA)}:k1`)).toEqual([board.id]);
      expect(await post(runnerA, `runner:${String(runnerA)}:k1`)).toEqual([]);
      expect(await post(runnerB, `runner:${String(runnerB)}:k1`)).toEqual([board.id]);
      expect(store.state.testRuns).toHaveLength(2);
    });

    it('takes a branch run only for a glob of the runner’s board', async () => {
      const bound = { boardId: board.id, runnerId: runnerA };
      expect(await service.recordAtf(report({ branch: `s${String(otherBoardId)}t1`, sha: HEAD, environment: null, eventId: 'runner:1:x' }), bound)).toEqual([]);
      expect(store.state.testRuns).toEqual([]);
      expect(await service.recordAtf(report({ branch: 's1t1', sha: HEAD, environment: null, eventId: 'runner:1:y' }), bound)).toEqual([board.id]);
      expect(store.state.testRuns).toEqual([expect.objectContaining({ globId: 's1t1', runnerId: runnerA })]);
    });

    it('ignores an environment with no deploy of the commit, and a board that is gone', async () => {
      expect(await service.recordAtf(report({ environment: 'dev', eventId: 'runner:1:z' }), { boardId: board.id, runnerId: runnerA })).toEqual([]);
      expect(await service.recordAtf(report({ eventId: 'runner:1:w' }), { boardId: 9999, runnerId: runnerA })).toEqual([]);
    });

    it('names the runners on the card and in the glob view only when the board has more than one', async () => {
      await service.recordAtf(report({ eventId: 'runner:1:a' }), { boardId: board.id, runnerId: runnerA });
      const names = async () => (await service.boardState(board.id, ['s1t1'])).get('s1t1')?.map((i) => i.runnerName);
      // Two registered runners, one of them posting: names show.
      expect(await names()).toEqual(['GitHub Actions']);
      await store.transaction((tx) => tx.updateAtfRunner(board.id, runnerB, { revokedAt: NOW }));
      expect(await names()).toEqual([undefined]);
      // A legacy run beside a runner's is two sources.
      await service.recordAtf(report({ eventId: 'runner:legacy:a', failed: 2 }), { boardId: board.id, runnerId: null });
      expect(await names()).toEqual(expect.arrayContaining(['GitHub Actions', 'Legacy runner']));
      const view = await service.forGlob('dev@example.com', 's1t1');
      expect(view.ok && view.value.runs.map((r) => r.runnerName).sort()).toEqual(['GitHub Actions', 'Legacy runner']);
    });
  });
});

