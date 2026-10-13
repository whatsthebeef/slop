import { describe, expect, it } from 'vitest';
import { humanSteps } from '../src/domain/human-steps.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import { machineSteps } from '../src/domain/machine-steps.js';
import type { MachineFacts } from '../src/domain/machine-steps.js';
import { stalledNotification, stalledSource } from '../src/domain/notifications.js';
import { unstickStep, whoseMove, withUnstick } from '../src/domain/whose-move.js';
import type { UnstickOptions } from '../src/domain/whose-move.js';
import type { Move } from '../src/domain/whose-move.js';
import type { Glob } from '../src/domain/types.js';
import type { DependencyState } from '../src/domain/waiting.js';
import { NOW, dev, glob, other, run } from './fixtures.js';

const minutesAgo = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();
const head = 'a2a88c8aaaa';
const viewer = { email: dev.email, role: dev.role };

const move = (g: Glob, facts: MachineFacts = {}, opts: { viewer?: typeof viewer; deps?: Map<string, DependencyState>; stored?: StoredHumanStep[] } = {}): Move =>
  whoseMove(g, humanSteps(g, {}, opts.stored ?? []), machineSteps(g, facts), opts.deps ?? new Map(), NOW, { ...('viewer' in opts ? (opts.viewer === undefined ? {} : { viewer: opts.viewer }) : { viewer }) });

