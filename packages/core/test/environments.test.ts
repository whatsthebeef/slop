import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { EnvironmentService, recordedBy } from '../src/app/environment-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { humanSteps } from '../src/domain/human-steps.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import type { ReportedDeploy } from '../src/app/environment-service.js';
import * as environments from '../src/domain/environments.js';
import type { GlobPresence } from '../src/domain/environments.js';
import type { DomainEvent } from '../src/domain/events.js';
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

const presence = (patch: Partial<GlobPresence> = {}): GlobPresence => ({
  boardId: board.id,
  globId: 's1t1',
  environment: 'prod',
  mergeSha: 'm1',
  contained: true,
  checkedSha: 'old',
  checkedAt: NOW,
  since: '2026-10-01T00:00:00.000Z',
  ...patch,
});

const merged = (globId: string, sha: string, at = NOW): DomainEvent => ({ type: 'Merged', globId, actor: null, at, data: { sha } });

describe('environment rules', () => {
  const target = { boardId: board.id, environment: 'prod', sha: 'd2' };

  it('observes only environments with a role', () => {
    expect(environments.observedEnvironment(board, 'prod')?.name).toBe('prod');
    expect(environments.observedEnvironment(board, 'dev')).toBeNull();
    expect(environments.observedEnvironment(board, 'nowhere')).toBeNull();
  });

  it("takes each glob's latest merge commit", () => {
    const merges = environments.latestMerges([
      merged('s1f1', 'a'),
      merged('s1t2', 'b'),
      merged('s1f1', 'c'),
      { type: 'Merged', globId: 's1t3', actor: null, at: NOW, data: {} },
    ]);
    expect([...merges]).toEqual([
      ['s1f1', 'c'],
      ['s1t2', 'b'],
    ]);
  });

  it('logs Deployed when a glob enters an environment', () => {
    const change = environments.containmentChange([], [{ globId: 's1t1', mergeSha: 'm1', contained: true }], target, NOW);
    expect(change.moved).toEqual(['s1t1']);
    expect(change.events.map((e) => [e.type, e.data])).toEqual([
      ['Deployed', { environment: 'prod', sha: 'd2', mergeSha: 'm1', observed: true }],
    ]);
    expect(change.writes).toEqual([presence({ checkedSha: 'd2', since: NOW })]);
  });

  it('keeps an unchanged glob quiet but records the commit it was checked against', () => {
    const was = presence();
    const change = environments.containmentChange([was], [{ globId: 's1t1', mergeSha: 'm1', contained: true }], target, NOW);
    expect(change.events).toEqual([]);
    expect(change.moved).toEqual([]);
    expect(change.writes).toEqual([{ ...was, checkedSha: 'd2', checkedAt: NOW }]);
  });

  it('logs DeployRolledBack when an environment no longer holds a glob', () => {
    const change = environments.containmentChange([presence()], [{ globId: 's1t1', mergeSha: 'm1', contained: false }], target, NOW);
    expect(change.events.map((e) => e.type)).toEqual(['DeployRolledBack']);
    expect(change.writes[0]).toMatchObject({ contained: false, since: null, checkedSha: 'd2' });
  });

  it('records a glob not yet in the environment without an event', () => {
    const change = environments.containmentChange([], [{ globId: 's1t1', mergeSha: 'm1', contained: false }], target, NOW);
    expect(change.events).toEqual([]);
    expect(change.writes[0]).toMatchObject({ contained: false, since: null });
  });

  it('warns when production holds a glob before sign-off', () => {
    const presences = [presence(), presence({ environment: 'staging' }), presence({ environment: 'dev' })];
    const reviewing = environments.environmentIndicators(board, glob({ status: 'reviewing' }), presences);
    expect(reviewing.map((i) => [i.environment, i.role, i.warning])).toEqual([
      ['staging', 'integration', undefined],
      ['prod', 'release', 'before_sign_off'],
    ]);
    const signedOff = environments.environmentIndicators(board, glob({ status: 'signed_off' }), presences);
    expect(signedOff.find((i) => i.production)?.warning).toBeUndefined();
  });

  it('shows nothing for environments that no longer hold the glob', () => {
    expect(environments.environmentIndicators(board, glob(), [presence({ contained: false, since: null })])).toEqual([]);
  });
});

