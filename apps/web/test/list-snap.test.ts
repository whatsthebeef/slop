import { describe, expect, it } from 'vitest';
import { LIST_GAP_PX, listScrollLeft, visibleListIndex } from '../src/lib/list-snap';

describe('list snap', () => {
  it('reports the list nearest the row edge', () => {
    const step = 366 + LIST_GAP_PX;
    expect(visibleListIndex(0, 366, 4)).toBe(0);
    expect(visibleListIndex(step * 0.4, 366, 4)).toBe(0);
    expect(visibleListIndex(step * 0.6, 366, 4)).toBe(1);
    expect(visibleListIndex(step * 3, 366, 4)).toBe(3);
  });

  it('stays within the lists', () => {
    expect(visibleListIndex(-20, 366, 4)).toBe(0);
    expect(visibleListIndex(99999, 366, 4)).toBe(3);
    expect(visibleListIndex(100, 0, 4)).toBe(0);
    expect(visibleListIndex(100, 366, 0)).toBe(0);
  });

  it('scrolls to a list boundary that reads back as that list', () => {
    for (const i of [0, 1, 2, 3]) expect(visibleListIndex(listScrollLeft(i, 366), 366, 4)).toBe(i);
  });
});
