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
  it('says Ready to merge for a ready same with passed checks', () => {
    const s = readyStatus(ready());
    expect(s).toMatchObject({ kind: 'ready', text: 'Ready to merge' });
    expect(s?.tip).toMatch(/passed at a2a88c8/);
    expect(s?.tip).toMatch(/--merge/);
    expect(s?.tip).not.toMatch(/auto-fix/);
  });

  it('mentions the watching session in the tooltip', () => {
    expect(readyStatus(ready({ type: 'super', runs: [run({ state: 'watching' })] }))?.tip).toMatch(/auto-fix/);
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
