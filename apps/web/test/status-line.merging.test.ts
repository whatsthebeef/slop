import { describe, expect, it } from 'vitest';
import { statusLine } from '../src/lib/status-line';
import { NOW } from '../../../packages/core/test/fixtures';
import { head, top, view } from './helpers/glob-views';

const merging = (patch: Parameters<typeof view>[0] = {}) =>
  view({ status: 'merging', pr: { number: 7, state: 'ready', headSha: head }, ...patch });
const staleRunFailure = { reason: 'Routine run failed', at: NOW };

describe('merging status line', () => {
  it('says checks are running while the head awaits its checks, never an earlier run failure', () => {
    for (const headChecks of [null, { sha: head, state: 'pending' as const }]) {
      const g = merging({ failure: staleRunFailure, headChecks });
      expect(statusLine(g, NOW)).toMatchObject({
        kind: 'merging',
        full: 'merging · checks running',
      });
      expect(top(g)).toMatchObject({ kind: 'merging' });
      expect(JSON.stringify(top(g))).not.toContain('run failed');
    }
  });

  it('says it is updating with the base when the head is newer than the recorded checks', () => {
    const g = merging({ headChecks: { sha: 'aaaaaaa1111', state: 'passed' } });
    expect(statusLine(g, NOW)).toMatchObject({
      kind: 'merging',
      full: 'merging · updating with main',
    });
  });

  it('says just merging while the squash merge runs, with the head in the tooltip', () => {
    const g = merging({ headChecks: { sha: head, state: 'passed' } });
    const line = statusLine(g, NOW);
    expect(line).toMatchObject({ kind: 'merging', full: 'merging' });
    expect(line?.tip).toContain(head.slice(0, 7));
    expect(line?.tip).toContain('merges by itself');
  });

  it("doesn't show a failure that predates the merge, and leaves failed globs unchanged", () => {
    expect(statusLine(merging({ failure: staleRunFailure }), NOW)?.kind).toBe('merging');
    const failed = view({ status: 'failed', failure: staleRunFailure });
    expect(statusLine(failed, NOW)).toMatchObject({ kind: 'failure' });
  });
});
