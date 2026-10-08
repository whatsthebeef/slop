import { describe, expect, it } from 'vitest';
import { describeEditFailure } from '../src/domain/edit-failure.js';
import * as m from '../src/domain/machine.js';
import { glob, run } from './fixtures.js';

describe('describeEditFailure', () => {
  it('passes the server message through for a refusal', () => {
    expect(describeEditFailure({ code: 'invalid_transition', message: 'Nope' }, 's1t1')).toEqual({ kind: 'refused', message: 'Nope' });
  });
  it('names a version conflict and says the edits are kept', () => {
    const failure = describeEditFailure({ code: 'version_conflict', message: 'x', current: {} }, 's1t1');
    expect(failure.kind).toBe('conflict');
    expect(failure.message).toContain('s1t1 changed meanwhile');
  });
  it('falls back when there is no message', () => {
    expect(describeEditFailure(undefined, 's1t1').message).toBe('The change could not be saved');
  });
});

describe('typeUnavailableReason', () => {
  it('explains a same that cannot become a super while planning', () => {
    expect(m.typeUnavailableReason(glob({ type: 'same', status: 'planning' }), 'super')).toMatch(/human is implementing/);
  });
  it('allows the swap while a human implements with no live run', () => {
    expect(m.typeUnavailableReason(glob({ type: 'same', status: 'in_progress' }), 'super')).toBeNull();
  });
  it('refuses the swap with a live run', () => {
    expect(m.typeUnavailableReason(glob({ type: 'same', status: 'in_progress', runs: [run({ state: 'active' })] }), 'super')).not.toBeNull();
  });
  it('limits same to sub to planning', () => {
    expect(m.typeUnavailableReason(glob({ type: 'same', status: 'planning' }), 'sub')).toBeNull();
    expect(m.typeUnavailableReason(glob({ type: 'same', status: 'in_progress' }), 'sub')).not.toBeNull();
  });
  it('is null for the current type', () => {
    expect(m.typeUnavailableReason(glob({ type: 'same' }), 'same')).toBeNull();
  });
});
