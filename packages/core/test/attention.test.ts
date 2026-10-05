import { describe, expect, it } from 'vitest';
import { isMine, needsHuman } from '../src/domain/attention.js';
import { glob } from './fixtures.js';

describe('needs a human', () => {
  it('counts failed globs and globs with a failure recorded', () => {
    expect(needsHuman(glob({ status: 'failed' }))).toBe(true);
    expect(needsHuman(glob({ status: 'in_progress', failure: { at: '2026-10-05T00:00:00.000Z', reason: 'x' } }))).toBe(true);
  });

  it('counts sames and supers whose PR is ready to merge, not subs', () => {
    const pr = { number: 1, state: 'ready' as const, headSha: 'abc' };
    expect(needsHuman(glob({ status: 'pr_open', type: 'same', pr }))).toBe(true);
    expect(needsHuman(glob({ status: 'pr_open', type: 'super', pr }))).toBe(true);
    expect(needsHuman(glob({ status: 'pr_open', type: 'sub', pr }))).toBe(false);
    expect(needsHuman(glob({ status: 'pr_open', type: 'same', pr: { ...pr, state: 'draft' } }))).toBe(false);
  });

  it('counts reviews waiting on the reviewer (required) or the developer (items added)', () => {
    expect(needsHuman(glob({ status: 'reviewing', labels: { QA: 'required' } }))).toBe(true);
    expect(needsHuman(glob({ status: 'reviewing', labels: { QA: 'added' } }))).toBe(true);
  });

  it('leaves fully approved reviews and signed-off globs alone', () => {
    const approved = { FR: 'approved', CR: 'approved', QA: 'approved' } as const;
    expect(needsHuman(glob({ status: 'reviewing', labels: approved }))).toBe(false);
    expect(needsHuman(glob({ status: 'signed_off', labels: approved }))).toBe(false);
  });

  it('leaves work in progress and planning alone', () => {
    expect(needsHuman(glob({ status: 'in_progress' }))).toBe(false);
    expect(needsHuman(glob({ status: 'planning' }))).toBe(false);
  });

  it('counts a glob as yours when you planned it or are implementing it', () => {
    expect(isMine(glob({ planner: 'a@x.com', implementer: null }), 'a@x.com')).toBe(true);
    expect(isMine(glob({ planner: 'b@x.com', implementer: 'a@x.com' }), 'a@x.com')).toBe(true);
    expect(isMine(glob({ planner: 'b@x.com', implementer: 'c@x.com' }), 'a@x.com')).toBe(false);
  });
});
