import { describe, expect, it } from 'vitest';
import { actionLine, statusLine } from '../src/lib/status-line';
import { cornerStatus, needsPerson } from '../src/lib/card-rows';
import { actionPresentation } from '../src/lib/action-presentation';
import { mainAction } from '../src/lib/main-action';
import { ACTION_PATHS } from '../src/lib/api';
import type { GlobView } from '../src/lib/api';
import { NOW } from '../../../packages/core/test/fixtures';
import { head, view } from './helpers/glob-views';

const prepared = (patch: Partial<GlobView> = {}, rounds = 1, outcome: null | { kind: 'done'; by: string; at: string } = null): GlobView =>
  view({
    id: 's1a1',
    category: 'action',
    type: null,
    pr: null,
    attributes: { assignee: null, outcome, preparation: { record: 'branch', rounds } },
    ...patch,
  });
const preparing = (rounds = 1) => prepared({ status: 'implementing', actionState: 'preparing', currentRun: null }, rounds);
const ready = () =>
  prepared({ status: 'pr_open', actionState: 'ready', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' } });
const recording = () =>
  prepared(
    { status: 'merging', actionState: 'recording', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' } },
    1,
    { kind: 'done', by: 'a@b.c', at: NOW },
  );
const failedPreparation = () =>
  prepared({ status: 'failed', actionState: 'preparation_failed', failure: { reason: 'The routine run timed out', at: NOW } });

describe('a prepared action', () => {
  it('is preparing with the machine, spinning, while the routine runs', () => {
    expect(actionLine(preparing())).toMatchObject({ state: 'preparing', icon: 'machine-spinning', text: 'preparing' });
    expect(actionLine(preparing(2))?.text).toBe('preparing · round 2');
    expect(statusLine(preparing(), NOW)).toMatchObject({ kind: 'action', text: 'preparing' });
    const corner = cornerStatus(preparing(), NOW);
    expect(corner).toMatchObject({ icon: 'machine-spinning', text: 'preparing' });
    expect(needsPerson(preparing(), NOW)).toBe(false);
  });

  it('is ready to run with a person once the routine marked it ready', () => {
    expect(actionLine(ready())).toMatchObject({ state: 'ready', icon: 'human', text: 'ready to run' });
    expect(cornerStatus(ready(), NOW)).toMatchObject({ icon: 'human', text: 'ready to run', click: { kind: 'section' } });
    expect(needsPerson(ready(), NOW)).toBe(true);
  });

  it('is recording with the machine while the branch merges after Done', () => {
    expect(actionLine(recording())).toMatchObject({ state: 'recording', icon: 'machine-spinning', text: 'recording' });
    expect(needsPerson(recording(), NOW)).toBe(false);
  });

  it('shows a failed preparation as a problem with Retry offered', () => {
    expect(actionLine(failedPreparation())).toMatchObject({ state: 'preparation_failed', icon: 'alert', text: 'preparation failed' });
    expect(statusLine(failedPreparation(), NOW)).toMatchObject({ kind: 'failure' });
    expect(statusLine(failedPreparation(), NOW)?.full).toContain('Preparation failed');
    expect(cornerStatus(failedPreparation(), NOW)).toMatchObject({ icon: 'alert' });
    expect(needsPerson(failedPreparation(), NOW)).toBe(true);
    const g = failedPreparation();
    expect(actionPresentation('prepare_action', g)).toMatchObject({ label: 'Retry', icon: 'machine' });
    expect(mainAction(['prepare_action', 'dismiss_action'], g)).toBe('prepare_action');
  });

  it('falls back to the attributes when an older API sends no actionState', () => {
    expect(actionLine(prepared({ status: 'implementing' }))?.state).toBe('preparing');
  });

  it('puts a real problem on its PR (failed checks) ahead of the state', () => {
    const g = prepared({
      status: 'pr_open',
      actionState: 'ready',
      pr: { number: 7, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'failed', failure: { name: 'Type check', step: null, lines: ['TS2322'], url: null } },
    });
    expect(statusLine(g, NOW)?.kind).toBe('checks');
    expect(cornerStatus(g, NOW)).toMatchObject({ icon: 'alert' });
  });

  it('says nothing special for a plain action, and no spinner while waiting to start', () => {
    const plain = view({ id: 's1a2', category: 'action', type: null, pr: null, attributes: { assignee: null, outcome: null } });
    expect(actionLine(plain)).toBeNull();
    expect(actionLine(prepared({ status: 'planning', actionState: 'waiting' }))).toBeNull();
    expect(needsPerson(prepared({ status: 'planning', actionState: 'waiting' }), NOW)).toBe(true);
  });

  it('presents Prepare, Done and Failed… with their actors, and Failed… has its own dialog', () => {
    expect(actionPresentation('prepare_action', prepared({ status: 'planning' }))).toMatchObject({ label: 'Prepare', icon: 'machine', placement: 'main' });
    expect(actionPresentation('complete_action', ready())).toMatchObject({ label: 'Done', icon: 'human' });
    expect(actionPresentation('fail_action', ready())).toMatchObject({ label: 'Failed…', placement: 'more' });
    expect(ACTION_PATHS.fail_action).toBeNull();
    expect(ACTION_PATHS.prepare_action).toBe('prepare');
    expect(mainAction(['complete_action', 'fail_action', 'dismiss_action'], ready())).toBe('complete_action');
  });
});
