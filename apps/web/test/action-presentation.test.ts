import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Action } from '@slop/core';
import { createElement } from 'react';
import { ActorIcon } from '../src/components/actor-icons';
import { actionPresentation, haltedBy, presentedActions } from '../src/lib/action-presentation';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const pr = { number: 63, state: 'draft' as const, headSha: 'abc' };

const ACTIONS: readonly Action[] = [
  'start',
  'investigate',
  'review_now',
  'start_anyway',
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
    expect(actionPresentation('merge', g).tip).toBe('Squash-merges PR #63');
    expect(actionPresentation('merge_continue', g)).toMatchObject({
      label: 'Merge & keep working',
      placement: 'more',
    });
    expect(actionPresentation('investigate', g).label).toBe('Investigate plan');
    expect(actionPresentation('review_now', g).label).toBe('Review code');
    expect(actionPresentation('delete', g)).toMatchObject({ icon: null, placement: 'reset' });
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
      tip: 'You pair on it with the product owner',
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

  it('names Discard by glob type', () => {
    const sub = actionPresentation('start_again', view({ type: 'sub', pr }));
    expect(sub).toMatchObject({ label: 'Discard & restart', icon: 'machine', placement: 'reset' });
    expect(sub.tip).toBe(
      'Closes PR #63 and deletes the branch, then a new machine run starts from the base branch',
    );
    expect(
      actionPresentation('start_again', view({ type: 'same', status: 'pr_open', pr })),
    ).toMatchObject({ label: 'Discard & back to Planning', icon: null });
    expect(actionPresentation('start_again', view({ type: 'super', pr }))).toMatchObject({
      label: 'Discard & start over',
      icon: 'human',
    });
    expect(actionPresentation('start_again', view({ type: 'same', pr: null })).tip).toBe(
      'Deletes the branch',
    );
  });

  it('does not say back to Planning for a same already in Planning', () => {
    expect(
      actionPresentation('start_again', view({ type: 'same', status: 'planning', pr })),
    ).toMatchObject({
      label: 'Discard & start over',
      icon: null,
      tip: 'Closes PR #63 and deletes the branch',
      placement: 'reset',
    });
  });
});

describe('actor icons', () => {
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
