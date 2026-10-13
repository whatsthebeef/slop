import { describe, expect, it } from 'vitest';
import { decideTitle } from '../src/lib/title-edit';

describe('decideTitle', () => {
  it('saves the trimmed title', () => {
    expect(decideTitle('Old', '  New title  ')).toEqual({ kind: 'save', title: 'New title' });
  });
  it('refuses an empty or whitespace-only title', () => {
    expect(decideTitle('Old', '')).toEqual({ kind: 'empty' });
    expect(decideTitle('Old', '   ')).toEqual({ kind: 'empty' });
  });
  it('sends nothing when the title is unchanged', () => {
    expect(decideTitle('Old', 'Old')).toEqual({ kind: 'unchanged' });
    expect(decideTitle('Old', ' Old ')).toEqual({ kind: 'unchanged' });
  });
});
