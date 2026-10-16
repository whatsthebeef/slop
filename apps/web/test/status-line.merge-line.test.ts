import { describe, expect, it } from 'vitest';
import { actionPresentation, statusLine } from '@slop/core';
import { NOW } from '../../../packages/core/test/fixtures';
import { presentOf } from '../src/lib/present';
import { head, view } from './helpers/glob-views';

const inLine = (patch: Parameters<typeof view>[0] = {}) =>
  view({
    status: 'merging',
    pr: { number: 7, state: 'ready', headSha: head },
    headChecks: { sha: head, state: 'passed' },
    mergeLine: { joinedAt: NOW },
    ...patch,
  });
const waiting = (position: number, ahead: string[]) => inLine({ mergeLinePlace: { position, ahead } });

describe('merge line status line', () => {
  it('says next to merge for the glob behind the head', () => {
    expect(statusLine(waiting(2, ['s1t1']), NOW)).toMatchObject({ kind: 'merging', full: 'next to merge' });
  });

  it('says how many are ahead and names them in the tooltip', () => {
    const line = statusLine(waiting(4, ['s1t1', 's1t2', 's1t3']), NOW);
    expect(line?.full).toBe('3 ahead in the merge line');
    for (const id of ['s1t1', 's1t2', 's1t3']) expect(line?.tip).toContain(id);
  });

  it('reads merging for the head, and running checks while its checks run', () => {
    const merging = inLine({ mergeLine: { joinedAt: NOW, head: { since: NOW } }, mergeLinePlace: { position: 1, ahead: [] } });
    expect(statusLine(merging, NOW)?.full).toBe('merging');
    const checking = inLine({
      mergeLine: { joinedAt: NOW, head: { since: NOW } },
      mergeLinePlace: { position: 1, ahead: [] },
      headChecks: { sha: head, state: 'pending' },
    });
    expect(statusLine(checking, NOW)?.full).toBe('running checks');
  });

  it('has no primary action for a glob in the line', () => {
    expect(presentOf(waiting(3, ['s1t1', 's1t2']), { now: NOW }).primary).toBeNull();
  });

  it('offers Cancel merge, whose tip mentions the merge line', () => {
    expect(actionPresentation('cancel_merge', waiting(2, ['s1t1'])).tip).toContain('merge line');
  });
});
