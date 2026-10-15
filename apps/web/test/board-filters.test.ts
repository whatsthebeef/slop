import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  activeCount,
  defaultFilters,
  matchesFilters,
  parseFilters,
  toggleOption,
  writeFilters,
  BOARD_FILTERS,
} from '../src/lib/board-filters';
import { NOW, glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView>): GlobView => ({ ...glob(), ...patch }) as GlobView;
const parse = (q: string) => parseFilters(new URLSearchParams(q));

describe('board filters', () => {
  it('passes every glob when no filter is on', () => {
    expect(matchesFilters(view({ category: 'decision', type: null }), {})).toBe(true);
    expect(matchesFilters(view({ category: 'decision', type: null }), parse('mode=all'))).toBe(true);
  });

  it('shows an action by default and filters to it', () => {
    const action = view({ category: 'action', type: null });
    expect(matchesFilters(action, {})).toBe(true);
    expect(matchesFilters(action, parse('mode=action'))).toBe(true);
    expect(matchesFilters(view({ category: 'task', type: 'same' }), parse('mode=action'))).toBe(false);
    expect(matchesFilters(action, parse('mode=decision'))).toBe(false);
  });

  it('defaults to the machine modes and action, hiding decisions', () => {
    const values = parse('');
    expect(values).toEqual({ mode: 'sub,same,super,action' });
    expect(values).toEqual(defaultFilters());
    expect(matchesFilters(view({ category: 'task', type: 'same' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'decision', type: null }), values)).toBe(false);
    expect(parse('mode=&id=')).toEqual(values);
    expect(activeCount(values)).toBe(0);
  });

  it('keeps "show all" distinct from the default across a reload', () => {
    const params = writeFilters(new URLSearchParams('glob=s1t1'), {});
    expect(params.toString()).toBe('glob=s1t1&mode=all');
    expect(parse('mode=all')).toEqual({});
    expect(activeCount(parseFilters(params))).toBe(1);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('writes an explicit selection and reads it back', () => {
    const params = writeFilters(new URLSearchParams(), { mode: 'decision' });
    expect(params.toString()).toBe('mode=decision');
    expect(parseFilters(params)).toEqual({ mode: 'decision' });
    expect(activeCount({ mode: 'decision' })).toBe(1);
  });

  it('matches any of several modes, by the glob\'s mode', () => {
    const values = parse('mode=sub,super');
    expect(matchesFilters(view({ type: 'sub' }), values)).toBe(true);
    expect(matchesFilters(view({ type: 'super' }), values)).toBe(true);
    expect(matchesFilters(view({ type: 'same' }), values)).toBe(false);
    expect(matchesFilters(view({ category: 'decision', type: null }), parse('mode=decision'))).toBe(true);
    expect(matchesFilters(view({ type: 'sub' }), parse('mode=decision'))).toBe(false);
  });

  it('ignores unknown modes and keeps a stable order', () => {
    expect(parse('mode=super,nope,Sub,super')).toEqual({ mode: 'sub,super' });
    expect(parse('mode=nope')).toEqual(defaultFilters());
  });

  it('filters to fixes by the fix flag, reading an old record through its category', () => {
    const values = parse('fix=1');
    expect(values).toEqual({ ...defaultFilters(), fix: '1' });
    expect(matchesFilters(view({ category: 'task', type: 'same', fix: true }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'bug', type: 'same', fix: false }), values)).toBe(false);
    expect(matchesFilters(view({ category: 'bug', type: 'same' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'feature', type: 'same' }), values)).toBe(false);
    expect(matchesFilters(view({ category: 'action', type: null }), values)).toBe(false);
    expect(activeCount(values)).toBe(1);
    expect(parse('fix=0')).toEqual(defaultFilters());
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
    const values = parse('fix=1&id=b1');
    expect(matchesFilters(view({ id: 's1b1', category: 'bug' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b1', category: 'task' }), values)).toBe(false);
    expect(matchesFilters(view({ id: 's1b2', category: 'bug' }), values)).toBe(false);
    expect(activeCount(values)).toBe(2);
    expect(activeCount({ ...defaultFilters(), id: 'b1' })).toBe(1);
  });

  it('round-trips through the query and leaves other parameters alone', () => {
    const values = parse('mode=same,super&id=f4');
    const params = writeFilters(new URLSearchParams('glob=s1t1&mode=sub'), values);
    expect(params.get('glob')).toBe('s1t1');
    expect(parseFilters(params)).toEqual(values);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('toggles a mode option on and off', () => {
    const [mode] = BOARD_FILTERS;
    if (mode === undefined) throw new Error('No filters');
    expect(toggleOption(mode, '', 'super')).toBe('super');
    expect(toggleOption(mode, 'super', 'sub')).toBe('sub,super');
    expect(toggleOption(mode, 'sub,super', 'sub')).toBe('super');
    expect(toggleOption(mode, 'super', 'super')).toBe('');
  });

  it('has the mode and fix filters, the ID filter, the temporary group filter, the Only human toggle and the Arm system toggle', () => {
    expect(BOARD_FILTERS.map((f) => f.key)).toEqual(['mode', 'fix', 'id', 'group', 'human', 'arm']);
  });

  it('ignores the removed yourTurn and move parameters and an old human value in links', () => {
    const values = parse('yourTurn=1&move=stalled&human=rollout');
    expect(values).toEqual(defaultFilters());
    expect(activeCount(values)).toBe(0);
    expect(matchesFilters(view({}), values)).toBe(true);
    expect(writeFilters(new URLSearchParams('yourTurn=1&move=stalled&human=rollout'), values).toString()).toBe(
      'yourTurn=1&move=stalled',
    );
  });

  it('filters by exact group name, hiding globs with no group, and round-trips through the URL', () => {
    const values = parse('group=glob-groups');
    expect(values).toEqual({ mode: 'sub,same,super,action', group: 'glob-groups' });
    expect(matchesFilters(view({ group: 'glob-groups' }), values)).toBe(true);
    expect(matchesFilters(view({ group: 'glob' }), values)).toBe(false);
    expect(matchesFilters(view({ group: null }), values)).toBe(false);
    expect(matchesFilters(view({ group: 'glob-groups', category: 'decision' }), values)).toBe(false);
    expect(matchesFilters(view({ group: 'glob-groups', id: 's9t9' }), { ...values, id: 'zzz' })).toBe(false);
    expect(activeCount(values)).toBe(1);
    const params = writeFilters(new URLSearchParams(), values);
    expect(params.toString()).toBe('group=glob-groups');
    expect(parseFilters(params)).toEqual(values);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('');
  });
  describe('Only human', () => {
    const ctx = { now: NOW };
    const mine = (patch: Partial<GlobView>) => view({ status: 'reviewing', labels: { CR: 'required' }, ...patch });
    const machine = view({ status: 'planning' });
    const escalated = view({ status: 'planning', escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'] });
    const signOff = mine({ category: 'bug' });

    it('is off by default and on for human=1', () => {
      expect(parse('')).toEqual(defaultFilters());
      expect(parse('human=1')).toEqual({ mode: 'sub,same,super,action', human: '1' });
      expect(parse('human=nope')).toEqual(defaultFilters());
      expect(activeCount(parse('human=1'))).toBe(1);
    });

    it('shows only globs whose status is the human outline', () => {
      const values = parse('human=1');
      expect(matchesFilters(signOff, values, ctx)).toBe(true);
      expect(matchesFilters(escalated, values, ctx)).toBe(true);
      expect(matchesFilters(machine, values, ctx)).toBe(false);
      expect(matchesFilters(machine, parse(''), ctx)).toBe(true);
    });

    it('combines with the other filters', () => {
      const values = parse('human=1&fix=1');
      expect(matchesFilters(signOff, values, ctx)).toBe(true);
      expect(matchesFilters({ ...signOff, category: 'task' }, values, ctx)).toBe(false);
      expect(matchesFilters(machine, values, ctx)).toBe(false);
    });

    it('round-trips through the URL', () => {
      const params = writeFilters(new URLSearchParams('glob=s1t1'), { ...defaultFilters(), human: '1' });
      expect(params.toString()).toBe('glob=s1t1&human=1');
      expect(parseFilters(params)).toEqual({ mode: 'sub,same,super,action', human: '1' });
      expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
    });
  });

  describe('Arm system', () => {
    const step = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] } as const;
    const armed = view({ status: 'planning', humanSteps: [step] });
    const predicted = view({ status: 'planning', humanSteps: [{ ...step, predicted: true }] });
    const plain = view({ status: 'planning' });

    it('is off by default and on for arm=1', () => {
      expect(parse('arm=1')).toEqual({ mode: 'sub,same,super,action', arm: '1' });
      expect(parse('arm=nope')).toEqual(defaultFilters());
      expect(activeCount(parse('arm=1'))).toBe(1);
    });

    it('shows only globs that need a person at release', () => {
      const values = parse('arm=1');
      expect(matchesFilters(armed, values)).toBe(true);
      expect(matchesFilters(predicted, values)).toBe(false);
      expect(matchesFilters(plain, values)).toBe(false);
      expect(matchesFilters(plain, parse(''))).toBe(true);
    });

    it('round-trips through the URL', () => {
      const params = writeFilters(new URLSearchParams('glob=s1t1'), { ...defaultFilters(), arm: '1' });
      expect(params.toString()).toBe('glob=s1t1&arm=1');
      expect(parseFilters(params)).toEqual({ mode: 'sub,same,super,action', arm: '1' });
    });
  });
});
