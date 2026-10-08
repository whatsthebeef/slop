import { describe, expect, it } from 'vitest';
import { describeEditFailure } from '../src/domain/edit-failure.js';

describe('describeEditFailure', () => {
  it("shows the server's reason for a refused change", () => {
    expect(describeEditFailure({ code: 'invalid_transition', message: 'Sames and supers can only be swapped in planning' })).toEqual({
      message: 'Sames and supers can only be swapped in planning',
      conflict: false,
    });
  });

  it('treats a version conflict as a reload prompt', () => {
    const failure = describeEditFailure({ code: 'version_conflict', message: 'x', current: { id: 's1t1' } });
    expect(failure.conflict).toBe(true);
    expect(failure.message).toContain('changed while you were editing');
  });

  it('falls back when there is no message', () => {
    expect(describeEditFailure(undefined)).toEqual({ message: 'The change was refused', conflict: false });
    expect(describeEditFailure({ code: 'x', message: '  ' }).message).toBe('The change was refused');
  });
});
