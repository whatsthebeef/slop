import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { statusLine, waitingFor } from '../src/lib/status-line';
import { onStandby, positionOf } from '../src/lib/position';
import { NOW, run } from '../../../packages/core/test/fixtures';
import { failedChecks, head, prOpen, view } from './helpers/glob-views';

describe('position indicator', () => {
  const withRun = (state: 'queued' | 'active' | 'watching', patch = {}, over: Partial<GlobView> = {}) => {
    const r = run({ state, ...patch });
    return view({ runs: [r], currentRun: r, ...over });
  };
  const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('shows nothing when no run is live and nobody has stalled the glob', () => {
    expect(positionOf(view({ status: 'planning', list: 'planning' }), NOW)).toBeNull();
    expect(positionOf(view({ status: 'planning', list: 'planning', runs: [run({ state: 'ended' })], currentRun: run({ state: 'ended' }) }), NOW)).toBeNull();
  });

  it('says who has a picked-up glob, keeps saying so after a long silence, and not while a run is live', () => {
    const picked = view({ status: 'in_progress', implementer: 'john.bower@example.com', updatedAt: NOW, currentRun: null, runs: [] });
    expect(positionOf(picked, NOW)).toMatchObject({ holder: 'human', text: 'Picked up', label: 'Picked up' });
    expect(positionOf(picked, NOW)?.tip).toContain('john.bower@example.com picked this up');
    expect(positionOf(picked, later(60))).toMatchObject({ holder: 'human', text: 'Picked up' });
    expect(positionOf(picked, later(2 * 24 * 60))).toMatchObject({ holder: 'human', text: 'Picked up, quiet 2 days', tone: 'text-muted-foreground' });
    expect(positionOf(picked, NOW, { email: 'john.bower@example.com', role: 'dev' })).toMatchObject({ text: 'Picked up' });
    const pairing = view({ type: 'super', status: 'in_progress', implementer: 'john.bower@example.com', updatedAt: NOW, currentRun: null, runs: [] });
    expect(positionOf(pairing, later(90))).toMatchObject({ holder: 'human', text: 'pairing' });
    expect(positionOf(withRun('active', {}, { status: 'in_progress', implementer: 'dev@example.com' }), later(1))).toMatchObject({
      holder: 'machine',
      text: 'implementing',
    });
  });

  it("labels slop's agent-set glob by what slop did, not as picked up with no session", () => {
    const agentSet = view({
      title: 'Agent set v58',
      category: 'task',
      type: 'same',
      status: 'in_progress',
      implementer: 'slop',
      updatedAt: NOW,
      currentRun: null,
      runs: [],
    });
    expect(positionOf(agentSet, later(30))).toMatchObject({ holder: 'machine', text: 'committing agent set v58' });
  });

  it('puts merging when checks pass ahead of the plain checks wait', () => {
    const armed = prOpen({ headChecks: { sha: head, state: 'pending' }, mergeMode: 'when_green', allowedActions: ['cancel_merge'] });
    expect(positionOf(armed, NOW)).toMatchObject({ holder: 'waiting', text: `merging when checks pass · ${head.slice(0, 7)}`, spinning: true });
    expect(waitingFor(armed, armed.allowedActions ?? [], 'dev')).toEqual([]);
    const settled = { ...armed, headChecks: { sha: head, state: 'passed' as const } };
    expect(positionOf(settled, NOW)).toMatchObject({ holder: 'machine', text: 'merging' });
  });

  it('says a ready PR is waiting for checks before they have started', () => {
    expect(positionOf(prOpen({ headChecks: null }), NOW)).toMatchObject({
      holder: 'waiting',
      text: 'checks running on d16d563',
      spinning: false,
    });
  });

  it('shows a run on standby as a muted marker that holds nothing', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'], runs: [run({ state: 'watching' })], currentRun: run({ state: 'watching' }) });
    expect(onStandby(g)).not.toBeNull();
    expect(positionOf(g, NOW)?.holder).not.toBe('machine');
  });

  it('names the run states', () => {
    expect(positionOf(withRun('active', {}, { status: 'in_progress' }), NOW)?.text).toBe('implementing');
    expect(positionOf(withRun('queued', {}, { status: 'in_progress' }), NOW)?.text).toBe('starting');
  });

  it('says how long a run has been queued', () => {
    const g = withRun('queued', { queuedAt: NOW }, { status: 'in_progress' });
    expect(positionOf(g, later(3))?.text).toBe('queued 3 min');
    expect(positionOf(g, later(3))?.tip).toMatch(/^Machine run queued/);
    // A queued step is not spinning and says so; a running one spins and names its verb.
    expect(positionOf(g, later(3))).toMatchObject({ queued: true, spinning: false });
    expect(positionOf(withRun('active', {}, { status: 'in_progress' }), NOW)).toMatchObject({ queued: false, spinning: true, text: 'implementing' });
  });

  it('stalls a run that has been queued past the threshold, in the warning tone', () => {
    const g = withRun('queued', { queuedAt: NOW, lastProgressAt: NOW }, { status: 'in_progress' });
    expect(positionOf(g, later(25))).toMatchObject({ holder: 'stalled', tone: 'text-required' });
    expect(positionOf(g, later(25))?.text).toMatch(/^stalled: queued for 25 min/);
  });

  it('names what a run on an open PR is fixing', () => {
    const open = (state: 'passed' | 'failed') =>
      withRun('active', {}, { status: 'pr_open', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state } });
    expect(positionOf(open('failed'), NOW)).toMatchObject({ holder: 'machine', text: 'fixing CI' });
    expect(positionOf(open('passed'), NOW)).toMatchObject({ holder: 'machine', text: 'implementing' });
  });

  it('shows nothing once the checks have settled, and leaves problems to the status line', () => {
    expect(positionOf(prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'] }), NOW)).toBeNull();
    const failed = prOpen({ headChecks: failedChecks });
    expect(statusLine(failed, NOW)?.kind).toBe('checks');
  });

  it("prefers the server's move over deriving one", () => {
    const g = view({ move: { holder: 'waiting', reason: 'waiting on s15f82', since: null, waitingOn: ['s15f82'] } });
    expect(positionOf(g, NOW)).toMatchObject({ holder: 'waiting', text: 'waiting on s15f82' });
  });
});

