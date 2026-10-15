import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { cornerStatus, hasBlocker, plainText, specifics, waitingOnCounts } from '../src/lib/card-rows';
import { humanSteps as deriveHumanSteps, signOffText, whoseMove } from '@slop/core';
import type { StoredHumanStep } from '@slop/core';
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
const hold = (to: string, patch: Partial<NonNullable<GlobView['holding']>[number]> = {}): NonNullable<GlobView['holding']>[number] => ({
  relationId: `rel_${to}`,
  to,
  toTitle: null,
  toIsDecision: false,
  gate: 'start',
  until: 'merged',
  state: 'open',
  reason: null,
  source: 'person',
  ...patch,
});
const ahead = (ids: string[]) => view({ status: 'planning', holding: ids.map((id) => hold(id)) });
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
    expect(at(g)?.tip).toContain('Merged; CR is waiting for a person to approve it.');
    const many = { status: 'reviewing', labels: { QA: 'required', FR: 'added', CR: 'required' } } as const;
    expect(at(view(many))?.text).toBe('sign off');
    expect(signOffText()).toBe('sign off');
    expect(at(view({ status: 'reviewing', labels: { CR: 'approved' } }))?.kind).not.toBe('sign-off');
  });

  it('says "fix feedback" with the open items for the developer, ahead of sign-off, and goes back to sign-off once ticked', () => {
    const item = (id: string, done = false) => ({ id, text: `do ${id}`, done, addedBy: 'r@x', addedAt: NOW, doneBy: null, doneAt: null });
    const g = view({ status: 'reviewing', labels: { QA: 'added', CR: 'required' }, checklists: { QA: [item('a'), item('b'), item('c', true)] } });
    expect(at(g)).toMatchObject({ kind: 'feedback', icon: 'human', text: 'fix feedback' });
    expect(at(g)?.tip).toContain('QA has 2 open items: do a; do b');
    const ticked = view({ status: 'reviewing', labels: { QA: 'added', CR: 'required' }, checklists: { QA: [item('a', true)] } });
    expect(at(ticked)).toMatchObject({ kind: 'sign-off', text: 'sign off' });
    const fixing = view({ ...g, ...live('active') });
    expect(at(fixing)).toMatchObject({ kind: 'machine', icon: 'machine-spinning', text: 'fixing feedback' });
  });

  it('keeps how long a stall has lasted out of the text, in the tooltip', () => {
    const g = view({ status: 'failed', failure: { reason: 'run gave up', at: minutesAgo(18) }, move: { holder: 'stalled', reason: 'run failed', since: minutesAgo(18), minutes: 18 } });
    expect(at(g)?.text).toBe('run failed');
    expect(at(g)?.tip).toContain('run failed · 18 min');
  });

  it('says "signed off" with the date in the tooltip', () => {
    const status = at(view({ status: 'signed_off', signedOffAt: NOW }));
    expect(status).toMatchObject({ kind: 'signed-off', icon: 'check', text: 'signed off', click: null });
    expect(status?.tip).toContain(new Date(NOW).toLocaleString());
    expect(status?.text).not.toMatch(/\d/);
  });

  it('says "provisioning failed" in the corner, opening the actions', () => {
    const status = at(view({ status: 'planning', provisioning: 'failed' }));
    expect(status).toMatchObject({ kind: 'stalled', text: 'provisioning failed', icon: 'alert' });
    expect(status?.tip).toContain('slop could not create the branch and draft PR');
    expect(status?.click).toEqual({ kind: 'section', target: { section: 'actions' } });
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

  it('is the person icon and just the action for your turn, running Merge from the corner (with its confirm)', () => {
    const status = at(prOpen({ allowedActions: ['merge'] }));
    expect(status).toMatchObject({ kind: 'ready', icon: 'human' });
    expect(status?.text).not.toMatch(/your turn/i);
    expect(status?.click).toEqual({ kind: 'act', action: 'merge', confirm: true });
  });

  it('opens the glob view for a ready step that needs input, or when something blocks', () => {
    const noMerge = at(prOpen({ allowedActions: [] }));
    expect(noMerge).toMatchObject({ kind: 'ready' });
    expect(noMerge?.click?.kind).toBe('section');
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
    const status = at(ahead(['s1t1', 's1t2', 's1t3', 's1t4']));
    expect(status).toMatchObject({ kind: 'hold', icon: 'hourglass', text: 'waiting · s1t1 +3' });
    expect(status?.tip).toContain('Waits for s1t1 (Doing)');
    expect(JSON.stringify(status)).not.toMatch(/blocked by/i);
  });

  it('names a decision it waits on, with the reason in the tooltip', () => {
    const g = view({ status: 'planning', holding: [hold('s15k190', { toIsDecision: true, until: 'decided', state: 'planning', reason: 'the store is not chosen' })] });
    expect(at(g)).toMatchObject({ kind: 'hold', icon: 'human', text: 'waiting · decision s15k190' });
    expect(at(g)?.tip).toContain('Waits for decision s15k190 (Planning): the store is not chosen');
  });

  it('only a glob in Planning is held by a start relation: a started one shows no prerequisite wait', () => {
    expect(at({ ...ahead(['s1t1']), status: 'in_progress' })?.kind).not.toBe('hold');
  });

  it('lets the machine running win over what it waits on, which goes in the tooltip', () => {
    const status = at({ ...ahead(['s1t1']), ...live('active') });
    expect(status?.text).toBe('implementing');
    expect(status?.tip).toContain('Waits for s1t1');
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

  it('says a decided learning\'s outcome, with who decided, why and any contradiction in the tooltip', () => {
    const learning = (outcome: unknown, extra: object = {}) =>
      view({ category: 'decision', type: null, attributes: { scope: { kind: 'project', ref: null }, outcome, ...extra } } as unknown as Partial<GlobView>);
    expect(at(learning(null))).toBeNull();
    const decided = at(learning({ kind: 'accept_with_edits', by: 'a@b.c', at: 'now', reason: 'clearer' }, { conflictsWith: ['s1k2'] }));
    expect(decided).toMatchObject({ kind: 'decided', text: 'accepted with edits' });
    expect(decided?.tip).toContain('Accepted with edits by a@b.c: clearer');
    expect(decided?.tip).toContain('Contradicts s1k2');
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

describe('cornerStatus tooltip lines are sentences', () => {
  const cases: [string, () => GlobView][] = [
    ['machine running', () => view({ status: 'in_progress', ...live('active') })],
    ['open conflict', openConflict],
    ['waiting on prerequisites', () => ahead(['s1t1', 's1t2'])],
    ['escalated', escalated],
    ['your turn', () => prOpen({ allowedActions: ['merge'] })],
    ['checks running', () => prOpen({ headChecks: { sha: head, state: 'pending' } })],
    ['merging', () => prOpen({ mergeMode: 'when_green' })],
  ];
  it.each(cases)('%s', (_name, make) => {
    const tip = cornerStatus(make(), NOW)?.tip ?? '';
    expect(tip).not.toBe('');
    for (const line of tip.split('\n')) expect(line).toMatch(/[.!?…:]$/);
  });
});

describe('cornerStatus text stays a word or two', () => {
  const situations: readonly [string, () => GlobView, string][] = [
    ['machine running', () => view({ status: 'in_progress', ...live('active') }), 'implementing'],
    ['queued', () => view({ status: 'in_progress', ...live('queued') }), 'starting'],
    ['merge conflict stall', mergeConflictStall, ''],
    ['open conflict', openConflict, 'conflicts with main'],
    ['waiting on prerequisites', () => ahead(['s1t1', 's1t2', 's1t3', 's1t4']), 'waiting · s1t1 +3'],
    ['waiting on one prerequisite', () => ahead(['s1t1']), 'waiting · s1t1'],
    ['escalated', escalated, 'needs a'],
    ['your turn', () => prOpen({ allowedActions: ['merge'] }), 'Merge'],
    ['checks running', () => prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') }), 'checks running'],
  ];
  it.each(situations)('%s: at most 3 words (not counting "+N"), no "(", ";" or digits but glob IDs and a "+N" count', (_name, make, expected) => {
    const text = cornerStatus(make(), NOW)?.text ?? '';
    if (expected !== '') expect(text).toBe(expected);
    expect(text.replace(/\+\d+/g, '').trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(text).not.toMatch(/[(;]/);
    expect(text.replace(/\bs\d+[a-z]\d+\b/g, '').replace(/\+\d+/g, '')).not.toMatch(/\d/);
  });
});

describe('a startable same in Planning', () => {
  // The server's move for a Planning same carrying the investigation's predicted rollout placeholder.
  const stored: StoredHumanStep = {
    id: 'hs-1',
    boardId: 1,
    globId: 's1t1',
    kind: 'rollout',
    title: 'Rollout: steps to be written',
    detail: null,
    who: 'admin',
    due: 'after_merge',
    state: 'open',
    blocks: ['sign_off'],
    check: null,
    script: null,
    why: null,
    permissions: null,
    commands: [],
    verify: null,
    origin: 'investigation',
    createdBy: 'dev@example.com',
    createdAt: NOW,
    doneBy: null,
    doneAt: null,
    dismissedReason: null,
    dueSince: null,
  };
  const withPlaceholder = (): Partial<GlobView> => {
    const g = glob({ status: 'planning', type: 'same' });
    return { move: whoseMove(g, deriveHumanSteps(g, {}, [stored]), [], [], NOW) };
  };
  const startable = (patch: Partial<GlobView> = {}) => view({ type: 'same', status: 'planning', list: 'planning', allowedActions: ['start', 'pick_up'], ...patch });
  const ended = run({ state: 'ended', outcome: 'completed' });

  it.each([
    ['a plain one', {}],
    ['a predicted rollout placeholder', withPlaceholder()],
    ['an unanswered oversized flag', { sizeCheck: { flagged: true, decision: null } } as Partial<GlobView>],
    ['a split original', { sizeCheck: { flagged: true, decision: 'split' } } as Partial<GlobView>],
    ['a finished investigate-only run', { runs: [ended], currentRun: ended }],
  ])('is not blocked with %s', (_name, patch) => {
    expect(hasBlocker(startable(patch), NOW)).toBe(false);
  });

  it('is still blocked while it waits for another glob', () => {
    expect(hasBlocker(startable({ holding: [hold('s1t1')] }), NOW)).toBe(true);
  });

  it('counts the Planning globs waiting on each glob', () => {
    const counts = waitingOnCounts([
      view({ id: 's1t2', status: 'planning', holding: [hold('s1t1')] }),
      view({ id: 's1t3', status: 'planning', holding: [hold('s1t1'), hold('s1t1', { relationId: 'r2' })] }),
      view({ id: 's1t4', status: 'planning', holding: [hold('s1t1', { gate: 'merge' })] }),
      view({ id: 's1t5', status: 'implementing', holding: [hold('s1t1')] }),
    ]);
    expect(counts.get('s1t1')).toBe(2);
  });
});
