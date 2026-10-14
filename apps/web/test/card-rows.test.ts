import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { cornerStatus, hasBlocker, plainText, specifics, turnButton } from '../src/lib/card-rows';
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

describe('cornerStatus', () => {
  const at = (g: GlobView) => cornerStatus(g, NOW);

  it('is the machine icon spinning plus the verb while a step runs, never "working"', () => {
    const status = at(view({ status: 'in_progress', ...live('active') }));
    expect(status).toMatchObject({ kind: 'machine', icon: 'machine-spinning', text: 'implementing' });
    expect(status?.text).not.toMatch(/working/i);
  });

  it('keeps the machine icon still for a queued step, with its age', () => {
    expect(at(view({ status: 'in_progress', ...live('queued') }))).toMatchObject({ kind: 'machine', icon: 'machine', text: 'starting' });
    const waiting = run({ state: 'queued', queuedAt: minutesAgo(3), startedAt: minutesAgo(3), lastProgressAt: minutesAgo(3) });
    const status = at(view({ status: 'in_progress', runs: [waiting], currentRun: waiting }));
    expect(status?.icon).toBe('machine');
    expect(status?.text).toMatch(/^(queued|starting)$/);
    expect(status?.text).not.toMatch(/min/);
  });

  it('is a warning plus the cause for a stall, never "stalled", with the files and the stall in the tooltip', () => {
    const status = at(mergeConflictStall());
    expect(status).toMatchObject({ kind: 'stalled', icon: 'alert', text: 'merge conflict' });
    expect(status?.text).not.toMatch(/stalled|\.tsx?|\//);
    expect(status?.tip).toContain(files[0]);
    expect(status?.tip).toContain('Merge conflict with main in');
    const failed = view({ status: 'planning', failure: { reason: 'A very long reason that goes on and on about a thing that went wrong', at: NOW } });
    expect(at(failed)).toMatchObject({ kind: 'stalled', icon: 'alert', text: 'run failed' });
    expect(at(failed)?.tip).toContain('A very long reason');
  });

  it('has no minutes or commit SHAs in the text, whatever the state', () => {
    const g = view({ status: 'pr_open', pr: { number: 1, state: 'ready', headSha: 'd16d563aaaa' }, headChecks: { sha: 'd16d563aaaa', state: 'pending' } });
    expect(plainText('checks running on d16d563')).toBe('checks running');
    expect(plainText('merging when checks pass · d16d563')).toBe('merging when checks pass');
    expect(plainText('queued 3 min')).toBe('queued');
    expect(plainText('queued · 3 min')).toBe('queued');
    expect(at(g)?.text ?? '').not.toMatch(/\bmin\b|\b[0-9a-f]{7}\b/);
  });

  it('shows the human outline and "sign off" for a merged glob awaiting sign-off', () => {
    const g = view({ status: 'reviewing', labels: { CR: 'required', QA: 'approved' } });
    expect(at(g)).toMatchObject({ kind: 'sign-off', icon: 'human', text: 'sign off' });
    expect(at(view({ status: 'reviewing', labels: { CR: 'approved' } }))?.kind).not.toBe('sign-off');
  });

  it('keeps how long a stall has lasted out of the text, in the tooltip', () => {
    const g = view({ status: 'failed', failure: { reason: 'run gave up', at: minutesAgo(18) }, move: { holder: 'stalled', reason: 'run failed', since: minutesAgo(18), minutes: 18 } });
    expect(at(g)?.text).toBe('run failed');
    expect(at(g)?.tip).toContain('run failed · 18 min');
  });

  it('puts standby in a stall\'s tooltip, not a second status', () => {
    const g = view({ status: 'failed', failure: { reason: 'run gave up', at: NOW }, ...live('watching') });
    const status = at(g);
    expect(status?.kind).toBe('stalled');
    expect(status?.tip).toContain('on standby, listening to GitHub');
  });

  it('is "needs a human" for an escalated Planning glob, and a stall beats it with the reason in the tooltip', () => {
    expect(at(escalated())).toMatchObject({ kind: 'needs-human', icon: 'needs-human', text: 'needs a' });
    const both = at(view({ ...escalated(), status: 'planning', provisioning: 'failed' }));
    expect(both?.kind).toBe('stalled');
    expect(both?.tip).toContain('touches billing');
  });

  it('is the person icon and just the action for your turn, opening the glob view', () => {
    const status = at(prOpen({ allowedActions: ['merge'] }));
    expect(status).toMatchObject({ kind: 'ready', icon: 'human' });
    expect(status?.text).not.toMatch(/your turn/i);
    expect(status?.click).toEqual({ kind: 'section', target: { section: 'actions' } });
  });

  it('says the other problems in a few words, with the detail in the tooltip', () => {
    const checks = prOpen({ headChecks: { sha: head, state: 'failed', failure: { name: 'Type check', step: null, lines: ['packages/core typecheck: TS2322'], url: null } } });
    expect(at(checks)).toMatchObject({ kind: 'checks', icon: 'alert', text: 'checks failed' });
    expect(at(checks)?.tip).toContain('TS2322');
    const conflict = at(openConflict());
    expect(conflict?.text).toBe('conflicts with main');
    expect(conflict?.tip).toContain(files[0]);
    const behind = at(view({ status: 'in_progress', ...live('active'), behind: { base: 'main', behindBy: 2, files: ['a.ts'], at: NOW } }));
    // The machine running wins over "behind"; the warning goes in the tooltip.
    expect(behind).toMatchObject({ kind: 'machine', text: 'implementing' });
    expect(behind?.tip).toContain('main');
  });

  it('shows a red base as waiting, with the failing run in the tooltip', () => {
    const red = prOpen({ headChecks: { sha: head, state: 'failed', inheritedFrom: { base: 'main', since: null }, failure: { name: 'Lint', step: null, lines: ['x'], url: null } } });
    expect(at(red)).toMatchObject({ icon: 'hourglass' });
    expect(at(red)?.text).toMatch(/main is red/);
  });

  it('names the machine fixing a problem rather than the problem', () => {
    const fixing = view({ status: 'in_progress', ...live('active'), conflict: { base: 'main', files, since: 's1t9', at: NOW } });
    const status = at(fixing);
    expect(status?.icon).toMatch(/^machine/);
    expect(status?.tip).toContain(files[0]);
  });

  it('says what it waits on once, with the chain in the tooltip and no "blocked by"', () => {
    const status = at(ahead(['s1t1', 's1t2', 's1t3', 's1t4'], 's1t9'));
    expect(status).toMatchObject({ kind: 'waiting-on', icon: 'hourglass', text: 'waiting on s1t1, s1t2 +2 · next: s1t9' });
    expect(status?.tip).toContain('Waits for, in order: s1t1 (Doing)');
    expect(JSON.stringify(status)).not.toMatch(/blocked by/i);
  });

  it('lets the machine running win over what it waits on, which goes in the tooltip', () => {
    const status = at({ ...ahead(['s1t1']), status: 'in_progress', ...live('active') });
    expect(status?.text).toBe('implementing');
    expect(status?.tip).toContain('Waits for, in order: s1t1');
  });

  it('shows other waiting as an hourglass', () => {
    const g = prOpen({ ...live('watching'), headChecks: { sha: 'abc1234', state: 'pending' } });
    expect(at(g)).toMatchObject({ kind: 'waiting', icon: 'hourglass' });
    expect(at(g)?.text).toMatch(/^checks running/);
  });

  it('shows standby as the machine icon and the word, with what it listens for in the tooltip', () => {
    const step = { id: 'machine:standby', kind: 'standby', state: 'standby', startedAt: null, lastProgressAt: null, detail: null, holdsBall: false } as const;
    const status = at(view({ status: 'planning', machineSteps: [step], move: { holder: 'none', reason: '', since: null } as unknown as GlobView['move'] }));
    expect(status).toMatchObject({ kind: 'standby', icon: 'machine', text: 'standby' });
    expect(status?.tip).toContain('listening to GitHub');
    // Any other waiting says its own words and keeps standby in the tooltip.
    const waiting = at(prOpen({ type: 'sub', ...live('watching') }));
    expect(waiting?.kind).toBe('waiting');
    expect(waiting?.tip).toContain('listening to GitHub');
  });

  it('has nothing for a Planning glob with nothing pending, or a decision', () => {
    expect(at(view({ status: 'planning' }))).toBeNull();
    expect(at(view({ status: 'planning', decision: { scope: { kind: 'board' }, outcome: null } } as Partial<GlobView>))).toBeNull();
  });

  it('keeps the specifics helper stripping the icon\'s word', () => {
    expect(specifics('stalled · merge conflict')).toBe('merge conflict');
    expect(specifics('stalled')).toBe('');
    expect(specifics('standby')).toBe('listening for CI and reviews');
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

describe('turnButton', () => {
  it('is Merge when it is the viewer\'s turn to merge and nothing blocks, and never with a blocker', () => {
    const g = prOpen({ allowedActions: ['merge'] });
    expect(turnButton(g, NOW, undefined, false)?.click).toEqual({ kind: 'act', action: 'merge', confirm: true });
    expect(turnButton(g, NOW, undefined, true)).toBeNull();
  });
});
