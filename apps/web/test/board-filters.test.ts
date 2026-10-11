import { describe, expect, it } from 'vitest';
import type { DecisionAttributes } from '@slop/core';
import { BOARD_FILTERS, defaultFilters, filterGlobs, loadFilters, saveFilters, toggleFilter } from '../src/lib/board-filters';
import { glob } from '../../../packages/core/test/fixtures';

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  source: { kind: 'manual' },
  channel: 'human',
  kbItemId: null,
  outcome: null,
  ...patch,
});

const work = glob({ id: 's1t1', planner: 'dev@example.com' });
const decision = glob({ id: 's1d1', category: 'decision', type: 'same', planner: 'po@example.com', attributes: attributes() });
const archived = glob({ id: 's1d2', category: 'decision', type: 'same', status: 'signed_off', attributes: attributes({ archived: true }) });
const all = [work, decision, archived];

const memoryStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('board filter chips', () => {
  it('start from the role: developers and QA see work, POs decisions, admins both', () => {
    expect(defaultFilters('dev')).toEqual(['work']);
    expect(defaultFilters('qa')).toEqual(['work']);
    expect(defaultFilters('po')).toEqual(['decisions']);
    expect(defaultFilters('admin')).toEqual(['work', 'decisions']);
  });

  it('show the kinds the chips pick and never an archived decision', () => {
    expect(filterGlobs(all, ['work'], 'x').map((g) => g.id)).toEqual(['s1t1']);
    expect(filterGlobs(all, ['decisions'], 'x').map((g) => g.id)).toEqual(['s1d1']);
    expect(filterGlobs(all, ['work', 'decisions'], 'x').map((g) => g.id)).toEqual(['s1t1', 's1d1']);
    expect(filterGlobs(all, [], 'x').map((g) => g.id)).toEqual(['s1t1', 's1d1']);
  });

  it('narrow to my globs with Mine, across both kinds when neither kind chip is on', () => {
    expect(filterGlobs(all, ['mine'], 'po@example.com').map((g) => g.id)).toEqual(['s1d1']);
    expect(filterGlobs(all, ['mine'], 'dev@example.com').map((g) => g.id)).toEqual(['s1t1']);
    expect(filterGlobs(all, ['work', 'mine'], 'po@example.com')).toEqual([]);
  });

  it('toggle one chip at a time', () => {
    expect(toggleFilter(['work'], 'mine')).toEqual(['work', 'mine']);
    expect(toggleFilter(['work', 'mine'], 'work')).toEqual(['mine']);
  });

  it('are remembered per board, and fall back to the role when the store is empty, broken or blocked', () => {
    const store = memoryStore();
    expect(loadFilters(1, 'po', store)).toEqual(['decisions']);
    saveFilters(1, ['decisions', 'mine'], store);
    expect(loadFilters(1, 'po', store)).toEqual(['decisions', 'mine']);
    expect(loadFilters(2, 'dev', store)).toEqual(['work']);
    saveFilters(1, [], store);
    expect(loadFilters(1, 'admin', store)).toEqual([]);
    expect(loadFilters(1, 'dev', memoryStore({ 'slop.board-filters.1': '{not json' }))).toEqual(['work']);
    expect(loadFilters(1, 'dev', memoryStore({ 'slop.board-filters.1': '"work"' }))).toEqual(['work']);
    expect(loadFilters(1, 'dev', memoryStore({ 'slop.board-filters.1': '["mine","bogus"]' }))).toEqual(['mine']);
    const blocked = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(loadFilters(1, 'po', blocked)).toEqual(['decisions']);
    expect(() => saveFilters(1, ['work'], blocked)).not.toThrow();
    expect(loadFilters(1, 'dev', null)).toEqual(['work']);
  });

  it('offer exactly Work, Decisions and Mine', () => {
    expect(BOARD_FILTERS).toEqual(['work', 'decisions', 'mine']);
  });
});
