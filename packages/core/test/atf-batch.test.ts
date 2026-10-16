import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { DeployService } from '../src/app/deploy-service.js';
import { TestRunService } from '../src/app/test-run-service.js';
import type { AtfBatchAnswer } from '../src/app/test-run-service.js';
import type { Result } from '../src/domain/errors.js';
import * as testRuns from '../src/domain/test-runs.js';
import type { Board } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { board as baseBoard, glob } from './fixtures.js';

const board: Board = {
  ...baseBoard,
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'qa', allowBranchDeploy: true },
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

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const ready = (answer: Awaited<ReturnType<TestRunService['atfBatch']>>) => {
  if (!answer.ok || answer.value.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(answer)}`);
  return answer.value;
};
const status = (answer: Awaited<ReturnType<TestRunService['atfBatch']>>): AtfBatchAnswer['status'] | 'error' =>
  answer.ok ? answer.value.status : 'error';

describe('the ATF spec list for a branch deploy', () => {
  let store: MemoryStore;
  let service: TestRunService;
  let deploys: DeployService;
  let artifacts: ArtifactService;
  let n = 0;
  let now = at(0);

  /** A branch deploy of the glob's commit that ran and succeeded. */
  const succeed = async (globId: string, sha: string) => {
    const requested = unwrap(await deploys.requestFromPush(globId, sha));
    if (requested === null) throw new Error('no deploy requested');
    unwrap(await deploys.finished(requested.id, { succeeded: true, error: null }));
    return requested.id;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    now = at(0);
    n = 0;
    const clock = { now: () => now };
    const notifier = new RecordingNotifier();
    service = new TestRunService({ store, notifier, clock });
    deploys = new DeployService({ store, notifier, clock, newDeployId: () => `d${String(++n)}` });
    artifacts = new ArtifactService({ store, clock, notifier });
    store.state.boards.set(board.id, { ...board, environments: [...board.environments], sensitivePaths: [] });
    await store.transaction(async (tx) => {
      for (const id of ['s1t1', 's1t2', 's1t3']) await tx.insertGlob(glob({ id, status: 'reviewing', environment: 'dev' }), null);
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
    });
    await artifacts.putTestPlan(DEV, 's1t1', plan(['e2e/a.spec.ts', 'e2e/b.spec.ts']));
    await artifacts.putTestPlan(DEV, 's1t2', plan(['e2e/b.spec.ts', 'e2e/c.spec.ts'], '@smoke'));
    await artifacts.putTestPlan(DEV, 's1t3', plan(['e2e/d.spec.ts']));
  });

  it('is pending until a branch deploy of the commit has succeeded', async () => {
    expect(status(await service.atfBatch(board.id, 'dev', D1))).toBe('pending');
    const requested = unwrap(await deploys.requestFromPush('s1t1', D1));
    expect(status(await service.atfBatch(board.id, 'dev', D1))).toBe('pending');
    unwrap(await deploys.finished(requested?.id ?? '', { succeeded: true, error: null }));
    expect(status(await service.atfBatch(board.id, 'dev', D1))).toBe('ready');
  });

  it('is pending after a failed deploy, and refuses an environment the board does not have', async () => {
    const requested = unwrap(await deploys.requestFromPush('s1t1', D1));
    unwrap(await deploys.finished(requested?.id ?? '', { succeeded: false, error: 'exit 1' }));
    expect(status(await service.atfBatch(board.id, 'dev', D1))).toBe('pending');
    expect(status(await service.atfBatch(board.id, 'prod', D1))).toBe('error');
    expect(status(await service.atfBatch(99, 'dev', D1))).toBe('error');
  });

  it("answers the deployed glob's specs and grep, attributed to it, without waiting for any check", async () => {
    await succeed('s1t2', D1);
    const batch = ready(await service.atfBatch(board.id, 'dev', D1));
    expect(batch).toMatchObject({ environment: 'dev', sha: D1 });
    expect(batch.specs).toEqual([
      { spec: 'e2e/b.spec.ts', globIds: ['s1t2'] },
      { spec: 'e2e/c.spec.ts', globIds: ['s1t2'] },
    ]);
    expect(batch.greps).toEqual([{ grep: '@smoke', globIds: ['s1t2'] }]);
  });

  it('unions the lists of the globs whose deploys put the commit there, each spec once', async () => {
    await succeed('s1t1', D1);
    // Another glob deployed the very same commit (a shared head): one union, attributed to both.
    await store.transaction((tx) =>
      tx.saveDeploys([
        {
          id: 'x1',
          boardId: board.id,
          environment: 'dev',
          globId: 's1t2',
          sha: D1,
          state: 'succeeded',
          trigger: 'push',
          requestedBy: null,
          requestedAt: at(1),
          runningSince: at(1),
          startedAt: at(1),
          finishedAt: at(2),
          providerRef: null,
          url: null,
          error: null,
        },
      ]),
    );
    const batch = ready(await service.atfBatch(board.id, 'dev', D1));
    expect(batch.specs).toEqual([
      { spec: 'e2e/a.spec.ts', globIds: ['s1t1'] },
      { spec: 'e2e/b.spec.ts', globIds: ['s1t1', 's1t2'] },
      { spec: 'e2e/c.spec.ts', globIds: ['s1t2'] },
    ]);
  });

  it("reads the glob's latest plan, and an empty list when it has none", async () => {
    await succeed('s1t1', D1);
    now = at(3);
    await artifacts.putTestPlan(DEV, 's1t1', plan(['e2e/z.spec.ts']));
    expect(ready(await service.atfBatch(board.id, 'dev', D1)).specs.map((s) => s.spec)).toEqual(['e2e/z.spec.ts']);
    await store.transaction(async (tx) => {
      await tx.insertGlob(glob({ id: 's1t9', status: 'reviewing', environment: 'qa' }), null);
    });
    await succeed('s1t9', D3);
    expect(ready(await service.atfBatch(board.id, 'qa', D3))).toMatchObject({ specs: [], greps: [] });
  });

  it('says superseded once a newer deploy has put another commit in the environment', async () => {
    await succeed('s1t1', D1);
    await succeed('s1t3', D2);
    const answer = await service.atfBatch(board.id, 'dev', D1);
    expect(answer).toEqual({ ok: true, value: { status: 'superseded', latestSha: D2 } });
    expect(status(await service.atfBatch(board.id, 'dev', D2))).toBe('ready');
    // Another environment is not affected.
    expect(status(await service.atfBatch(board.id, 'qa', D1))).toBe('pending');
  });

  it('matches an abbreviated commit', async () => {
    await succeed('s1t1', D1);
    expect(ready(await service.atfBatch(board.id, 'dev', D1.slice(0, 8))).sha).toBe(D1);
  });

  it('adds a missing row for each listed spec the run did not report, and none when it reported no specs', async () => {
    await succeed('s1t2', D1);
    const passed = { spec: 'e2e/b.spec.ts', status: 'passed', tests: 3, failedTests: 0, durationMs: 10 } as const;
    const report = {
      repo: 'acme/app',
      sha: D1,
      environment: 'dev',
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
    const rows = await store.transaction((tx) => tx.listTestRunSpecs([first?.id ?? 0, second?.id ?? 0]));
    expect(rows.map((r) => [r.testRunId === first?.id, r.spec, r.status])).toEqual([
      [true, 'e2e/b.spec.ts', 'passed'],
      [true, 'e2e/c.spec.ts', 'missing'],
    ]);
  });

  it('attaches an environment run to the glob whose deploy put the commit there, and ignores one nobody deployed', async () => {
    await succeed('s1t1', D1);
    await succeed('s1t3', D2);
    const report = { repo: 'acme/app', environment: 'dev', branch: null, passed: 2, failed: 1, skipped: 0, url: null, at: null, specs: [] };
    expect(await service.recordAtf({ ...report, sha: D1, eventId: 'e1' })).toEqual([board.id]);
    // Without a commit it tested what the environment runs now.
    expect(await service.recordAtf({ ...report, sha: null, eventId: 'e2' })).toEqual([board.id]);
    expect(await service.recordAtf({ ...report, sha: 'eeeeeee5555', eventId: 'e3' })).toEqual([]);
    expect(await service.recordAtf({ ...report, environment: 'prod', sha: D1, eventId: 'e4' })).toEqual([]);
    expect(store.state.testRuns.map((r) => [r.globId, r.environment, r.sha])).toEqual([
      ['s1t1', 'dev', D1],
      ['s1t3', 'dev', D2],
    ]);
    const state = await service.boardState(board.id, ['s1t1', 's1t3']);
    expect(state.get('s1t1')).toMatchObject([{ scope: 'environment', environment: 'dev', sha: D1, failing: true }]);
    expect(state.get('s1t3')?.[0]).toMatchObject({ scope: 'environment', sha: D2 });
  });

  it('shows a run as an environment run only while the glob has a deploy of that commit there', () => {
    const run: testRuns.TestRun = {
      id: 1,
      boardId: 1,
      kind: 'atf',
      globId: 's1t1',
      environment: 'dev',
      sha: D1,
      passed: 1,
      failed: 0,
      skipped: 0,
      url: null,
      finishedAt: at(5),
      eventId: 'e',
      runnerId: null,
    };
    const g = { id: 's1t1', pr: null };
    expect(testRuns.atfIndicators(g, [run], [{ globId: 's1t1', environment: 'dev', sha: D1 }]).map((i) => i.scope)).toEqual(['environment']);
    expect(testRuns.atfIndicators(g, [run], []).map((i) => i.scope)).toEqual(['branch']);
    expect(testRuns.atfIndicators(g, [run], [{ globId: 's1t2', environment: 'dev', sha: D1 }]).map((i) => i.scope)).toEqual(['branch']);
  });

  it('computes missing rows for a list, and the pure helper skips reported specs', () => {
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

  it('queues no start_atf when a branch deploy succeeds, even for a push board (the int pipeline starts ATF)', async () => {
    await store.transaction(async (tx) => {
      const current = (await tx.getBoard(board.id)) ?? board;
      await tx.updateBoard({ ...current, atf: { provider: 'codebuild', region: 'us-east-1', project: 'atf', mode: 'push' } }, current.version);
    });
    store.state.outbox.length = 0;
    await succeed('s1t3', D2);
    expect(store.state.outbox.filter((e) => e.kind === 'start_atf')).toEqual([]);
  });
});
