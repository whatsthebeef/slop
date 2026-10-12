import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  activeCount,
  matchesFilters,
  parseFilters,
  toggleOption,
  writeFilters,
  BOARD_FILTERS,
} from '../src/lib/board-filters';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView>): GlobView => ({ ...glob(), ...patch }) as GlobView;
const parse = (q: string) => parseFilters(new URLSearchParams(q));

describe('board filters', () => {
  it('passes every glob when no filter is on', () => {
    expect(matchesFilters(view({ category: 'bug' }), {})).toBe(true);
    expect(matchesFilters(view({ category: 'bug' }), parse('category=&id='))).toBe(true);
    expect(activeCount({})).toBe(0);
  });

  it('matches any of several categories', () => {
    const values = parse('category=feature,bug');
    expect(matchesFilters(view({ category: 'feature' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'bug' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'task' }), values)).toBe(false);
    expect(matchesFilters(view({ category: 'decision' }), parse('category=decision'))).toBe(true);
    expect(matchesFilters(view({ category: 'bug' }), parse('category=decision'))).toBe(false);
  });

  it('ignores unknown categories and keeps a stable order', () => {
    expect(parse('category=bug,nope,Feature,bug')).toEqual({ category: 'feature,bug' });
    expect(parse('category=nope')).toEqual({});
  });

  it('matches IDs by case-insensitive substring', () => {
    expect(matchesFilters(view({ id: 's15f4' }), parse('id=F4'))).toBe(true);
    expect(matchesFilters(view({ id: 's15f40' }), parse('id=f4'))).toBe(true);
    expect(matchesFilters(view({ id: 's15f44' }), parse('id=s15f44'))).toBe(true);
    expect(matchesFilters(view({ id: 's15f4' }), parse('id=s15f44'))).toBe(false);
  });

  it('matches any of several IDs separated by commas or spaces', () => {
    const values = parse('id=f4, t2 b9');
    expect(matchesFilters(view({ id: 's1f4' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1t2' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b9' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b1' }), values)).toBe(false);
  });

  it('requires every active filter', () => {
    const values = parse('category=bug&id=b1');
    expect(matchesFilters(view({ id: 's1b1', category: 'bug' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b1', category: 'task' }), values)).toBe(false);
    expect(matchesFilters(view({ id: 's1b2', category: 'bug' }), values)).toBe(false);
    expect(activeCount(values)).toBe(2);
  });

  it('round-trips through the query and leaves other parameters alone', () => {
    const values = parse('category=feature,bug&id=f4');
    const params = writeFilters(new URLSearchParams('glob=s1t1&category=task'), values);
    expect(params.get('glob')).toBe('s1t1');
    expect(parseFilters(params)).toEqual(values);
    expect(writeFilters(params, {}).toString()).toBe('glob=s1t1');
  });

  it('toggles a category option on and off', () => {
    const [category] = BOARD_FILTERS;
    if (category === undefined) throw new Error('No filters');
    expect(toggleOption(category, '', 'bug')).toBe('bug');
    expect(toggleOption(category, 'bug', 'feature')).toBe('feature,bug');
    expect(toggleOption(category, 'feature,bug', 'feature')).toBe('bug');
    expect(toggleOption(category, 'bug', 'bug')).toBe('');
  });
});
