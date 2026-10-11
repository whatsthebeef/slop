import { describe, expect, it } from 'vitest';
import { LONG_DIFF, visibleLines } from '../src/components/diff-view';

const lines = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('the diff view collapse', () => {
  it('keeps a short diff whole, expanded or not', () => {
    expect(visibleLines(lines(LONG_DIFF), false)).toHaveLength(LONG_DIFF);
    expect(visibleLines(lines(3), false)).toHaveLength(3);
  });

  it('cuts a long diff to the first lines until it is expanded', () => {
    expect(visibleLines(lines(LONG_DIFF + 10), false)).toHaveLength(LONG_DIFF);
    expect(visibleLines(lines(LONG_DIFF + 10), true)).toHaveLength(LONG_DIFF + 10);
    expect(visibleLines(lines(12), false, 5)).toEqual([0, 1, 2, 3, 4]);
  });
});
