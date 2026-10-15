import { describe, expect, it } from 'vitest';
import { statusLine, waitingFor } from '../src/lib/status-line';
import { positionOf } from '../src/lib/position';
import { NOW, run } from '../../../packages/core/test/fixtures';
import { failedChecks, head, prOpen, top, view } from './helpers/glob-views';

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
    expect(line?.full).toBe('⏳ waiting · main is red');
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

  it('keeps waiting for checks off the status line: the position indicator carries it', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(statusLine(g, NOW)).toBeNull();
    expect(top(g)).toBeNull();
    expect(positionOf(g, NOW)).toMatchObject({
      holder: 'waiting',
      text: 'checks running on d16d563',
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

  it('gives QA and PO no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(waitingFor(g, [], 'qa')).toEqual([]);
  });
});