const ready = (patch: Partial<Glob> = {}) =>
  glob({ status: 'pr_open', pr: { number: 49, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, implementer: dev.email, ...patch });

describe('whoseMove: priority', () => {
  it('you: a due step for the viewer; human: the same step for someone else', () => {
    expect(move(ready())).toMatchObject({ holder: 'you', reason: 'Merge', who: dev.email });
    expect(move(ready(), {}, { viewer: { email: other.email, role: 'dev' } })).toMatchObject({ holder: 'you', reason: 'Merge' });
    const pair = glob({ type: 'super', status: 'planning' });
    expect(move(pair)).toMatchObject({ holder: 'you' });
    const conflict = ready({ conflict: { base: 'main', files: [], since: null, at: NOW } });
    expect(move(conflict, {}, { viewer: { email: other.email, role: 'dev' } })).toMatchObject({ holder: 'human', reason: 'Resolve conflict', who: dev.email });
    expect(move(conflict, {}, { viewer: undefined })).toMatchObject({ holder: 'human' });
  });

  it('waiting, not stalled: checks failing the same way as a red base', () => {
    const inherited = {
      sha: head,
      state: 'failed' as const,
      failure: { name: 'Check', step: 'Test', lines: ['FAIL a > b'], url: null },
      inheritedFrom: { base: 'main', since: 's1t1' },
    };
    const g = glob({ status: 'pr_open', type: 'sub', pr: { number: 49, state: 'ready', headSha: head }, headChecks: inherited, implementer: null, runs: [] });
    expect(move(g, {}, { viewer: undefined })).toMatchObject({ holder: 'waiting', reason: 'main is red' });
  });

  it('you beats machine: a due step wins while a run works', () => {
    expect(move(ready({ runs: [run({ state: 'watching' })] }))).toMatchObject({ holder: 'you' });
    const working = glob({ type: 'super', status: 'planning', runs: [run({ purpose: 'investigate' })] });
    expect(move(working).holder).toBe('you');
  });

  it('machine: a step holding the ball that is alive', () => {
    const g = glob({ status: 'in_progress', implementer: null, runs: [run({ lastProgressAt: minutesAgo(5) })] });
    expect(move(g)).toMatchObject({ holder: 'machine', reason: 'implement', since: minutesAgo(5) });
  });

  it('machine beats waiting: a run and checks together', () => {
    const g = glob({ status: 'pr_open', runs: [run()], headChecks: { sha: 'a', state: 'pending' } });
    expect(move(g).holder).toBe('machine');
  });

  it('waiting: checks and deploys, never machine', () => {
    const checking = glob({ status: 'pr_open', headChecks: { sha: 'abc1234def', state: 'pending' } });
    expect(move(checking)).toMatchObject({ holder: 'waiting', reason: 'checks running on abc1234', waitingOn: ['checks'] });
    const deploy = { id: 'd', environment: 'staging', sha: 'a', state: 'running' as const, requestedAt: NOW, runningSince: NOW, url: null };
    expect(move(glob({ status: 'reviewing' }), { deploys: [deploy] })).toMatchObject({ holder: 'waiting', reason: 'deploying to staging' });
  });

  it('waiting: a Planning glob whose needs have not merged, and an upload slop has not seen', () => {
    const held = glob({ status: 'planning', after: ['s1t9'], waiting: { since: NOW } });
    expect(move(held, {}, { deps: new Map([['s1t9', 'open']]) })).toMatchObject({ holder: 'waiting', reason: 'waiting on s1t9', waitingOn: ['s1t9'] });
    expect(move(held, {}, { deps: new Map([['s1t9', 'merged']]) }).holder).toBe('idle');
    expect(move(glob({ status: 'in_progress', implementer: dev.email }), { pendingUploads: [{ key: 'k', fileName: 'a.png', since: NOW }] })).toMatchObject({ holder: 'waiting' });
  });

  it('waiting: only a rollout step still pending after the merge', () => {
    const rollout: StoredHumanStep = {
      id: 'hs-1', boardId: 1, globId: 's1t1', kind: 'rollout', title: 'Deploy the host stack', detail: null, who: 'admin', due: 'after_merge',
      state: 'open', blocks: ['sign_off'], check: null, script: null, origin: 'rollout-section', createdBy: dev.email, createdAt: NOW,
      doneBy: null, doneAt: null, dismissedReason: null,
    };
    const g = glob({ status: 'pr_open', type: 'sub', runs: [], pr: { number: 1, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' } });
    expect(move(g, {}, { stored: [rollout] })).toMatchObject({ holder: 'waiting', reason: 'waiting for Deploy the host stack' });
  });

  it('a person by state alone: review asked for, an escalation', () => {
    const reviewing = glob({ status: 'reviewing', implementer: dev.email, labels: { QA: 'required' } });
    expect(move(reviewing)).toMatchObject({ holder: 'you', reason: 'Review needed' });
    expect(move(reviewing, {}, { viewer: { email: other.email, role: 'dev' } })).toMatchObject({ holder: 'human', who: dev.email });
    const escalated = glob({ status: 'implementing', type: 'same', runs: [], escalation: { reason: 'touches auth', by: dev.email, at: NOW } });
    expect(move(escalated).reason).toBe('Needs a human: touches auth');
  });

  it('an escalation never outranks the machine: failed checks with a watching run, or a run working', () => {
    const escalation = { reason: 'touches auth', by: dev.email, at: NOW };
    const failedChecks = { sha: head, state: 'failed' as const, at: NOW };
    const fixing = ready({ type: 'same', escalation, headChecks: failedChecks, runs: [run({ state: 'watching' })] });
    expect(move(fixing)).toMatchObject({ holder: 'machine', reason: 'fix checks' });
    const working = glob({ status: 'implementing', type: 'same', escalation, runs: [run()] });
    expect(move(working).holder).toBe('machine');
    // with nothing on it, the escalation is still the person's turn, ahead of the open-PR next steps
    expect(move(ready({ type: 'same', escalation, headChecks: failedChecks }))).toMatchObject({ holder: 'you', reason: 'Needs a human: touches auth' });
    const conflict = { base: 'main', files: [], since: null, at: NOW };
    expect(move(ready({ type: 'same', escalation, conflict, implementer: null }))).toMatchObject({ reason: 'Needs a human: touches auth' });
    expect(move(ready({ type: 'sub', escalation, implementer: null }))).toMatchObject({ reason: 'Needs a human: touches auth' });
    expect(move(glob({ status: 'implementing', type: 'same', runs: [], escalation }))).toMatchObject({ holder: 'you', reason: 'Needs a human: touches auth' });
  });

  it('done and idle show nothing', () => {
    expect(move(glob({ status: 'signed_off', signedOffAt: NOW })).holder).toBe('done');
    expect(move(glob({ status: 'planning' })).holder).toBe('idle');
    expect(move(glob({ status: 'planning', runs: [run({ state: 'ended', outcome: 'completed' })] })).holder).toBe('idle');
  });
});

describe('whoseMove: stalled', () => {
  it('nothing applies while the glob is not finished', () => {
    const g = glob({ status: 'in_progress', type: 'sub', updatedAt: minutesAgo(3) });
    expect(move(g)).toMatchObject({ holder: 'stalled', cause: 'nobody', reason: 'nobody is on this' });
    expect(move(glob({ status: 'pr_open', type: 'sub', headChecks: { sha: 'a', state: 'passed' } })).holder).toBe('stalled');
  });

  it('a watcher left on a failed glob: standby holds nothing', () => {
    const g = glob({ status: 'failed', failure: { reason: 'run gave up', at: NOW }, runs: [run({ state: 'watching' })] });
    expect(move(g)).toMatchObject({ holder: 'stalled', cause: 'failed', reason: 'run gave up' });
    const watcher = glob({ status: 'pr_open', type: 'sub', runs: [run({ state: 'watching' })], headChecks: { sha: 'a', state: 'passed' } });
    expect(move(watcher).holder).toBe('stalled');
  });

  it('a machine step quiet past its threshold stalls the glob; just inside it does not', () => {
    const working = (n: number) => glob({ status: 'in_progress', runs: [run({ startedAt: minutesAgo(300), lastProgressAt: minutesAgo(n) })] });
    expect(move(working(44)).holder).toBe('machine');
    expect(move(working(50))).toMatchObject({ holder: 'stalled', cause: 'quiet', minutes: 50 });
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null, queuedAt: minutesAgo(25), lastProgressAt: null })] });
    expect(move(queued)).toMatchObject({ holder: 'stalled', cause: 'queued', reason: 'queued for 25 min' });
  });

  it('gives each stall a short label from its cause, and keeps the long reason', () => {
    const conflict = glob({
      status: 'failed',
      failure: { reason: 'Merge conflict with main in apps/web/src/a.ts, apps/web/src/b.ts', at: NOW, kind: 'merge', conflict: { base: 'main', files: ['apps/web/src/a.ts', 'apps/web/src/b.ts'] } },
    });
    expect(move(conflict)).toMatchObject({ holder: 'stalled', label: 'stalled · merge conflict', reason: 'merge conflict' });
    expect(move(glob({ status: 'failed', failure: { reason: 'run gave up', at: NOW } })).label).toBe('stalled · run failed');
    expect(move(glob({ status: 'failed', failure: { reason: 'needs a call', at: NOW, kind: 'needs_pairing', decision: 'CSV or report?' } })).label).toBe('stalled · needs your decision');
    const checks = glob({ status: 'failed', failure: { reason: 'run gave up', at: NOW }, headChecks: { sha: 'a', state: 'failed' } });
    expect(move(checks).label).toBe('stalled · checks failed');
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null, queuedAt: minutesAgo(25), lastProgressAt: null })] });
    expect(move(queued).label).toBe('stalled · queued 25 min');
    const quiet = glob({ status: 'in_progress', runs: [run({ startedAt: minutesAgo(300), lastProgressAt: minutesAgo(50) })] });
    expect(move(quiet).label).toBe('stalled · no progress 50 min');
    expect(move(glob({ status: 'in_progress', type: 'sub', updatedAt: minutesAgo(3) })).label).toBe('stalled · nobody on it');
  });

  it('a stale step does not hide a live one', () => {
    const g = glob({ status: 'in_progress', runs: [run({ lastProgressAt: minutesAgo(300) })] });
    const live = { effects: [{ kind: 'review_change', state: 'running' as const, since: minutesAgo(1) }] };
    expect(move(g).holder).toBe('stalled');
    expect(move(g, live).holder).toBe('machine');
  });

  it('a person who picked it up is on it for a while, then nobody is', () => {
    const picked = (n: number) => glob({ status: 'implementing', implementer: dev.email, updatedAt: minutesAgo(n) });
    expect(move(picked(5), {}, { viewer: undefined })).toMatchObject({ holder: 'human', who: dev.email });
    expect(move(picked(40))).toMatchObject({ holder: 'stalled', cause: 'nobody', minutes: 40 });
  });

  it('a failed provision or a failed effect stalls', () => {
    expect(move(glob({ status: 'planning', provisioning: 'failed' })).holder).toBe('stalled');
    expect(move(glob({ status: 'reviewing', labels: {} }), { effects: [{ kind: 'commit_agent_set', state: 'failed', since: NOW }] }).holder).toBe('stalled');
  });

  it('with incomplete facts, a glob nobody is on is idle, while failures and quiet runs still stall', () => {
    const partial = (g: Glob): Move => whoseMove(g, humanSteps(g, {}, []), machineSteps(g, {}), new Map(), NOW, { viewer, complete: false });
    expect(partial(glob({ status: 'in_progress', type: 'sub', updatedAt: minutesAgo(3) }))).toMatchObject({ holder: 'idle', reason: 'Not enough facts to say' });
    expect(partial(glob({ status: 'implementing', implementer: dev.email, updatedAt: minutesAgo(90) })).holder).toBe('idle');
    expect(partial(glob({ status: 'failed', failure: { reason: 'run gave up', at: NOW } }))).toMatchObject({ holder: 'stalled', cause: 'failed' });
    const quiet = glob({ status: 'in_progress', runs: [run({ startedAt: minutesAgo(300), lastProgressAt: minutesAgo(90) })] });
    expect(partial(quiet)).toMatchObject({ holder: 'stalled', cause: 'quiet' });
  });

  it('a due human step beats a stall', () => {
    expect(move(ready({ failure: null, runs: [run({ state: 'watching' })] })).holder).toBe('you');
  });
});

