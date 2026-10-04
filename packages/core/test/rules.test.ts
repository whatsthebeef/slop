import { describe, expect, it } from 'vitest';
import { formatId, letterOf, parseId } from '../src/domain/ids.js';
import { isValidCombination, listOf } from '../src/domain/matrix.js';

describe('type/category matrix', () => {
  it.each([
    ['sub', 'feature', false],
    ['same', 'feature', true],
    ['super', 'feature', true],
    ['sub', 'task', true],
    ['same', 'task', true],
    ['super', 'task', true],
    ['sub', 'bug', true],
    ['same', 'bug', true],
    ['super', 'bug', false],
  ] as const)('%s %s → %s', (type, category, expected) => {
    expect(isValidCombination(type, category)).toBe(expected);
  });
});

describe('IDs', () => {
  it('formats and parses board, letter and number', () => {
    expect(formatId(1, letterOf('feature'), 12)).toBe('s1f12');
    expect(formatId(2, letterOf('bug'), 3)).toBe('s2b3');
    expect(parseId('s12t4')).toEqual({ boardId: 12, letter: 't', n: 4 });
    expect(parseId('s1x4')).toBeNull();
    expect(parseId('s0t4')).toBeNull();
    expect(parseId('feature/s1t4')).toBeNull();
  });
});

describe('lists', () => {
  it('projects statuses onto the four lists', () => {
    expect(listOf('planning')).toBe('planning');
    expect(listOf('merging')).toBe('doing');
    expect(listOf('failed')).toBe('doing');
    expect(listOf('reviewing')).toBe('reviewing');
    expect(listOf('signed_off')).toBe('signed_off');
  });
});
