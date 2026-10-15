import { describe, expect, it } from 'vitest';
import { statusLine } from '../src/lib/status-line';
import { actionPresentation } from '../src/lib/action-presentation';
import { NOW } from '../../../packages/core/test/fixtures';
import { head, view } from './helpers/glob-views';

const queued = (mergeQueue: { position: number | null; state: 'queued' | 'merging' }, patch: Parameters<typeof view>[0] = {}) =>
  view({
    status: 'merging',
    pr: { number: 7, state: 'ready', headSha: head },
    headChecks: { sha: head, state: 'passed' },
    mergeQueue: { since: NOW, sha: head, ...mergeQueue },
    ...patch,
  });

describe('merge queue status line', () => {
  it('says how many PRs are ahead', () => {
    expect(statusLine(queued({ position: 3, state: 'queued' }), NOW)).toMatchObject({ kind: 'merging', full: 'in merge queue · 2 ahead' });
    expect(statusLine(queued({ position: 1, state: 'queued' }), NOW)?.full).toBe('in merge queue · 0 ahead');
  });

  it('drops the count when the position is unknown', () => {
    expect(statusLine(queued({ position: null, state: 'queued' }), NOW)?.full).toBe('in merge queue');
  });

  it('says merging once its group is being merged', () => {
    expect(statusLine(queued({ position: 1, state: 'merging' }), NOW)?.full).toBe('merging');
  });

  it('explains the queue in the tooltip and keeps the rollout suffix', () => {
    const line = statusLine(queued({ position: 2, state: 'queued' }), NOW);
    expect(line?.tip).toContain(`Merging ${head.slice(0, 7)}: in the merge queue.`);
    expect(line?.tip).toContain('GitHub tests it with the PRs ahead of it and merges it in order.');
    const humanSteps = [{ id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'], source: 'work' }] as never;
    expect(statusLine(queued({ position: 2, state: 'queued' }, { humanSteps }), NOW)?.tip).toContain('the rollout step comes after');
  });

  it('offers Cancel merge, whose tip mentions the queue', () => {
    expect(actionPresentation('cancel_merge', queued({ position: 2, state: 'queued' })).tip).toContain('merge queue');
  });
});
