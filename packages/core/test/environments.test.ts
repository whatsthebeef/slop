import { beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentService } from '../src/app/environment-service.js';
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

  it('rolls a glob out when a later deploy no longer contains it', async () => {
    await service.recordDeploy(report());
    await service.recordContainment(board.id, 'prod', 'd1', [{ globId: 's1t1', mergeSha: 'm1', contained: true }]);
    now = '2026-10-05T14:00:00.000Z';
    await service.recordDeploy(report({ eventId: 'aws:e2', sha: 'd0' }));
    await service.recordContainment(board.id, 'prod', 'd0', [{ globId: 's1t1', mergeSha: 'm1', contained: false }]);
    expect(store.state.events.map((e) => e.type)).toEqual(['Deployed', 'DeployRolledBack']);
    expect((await service.boardState(board.id, ['s1t1'])).size).toBe(0);
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
