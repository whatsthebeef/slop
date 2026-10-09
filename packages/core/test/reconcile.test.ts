import { describe, expect, it } from 'vitest';
import * as m from '../src/domain/machine.js';
import { RECONCILE_CHECKS_AFTER_MS, RECONCILE_WATCHING_AFTER_MS, reconcileDue } from '../src/domain/reconcile.js';
import { NOW, ctx, glob, run } from './fixtures.js';

const ready = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
const at = (ms: number) => new Date(Date.parse(NOW) + ms).getTime();

describe('reconcile after missed webhooks', () => {
  it('queues one re-read for a glob with an open PR, and nothing otherwise', () => {
    const effect = [{ kind: 'reconcile_pr', globId: 's1t1', generation: 1 }];
    for (const status of ['implementing', 'in_progress', 'pr_open', 'merging'] as const) {
      const result = m.reconcileRequested(glob({ status, pr: ready }), ctx(null));
      expect(result.ok && result.value.effects).toEqual(effect);
    }
    for (const g of [
      glob({ status: 'pr_open', pr: null }),
      glob({ status: 'pr_open', pr: { ...ready, state: 'closed' } }),
      glob({ status: 'reviewing', pr: ready }),
      glob({ status: 'failed', pr: ready }),
    ]) {
      const result = m.reconcileRequested(g, ctx(null));
      expect(result.ok && result.value.effects).toEqual([]);
    }
  });

  it('the sweep picks a ready PR with no check result for this head after 10 minutes', () => {
    const g = glob({ status: 'pr_open', pr: ready, headChecks: null, updatedAt: NOW });
    expect(reconcileDue(g, at(RECONCILE_CHECKS_AFTER_MS - 1))).toBe(false);
    expect(reconcileDue(g, at(RECONCILE_CHECKS_AFTER_MS + 1))).toBe(true);
    expect(reconcileDue({ ...g, headChecks: { sha: 'abc1234', state: 'pending' } }, at(RECONCILE_CHECKS_AFTER_MS + 1))).toBe(true);
    // A result for an older head doesn't count.
    expect(reconcileDue({ ...g, headChecks: { sha: 'old', state: 'passed' } }, at(RECONCILE_CHECKS_AFTER_MS + 1))).toBe(true);
  });

  it('leaves alone globs that are recent, checked, drafts or finished', () => {
    const later = at(RECONCILE_CHECKS_AFTER_MS * 2);
    const checked = glob({ status: 'pr_open', pr: ready, headChecks: { sha: 'abc1234', state: 'passed' }, updatedAt: NOW });
    expect(reconcileDue(checked, later)).toBe(false);
    expect(reconcileDue({ ...checked, headChecks: null, pr: { ...ready, state: 'draft' } }, later)).toBe(false);
    expect(reconcileDue({ ...checked, headChecks: null, status: 'reviewing' }, later)).toBe(false);
  });

  it('the sweep picks a glob a run is watching once nothing has changed for an hour', () => {
    const g = glob({ status: 'pr_open', pr: ready, headChecks: { sha: 'abc1234', state: 'passed' }, runs: [run({ state: 'watching' })], updatedAt: NOW });
    expect(reconcileDue(g, at(RECONCILE_WATCHING_AFTER_MS - 1))).toBe(false);
    expect(reconcileDue(g, at(RECONCILE_WATCHING_AFTER_MS + 1))).toBe(true);
  });
});