describe('stall hand-off', () => {
  const stalledGlob = (patch: Partial<Glob> = {}) => glob({ status: 'in_progress', implementer: dev.email, updatedAt: minutesAgo(60), ...patch });

  it('adds an unstick step titled by its one action, with the cause as detail', () => {
    const step = (g: Glob, options: UnstickOptions = {}) => unstickStep(move(g), g, options);
    const failed = glob({ status: 'failed', failure: { reason: 'x', at: NOW } });
    expect(step(failed)).toMatchObject({ title: 'Retry', action: 'retrigger', alternative: 'pick_up' });
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null, queuedAt: minutesAgo(25), lastProgressAt: null })] });
    expect(step(queued)).toMatchObject({ title: 'Open session', action: 'open_session', alternative: 'pick_up' });
    expect(step(queued)?.detail).toContain('25 min');
    const quiet = glob({ status: 'in_progress', runs: [run({ lastProgressAt: minutesAgo(60) })] });
    expect(step(quiet)).toMatchObject({ title: 'Open session', action: 'open_session' });
    const nobody = glob({ status: 'in_progress', implementer: null, updatedAt: minutesAgo(1) });
    expect(step(nobody)).toMatchObject({ title: 'Start', action: 'start', alternative: 'pick_up', detail: 'nobody is on this' });
  });

  it('a person who is the implementer is offered Pick up, or Start for a hand-over', () => {
    const g = stalledGlob({ updatedAt: minutesAgo(60) });
    expect(unstickStep(move(g), g)).toMatchObject({ title: 'Pick up', action: 'pick_up', alternative: 'start_anyway' });
    const failed = glob({ status: 'failed', implementer: dev.email, failure: { reason: 'x', at: NOW } });
    const step = unstickStep(move(failed), failed);
    expect(step).toMatchObject({ title: 'Pick up', action: 'pick_up' });
    expect(step?.alternative).toBeUndefined();
  });

  it('uses only allowed actions: the alternative takes over, and with neither there is no step', () => {
    const failed = glob({ status: 'failed', failure: { reason: 'x', at: NOW } });
    expect(unstickStep(move(failed), failed, { allowed: ['pick_up'] })).toMatchObject({ action: 'pick_up' });
    expect(unstickStep(move(failed), failed, { allowed: ['retrigger'] })).toMatchObject({ action: 'retrigger' });
    expect(unstickStep(move(failed), failed, { allowed: ['retrigger'] })?.alternative).toBeUndefined();
    expect(unstickStep(move(failed), failed, { allowed: ['merge'] })).toBeNull();
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null, queuedAt: minutesAgo(25), lastProgressAt: null })] });
    expect(unstickStep(move(queued), queued, { allowed: ['pick_up'], session: false })).toMatchObject({ action: 'pick_up' });
  });

  it('is for the implementer, or the planner while there is none', () => {
    const step = unstickStep(move(stalledGlob()));
    expect(step).toMatchObject({ kind: 'unstick', who: 'implementer', state: 'due', source: 'machine' });
    // `isForViewer` resolves `implementer` to the planner when nobody implements.
    expect(withUnstick(humanSteps(stalledGlob({ implementer: null }), {}), move(stalledGlob({ implementer: null })))[0]?.who).toBe('implementer');
  });

  it('clears itself when the cause clears', () => {
    const g = stalledGlob({ implementer: null });
    expect(withUnstick(humanSteps(g, {}), move(g)).map((s) => s.kind)).toContain('unstick');
    const moving = glob({ ...g, runs: [run({ lastProgressAt: minutesAgo(1) })] });
    expect(withUnstick(humanSteps(moving, {}), move(moving)).map((s) => s.kind)).not.toContain('unstick');
    expect(unstickStep({ holder: 'machine', reason: 'implement', since: null })).toBeNull();
  });

  it('an unstick step passed in is not a due step: the glob stays stalled, not you', () => {
    const g = stalledGlob();
    const first = move(g);
    const again = whoseMove(g, withUnstick(humanSteps(g, {}), first), machineSteps(g), new Map(), NOW, { viewer });
    expect(again.holder).toBe('stalled');
  });
});

