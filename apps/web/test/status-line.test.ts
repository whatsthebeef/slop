import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { activityLabel, statusLine, viewStatusLine, waitingFor } from '../src/lib/status-line';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

const head = 'd16d563aaaa';
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: head }, ...patch });
const failedChecks = {
  sha: head,
  state: 'failed' as const,
  failure: {
    name: 'Type check',
    step: null,
    lines: ['packages/core typecheck: TS2322 not assignable'],
    url: 'https://github.com/x/y/actions/runs/1',
  },
};
const top = (g: GlobView, role: 'dev' | 'qa' = 'dev') => {
  const actions = g.allowedActions ?? [];
  return viewStatusLine(g, NOW, waitingFor(g, actions, role));
};

describe('shared status line', () => {
  it('shows checks failed on a sub in the card and the view alike, linking the run and the routine fixing it', () => {
    const g = prOpen({
      type: 'sub',
      headChecks: failedChecks,
      runs: [run({ state: 'watching', sessionUrl: 'https://claude.ai/code/s' })],
      currentRun: run({ state: 'watching', sessionUrl: 'https://claude.ai/code/s' }),
    });
    const card = statusLine(g, NOW);
    expect(card).toMatchObject({
      kind: 'checks',
      url: failedChecks.failure.url,
      doing: 'routine session is fixing it',
      sessionUrl: 'https://claude.ai/code/s',
    });
    expect(card?.text).toMatch(/^Type check failed: packages\/core typecheck/);
    expect(top(g)).toEqual(card);
  });

  it("shows a red base as not this glob's change, and that the branch updates when fixed", () => {
    const g = prOpen({
      type: 'sub',
      headChecks: { ...failedChecks, inheritedFrom: { base: 'main', since: 's15t11' } },
    });
    const line = top(g);
    expect(line).toMatchObject({
      kind: 'base-red',
      doing: 'this branch is updated when the base is fixed',
    });
    expect(line?.full).toMatch(/not this glob's change/);
    expect(line).toEqual(statusLine(g, NOW));
  });

  it('shows a run failure', () => {
    const g = view({ status: 'failed', failure: { reason: 'Routine run failed: boom', at: NOW } });
    expect(top(g)).toMatchObject({ kind: 'failure', full: 'Routine run failed: boom' });
    expect(top(g)).toEqual(statusLine(g, NOW));
  });

  it('shows a stuck hint', () => {
    const g = prOpen({ type: 'sub', headChecks: null, updatedAt: '2026-10-05T10:00:00.000Z' });
    const card = statusLine(g, NOW);
    expect(card?.kind).toBe('stuck');
    expect(top(g)).toEqual(card);
  });

  it('shows a same that is ready as ready, with no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'] });
    expect(top(g)).toMatchObject({ kind: 'ready', full: 'Ready to merge' });
    expect(top(g)).toEqual(statusLine(g, NOW));
  });

  it('keeps waiting for checks off the status line: the activity label carries it', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(statusLine(g, NOW)).toBeNull();
    expect(top(g)).toBeNull();
    expect(activityLabel(g, NOW)).toMatchObject({ kind: 'checks', text: 'Checks running on d16d563' });
  });

  it('says why a same with failed checks cannot merge, keeping the link', () => {
    const g = prOpen({ headChecks: failedChecks, allowedActions: [] });
    const line = top(g);
    expect(line?.full).toMatch(
      /^Merge waits: checks failed on d16d563 Type check: packages\/core typecheck/,
    );
    expect(line?.url).toBe(failedChecks.failure.url);
    expect(line?.kind).toBe('checks');
  });

  it('says a red main is why a same cannot merge', () => {
    const g = prOpen({
      headChecks: { ...failedChecks, inheritedFrom: { base: 'main', since: 's15t11' } },
      allowedActions: [],
    });
    expect(top(g)?.full).toBe('Merge waits: main is red since s15t11');
  });

  it('says a super waits for the postplan', () => {
    const g = view({
      type: 'super',
      status: 'pr_open',
      pr: { number: 7, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'passed' },
      allowedActions: ['merge'],
    });
    expect(top(g)?.full).toBe('Merge and continue waits for the postplan at the head');
  });

  it('gives QA and PO no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(waitingFor(g, [], 'qa')).toEqual([]);
  });
});

describe('provisioning failure', () => {
  it('shows the reason and fix first, ahead of every other problem', () => {
    const reason = "Couldn't create branch s1t1 on acme/app: the slop GitHub App can't see that repo. Install it on the repo, or add the repo to its access, then Start over.";
    const g = view({
      status: 'failed',
      provisioning: 'failed',
      failure: { reason, at: NOW, kind: 'provisioning' },
      headChecks: failedChecks,
    });
    const line = statusLine(g, NOW);
    expect(line).toMatchObject({ kind: 'provisioning', full: reason });
    expect(line?.tip).not.toContain('the routine run failed');
    expect(top(g)).toMatchObject({ kind: 'provisioning', full: reason });
  });
});

describe('activity label', () => {
  const live = (state: 'queued' | 'active' | 'watching', patch = {}) => ({
    currentRun: run({ state, ...patch }),
  });

  it('is null when nothing runs on its own', () => {
    expect(activityLabel(view(), NOW)).toBeNull();
    expect(activityLabel(view({ currentRun: run({ state: 'ended' }) }), NOW)).toBeNull();
  });

  it('puts merging over checks over the run', () => {
    const base = prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') });
    expect(activityLabel(base, NOW)?.kind).toBe('checks');
    expect(activityLabel({ ...base, status: 'merging' }, NOW)?.text).toBe('Merging');
  });

  it('puts checks over the run, and says waiting before the checks have started', () => {
    expect(activityLabel(prOpen({ headChecks: null, ...live('active') }), NOW)).toMatchObject({
      kind: 'checks',
      text: 'Waiting for checks on d16d563',
    });
  });

  it('names the run states', () => {
    expect(activityLabel(view(live('active')), NOW)?.text).toBe('Routine working');
    expect(activityLabel(view(live('watching')), NOW)?.text).toBe('Routine watching the PR');
    expect(activityLabel(view(live('queued')), NOW)?.text).toBe('Queued');
  });

  it('says how long a run has been queued past 10 minutes', () => {
    const later = new Date(Date.parse(NOW) + 25 * 60_000).toISOString();
    const g = view(live('queued', { queuedAt: NOW }));
    expect(activityLabel(g, later)?.text).toBe('Queued for 25 min');
  });

  it('shows nothing once the checks have settled, and leaves problems to the status line', () => {
    expect(activityLabel(prOpen({ headChecks: { sha: head, state: 'passed' } }), NOW)).toBeNull();
    const failed = prOpen({ headChecks: failedChecks });
    expect(activityLabel(failed, NOW)).toBeNull();
    expect(statusLine(failed, NOW)?.kind).toBe('checks');
  });
});
