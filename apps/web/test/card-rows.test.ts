import { describe, expect, it } from 'vitest';
import type { Action } from '@slop/core';
import type { GlobView } from '../src/lib/api';
import { cardActions, cardStatus, cornerMarker, hasBlocker, turnButton } from '../src/lib/card-rows';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

const head = 'd16d563aaaa';
const minutesAgo = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ type: 'same', status: 'pr_open', pr: { number: 289, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, ...patch });
const files = ['apps/web/src/components/glob-dialog.tsx', 'apps/web/src/pages/board.tsx'];
const mergeConflictStall = () =>
  view({
    status: 'failed',
    implementer: null,
    failure: { reason: `Merge conflict with main in ${files.join(', ')}`, at: NOW, kind: 'merge', conflict: { base: 'main', files } },
  });
const openConflict = () => prOpen({ conflict: { base: 'main', files, since: 's1t9', at: NOW } });
const ahead = (ids: string[], nextStartable: string | null = null) =>
  view({
    status: 'planning',
    blockedBy: ids.map((id, i) => ({ id, state: 'open' as const, status: 'implementing' as const, depth: i + 1 })),
    nextStartable,
  });
const escalated = () => view({ status: 'planning', escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'] });
const live = (state: 'queued' | 'active' | 'watching') => {
  const r = run({ state });
  return { runs: [r], currentRun: r };
};

describe('cornerMarker', () => {
  it('shows stalled, with standby in its tooltip and no second marker', () => {
    const g = view({ status: 'failed', failure: { reason: 'run gave up', at: NOW }, ...live('watching') });
    const marker = cornerMarker(g, NOW);
    expect(marker).toMatchObject({ kind: 'stalled', text: 'stalled' });
    expect(marker?.tip).toContain('on standby, listening to GitHub');
  });

  it('shows one marker by precedence: stalled, needs a human, working, standby, none', () => {
    expect(cornerMarker(escalated(), NOW)).toMatchObject({ kind: 'needs-human' });
    expect(cornerMarker(view({ status: 'in_progress', ...live('active') }), NOW)).toMatchObject({ kind: 'working', text: 'working' });
    expect(cornerMarker(prOpen({ type: 'sub', ...live('watching') }), NOW)).toMatchObject({ kind: 'standby' });
    expect(cornerMarker(view({ status: 'planning' }), NOW)).toBeNull();
    // Stalled beats an escalation, and the escalation's reason stays reachable in the tooltip.
    const both = view({ ...escalated(), status: 'planning', provisioning: 'failed' });
    const marker = cornerMarker(both, NOW);
    expect(marker?.kind).toBe('stalled');
    expect(marker?.tip).toContain('touches billing');
  });
});

describe('cardStatus', () => {
  it('says a merge-conflict stall once, short, with the files only in the tooltip', () => {
    const line = cardStatus(mergeConflictStall(), NOW);
    expect(line?.text).toBe('stalled · merge conflict');
    expect(line?.text.length).toBeLessThanOrEqual(40);
    expect(line?.text).not.toMatch(/\.tsx?|\//);
    expect(line?.tip).toContain(files[0]);
    expect(line?.tip).toContain('Merge conflict with main in');
  });

  it('says "conflicts with main" for a conflicting glob, without files or advice, which stay in the tooltip', () => {
    const line = cardStatus(openConflict(), NOW);
    expect(line?.text).toBe('conflicts with main');
    expect(line?.tip).toContain(files[0]);
    const mine = cardStatus({ ...openConflict(), implementer: 'dev@example.com' }, NOW);
    expect(mine?.text).toBe('conflicts with main');
    expect(mine?.tip).toContain('Resolve locally');
  });

  it('says what it waits on once, with the chain in the tooltip and no "blocked by"', () => {
    const line = cardStatus(ahead(['s1t1', 's1t2', 's1t3', 's1t4'], 's1t9'), NOW);
    expect(line?.text).toBe('waiting on s1t1, s1t2 +2 · next: s1t9');
    expect(line?.waiting).toMatchObject({ ids: ['s1t1', 's1t2'], more: 2, next: 's1t9' });
    expect(line?.tip).toContain('Waits for, in order: s1t1 (Doing)');
    expect(JSON.stringify(line)).not.toMatch(/blocked by/i);
  });

  it('puts the position first and what it waits on second', () => {
    const line = cardStatus({ ...ahead(['s1t1']), status: 'in_progress', ...live('active') }, NOW);
    expect(line?.text).toBe('implementing · waiting on s1t1');
  });

  it('names the next step after Your turn, and nothing for a decision or a glob with nothing to say', () => {
    const ready = cardStatus(prOpen({ allowedActions: ['merge'] }), NOW);
    expect(ready?.head?.kind).toBe('ready');
    expect(ready?.head?.text).toMatch(/^Your turn · /);
    expect(cardStatus(view({ status: 'planning' }), NOW)).toBeNull();
  });

  it('keeps every other problem to a few words', () => {
    const checks = prOpen({ headChecks: { sha: head, state: 'failed', failure: { name: 'Type check', step: null, lines: ['packages/core typecheck: TS2322'], url: null } } });
    expect(cardStatus(checks, NOW)?.head?.text).toBe('checks failed');
    const failed = view({ status: 'planning', failure: { reason: 'A very long reason that goes on and on about a thing that went wrong', at: NOW } });
    // A failed run is a stall: the card says it once, short, and the long reason stays in the tooltip.
    expect(cardStatus(failed, NOW)?.head?.text).toBe('stalled · run failed');
    expect(cardStatus(failed, NOW)?.tip).toContain('A very long reason');
  });
});

describe('hasBlocker', () => {
  it('is true for unmerged needs, a conflict, a stall, an escalation and failed checks', () => {
    expect(hasBlocker(ahead(['s1t1']), NOW)).toBe(true);
    expect(hasBlocker(openConflict(), NOW)).toBe(true);
    expect(hasBlocker(mergeConflictStall(), NOW)).toBe(true);
    expect(hasBlocker(view({ status: 'in_progress', type: 'sub', updatedAt: minutesAgo(3) }), NOW)).toBe(true);
    expect(hasBlocker(escalated(), NOW)).toBe(true);
    expect(hasBlocker(prOpen({ headChecks: { sha: head, state: 'failed', failure: { name: 'Lint', step: null, lines: ['x'], url: null } } }), NOW)).toBe(true);
  });

  it('is false when the glob is only behind, overlaps or clashes with another, or has checks running', () => {
    const behind = view({ status: 'in_progress', ...live('active'), behind: { base: 'main', behindBy: 2, files: ['a.ts'], at: NOW } });
    expect(hasBlocker(behind, NOW)).toBe(false);
    expect(hasBlocker(view({ status: 'planning', impliedAfter: [{ id: 's1t2', paths: ['a.ts'], kind: 'overlaps' }] }), NOW)).toBe(false);
    expect(hasBlocker(view({ status: 'planning', clash: { with: 's1t2', paths: ['a.ts'] } }), NOW)).toBe(false);
    expect(hasBlocker(view({ status: 'planning' }), NOW)).toBe(false);
    expect(hasBlocker(prOpen({ allowedActions: ['merge'] }), NOW)).toBe(false);
  });
});

describe('cardActions', () => {
  const moves = (...actions: Action[]) => actions.map((action) => ({ action }));
  const names = (list: readonly { action: Action }[]) => list.map((m) => m.action);

  it('shows Start and Pick up for a same in Planning, and drops the rest', () => {
    const g = view({ type: 'same', status: 'planning' });
    expect(names(cardActions(moves('start', 'start_anyway', 'pick_up', 'take_over'), g, false, false))).toEqual(['start', 'pick_up']);
  });

  it('shows the one main action otherwise', () => {
    expect(names(cardActions(moves('start', 'pick_up'), view({ type: 'sub', status: 'planning' }), false, false))).toEqual(['start']);
    expect(names(cardActions(moves('pick_up', 'start_anyway'), view({ type: 'super', status: 'planning' }), false, false))).toEqual(['pick_up']);
    expect(names(cardActions(moves('start', 'retrigger'), view({ type: 'same', status: 'planning' }), false, false))).toEqual(['retrigger']);
  });

  it('shows nothing with a blocker', () => {
    expect(cardActions(moves('start', 'pick_up'), view({ type: 'same', status: 'planning' }), false, true)).toEqual([]);
  });
});

describe('turnButton', () => {
  it('is Merge when it is the viewer\'s turn to merge and nothing blocks, and never with a blocker', () => {
    const g = prOpen({ allowedActions: ['merge'] });
    expect(turnButton(g, NOW, undefined, false)?.click).toEqual({ kind: 'act', action: 'merge', confirm: true });
    expect(turnButton(g, NOW, undefined, true)).toBeNull();
  });
});
