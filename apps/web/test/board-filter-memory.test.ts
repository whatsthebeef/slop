import { describe, expect, it } from 'vitest';
import {
  clearFilterMemory,
  filterParams,
  hasFilterParams,
  loadFilterMemory,
  saveFilterMemory,
  type FilterStore,
} from '../src/lib/board-filter-memory';

const fake = (): FilterStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const throwing: FilterStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('board filter memory', () => {
  it('keeps only the filters of a query', () => {
    expect(filterParams(new URLSearchParams('mode=sub&glob=s1&id=s2')).toString()).toBe(
      'mode=sub&id=s2',
    );
    expect(hasFilterParams(new URLSearchParams('glob=s1'))).toBe(false);
    expect(hasFilterParams(new URLSearchParams('mode=all'))).toBe(true);
  });

  it('saves and loads per board', () => {
    const store = fake();
    saveFilterMemory(store, 1, new URLSearchParams('mode=sub&glob=s1'));
    expect(store.data.get('slop.board-filters.1')).toBe('mode=sub');
    expect(loadFilterMemory(store, 1)?.toString()).toBe('mode=sub');
    expect(loadFilterMemory(store, 2)).toBeNull();
  });

  it('forgets when cleared or when saving a query without filters', () => {
    const store = fake();
    saveFilterMemory(store, 1, new URLSearchParams('id=s1'));
    clearFilterMemory(store, 1);
    expect(loadFilterMemory(store, 1)).toBeNull();
    saveFilterMemory(store, 1, new URLSearchParams('id=s1'));
    saveFilterMemory(store, 1, new URLSearchParams());
    expect(loadFilterMemory(store, 1)).toBeNull();
  });

  it('survives a missing or throwing store', () => {
    for (const store of [undefined, throwing]) {
      expect(() => saveFilterMemory(store, 1, new URLSearchParams('id=s1'))).not.toThrow();
      expect(() => clearFilterMemory(store, 1)).not.toThrow();
      expect(loadFilterMemory(store, 1)).toBeNull();
    }
  });

  it('ignores junk in storage', () => {
    const store = fake();
    store.data.set('slop.board-filters.1', 'glob=s1&x=y');
    expect(loadFilterMemory(store, 1)).toBeNull();
  });
});
