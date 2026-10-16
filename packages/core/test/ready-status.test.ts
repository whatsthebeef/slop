import { describe, expect, it } from 'vitest';
import { readyStatus } from '../src/domain/readiness.js';
import { NOW, glob, run } from './fixtures.js';

const head = 'a2a88c8aaaa';
const ready = (patch = {}) =>
  glob({
    status: 'pr_open',
    pr: { number: 49, state: 'ready', headSha: head },
    headChecks: { sha: head, state: 'passed' },
    ...patch,
  });

describe('readyStatus', () => {
  it('says Merge (your turn) for a ready same with passed checks', () => {
    const s = readyStatus(ready());
    expect(s).toMatchObject({ kind: 'ready', text: 'Merge' });
    expect(s?.tip).toMatch(/^Merge: checks passed at a2a88c8/);
    expect(s?.tip).toMatch(/--merge/);
    expect(s?.tip).not.toMatch(/auto-fix/);
  });

  it('says Merge for a same with open rollout steps, whose tip says it stays open', () => {
    const s = readyStatus(ready(), null, { rolloutSteps: 2 });
    expect(s).toMatchObject({ kind: 'ready', text: 'Merge' });
    expect(s?.tip).toMatch(/^Merge: checks passed/);
    expect(readyStatus(ready(), null, { rolloutSteps: 0 })?.text).toBe('Merge');
  });

  it('adds the escalation reason to the tooltip', () => {
    const escalation = { reason: 'touches auth', criterion: 'auth_permissions', by: 'agent', at: NOW };
    expect(readyStatus(ready({ escalation }))?.tip).toMatch(/Needs a person because: touches auth/);
  });

  it('keeps a watching run out of the tooltip and hides the chip while a fix run is active', () => {
    expect(readyStatus(ready({ runs: [run({ state: 'watching' })] }))?.tip).not.toMatch(/auto-fix/);
    expect(readyStatus(ready({ runs: [run({ state: 'active' })] }))).toBeNull();
  });

  it('says Waiting for checks while checks are pending or missing', () => {
    expect(readyStatus(ready({ headChecks: { sha: head, state: 'pending' } }))).toMatchObject({ kind: 'waiting', text: 'Waiting for checks' });
    expect(readyStatus(ready({ headChecks: null }))?.text).toBe('Waiting for checks');
  });

  it('leaves subs unchanged', () => {
    expect(readyStatus(ready({ type: 'sub' }))).toBeNull();
  });

  it('gives way to failures, failed checks and conflicts', () => {
    expect(readyStatus(ready({ failure: { reason: 'boom', at: NOW } }))).toBeNull();
    expect(readyStatus(ready({ headChecks: { sha: head, state: 'failed' } }))).toBeNull();
    expect(readyStatus(ready({ conflict: { base: 'main', files: [], since: null, at: NOW } }))).toBeNull();
  });

  it('is null for a draft PR', () => {
    expect(readyStatus(ready({ pr: { number: 49, state: 'draft', headSha: head } }))).toBeNull();
  });

  it('notes a local review older than the head', () => {
    expect(readyStatus(ready(), '32c54ddffff')?.tip).toMatch(/Local review is from 32c54dd, before the latest push\./);
    expect(readyStatus(ready(), head)?.tip).not.toMatch(/Local review/);
  });
});
