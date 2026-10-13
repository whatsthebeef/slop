import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  activeCount,
  defaultFilters,
  matchesFilters,
  parseFilters,
  toggleOption,
  writeFilters,
  stalledCount,
  yourTurnCount,
  BOARD_FILTERS,
} from '../src/lib/board-filters';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView>): GlobView => ({ ...glob(), ...patch }) as GlobView;
const parse = (q: string) => parseFilters(new URLSearchParams(q));

describe('board filters', () => {
  it('passes every glob when no filter is on', () => {
    expect(matchesFilters(view({ category: 'decision' }), {})).toBe(true);
    expect(matchesFilters(view({ category: 'decision' }), parse('category=all'))).toBe(true);
  });

  it('defaults to feature, task and bug, hiding decisions', () => {
    const values = parse('');
    expect(values).toEqual({ category: 'feature,task,bug' });
    expect(values).toEqual(defaultFilters());
    expect(matchesFilters(view({ category: 'task' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'decision' }), values)).toBe(false);
    expect(parse('category=&id=')).toEqual(values);
    expect(activeCount(values)).toBe(0);
  });

  it('keeps "show all" distinct from the default across a reload', () => {
    const params = writeFilters(new URLSearchParams('glob=s1t1'), {});
    expect(params.toString()).toBe('glob=s1t1&category=all');
    expect(parse('category=all')).toEqual({});
    expect(activeCount(parseFilters(params))).toBe(1);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('writes an explicit selection and reads it back', () => {
    const params = writeFilters(new URLSearchParams(), { category: 'decision' });
    expect(params.toString()).toBe('category=decision');
    expect(parseFilters(params)).toEqual({ category: 'decision' });
    expect(activeCount({ category: 'decision' })).toBe(1);
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
    expect(parse('category=nope')).toEqual(defaultFilters());
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

  it('matches titles by case-insensitive substring', () => {
    const v = view({ id: 's1t1', title: 'File attachments on globs' });
    expect(matchesFilters(v, parse('id=ATTACH'))).toBe(true);
    expect(matchesFilters(v, parse('id=nothing'))).toBe(false);
    expect(matchesFilters(v, parse('id=f4, attach'))).toBe(true);
  });

  it('matches a multi-word phrase against a title', () => {
    const v = view({ id: 's1t1', title: 'File attachments on globs' });
    expect(matchesFilters(v, parse('id=file attach'))).toBe(true);
    expect(matchesFilters(v, parse('id=attach file'))).toBe(true);
    expect(matchesFilters(v, parse('id=zzz qqq'))).toBe(false);
  });

  it('treats a blank value as off', () => {
    expect(parse('id=%20')).toEqual(defaultFilters());
  });

  it('requires every active filter', () => {
    const values = parse('category=bug&id=b1');
    expect(matchesFilters(view({ id: 's1b1', category: 'bug' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b1', category: 'task' }), values)).toBe(false);
    expect(matchesFilters(view({ id: 's1b2', category: 'bug' }), values)).toBe(false);
    expect(activeCount(values)).toBe(2);
    expect(activeCount({ ...defaultFilters(), id: 'b1' })).toBe(1);
  });

  it('round-trips through the query and leaves other parameters alone', () => {
    const values = parse('category=feature,bug&id=f4');
    const params = writeFilters(new URLSearchParams('glob=s1t1&category=task'), values);
    expect(params.get('glob')).toBe('s1t1');
    expect(parseFilters(params)).toEqual(values);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('toggles a category option on and off', () => {
    const [category] = BOARD_FILTERS;
    if (category === undefined) throw new Error('No filters');
    expect(toggleOption(category, '', 'bug')).toBe('bug');
    expect(toggleOption(category, 'bug', 'feature')).toBe('feature,bug');
    expect(toggleOption(category, 'feature,bug', 'feature')).toBe('bug');
    expect(toggleOption(category, 'bug', 'bug')).toBe('');
  });

  describe('human step filters', () => {
    const step = (patch: Record<string, unknown>) => ({ id: 'x', kind: 'merge', title: 'T', state: 'due', who: 'anyone', due: 'now', blocks: [], ...patch });
    const viewer = { email: 'me@x.com', role: 'admin' as const };
    const withSteps = (...steps: Record<string, unknown>[]) => view({ humanSteps: steps as never });

    it('Your turn shows only cards with a step due for the viewer', () => {
      const values = parse('yourTurn=1');
      expect(matchesFilters(withSteps(step({ who: 'me@x.com' })), values, viewer)).toBe(true);
      expect(matchesFilters(withSteps(step({ who: 'other@x.com' })), values, viewer)).toBe(false);
      expect(matchesFilters(withSteps(step({ who: 'me@x.com', state: 'pending' })), values, viewer)).toBe(false);
      expect(matchesFilters(withSteps(step({ who: 'me@x.com' })), values, undefined)).toBe(false);
      expect(matchesFilters(view({}), values, viewer)).toBe(false);
    });

    it('Human steps shows pending and due, with the kind refinement', () => {
      const pending = withSteps(step({ kind: 'rollout', state: 'pending' }));
      const done = withSteps(step({ state: 'done' }));
      expect(matchesFilters(pending, parse('human=all'), viewer)).toBe(true);
      expect(matchesFilters(done, parse('human=all'), viewer)).toBe(false);
      expect(matchesFilters(pending, parse('human=rollout'), viewer)).toBe(true);
      expect(matchesFilters(pending, parse('human=merge'), viewer)).toBe(false);
      expect(parse('human=bogus')).toEqual(defaultFilters());
    });

    it('round-trips through the URL and combines with the other filters', () => {
      const values = parse('yourTurn=1&human=rollout&id=foo');
      expect(values).toMatchObject({ yourTurn: '1', human: 'rollout', id: 'foo' });
      expect(parse(writeFilters(new URLSearchParams(), values).toString())).toEqual(values);
      const g = view({ title: 'foo', humanSteps: [step({ kind: 'rollout', who: 'me@x.com' })] as never });
      expect(matchesFilters(g, values, viewer)).toBe(true);
      expect(matchesFilters({ ...g, title: 'bar', id: 'zz' }, values, viewer)).toBe(false);
      expect(matchesFilters({ ...g, category: 'decision' }, parse('yourTurn=1'), viewer)).toBe(false);
    });

    it('counts the due steps that are the viewer\'s', () => {
      const globs = [withSteps(step({ who: 'me@x.com' }), step({ who: 'anyone' })), withSteps(step({ who: 'o@x.com' })), withSteps(step({ who: 'me@x.com', state: 'pending' }))];
      expect(yourTurnCount(globs, viewer)).toBe(2);
      expect(yourTurnCount([], viewer)).toBe(0);
    });
  });
});

describe('whose-move filter and stalled count', () => {
  const moved = (holder: 'machine' | 'waiting' | 'stalled' | 'you') =>
    view({ move: { holder, reason: '', since: null } });

  it('matches the chosen holders', () => {
    const values = parse('category=all&move=machine,stalled');
    expect(values.move).toBe('machine,stalled');
    expect(matchesFilters(moved('machine'), values)).toBe(true);
    expect(matchesFilters(moved('stalled'), values)).toBe(true);
    expect(matchesFilters(moved('waiting'), values)).toBe(false);
    expect(matchesFilters(view({}), values)).toBe(false);
  });

  it('keeps a stable order and drops unknown holders', () => {
    expect(parse('category=all&move=stalled,nope,Machine').move).toBe('machine,stalled');
  });

  it('counts the stalled globs', () => {
    expect(stalledCount([moved('stalled'), moved('machine'), moved('stalled'), view({})])).toBe(2);
  });
});
