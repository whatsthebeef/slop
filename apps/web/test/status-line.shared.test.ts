import { describe, expect, it } from 'vitest';
import { holdLine, statusLine, waitingFor } from '../src/lib/status-line';
import { cornerStatus } from '../src/lib/card-rows';
import { positionOf } from '../src/lib/position';
import type { GlobView } from '../src/lib/api';
import { NOW, run } from '../../../packages/core/test/fixtures';
import { failedChecks, head, hold, prOpen, top, view } from './helpers/glob-views';

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
    expect(line?.full).toBe('main is red');
    expect(line?.full).not.toMatch(/not this glob's change/);
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

  it("names the board's own gate check in the stuck hint, `checks` by default", () => {
    const patch = { type: 'sub' as const, headChecks: null, updatedAt: '2026-10-05T10:00:00.000Z' };
    const own = statusLine(prOpen({ ...patch, gateCheck: 'sub-gate' }), NOW);
    expect(own?.full).toMatch(/`sub-gate`/);
    expect(own?.full).not.toMatch(/checks\.yml/);
    expect(statusLine(prOpen(patch), NOW)?.full).toMatch(/`checks`/);
  });

  it('shows a same that is ready as ready, with no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'] });
    expect(top(g)).toMatchObject({ kind: 'ready', full: 'Merge' });
    expect(top(g)).toEqual(statusLine(g, NOW));
  });

  it('shows a same with open rollout steps as ready for Merge and continue, from the server count', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge_continue'], rolloutSteps: 1 });
    expect(top(g)).toMatchObject({ kind: 'ready', full: 'Merge and continue' });
    expect(top(g)?.tip).not.toContain('--merge');
  });

  it('keeps waiting for checks off the status line: the position indicator carries it', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(statusLine(g, NOW)).toBeNull();
    expect(top(g)).toBeNull();
    expect(positionOf(g, NOW)).toMatchObject({
      holder: 'waiting',
      text: 'checks running',
      onChecks: true,
    });
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

  it('says a conflict with the base is why a same with passing checks cannot merge', () => {
    const g = prOpen({
      headChecks: { sha: head, state: 'passed' },
      conflict: { base: 'main', files: [], since: 's1t2', at: NOW },
      allowedActions: [],
    });
    expect(waitingFor(g, [], 'dev')).toMatchObject([
      { action: 'merge', why: ': conflicts with main' },
    ]);
  });

  it('says a super waits for the implementation record', () => {
    const g = view({
      type: 'super',
      status: 'pr_open',
      pr: { number: 7, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'passed' },
      allowedActions: ['merge'],
    });
    expect(top(g)?.full).toBe(
      'Merge & keep working waits for the implementation record at the head',
    );
  });

  it('says Merge and continue waits for the checks on a same with open rollout steps', () => {
    const g = prOpen({
      headChecks: { sha: head, state: 'pending' },
      allowedActions: [],
      rolloutSteps: 1,
    });
    expect(waitingFor(g, [], 'dev')).toMatchObject([
      { action: 'merge_continue', label: 'Merge and continue', running: true },
    ]);
    // Without steps it is still plain Merge.
    expect(waitingFor({ ...g, rolloutSteps: 0 }, [], 'dev')).toMatchObject([{ action: 'merge', label: 'Merge' }]);
    // The web reads the server's count, not the step list: a placeholder or non-blocking step does not turn Merge into Merge and continue.
    const placeholder = { ...g, rolloutSteps: 0, humanSteps: [{ id: 'hs_1', kind: 'rollout', title: 'Run it', who: 'admin', due: 'after_merge', blocks: ['sign_off'], state: 'pending' }] } as never;
    expect(waitingFor(placeholder, [], 'dev')).toMatchObject([{ action: 'merge', label: 'Merge' }]);
  });

  it('gives QA and PO no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(waitingFor(g, [], 'qa')).toEqual([]);
  });
});

describe('an action waiting for its script', () => {
  const SCRIPT = 'scripts/rollout/s1t1-report-groups.sh';
  const action = (patch: Partial<GlobView> = {}): GlobView =>
    view({
      id: 's1a1',
      category: 'action',
      type: null,
      status: 'planning',
      holding: [hold('s1t1', { state: 'planning', reason: 'builds its script' })],
      script: { path: SCRIPT, onBase: false },
      allowedActions: ['dismiss_action', 'delete'],
      ...patch,
    });

  it('says "waiting · s1t1" with the human icon and the script tooltip', () => {
    expect(holdLine(action())).toEqual({
      text: 'waiting · s1t1',
      tip: `Its script ${SCRIPT} is written by s1t1, which hasn't merged to main yet.`,
      icon: 'human',
    });
  });

  it('names the glob even when the script path is not on the view, and keeps the generic tip for another hold', () => {
    expect(holdLine(action({ script: null }))?.tip).toBe("Its script is written by s1t1, which hasn't merged to main yet.");
    const other = holdLine(action({ script: null, holding: [hold('s1t2', { state: 'planning' })] }));
    expect(other?.tip).toBe('Waits for s1t2 to be merged and rolled out (Planning) (no reason given)');
    expect(other?.icon).toBe('human');
  });

  it('leaves the hourglass for a code glob that waits for another', () => {
    const code = view({ status: 'planning', holding: [hold('s1t1', { state: 'planning' })] });
    expect(holdLine(code)?.icon).toBe('hourglass');
    expect(holdLine(code)?.tip).not.toContain('script');
  });

  it('shows the hold on the card, and nothing for a free or finished action', () => {
    expect(cornerStatus(action(), NOW)).toMatchObject({ kind: 'hold', icon: 'human', text: 'waiting · s1t1' });
    expect(cornerStatus(action({ holding: [], script: null, allowedActions: ['complete_action', 'dismiss_action', 'delete'] }), NOW)).toBeNull();
  });

  it('disables Done with the reason, for any role, and the status line says what it waits for', () => {
    const waiting = waitingFor(action(), ['dismiss_action', 'delete'], 'qa');
    expect(waiting).toMatchObject([
      { action: 'complete_action', label: 'Done', tip: `Its script ${SCRIPT} is written by s1t1, which hasn't merged to main yet.`, why: 'for s1t1 to be merged and rolled out' },
    ]);
    expect(top(action())?.full).toBe('Done waits for s1t1 to be merged and rolled out');
  });

  it('disables Done for a script that is not on main yet when nothing else holds it', () => {
    const g = action({ holding: [] });
    expect(waitingFor(g, ['dismiss_action', 'delete'], 'dev')).toMatchObject([
      { action: 'complete_action', tip: `Script not on main yet: ${SCRIPT}`, why: `: script not on main yet: ${SCRIPT}` },
    ]);
  });

  it('shows no wait once Done is allowed, or when the script could not be checked', () => {
    expect(waitingFor(action({ holding: [], script: { path: SCRIPT, onBase: true } }), ['complete_action', 'dismiss_action'], 'dev')).toEqual([]);
    expect(waitingFor(action({ holding: [], script: { path: SCRIPT, onBase: null } }), ['complete_action', 'dismiss_action'], 'dev')).toEqual([]);
    expect(waitingFor(action({ status: 'signed_off' }), ['delete'], 'dev')).toEqual([]);
  });
});
