import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  activeCount,
  defaultFilters,
  kindOf,
  KINDS,
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
    expect(matchesFilters(view({ category: 'decision', type: null }), parse('kind=all'))).toBe(true);
  });

  it('shows an action by default and filters to it', () => {
    const action = view({ category: 'action', type: null });
    expect(matchesFilters(action, {})).toBe(true);
    expect(matchesFilters(action, parse('kind=action'))).toBe(true);
    expect(matchesFilters(view({ category: 'task', type: 'same' }), parse('kind=action'))).toBe(false);
    expect(matchesFilters(action, parse('kind=decision'))).toBe(false);
  });

  it('defaults to task, bug and action, hiding decisions', () => {
    const values = parse('');
    expect(values).toEqual({ kind: 'task,bug,action' });
    expect(values).toEqual(defaultFilters());
    expect(matchesFilters(view({ category: 'task', type: 'same' }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'decision', type: null }), values)).toBe(false);
    expect(parse('kind=&id=')).toEqual(values);
    expect(activeCount(values)).toBe(0);
  });

  it('keeps "show all" distinct from the default across a reload', () => {
    const params = writeFilters(new URLSearchParams('glob=s1t1'), {});
    expect(params.toString()).toBe('glob=s1t1&kind=all');
    expect(parse('kind=all')).toEqual({});
    expect(activeCount(parseFilters(params))).toBe(1);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('writes an explicit selection and reads it back', () => {
    const params = writeFilters(new URLSearchParams(), { kind: 'decision' });
    expect(params.toString()).toBe('kind=decision');
    expect(parseFilters(params)).toEqual({ kind: 'decision' });
    expect(activeCount({ kind: 'decision' })).toBe(1);
  });

  it('matches any of several kinds, by the glob\'s kind', () => {
    const values = parse('kind=bug,decision');
    expect(matchesFilters(view({ type: 'sub', fix: true }), values)).toBe(true);
    expect(matchesFilters(view({ category: 'decision', type: null }), values)).toBe(true);
    expect(matchesFilters(view({ type: 'same', fix: false }), values)).toBe(false);
    expect(matchesFilters(view({ category: 'action', type: null }), values)).toBe(false);
  });

  it('ignores unknown kinds and keeps a stable order', () => {
    expect(parse('kind=decision,nope,Task,decision')).toEqual({ kind: 'task,decision' });
    expect(parse('kind=nope')).toEqual(defaultFilters());
  });

  it('has one kind chip per kind and no Fixes toggle', () => {
    expect(KINDS).toEqual(['task', 'bug', 'action', 'decision']);
    const [kind] = BOARD_FILTERS;
    expect(kind?.key).toBe('kind');
    expect(kind?.control === 'chips' && kind.options.map((o) => o.value)).toEqual([...KINDS]);
    expect(BOARD_FILTERS.some((f) => f.key === 'fix' || f.key === 'mode')).toBe(false);
  });

  describe('kinds', () => {
    const only = (kind: string, glob: GlobView) => matchesFilters(glob, parse(`kind=${kind}`));
    const subBug = view({ category: 'task', type: 'sub', fix: true });
    const superTask = view({ category: 'task', type: 'super', fix: false });
    const sameBug = view({ category: 'bug', type: 'same' });
    const feature = view({ category: 'feature', type: 'same' });
    const action = view({ category: 'action', type: null });
    const decision = view({ category: 'decision', type: null });
    const all = { subBug, superTask, sameBug, feature, action, decision };

    it.each([
      ['task', ['superTask', 'feature']],
      ['bug', ['subBug', 'sameBug']],
      ['action', ['action']],
      ['decision', ['decision']],
    ])('the %s chip matches exactly its globs', (kind, expected) => {
      const hits = Object.entries(all)
        .filter(([, g]) => only(kind, g))
        .map(([name]) => name);
      expect(hits).toEqual(expected);
    });

    it('reads the kind of a glob: a feature is a task, a fix is a bug', () => {
      expect(kindOf(feature)).toBe('task');
      expect(kindOf(superTask)).toBe('task');
      expect(kindOf(subBug)).toBe('bug');
      expect(kindOf(action)).toBe('action');
      expect(kindOf(decision)).toBe('decision');
    });

    it('shows task, bug and action by default, hiding decisions', () => {
      const values = parse('');
      expect(Object.values(all).map((g) => matchesFilters(g, values))).toEqual([true, true, true, true, true, false]);
    });
  });

  describe('old links', () => {
    it('maps mode sub, same or super to task and bug, and keeps action and decision', () => {
      expect(parse('mode=sub')).toEqual({ kind: 'task,bug' });
      expect(parse('mode=same,super')).toEqual({ kind: 'task,bug' });
      expect(parse('mode=sub,decision')).toEqual({ kind: 'task,bug,decision' });
      expect(parse('mode=action')).toEqual({ kind: 'action' });
      expect(parse('mode=decision,action')).toEqual({ kind: 'action,decision' });
      expect(parse('mode=sub,same,super,action')).toEqual(defaultFilters());
      expect(parse('mode=all')).toEqual({});
    });

    it('maps fix=1 to bug only, and ignores fix=0', () => {
      expect(parse('fix=1')).toEqual({ kind: 'bug' });
      expect(parse('mode=sub,same&fix=1')).toEqual({ kind: 'bug' });
      expect(parse('fix=0')).toEqual(defaultFilters());
      expect(activeCount(parse('fix=1'))).toBe(1);
    });

    it('prefers kind over the old parameters', () => {
      expect(parse('kind=decision&mode=sub&fix=1')).toEqual({ kind: 'decision' });
    });

    it('writes the normalised kind and drops the old parameters, so equal selections give equal URLs', () => {
      const write = (q: string) => writeFilters(new URLSearchParams(q), parse(q)).toString();
      expect(write('mode=sub')).toBe('kind=task%2Cbug');
      expect(write('mode=same,super')).toBe(write('mode=sub'));
      expect(write('mode=sub')).toBe(write('kind=bug,task'));
      expect(write('fix=1')).toBe('kind=bug');
      expect(write('mode=sub&fix=1')).toBe(write('kind=bug'));
      expect(write('mode=sub,same,super,action')).toBe('');
      expect(write('glob=s1&mode=all&fix=0')).toBe('glob=s1&kind=all');
    });
  });

  it('ignores a legacy category value in the URL: there is no category filter', () => {
    expect(parse('category=feature')).toEqual(defaultFilters());
    expect(parse('category=task')).toEqual(defaultFilters());
    expect(parse('category=feature&fix=1')).toEqual({ kind: 'bug' });
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
    const values = parse('kind=bug&id=b1');
    expect(matchesFilters(view({ id: 's1b1', category: 'bug' }), values)).toBe(true);
    expect(matchesFilters(view({ id: 's1b1', category: 'task' }), values)).toBe(false);
    expect(matchesFilters(view({ id: 's1b2', category: 'bug' }), values)).toBe(false);
    expect(activeCount(values)).toBe(2);
    expect(activeCount({ ...defaultFilters(), id: 'b1' })).toBe(1);
  });

  it('round-trips through the query and leaves other parameters alone', () => {
    const values = parse('kind=task,decision&id=f4');
    const params = writeFilters(new URLSearchParams('glob=s1t1&kind=bug'), values);
    expect(params.get('glob')).toBe('s1t1');
    expect(parseFilters(params)).toEqual(values);
    expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
  });

  it('toggles a kind option on and off', () => {
    const [kind] = BOARD_FILTERS;
    if (kind === undefined) throw new Error('No filters');
    expect(toggleOption(kind, '', 'bug')).toBe('bug');
    expect(toggleOption(kind, 'bug', 'task')).toBe('task,bug');
    expect(toggleOption(kind, 'task,bug', 'task')).toBe('bug');
    expect(toggleOption(kind, 'bug', 'bug')).toBe('');
  });

  it('has the kind filter, the ID filter, the temporary group filter, the Only human toggle and the Arm system toggle', () => {
    expect(BOARD_FILTERS.map((f) => f.key)).toEqual(['kind', 'id', 'group', 'human', 'arm']);
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
    expect(values).toEqual({ kind: 'task,bug,action', group: 'glob-groups' });
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
      expect(parse('human=1')).toEqual({ kind: 'task,bug,action', human: '1' });
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
      const values = parse('human=1&kind=bug');
      expect(matchesFilters(signOff, values, ctx)).toBe(true);
      expect(matchesFilters({ ...signOff, category: 'task' }, values, ctx)).toBe(false);
      expect(matchesFilters(machine, values, ctx)).toBe(false);
    });

    it('round-trips through the URL', () => {
      const params = writeFilters(new URLSearchParams('glob=s1t1'), { ...defaultFilters(), human: '1' });
      expect(params.toString()).toBe('glob=s1t1&human=1');
      expect(parseFilters(params)).toEqual({ kind: 'task,bug,action', human: '1' });
      expect(writeFilters(params, defaultFilters()).toString()).toBe('glob=s1t1');
    });
  });

  describe('Arm system', () => {
    const step = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] } as const;
    const armed = view({ status: 'planning', humanSteps: [step] });
    const predicted = view({ status: 'planning', humanSteps: [{ ...step, predicted: true }] });
    const plain = view({ status: 'planning' });

    it('is off by default and on for arm=1', () => {
      expect(parse('arm=1')).toEqual({ kind: 'task,bug,action', arm: '1' });
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
      expect(parseFilters(params)).toEqual({ kind: 'task,bug,action', arm: '1' });
    });
  });

  describe('open questions', () => {
    const q = { id: 'q1', text: 'Prod?', raisedBy: { kind: 'intake', actor: null }, source: 'create', blocking: 'none', raisedAt: NOW } as const;

    it('has no Has open questions toggle, and ignores an old questions=1 link', () => {
      expect(BOARD_FILTERS.some((f) => f.label === 'Has open questions')).toBe(false);
      expect(parse('questions=1')).toEqual(defaultFilters());
      expect(writeFilters(new URLSearchParams('questions=1'), parse('questions=1')).toString()).toBe('questions=1');
      expect(matchesFilters(view({ questions: [q] }), parse('questions=1'))).toBe(true);
    });

    it('Only human includes a glob with an open question even when the corner shows a machine status', () => {
      const values = parse('human=1');
      const running = view({ status: 'implementing', questions: [q] });
      expect(matchesFilters(running, values, { now: NOW })).toBe(true);
      expect(matchesFilters({ ...running, questions: [{ ...q, answer: { text: 'Yes', by: 'a', at: NOW } }] }, values, { now: NOW })).toBe(false);
    });
  });
});
