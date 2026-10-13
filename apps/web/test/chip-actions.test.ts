import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlobCard } from '../src/components/glob-card';
import type { GlobView } from '../src/lib/api';
import { activityClick, checksUrl, statusClick, turnStep, yourTurnClick } from '../src/lib/chip-actions';
import { activityLabel, statusLine } from '../src/lib/status-line';
import type { StatusLine } from '../src/lib/status-line';
import { NOW, glob } from '../../../packages/core/test/fixtures';

const head = 'd16d563aaaa';
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const ready = (patch: Partial<GlobView> = {}) =>
  view({ type: 'same', status: 'pr_open', pr: { number: 289, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, ...patch });
const turn = (kind: StatusLine['turn']): StatusLine => ({ kind: 'ready', turn: kind, text: 'x', full: 'x', tone: '', tip: '', url: null, doing: null, sessionUrl: null });

describe('Your turn click', () => {
  it('asks for a confirming click before Merge runs, then runs it once', () => {
    const click = yourTurnClick(turn('merge'), { allowedActions: ['merge'] });
    expect(click).toEqual({ kind: 'act', action: 'merge', confirm: true });
    expect(turnStep(click, false)).toBe('confirm');
    expect(turnStep(click, true)).toBe('run');
  });

  it('runs Done at once', () => {
    const click = yourTurnClick(turn('done'), { allowedActions: ['mark_ready'] });
    expect(click).toEqual({ kind: 'act', action: 'mark_ready', confirm: false });
    expect(turnStep(click, false)).toBe('run');
  });

  it('opens the section for steps that need input, without an action', () => {
    expect(yourTurnClick(turn('decide'), { allowedActions: ['merge'] })).toEqual({ kind: 'section', target: { section: 'decision' } });
    expect(yourTurnClick(turn('rollout'), {})).toEqual({ kind: 'section', target: { section: 'actions' } });
    expect(yourTurnClick(turn('resolve_conflict'), {})).toEqual({ kind: 'section', target: { section: 'conflict' } });
    expect(yourTurnClick(turn('sign_off'), {})).toEqual({ kind: 'section', target: { section: 'labels' } });
  });

  it('opens the Human steps section for a due work step, whatever its kind', () => {
    expect(yourTurnClick({ ...turn('rollout'), work: true }, {})).toEqual({ kind: 'section', target: { section: 'human-steps' } });
    expect(yourTurnClick({ ...turn('merge'), work: true }, { allowedActions: ['merge'] }).kind).toBe('section');
    expect(statusClick({ ...turn(undefined), kind: 'rollout' })).toEqual({ kind: 'section', target: { section: 'human-steps' } });
  });

  it('does not run Merge when the glob view would not offer it', () => {
    expect(yourTurnClick(turn('merge'), { allowedActions: [] }).kind).toBe('section');
  });
});

describe('status chips', () => {
  it('open the run session when working, and the PR checks while checks run', () => {
    const working = view({ status: 'implementing', currentRun: { ...glob().runs[0], state: 'active', sessionUrl: 'https://claude.ai/code/x' } as never });
    const activity = activityLabel(working, NOW);
    expect(activity).not.toBeNull();
    if (activity !== null) expect(activityClick(activity, working, 'a/b')).toEqual({ kind: 'link', url: 'https://claude.ai/code/x' });
    const checking = ready({ headChecks: { sha: head, state: 'pending' } });
    const checks = activityLabel(checking, NOW);
    if (checks !== null) expect(activityClick(checks, checking, 'a/b')).toEqual({ kind: 'link', url: 'https://github.com/a/b/pull/289/checks' });
    expect(checksUrl(undefined, checking)).toBeNull();
  });

  it('open a failing check, else the actions section', () => {
    const failing = ready({ headChecks: { sha: head, state: 'failed', failure: { name: 'Lint', step: null, lines: ['x'], url: 'https://github.com/x/y/actions/runs/1' } } });
    const line = statusLine(failing, NOW);
    expect(line).not.toBeNull();
    if (line !== null) expect(statusClick(line)).toEqual({ kind: 'link', url: 'https://github.com/x/y/actions/runs/1' });
    expect(statusClick({ ...turn(undefined), kind: 'stuck' })).toEqual({ kind: 'section', target: { section: 'actions' } });
  });
});

describe('card markup', () => {
  const props = {
    onOpen: () => undefined,
    onOpenSection: () => undefined,
    onReviewLabel: () => Promise.resolve(true),
    moves: [],
    previewing: null,
    onPreview: () => undefined,
    onMove: () => undefined,
    onArrow: () => undefined,
  };
  it('renders Your turn as a button named for its action', () => {
    const html = renderToStaticMarkup(createElement(GlobCard, { ...props, glob: ready({ allowedActions: ['merge'] }), repo: 'a/b' }));
    expect(html).toMatch(/<button[^>]*aria-label="Your turn: Merge PR #289"[^>]*data-testid="your-turn-chip"/);
  });
});