describe('investigate runs', () => {
  const planning = (r: ReturnType<typeof run>) =>
    view({ status: 'planning', list: 'planning', runs: [r], currentRun: r });

  it('says investigating while queued or active, never started or working', () => {
    for (const state of ['queued', 'active'] as const) {
      const label = positionOf(
        planning(run({ state, purpose: 'investigate', sessionUrl: 'https://claude.ai/code/s', queuedAt: NOW })),
        NOW,
      );
      expect(label?.holder).toBe('machine');
      expect(label?.text).toBe(state === 'queued' ? 'starting' : 'investigating');
      expect(label?.sessionUrl).toBe('https://claude.ai/code/s');
    }
  });

  it('shows nothing run-like once a completed investigation has ended', () => {
    const g = planning(run({ state: 'ended', outcome: 'completed', purpose: 'investigate' }));
    expect(positionOf(g, NOW)).toBeNull();
    expect(statusLine(g, NOW)).toBeNull();
  });

  it('shows a failed investigation as a muted note with the reason, not a red failure', () => {
    const line = statusLine(
      planning(
        run({
          state: 'ended',
          outcome: 'failed',
          failureReason: 'No progress',
          purpose: 'investigate',
        }),
      ),
      NOW,
    );
    expect(line?.kind).toBe('investigation-failed');
    expect(line?.full).toBe('Investigation failed: No progress');
    expect(line?.tone).not.toBe('text-red');
  });

  it('says a Start queued behind the investigation waits for it, with the session', () => {
    const r = run({ state: 'active', purpose: 'investigate', sessionUrl: 'https://claude.ai/code/s' });
    const g = planning(r);
    const queued = { ...g, waiting: { since: NOW, investigation: { runId: r.id, by: 'dev@x.com' } } } as GlobView;
    const line = statusLine(queued, NOW);
    expect(line?.kind).toBe('start-queued');
    expect(line?.full).toBe('Investigating — starts after');
    expect(line?.tone).not.toBe('text-red');
    expect(line?.sessionUrl).toBe('https://claude.ai/code/s');
    // Without a queued Start the investigation alone is not a problem line.
    expect(statusLine(g, NOW)).toBeNull();
  });

  it('leaves an implementation run unchanged', () => {
    const r = run({ state: 'active' });
    expect(positionOf(view({ status: 'in_progress', runs: [r], currentRun: r }), NOW)?.text).toBe('implementing');
    expect(
      statusLine(
        view({ currentRun: run({ state: 'ended', outcome: 'failed', failureReason: 'x' }) }),
        NOW,
      )?.kind,
    ).not.toBe('investigation-failed');
  });
});
