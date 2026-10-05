import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DeployService } from '../src/app/deploy-service.js';
import * as deploys from '../src/domain/deploys.js';
import type { Deploy } from '../src/domain/deploys.js';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, ctx, dev, glob } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const deploy = (patch: Partial<Deploy> = {}): Deploy => ({
  id: 'd1',
  boardId: board.id,
  environment: 'dev',
  globId: 's1t1',
  sha: 'aaa',
  state: 'waiting',
  trigger: 'push',
  requestedBy: null,
  requestedAt: NOW,
  startedAt: null,
  finishedAt: null,
  providerRef: null,
  url: null,
  error: null,
  ...patch,
});

describe('deploy rules', () => {
  it('starts a request at once when nothing runs in the environment', () => {
    const change = deploys.request([], deploy(), NOW);
    expect(change.writes.map((d) => d.state)).toEqual(['running']);
    expect(change.effects).toEqual([{ kind: 'start_deploy', deployId: 'd1', globId: 's1t1' }]);
  });

  it('keeps one waiting slot: a new request replaces the waiting one', () => {
    const running = deploy({ id: 'd1', state: 'running' });
    const waiting = deploy({ id: 'd2', globId: 's1t2', state: 'waiting' });
    const change = deploys.request([running, waiting], deploy({ id: 'd3', globId: 's1t3' }), NOW);
    expect(change.writes.map((d) => [d.id, d.state])).toEqual([
      ['d2', 'replaced'],
      ['d3', 'waiting'],
    ]);
    expect(change.effects).toEqual([]);
    expect(change.events.map((e) => e.type)).toEqual(['DeployReplaced', 'DeployRequested']);
  });

  it('starts the waiting deploy when the running one finishes', () => {
    const running = deploy({ id: 'd1', state: 'running', startedAt: NOW });
    const waiting = deploy({ id: 'd2', globId: 's1t2', state: 'waiting' });
    const change = deploys.finished([running, waiting], running, { succeeded: true, error: null }, NOW);
    expect(change.writes.map((d) => [d.id, d.state])).toEqual([
      ['d1', 'succeeded'],
      ['d2', 'running'],
    ]);
    expect(change.events.map((e) => e.type)).toEqual(['Deployed']);
    expect(change.effects).toEqual([{ kind: 'start_deploy', deployId: 'd2', globId: 's1t2' }]);
  });

  it('records a failure with its error and ignores repeated results', () => {
    const running = deploy({ state: 'running' });
    const change = deploys.finished([running], running, { succeeded: false, error: 'exit 1' }, NOW);
    expect(change.writes[0]).toMatchObject({ state: 'failed', error: 'exit 1' });
    expect(change.events[0]?.type).toBe('DeployFailed');
    const failed = change.writes[0] ?? running;
    expect(deploys.finished([], failed, { succeeded: true, error: null }, NOW).writes).toEqual([]);
  });

  it('records the start once', () => {
    const running = deploy({ state: 'running' });
    const change = deploys.started(running, { providerRef: 'build:1', url: null }, NOW);
    expect(change.writes[0]).toMatchObject({ startedAt: NOW, providerRef: 'build:1' });
    expect(deploys.started(change.writes[0] ?? running, { providerRef: 'build:2', url: null }, NOW).writes).toEqual([]);
  });

  it('shows deploying, live, failed and replaced on the card', () => {
    const ok = deploy({ state: 'succeeded', sha: 'bbb' });
    expect(deploys.indicatorFor(deploy({ state: 'waiting' }), null)).toMatchObject({ state: 'deploying', waiting: true });
    expect(deploys.indicatorFor(ok, ok)).toEqual({ state: 'live', environment: 'dev', sha: 'bbb' });
    expect(deploys.indicatorFor(deploy({ state: 'failed', error: 'x' }), ok)).toMatchObject({ state: 'failed' });
    expect(deploys.indicatorFor(ok, deploy({ id: 'd9', globId: 's1t9', state: 'succeeded' }))).toEqual({
      state: 'replaced',
      environment: 'dev',
      by: 's1t9',
    });
    expect(deploys.indicatorFor(null, ok)).toBeNull();
  });

  it('says why a glob cannot deploy', () => {
    expect(deploys.deployBlocked(board, null)).toMatch(/no environment/);
    expect(deploys.deployBlocked(board, 'prod')).toMatch(/doesn't take branch deploys/);
    expect(deploys.deployBlocked(board, 'qa')).toMatch(/no environment qa/);
    expect(deploys.deployBlocked({ ...board, deploy: null }, 'dev')).toMatch(/no deploy integration/);
    expect(deploys.deployBlocked(board, 'dev')).toBeNull();
  });
});

describe('stale and blocked deploys', () => {
  const minutes = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();

  it('gives up on a deploy that never started, or whose result never came', () => {
    expect(deploys.staleReason(deploy({ state: 'running' }), minutes(9))).toBeNull();
    expect(deploys.staleReason(deploy({ state: 'running' }), minutes(10))).toMatch(/didn't start within 10 minutes/);
    const started = deploy({ state: 'running', startedAt: NOW });
    expect(deploys.staleReason(started, minutes(59))).toBeNull();
    expect(deploys.staleReason(started, minutes(60))).toMatch(/No result .* after 60 minutes/);
    expect(deploys.staleReason(deploy({ state: 'waiting' }), minutes(600))).toBeNull();
  });

  it('refuses to start a deploy whose environment changed while it waited', () => {
    const d = deploy({ environment: 'dev' });
    expect(deploys.startBlocked(board, d, 'dev')).toBeNull();
    expect(deploys.startBlocked({ ...board, environments: [{ name: 'dev', allowBranchDeploy: false }] }, d, 'dev')).toMatch(
      /doesn't take branch deploys/,
    );
    expect(deploys.startBlocked(board, d, 'qa')).toMatch(/moved to qa while this deploy waited/);
  });
});

describe('pushes request deploys', () => {
  const push = (patch: Parameters<typeof glob>[0], p: Parameters<typeof m.commitPushed>[1]) => {
    const t = m.commitPushed(glob({ status: 'in_progress', type: 'super', ...patch }), p, ctx(null));
    if (!t.ok) throw new Error(t.error.message);
    return t.value.effects.filter((e) => e.kind === 'request_deploy');
  };

  it('asks for a deploy of exactly the pushed commit when the glob has an environment', () => {
    expect(push({ environment: 'dev' }, { sha: 'ccc', runId: null, message: 'wip' })).toEqual([
      { kind: 'request_deploy', globId: 's1t1', generation: 1, sha: 'ccc' },
    ]);
  });

  it('not without an environment, for the start commit, or from a superseded run', () => {
    expect(push({ environment: null }, { sha: 'ccc', runId: null })).toEqual([]);
    expect(push({ environment: 'dev' }, { sha: 'ccc', runId: null, message: 's1t1: start' })).toEqual([]);
    expect(push({ environment: 'dev' }, { sha: 'ccc', runId: 'run-0' })).toEqual([]);
  });
});

describe('DeployService', () => {
  const MEMBER = dev.email;
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: DeployService;
  let n: number;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    n = 0;
    service = new DeployService({ store, notifier, clock: { now: () => NOW }, newDeployId: () => `d${++n}` });
    store.state.boards.set(board.id, board);
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: MEMBER, name: MEMBER, active: true });
      await tx.upsertMember({ boardId: board.id, email: MEMBER, role: 'po' });
      for (const id of ['s1t1', 's1t2', 's1t3']) {
        await tx.insertGlob(
          glob({ id, environment: 'dev', status: 'in_progress', pr: { number: 1, state: 'draft', headSha: `${id}-head` } }),
          null,
        );
      }
    });
  });

  it('runs one deploy per environment and keeps the newest waiting', async () => {
    unwrap(await service.requestFromPush('s1t1', 'a1'));
    unwrap(await service.requestFromPush('s1t2', 'b1'));
    unwrap(await service.requestFromPush('s1t3', 'c1'));
    const states = [...store.state.deploys.values()].map((d) => [d.globId, d.state]);
    expect(states).toEqual([
      ['s1t1', 'running'],
      ['s1t2', 'replaced'],
      ['s1t3', 'waiting'],
    ]);
    expect(store.state.outbox.filter((e) => e.kind === 'start_deploy')).toHaveLength(1);
    expect(notifier.hints).toContainEqual({ kind: 'glob.deploys', boardId: board.id, globId: 's1t2' });
  });

  it('does not request the same pushed commit twice (outbox retries)', async () => {
    unwrap(await service.requestFromPush('s1t1', 'a1'));
    expect(unwrap(await service.requestFromPush('s1t1', 'a1'))).toBeNull();
    expect(store.state.deploys.size).toBe(1);
  });

  it('starts the waiting deploy after a result, and shows live and replaced', async () => {
    unwrap(await service.requestFromPush('s1t1', 'a1'));
    unwrap(await service.requestFromPush('s1t2', 'b1'));
    unwrap(await service.started('d1', { providerRef: 'build:1', url: null }));
    unwrap(await service.finishedByProviderRef('build:1', { succeeded: true, error: null }));
    expect(store.state.deploys.get('d2')?.state).toBe('running');
    unwrap(await service.finished('d2', { succeeded: true, error: null }));
    const { indicators, running } = await service.boardState(board.id, ['s1t1', 's1t2']);
    expect(indicators.get('s1t2')).toMatchObject({ state: 'live' });
    expect(indicators.get('s1t1')).toEqual({ state: 'replaced', environment: 'dev', by: 's1t2' });
    expect(running.size).toBe(0);
  });

  it('sweeps stale running deploys and starts the waiting one', async () => {
    unwrap(await service.requestFromPush('s1t1', 'a1'));
    unwrap(await service.requestFromPush('s1t2', 'b1'));
    expect(await service.sweep(new Date(Date.parse(NOW) + 5 * 60_000).toISOString())).toBe(0);
    expect(await service.sweep(new Date(Date.parse(NOW) + 11 * 60_000).toISOString())).toBe(1);
    expect(store.state.deploys.get('d1')?.state).toBe('failed');
    expect(store.state.deploys.get('d1')?.error).toMatch(/didn't start/);
    expect(store.state.deploys.get('d2')?.state).toBe('running');
  });

  it("shows a glob's history to board members only", async () => {
    unwrap(await service.requestFromPush('s1t1', 'a1'));
    expect(unwrap(await service.history(MEMBER, 's1t1'))).toHaveLength(1);
    expect((await service.history('stranger@example.com', 's1t1')).ok).toBe(false);
  });

  it('ignores provider results for builds slop did not start', async () => {
    expect(unwrap(await service.finishedByProviderRef('other-build', { succeeded: true, error: null }))).toBeNull();
  });

  it('lets any board member deploy now, at the PR head, except while one runs there', async () => {
    const d = unwrap(await service.deployNow(MEMBER, 's1t1'));
    expect(d).toMatchObject({ sha: 's1t1-head', trigger: 'deploy_now', requestedBy: MEMBER, state: 'running' });
    const refused = await service.deployNow(MEMBER, 's1t2');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/A deploy of s1t1 is running in dev/);
    const { running } = await service.boardState(board.id, []);
    expect([...running]).toEqual(['dev']);
  });

  it('refuses Deploy now to people outside the board and globs that cannot deploy', async () => {
    expect((await service.deployNow('stranger@example.com', 's1t1')).ok).toBe(false);
    store.state.boards.set(board.id, { ...board, deploy: null });
    const refused = await service.deployNow(MEMBER, 's1t1');
    expect(refused.ok).toBe(false);
    expect(unwrap(await service.requestFromPush('s1t1', 'a1'))).toBeNull();
  });
});

describe('board deploy settings', () => {
  it('stores a deploy integration and refuses incomplete ones', async () => {
    const store = new MemoryStore();
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    const admin = 'admin@example.com';
    await store.transaction((tx) => tx.upsertUser({ email: admin, name: admin, active: true }));
    const created = unwrap(
      await boards.create(admin, { name: 'sandbox', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    );
    expect(created.deploy).toBeNull();
    const incomplete = await boards.updateSettings(admin, created.id, created.version, {
      deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: ' ', projects: {} },
    });
    expect(incomplete.ok).toBe(false);
    const deploy = { provider: 'codebuild', region: 'us-east-1', defaultProject: 'sandbox-deploy', projects: {} } as const;
    expect(unwrap(await boards.updateSettings(admin, created.id, created.version, { deploy })).deploy).toEqual(deploy);
  });
});