describe('EnvironmentService', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: EnvironmentService;
  let now = NOW;

  const report = (patch: Partial<ReportedDeploy> = {}): ReportedDeploy => ({
    repo: 'Acme/App',
    environment: 'prod',
    sha: 'd1',
    ref: 'release/1',
    succeeded: true,
    url: null,
    at: null,
    eventId: 'aws:e1',
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = NOW;
    service = new EnvironmentService({ store, notifier, clock: { now: () => now } });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      for (const id of ['s1t1', 's1t2', 's1t3']) await tx.insertGlob(glob({ id, status: 'reviewing' }), null);
    });
  });

  it('records a deploy once per event and queues the containment check', async () => {
    expect(await service.recordDeploy(report())).toEqual([board.id]);
    expect(await service.recordDeploy(report())).toEqual([]);
    expect(store.state.environmentDeploys).toHaveLength(1);
    expect(store.state.outbox).toEqual([
      { kind: 'check_environment', globId: `board-${String(board.id)}`, boardId: board.id, environment: 'prod', sha: 'd1' },
    ]);
  });

  it('ignores unknown repos and environments without a role', async () => {
    expect(await service.recordDeploy(report({ repo: 'acme/other' }))).toEqual([]);
    expect(await service.recordDeploy(report({ environment: 'dev', eventId: 'aws:e2' }))).toEqual([]);
    expect(store.state.environmentDeploys).toEqual([]);
    expect(store.state.outbox).toEqual([]);
  });

  it("records a failed deploy without checking, and doesn't check an older deploy reported late", async () => {
    await service.recordDeploy(report({ succeeded: false }));
    expect(store.state.outbox).toEqual([]);
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd2', at: '2026-10-05T11:00:00.000Z' }));
    await service.recordDeploy(report({ eventId: 'aws:e3', sha: 'd0', at: '2026-10-05T10:00:00.000Z' }));
    expect(store.state.outbox.map((e) => ('sha' in e ? e.sha : null))).toEqual(['d2']);
  });

  it('checks recent merges and globs the environment held, however old', async () => {
    await store.transaction(async (tx) => {
      await tx.appendEvents([merged('s1t1', 'm1', '2026-10-04T00:00:00.000Z'), merged('s1t2', 'm2', '2026-08-01T00:00:00.000Z')]);
      await tx.saveGlobPresence([presence({ globId: 's1t2', mergeSha: 'm2' }), presence({ globId: 's1t3', mergeSha: 'm3', contained: false, since: null })]);
    });
    await service.recordDeploy(report());
    expect(await service.candidates(board.id, 'prod', 'd1')).toEqual([
      { globId: 's1t1', mergeSha: 'm1' },
      { globId: 's1t2', mergeSha: 'm2' },
    ]);
    // Not what the environment runs now, or not observed: nothing to check.
    expect(await service.candidates(board.id, 'prod', 'd0')).toBeNull();
    expect(await service.candidates(board.id, 'dev', 'd1')).toBeNull();
  });

  it('stores containment, tells the board about globs that moved, and serves indicators', async () => {
    await service.recordDeploy(report());
    const recorded = await service.recordContainment(board.id, 'prod', 'd1', [
      { globId: 's1t1', mergeSha: 'm1', contained: true },
      { globId: 's1t2', mergeSha: 'm2', contained: false },
      { globId: 'gone', mergeSha: 'm9', contained: true },
    ]);
    expect(recorded).toBe('recorded');
    expect(notifier.hints).toEqual([{ kind: 'glob.deploys', boardId: board.id, globId: 's1t1' }]);
    expect(store.state.events.map((e) => [e.type, e.globId])).toEqual([['Deployed', 's1t1']]);
    const state = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect([...state.keys()]).toEqual(['s1t1']);
    expect(state.get('s1t1')).toEqual([
      { environment: 'prod', role: 'release', production: true, sha: 'd1', since: NOW, warning: 'before_sign_off' },
    ]);
  });

  it('drops a check when a newer deploy has been recorded since it started', async () => {
    await service.recordDeploy(report());
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd2', at: '2026-10-05T13:00:00.000Z' }));
    expect(await service.recordContainment(board.id, 'prod', 'd1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }])).toBe('stale');
    expect(store.state.globPresence.size).toBe(0);
  });

  it('stamps the deploy as checked once its containment is stored, and only then', async () => {
    await service.recordDeploy(report());
    expect((await store.transaction((tx) => tx.latestEnvironmentDeploy(board.id, 'prod')))?.checkedAt).toBeNull();
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd2', at: '2026-10-05T13:00:00.000Z' }));
    expect(await service.recordContainment(board.id, 'prod', 'd1', [])).toBe('stale');
    const stale = await store.transaction((tx) => tx.listEnvironmentDeploys(board.id, 'prod', 10));
    expect(stale.map((d) => [d.sha, d.checkedAt])).toEqual([['d2', null], ['d1', null]]);
    expect(await service.recordContainment(board.id, 'prod', 'd2', [{ globId: 's1t1', mergeSha: 'm1', contained: true }])).toBe('recorded');
    const after = await store.transaction((tx) => tx.listEnvironmentDeploys(board.id, 'prod', 10));
    expect(after.map((d) => [d.sha, d.checkedAt])).toEqual([['d2', NOW], ['d1', null]]);
  });

  it('rolls a glob out when a later deploy no longer contains it', async () => {
    await service.recordDeploy(report());
    await service.recordContainment(board.id, 'prod', 'd1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    now = '2026-10-05T14:00:00.000Z';
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd0' }));
    await service.recordContainment(board.id, 'prod', 'd0', [{ globId: 's1t1', mergeSha: 'm1', contained: false }]);
    expect(store.state.events.map((e) => e.type)).toEqual(['Deployed', 'DeployRolledBack']);
    expect((await service.boardState(board.id, ['s1t1'])).size).toBe(0);
  });

  it('brings a rolled-back glob back with Deployed when a later deploy contains it again (s15f10)', async () => {
    await service.recordDeploy(report());
    await service.recordContainment(board.id, 'prod', 'd1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    now = '2026-10-05T14:00:00.000Z';
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd0' }));
    await service.recordContainment(board.id, 'prod', 'd0', [{ globId: 's1t1', mergeSha: 'm1', contained: false }]);
    now = '2026-10-05T15:00:00.000Z';
    await service.recordDeploy(report({ eventId: 'aws:e3', sha: 'd3' }));
    await service.recordContainment(board.id, 'prod', 'd3', [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    expect(store.state.events.map((e) => e.type)).toEqual(['Deployed', 'DeployRolledBack', 'Deployed']);
    expect((await service.boardState(board.id, ['s1t1'])).get('s1t1')).toEqual([
      expect.objectContaining({ environment: 'prod', sha: 'd3', since: '2026-10-05T15:00:00.000Z' }),
    ]);
  });

  it("keeps a check current when the deploy after it failed: the environment still runs the last success (s15f10)", async () => {
    await service.recordDeploy(report());
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd2', succeeded: false, at: '2026-10-05T13:00:00.000Z' }));
    expect(store.state.outbox).toHaveLength(1);
    expect(await service.recordContainment(board.id, 'prod', 'd1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }])).toBe('recorded');
    expect(await service.candidates(board.id, 'prod', 'd2')).toBeNull();
  });

  it('lists the observed environments in the glob view to members only', async () => {
    await store.transaction((tx) => tx.upsertMember({ boardId: board.id, email: 'dev@example.com', role: 'dev' }));
    await service.recordDeploy(report());
    const view = await service.forGlob('dev@example.com', 's1t1');
    expect(view.ok && view.value.map((e) => [e.environment, e.presence, e.latest?.sha ?? null])).toEqual([
      ['staging', null, null],
      ['prod', null, 'd1'],
    ]);
    expect((await service.forGlob('stranger@example.com', 's1t1')).ok).toBe(false);
  });
});

describe('after-deploy steps fall due (s15f176)', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: EnvironmentService;
  let globs: GlobService;
  const DEV = 'dev@example.com';

  const step = (id: string, globId: string, patch: Partial<StoredHumanStep> = {}): StoredHumanStep => ({
    id,
    boardId: board.id,
    globId,
    kind: 'rollout',
    title: `Step ${id}`,
    detail: null,
    who: 'anyone',
    due: 'after_deploy:prod',
    state: 'open',
    blocks: [],
    check: null,
    script: null,
    why: null,
    permissions: null,
    commands: [],
    verify: null,
    origin: 'rollout-section',
    createdBy: DEV,
    createdAt: NOW,
    doneBy: null,
    doneAt: null,
    dismissedReason: null,
    dueSince: null,
    ...patch,
  });
  const read = (id: string) => store.transaction(async (tx) => (await tx.listHumanSteps(board.id, ['s1t1', 's1t2'])).find((s) => s.id === id) as StoredHumanStep);
  const contained = (globId: string, value: boolean) => [{ globId, mergeSha: 'm1', contained: value }];
  const deploy = async (sha: string, eventId: string) =>
    service.recordDeploy({ repo: 'Acme/App', environment: 'prod', sha, ref: null, succeeded: true, url: null, at: null, eventId });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    let n = 0;
    service = new EnvironmentService({ store, notifier, clock: { now: () => NOW } });
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `r${++n}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      for (const id of ['s1t1', 's1t2']) await tx.insertGlob(glob({ id, status: 'reviewing' }), null);
      await tx.saveHumanSteps([
        step('a', 's1t1'),
        step('b', 's1t1', { due: 'after_deploy:staging' }),
        step('c', 's1t1', { due: 'after_merge' }),
        step('d', 's1t2'),
      ]);
    });
  });

  it('a containment check marks only the steps of globs that newly enter that environment, for that environment', async () => {
    await deploy('d1', 'e1');
    await service.recordContainment(board.id, 'prod', 'd1', contained('s1t1', true));
    expect((await read('a')).dueSince).toBe(NOW);
    expect((await read('b')).dueSince).toBeNull();
    expect((await read('c')).dueSince).toBeNull();
    expect((await read('d')).dueSince).toBeNull();
    expect(notifier.hints).toContainEqual(expect.objectContaining({ kind: 'glob.changed', globId: 's1t1' }));
    const [g] = await store.transaction((tx) => tx.getGlobs(['s1t1']));
    expect(humanSteps(g as never, {}, [await read('a'), await read('b')]).map((s) => [s.title, s.state])).toEqual([['Step a', 'due'], ['Step b', 'pending']]);
  });

  it('is idempotent: a repeat check, or one that finds the glob already there, keeps the first moment', async () => {
    await deploy('d1', 'e1');
    await service.recordContainment(board.id, 'prod', 'd1', contained('s1t1', true));
    notifier.hints.length = 0;
    await deploy('d2', 'e2');
    await store.transaction((tx) => tx.saveHumanSteps([step('a', 's1t1', { dueSince: '2026-10-01T00:00:00.000Z' })]));
    await service.recordContainment(board.id, 'prod', 'd2', contained('s1t1', true));
    expect((await read('a')).dueSince).toBe('2026-10-01T00:00:00.000Z');
    expect(notifier.hints).toEqual([]);
  });

  it('a stale check marks nothing', async () => {
    await deploy('d1', 'e1');
    await deploy('d2', 'e2');
    expect(await service.recordContainment(board.id, 'prod', 'd1', contained('s1t1', true))).toBe('stale');
    expect((await read('a')).dueSince).toBeNull();
  });

  it('a rollback keeps the step due', async () => {
    await deploy('d1', 'e1');
    await service.recordContainment(board.id, 'prod', 'd1', contained('s1t1', true));
    await deploy('d0', 'e2');
    await service.recordContainment(board.id, 'prod', 'd0', contained('s1t1', false));
    expect(store.state.events.map((e) => e.type)).toEqual(['Deployed', 'DeployRolledBack']);
    expect((await read('a')).dueSince).toBe(NOW);
  });

  it('markEnvironmentDeployed makes the glob\'s steps for that environment due, once, and logs EnvironmentMarkedDeployed', async () => {
    const before = (await store.transaction((tx) => tx.getGlob('s1t1')))?.version;
    expect(await globs.markEnvironmentDeployed(DEV, 's1t1', 'prod')).toEqual({ ok: true, value: { marked: 1 } });
    expect((await read('a')).dueSince).toBe(NOW);
    expect((await read('b')).dueSince).toBeNull();
    expect((await read('d')).dueSince).toBeNull();
    expect(store.state.events.filter((e) => e.type === 'EnvironmentMarkedDeployed').map((e) => [e.globId, e.actor, e.data])).toEqual([['s1t1', DEV, { environment: 'prod', steps: 1 }]]);
    // It is not a deploy: no Deployed event, no presence, and the glob's version stays.
    expect(store.state.events.some((e) => e.type === 'Deployed')).toBe(false);
    expect(store.state.globPresence.size).toBe(0);
    expect((await store.transaction((tx) => tx.getGlob('s1t1')))?.version).toBe(before);
    // Again: nothing changes and nothing more is logged.
    expect(await globs.markEnvironmentDeployed(DEV, 's1t1', 'prod')).toEqual({ ok: true, value: { marked: 0 } });
    expect(store.state.events.filter((e) => e.type === 'EnvironmentMarkedDeployed')).toHaveLength(1);
  });

  it('markEnvironmentDeployed refuses an unknown environment, a stranger and an unknown glob', async () => {
    const unknown = await globs.markEnvironmentDeployed(DEV, 's1t1', 'nowhere');
    expect(!unknown.ok && unknown.error.code).toBe('invalid_input');
    const stranger = await globs.markEnvironmentDeployed('stranger@example.com', 's1t1', 'prod');
    expect(!stranger.ok && stranger.error.code).toBe('forbidden');
    const missing = await globs.markEnvironmentDeployed(DEV, 's1t99', 'prod');
    expect(!missing.ok && missing.error.code).toBe('not_found');
    expect(store.state.events.filter((e) => e.type === 'EnvironmentMarkedDeployed')).toEqual([]);
  });

  it('a step added after a mark is due at once; a mark with no steps yet is remembered', async () => {
    await globs.markEnvironmentDeployed(DEV, 's1t2', 'staging');
    const added = await globs.addHumanStep(DEV, 's1t2', null, { title: 'Later', due: 'after_deploy:staging' });
    expect(added.ok && added.value.dueSince).toBe(NOW);
    const other = await globs.addHumanStep(DEV, 's1t2', null, { title: 'Other env', due: 'after_deploy:prod' });
    expect(other.ok && other.value.dueSince).toBeNull();
    // A step added by hand for an after-deploy env holds nothing back by default.
    expect(added.ok && added.value.blocks).toEqual([]);
    const merge = await globs.addHumanStep(DEV, 's1t2', null, { title: 'Now' });
    expect(merge.ok && merge.value.blocks).toEqual(['sign_off', 'dependants']);
  });
});

describe('environments whose deploys are recorded by hand (s15t239)', () => {
  const DEV = 'dev@example.com';
  const manualBoard: Board = {
    ...board,
    environments: [
      { name: 'staging', allowBranchDeploy: false, role: 'integration' },
      { name: 'prod', allowBranchDeploy: false, role: 'release', production: true, deployKnown: 'manual' },
    ],
  };
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: EnvironmentService;
  let globs: GlobService;

  const rolloutStep = (): StoredHumanStep => ({
    id: 'a',
    boardId: board.id,
    globId: 's1t1',
    kind: 'rollout',
    title: 'Arm prod',
    detail: null,
    who: 'anyone',
    due: 'after_deploy:prod',
    state: 'open',
    blocks: [],
    check: null,
    script: null,
    why: null,
    permissions: null,
    commands: [],
    verify: null,
    origin: 'rollout-section',
    createdBy: DEV,
    createdAt: NOW,
    doneBy: null,
    doneAt: null,
    dismissedReason: null,
    dueSince: null,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    service = new EnvironmentService({ store, notifier, clock: { now: () => NOW } });
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => 'r1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...manualBoard, environments: [...manualBoard.environments], sensitivePaths: [] });
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      await tx.insertGlob(glob({ id: 's1t1', status: 'reviewing' }), null);
      await tx.saveHumanSteps([rolloutStep()]);
    });
  });

  it('records a deploy like a reported one: once, with who, queueing the containment check', async () => {
    const recorded = await service.recordManualDeploy(DEV, board.id, 'prod', { sha: 'r1', ref: 'v1.2' });
    expect(recorded.ok && [recorded.value.sha, recorded.value.ref, recorded.value.succeeded, recorded.value.at]).toEqual(['r1', 'v1.2', true, NOW]);
    expect(store.state.outbox).toEqual([{ kind: 'check_environment', globId: `board-${String(board.id)}`, boardId: board.id, environment: 'prod', sha: 'r1' }]);
    const view = await service.forBoard(DEV, board.id);
    expect(view.ok && view.value.map((e) => [e.environment, e.deployKnown, e.latest?.sha ?? null, e.recordedBy])).toEqual([
      ['staging', 'pipeline', null, null],
      ['prod', 'manual', 'r1', DEV],
    ]);
  });

  it('puts the environment on the contained globs and makes their after-deploy steps due, with no per-glob mark', async () => {
    await service.recordManualDeploy(DEV, board.id, 'prod', { sha: 'r1', ref: null });
    await service.recordContainment(board.id, 'prod', 'r1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    const step = await store.transaction(async (tx) => (await tx.listHumanSteps(board.id, ['s1t1']))[0]);
    expect(step?.dueSince).toBe(NOW);
    const state = await service.boardState(board.id, ['s1t1']);
    expect(state.get('s1t1')?.map((i) => i.environment)).toEqual(['prod']);
  });

  it('keeps the per-glob Mark deployed for one-offs', async () => {
    const marked = await globs.markEnvironmentDeployed(DEV, 's1t1', 'prod');
    expect(marked.ok && marked.value.marked).toBe(1);
  });

  it('refuses a stranger, an environment a pipeline reports, an unobserved one and an unknown one', async () => {
    const code = async (who: string, env: string) => {
      const r = await service.recordManualDeploy(who, board.id, env, { sha: 'r1', ref: null });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(await code('stranger@example.com', 'prod')).toBe('forbidden');
    expect(await code(DEV, 'staging')).toBe('invalid_input');
    expect(await code(DEV, 'nowhere')).toBe('invalid_input');
    expect(store.state.environmentDeploys).toHaveLength(0);
  });

  it('says a pipeline environment has never reported, and a manual one has nothing recorded', async () => {
    const view = await service.forBoard(DEV, board.id);
    expect(view.ok && view.value.map((e) => [e.deployKnown, e.latest])).toEqual([['pipeline', null], ['manual', null]]);
    expect((await service.forBoard('stranger@example.com', board.id)).ok).toBe(false);
  });

  it('keeps the recorder out of a pipeline deploy', () => {
    const deploy = { id: 1, boardId: 1, environment: 'prod', sha: 'a', ref: null, succeeded: true, url: null, at: NOW, eventId: 'aws:e1', checkedAt: null };
    expect(recordedBy(deploy)).toBeNull();
    expect(recordedBy({ ...deploy, eventId: 'person:a.b@example.com:1760572800000.abc' })).toBe('a.b@example.com');
  });
});

describe('board settings: how an environment\'s deploys are known (s15t239)', () => {
  const admin = 'admin@example.com';
  it('stores manual on an environment with a role and refuses it on one without', async () => {
    const store = new MemoryStore();
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    await store.transaction((tx) => tx.upsertUser({ email: admin, name: admin, active: true }));
    const created = await boards.create(admin, { name: 'b', repo: null, timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error('create failed');
    const without = await boards.updateSettings(admin, created.value.id, created.value.version, {
      environments: [{ name: 'prod', allowBranchDeploy: false, deployKnown: 'manual' }],
    });
    expect(without.ok).toBe(false);
    const environments = [{ name: 'prod', allowBranchDeploy: false, role: 'release', deployKnown: 'manual' } as const];
    const saved = await boards.updateSettings(admin, created.value.id, created.value.version, { environments });
    expect(saved.ok && saved.value.environments).toEqual(environments);
  });
});