describe('stall notification', () => {
  const g = glob({ id: 's1t4', title: 'Fix login', status: 'in_progress', implementer: null, updatedAt: minutesAgo(1) });

  it('a warning per glob while it is stalled, with whom it is for', () => {
    const n = stalledNotification(g, move(g));
    if (n === null) throw new Error('no notification');
    expect(n).toMatchObject({ boardId: 1, source: stalledSource('s1t4'), severity: 'warning', clears: { kind: 'condition' } });
    expect(n.title).toBe('s1t4 is stalled: nobody is on this');
    expect(n.detail).toContain(g.planner);
  });

  it('none once the glob moves', () => {
    expect(stalledNotification(g, { holder: 'machine', reason: 'implement', since: null })).toBeNull();
  });
});

describe('whoseMove: a conflict or failed checks on an open PR is never "nobody"', () => {
  const conflict = { base: 'main', files: ['a.ts'], since: null, at: NOW };

  it('an active conflict-fix run is the machine\'s', () => {
    const g = ready({ implementer: null, conflict, runs: [run({ state: 'active', purpose: 'resolve_conflict', lastProgressAt: minutesAgo(1) })] });
    expect(move(g)).toMatchObject({ holder: 'machine', reason: 'resolve conflict' });
  });

  it('a conflict with only a standby run names the action', () => {
    const g = ready({ implementer: null, conflict, runs: [run({ state: 'watching' })] });
    expect(move(g)).toMatchObject({ holder: 'you', reason: 'Fix conflict' });
    expect(move(g, {}, { viewer: undefined })).toMatchObject({ holder: 'human', reason: 'Fix conflict' });
    expect(move(ready({ implementer: null, conflict }))).toMatchObject({ reason: 'Fix conflict' });
  });

  it('an in_progress glob with a human implementer keeps its pick-up / stall handling', () => {
    const g = glob({ status: 'in_progress', implementer: dev.email, pr: { number: 49, state: 'draft', headSha: head }, conflict });
    expect(move(g).reason).not.toBe('Fix conflict: pick up');
  });

  it('failed checks with no run are a person\'s; with a watching run they are the watcher\'s', () => {
    const failedChecks = { sha: head, state: 'failed' as const, at: NOW };
    expect(move(ready({ implementer: null, headChecks: failedChecks }))).toMatchObject({ holder: 'you', reason: 'Fix checks' });
    expect(move(ready({ implementer: null, headChecks: failedChecks, runs: [run({ state: 'watching' })] }))).toMatchObject({ holder: 'machine', reason: 'fix checks' });
  });

  it('a standby run with a draft PR whose record is at the head is Done', () => {
    const g = glob({ status: 'in_progress', implementer: null, pr: { number: 49, state: 'draft', headSha: head }, runs: [run({ state: 'watching' })] });
    const steps = humanSteps(g, { recordAtHead: true }, []);
    expect(whoseMove(g, steps, machineSteps(g, {}), new Map(), NOW, { viewer })).toMatchObject({ reason: 'Mark ready' });
  });
});
