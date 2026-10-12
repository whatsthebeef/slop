import { describe, expect, it } from 'vitest';
import type { DecisionAttributes } from '@slop/core';
import { VIEW_CHIPS, defaultChips, applyViewChips, loadChips, saveChips, toggleChip } from '../src/lib/board-view-chips';
import { glob } from '../../../packages/core/test/fixtures';

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'manual' },
  channel: 'human',
  outcome: null,
  ...patch,
});

const work = glob({ id: 's1t1', planner: 'dev@example.com' });
const decision = glob({ id: 's1k1', category: 'decision', type: 'same', planner: 'po@example.com', attributes: attributes() });
const archived = glob({ id: 's1k2', category: 'decision', type: 'same', status: 'signed_off', attributes: attributes({ archived: true }) });
const all = [work, decision, archived];

const memoryStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('board filter chips', () => {
  it('start from the role: developers and QA see work, POs decisions, admins both', () => {
    expect(defaultChips('dev')).toEqual(['work']);
    expect(defaultChips('qa')).toEqual(['work']);
    expect(defaultChips('po')).toEqual(['decisions']);
    expect(defaultChips('admin')).toEqual(['work', 'decisions']);
  });

  it('show the kinds the chips pick and never an archived decision', () => {
    expect(applyViewChips(all, ['work'], 'x').map((g) => g.id)).toEqual(['s1t1']);
    expect(applyViewChips(all, ['decisions'], 'x').map((g) => g.id)).toEqual(['s1k1']);
    expect(applyViewChips(all, ['work', 'decisions'], 'x').map((g) => g.id)).toEqual(['s1t1', 's1k1']);
    expect(applyViewChips(all, [], 'x').map((g) => g.id)).toEqual(['s1t1', 's1k1']);
  });

  it('narrow to my globs with Mine, across both kinds when neither kind chip is on', () => {
    expect(applyViewChips(all, ['mine'], 'po@example.com').map((g) => g.id)).toEqual(['s1k1']);
    expect(applyViewChips(all, ['mine'], 'dev@example.com').map((g) => g.id)).toEqual(['s1t1']);
    expect(applyViewChips(all, ['work', 'mine'], 'po@example.com')).toEqual([]);
  });

  it('toggle one chip at a time', () => {
    expect(toggleChip(['work'], 'mine')).toEqual(['work', 'mine']);
    expect(toggleChip(['work', 'mine'], 'work')).toEqual(['mine']);
  });

  it('are remembered per board, and fall back to the role when the store is empty, broken or blocked', () => {
    const store = memoryStore();
    expect(loadChips(1, 'po', store)).toEqual(['decisions']);
    saveChips(1, ['decisions', 'mine'], store);
    expect(loadChips(1, 'po', store)).toEqual(['decisions', 'mine']);
    expect(loadChips(2, 'dev', store)).toEqual(['work']);
    saveChips(1, [], store);
    expect(loadChips(1, 'admin', store)).toEqual([]);
    expect(loadChips(1, 'dev', memoryStore({ 'slop.board-chips.1': '{not json' }))).toEqual(['work']);
    expect(loadChips(1, 'dev', memoryStore({ 'slop.board-chips.1': '"work"' }))).toEqual(['work']);
    expect(loadChips(1, 'dev', memoryStore({ 'slop.board-chips.1': '["mine","bogus"]' }))).toEqual(['mine']);
    const blocked = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(loadChips(1, 'po', blocked)).toEqual(['decisions']);
    expect(() => saveChips(1, ['work'], blocked)).not.toThrow();
    expect(loadChips(1, 'dev', null)).toEqual(['work']);
  });

  it('offer exactly Work, Decisions and Mine', () => {
    expect(VIEW_CHIPS).toEqual(['work', 'decisions', 'mine']);
  });
});
