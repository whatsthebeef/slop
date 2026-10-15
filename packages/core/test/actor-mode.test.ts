import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { isRnd, isValidCombination } from '../src/domain/matrix.js';
import { actorOf, fixOf, modeOf, workKindOf } from '../src/domain/types.js';
import type { Category } from '../src/domain/types.js';
import { board, ctx, glob } from './fixtures.js';

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const input = (patch: Partial<m.CreateInput> = {}): m.CreateInput => ({
  id: 's1t1',
  boardId: 1,
  title: 'Something',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  autoTrigger: false,
  ...patch,
});

describe('actorOf and modeOf', () => {
  it.each<[Category, 'sub' | 'same' | 'super' | null, string, string]>([
    ['feature', 'sub', 'machine', 'sub'],
    ['task', 'same', 'machine', 'same'],
    ['bug', 'super', 'machine', 'super'],
    ['decision', null, 'human', 'decision'],
    ['action', null, 'human', 'action'],
  ])('%s %s -> %s %s', (category, type, actor, mode) => {
    expect(actorOf({ category })).toBe(actor);
    expect(modeOf({ category, type })).toBe(mode);
  });

  it('reads a machine glob without a type as a same', () => {
    expect(modeOf({ category: 'task', type: null })).toBe('same');
  });
});

describe('legacy records read by category', () => {
  it('fix: bugs only; human work never', () => {
    expect(fixOf({ category: 'bug' })).toBe(true);
    expect(fixOf({ category: 'task' })).toBe(false);
    expect(fixOf({ category: 'task', fix: true })).toBe(true);
    expect(fixOf({ category: 'bug', fix: false })).toBe(false);
    expect(fixOf({ category: 'decision', fix: true })).toBe(false);
  });

  it('work kind and isRnd: features are R&D unless a work kind says otherwise', () => {
    expect(workKindOf({ category: 'feature' })).toBe('rnd');
    expect(workKindOf({ category: 'bug' })).toBe('maintenance');
    expect(workKindOf({ category: 'feature', workKind: 'maintenance' })).toBe('maintenance');
    expect(isRnd({ category: 'feature' })).toBe(true);
    expect(isRnd({ category: 'task' })).toBe(false);
    expect(isRnd({ category: 'task', workKind: 'rnd' })).toBe(true);
    expect(isRnd({ category: 'feature', workKind: 'maintenance' })).toBe(false);
    expect(isRnd('feature')).toBe(true);
  });
});

describe('a fix is never a super', () => {
  it('by the flag, not only the category', () => {
    expect(isValidCombination('super', 'bug')).toBe(false);
    expect(isValidCombination('super', 'task', true)).toBe(false);
    expect(isValidCombination('super', 'task', false)).toBe(true);
    expect(isValidCombination('super', 'bug', false)).toBe(true);
    expect(isValidCombination('sub', 'bug', true)).toBe(true);
    expect(isValidCombination(null, 'decision')).toBe(true);
    expect(isValidCombination('same', 'action')).toBe(false);
  });
});

describe('create sets fix and work kind', () => {
  it.each<[Category, boolean, string]>([
    ['feature', false, 'rnd'],
    ['task', false, 'maintenance'],
    ['bug', true, 'maintenance'],
  ])('%s defaults', (category, fix, workKind) => {
    const g = value(m.create(input({ category }), board, ctx())).glob;
    expect(g).toMatchObject({ fix, workKind, fixSource: 'inferred', workKindSource: 'inferred', inferenceReason: null });
  });

  it('takes given values and refuses a fix super', () => {
    const g = value(m.create(input({ fix: true, workKind: 'rnd', fixSource: 'person', inferenceReason: 'it crashes' }), board, ctx())).glob;
    expect(g).toMatchObject({ fix: true, workKind: 'rnd', fixSource: 'person', inferenceReason: 'it crashes' });
    expect(m.create(input({ type: 'super', fix: true }), board, ctx()).ok).toBe(false);
    expect(m.create(input({ type: 'super', category: 'bug' }), board, ctx()).ok).toBe(false);
  });

  it('records them on the GlobCreated event (an asked feature is stored as a task, R&D)', () => {
    const t = value(m.create(input({ category: 'feature' }), board, ctx()));
    expect(t.events[0]?.data).toMatchObject({ category: 'task', fix: false, workKind: 'rnd' });
  });
});

describe('changeFields with fix and work kind', () => {
  it('a person sets them and they become the person\'s', () => {
    const t = value(m.changeFields(glob(), { fix: true, workKind: 'rnd' }, board, ctx()));
    expect(t.glob).toMatchObject({ fix: true, fixSource: 'person', workKind: 'rnd', workKindSource: 'person' });
    expect(t.events[0]?.data).toMatchObject({ fix: { from: false, to: true }, workKind: { from: 'maintenance', to: 'rnd' } });
  });

  it('inference updates its own values and reason silently', () => {
    const g = glob({ fix: false, fixSource: 'inferred', inferenceReason: 'old' });
    const t = value(m.changeFields(g, { fix: true, fixSource: 'inferred', inferenceReason: 'it fails' }, board, ctx()));
    expect(t.glob).toMatchObject({ fix: true, fixSource: 'inferred', inferenceReason: 'it fails' });
  });

  it('inference never overwrites a person\'s value', () => {
    const g = glob({ fix: true, fixSource: 'person', workKind: 'rnd', workKindSource: 'person', inferenceReason: 'mine' });
    const t = m.changeFields(g, { fix: false, fixSource: 'inferred', workKind: 'maintenance', workKindSource: 'inferred', inferenceReason: 'x' }, board, ctx());
    expect(t.ok && t.value.changed).toBe(false);
  });

  it('refuses a fix on a super', () => {
    expect(m.changeFields(glob({ type: 'super' }), { fix: true }, board, ctx()).ok).toBe(false);
  });

  it('a category alias moves a still-inferred value, not a person\'s', () => {
    const inferred = value(m.changeFields(glob({ category: 'task' }), { category: 'bug' }, board, ctx())).glob;
    expect(fixOf(inferred)).toBe(true);
    const kept = value(m.changeFields(glob({ category: 'task', fix: false, fixSource: 'person' }), { category: 'bug' }, board, ctx())).glob;
    expect(fixOf(kept)).toBe(false);
  });
});
