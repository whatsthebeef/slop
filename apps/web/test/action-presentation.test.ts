import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { actionPresentation, haltedBy, presentedActions } from '@slop/core';
import type { Action } from '@slop/core';
import { createElement } from 'react';
import { ActorIcon } from '../src/components/actor-icons';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const pr = { number: 63, state: 'draft' as const, headSha: 'abc' };

const ACTIONS: readonly Action[] = [
  'start',
  'investigate',
  'review_now',
  'start_anyway',
  'merge_anyway',
  'sign_off_anyway',
  'pick_up',
  'take_over',
  'retrigger',
  'retry_autofix',
  'resolve_conflict',
  'start_again',
  'merge',
  'retry_merge',
  'deescalate',
  'make_super',
  'merge_continue',
  'mark_ready',
  'decide',
  'sign_off',
  'reopen',
  'delete',
];

describe('actionPresentation', () => {
  it('gives every action a label, a tip and a placement', () => {
    for (const action of ACTIONS) {
      const p = actionPresentation(action, view());
      expect(p.label, action).not.toBe('');
      expect(p.tip, action).not.toBe('');
    }
  });

  it('names Decide as approving the change, never as a generic Decide', () => {
    expect(actionPresentation('decide', view())).toMatchObject({
      label: 'Approve change',
      tip: 'Approves the proposed change as drafted',
      placement: 'main',
    });
  });

  it('reads Start as Start after investigation while an investigation is running', () => {
    const g = view({ type: 'same', status: 'planning' });
    const investigating = { ...g, currentRun: { ...glob().runs[0], purpose: 'investigate', state: 'active' } } as GlobView;
    expect(actionPresentation('start', investigating)).toMatchObject({ label: 'Start after investigation', placement: 'main' });
    const ended = { ...investigating, currentRun: { ...investigating.currentRun, state: 'ended' } } as GlobView;
    expect(actionPresentation('start', ended).label).toBe('Start');
  });

  it('names and places the standard actions', () => {
    const g = view({ type: 'same', status: 'planning', pr });
    expect(actionPresentation('start', g)).toMatchObject({
      label: 'Start',
      icon: 'machine',
      placement: 'main',
    });
    expect(actionPresentation('retrigger', g)).toMatchObject({
      label: 'Retry',
      icon: 'machine',
      placement: 'main',
    });
    expect(actionPresentation('retry_autofix', g).label).toBe('Fix checks');
    expect(actionPresentation('resolve_conflict', g).label).toBe('Fix conflict');
    expect(actionPresentation('mark_ready', g)).toMatchObject({ label: 'Done', icon: 'human' });
    const passed = { ...g, headChecks: { sha: 'abc', state: 'passed' as const } };
    expect(actionPresentation('merge', passed)).toMatchObject({ label: 'Merge', tip: 'Squash-merges PR #63' });
    for (const headChecks of [{ sha: 'abc', state: 'pending' as const }, null, { sha: 'old', state: 'passed' as const }]) {
      expect(actionPresentation('merge', { ...g, headChecks })).toMatchObject({
        label: 'Merge when checks pass',
        placement: 'main',
        tip: 'Slop merges automatically if the checks on abc go green; it stops and tells you if they fail or the branch conflicts',
      });
    }
    expect(actionPresentation('cancel_merge', g)).toMatchObject({ label: 'Cancel merge', placement: 'more' });
    // A super keeps Merge & keep working in the menu; a same's Merge covers its rollout steps.
    expect(actionPresentation('merge_continue', { ...g, type: 'super' })).toMatchObject({
      label: 'Merge & keep working',
      placement: 'more',
    });
    // A same is never offered merge_continue; an old alias reads as Merge.
    expect(actionPresentation('merge_continue', g)).toMatchObject({ label: 'Merge', icon: 'machine', placement: 'main' });
    // Merge says what follows when the glob has rollout steps.
    expect(actionPresentation('merge', { ...g, headChecks: { sha: 'abc', state: 'passed' }, rolloutSteps: 3 }).tip).toContain(
      "Then run its 3 rollout steps (it stays open until they're done)",
    );
    expect(actionPresentation('investigate', g).label).toBe('Investigate plan');
    expect(actionPresentation('review_now', g).label).toBe('Review code');
    expect(actionPresentation('delete', g)).toMatchObject({ icon: null, placement: 'reset' });
  });

  it('puts Merge anyway and Sign off anyway in the More menu, named for what they force through', () => {
    expect(actionPresentation('merge_anyway', view({ status: 'pr_open' }))).toMatchObject({ label: 'Merge anyway', icon: 'machine', placement: 'more' });
    expect(actionPresentation('sign_off_anyway', view({ status: 'reviewing' }))).toMatchObject({ label: 'Sign off anyway', icon: 'human', placement: 'more' });
    expect(actionPresentation('merge_anyway', view()).tip).toContain('who did it is recorded');
  });

  it('names start_anyway by what it does: Start now in Planning, Start when taking over from a person', () => {
    expect(actionPresentation('start_anyway', view({ status: 'planning' }))).toMatchObject({
      label: 'Start now',
      icon: 'machine',
    });
    const taken = actionPresentation(
      'start_anyway',
      view({ status: 'in_progress', implementer: 'ana@x.io' }),
    );
    expect(taken).toMatchObject({ label: 'Start', icon: 'machine' });
    expect(taken.tip).toBe('The machine takes over from ana@x.io');
  });

  it('names pick_up for Planning (main for a super), and for taking over', () => {
    expect(actionPresentation('pick_up', view({ status: 'planning', type: 'same' }))).toMatchObject(
      { label: 'Pick up', icon: 'human', placement: 'more' },
    );
    expect(
      actionPresentation('pick_up', view({ status: 'planning', type: 'super' })),
    ).toMatchObject({
      placement: 'main',
      tip: 'You pair on it with the product owner: copies the sstor command that opens the pairing session',
    });
    expect(
      actionPresentation('pick_up', view({ status: 'planning', type: 'same' }), true).placement,
    ).toBe('main');
    expect(
      actionPresentation('pick_up', view({ status: 'failed', implementer: 'bo@x.io' })).tip,
    ).toBe('You take it over from bo@x.io');
    expect(actionPresentation('take_over', view({ status: 'in_progress' }))).toMatchObject({
      label: 'Pick up',
      icon: 'human',
      placement: 'more',
    });
  });

  it('offers one Pick up: take_over when both are allowed', () => {
    expect(presentedActions(['start_again', 'pick_up', 'take_over'] as Action[])).toEqual(['start_again', 'take_over']);
    expect(presentedActions(['pick_up', 'start'] as Action[])).toEqual(['pick_up', 'start']);
    expect(presentedActions(['take_over'] as Action[])).toEqual(['take_over']);
  });

  it('names Discard the same way for every type', () => {
    for (const type of ['sub', 'same', 'super'] as const) {
      expect(actionPresentation('start_again', view({ type, status: 'pr_open', pr }))).toMatchObject({
        label: 'Discard and back to Planning',
        icon: null,
        placement: 'reset',
      });
    }
    expect(actionPresentation('start_again', view({ type: 'sub', pr })).tip).toBe(
      'Closes PR #63 and deletes the branch; the glob goes back to Planning and nothing starts',
    );
    expect(actionPresentation('start_again', view({ type: 'same', pr: null })).tip).toBe(
      'Deletes the branch; the glob goes back to Planning and nothing starts',
    );
  });

  it('labels the machine and human icons, and hides them where text says it', () => {
    expect(renderToStaticMarkup(createElement(ActorIcon, { actor: 'machine' }))).toContain(
      'aria-label="machine"',
    );
    expect(renderToStaticMarkup(createElement(ActorIcon, { actor: 'human' }))).toContain(
      'aria-label="human"',
    );
    expect(
      renderToStaticMarkup(createElement(ActorIcon, { actor: 'human', decorative: true })),
    ).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(createElement(ActorIcon, { actor: null }))).toBe('');
  });
});

describe('haltedBy (the confirmation before a take-over)', () => {
  const withRun = (state: string) => view({ currentRun: { state } as GlobView['currentRun'] });

  it('asks only when the run is active; a queued or standby run holds nothing unpushed', () => {
    expect(haltedBy(withRun('active'), 'take_over')).toEqual(['the machine run in progress']);
    expect(haltedBy(withRun('queued'), 'take_over')).toEqual([]);
    expect(haltedBy(withRun('watching'), 'take_over')).toEqual([]);
    expect(haltedBy(view({ currentRun: null }), 'take_over')).toEqual([]);
  });
});
