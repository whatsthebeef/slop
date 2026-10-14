import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@slop/core';
import type { GlobView } from '../src/lib/api';
import { categoryOptions, saveCategory, typeOptions } from '../src/lib/type-change';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const option = (g: GlobView, to: string, role: Role = 'admin') => {
  const found = typeOptions(g, role).find((o) => o.to === to);
  if (found === undefined) throw new Error(`no ${to} option`);
  return found;
};

describe('type options', () => {
  it('lists the three types with their descriptions and actors', () => {
    const options = typeOptions(view({ type: 'same' }), 'admin');
    expect(options.map((o) => o.to)).toEqual(['sub', 'same', 'super']);
    expect(options.map((o) => o.description)).toEqual([
      'The machine does it all and merges it itself',
      'The machine builds it; a human starts and merges it',
      'A human pairs with the machine',
    ]);
    expect(options.map((o) => [o.machine, o.human])).toEqual([
      [true, false],
      [true, true],
      [false, true],
    ]);
    expect(options.find((o) => o.current)?.to).toBe('same');
  });

  it('offers a Planning type change through the glob update', () => {
    const g = view({ type: 'same', status: 'planning' });
    expect(option(g, 'sub')).toMatchObject({ via: 'update', reason: null });
    expect(option(g, 'super')).toMatchObject({ via: 'update', reason: null });
  });

  it('says what a change leads to', () => {
    expect(option(view({ type: 'same' }), 'sub').consequence).toBe('The machine starts it now and merges it itself when ready.');
    expect(option(view({ type: 'same', after: ['s1t2'] }), 'sub').consequence).toBe(
      'Waits for s1t2 to merge, then the machine starts it and merges it itself when ready.',
    );
    expect(option(view({ type: 'sub', status: 'implementing' }), 'same').consequence).toBe('A person merges it.');
    expect(option(view({ type: 'same' }), 'super').consequence).toBe('You and the PO work on it together; no machine run.');
  });

  it('makes an escalated same a sub with deescalate, which also clears the escalation', () => {
    const g = view({
      type: 'same',
      status: 'in_progress',
      escalation: { reason: 'r', by: 'a@b.c', at: '2026-01-01T00:00:00Z' },
      allowedActions: ['deescalate'],
    });
    const sub = option(g, 'sub');
    expect(sub.via).toBe('deescalate');
    expect(sub.consequence).toMatch(/Also clears "needs a human"\.$/);
  });

  it('makes a failed glob a super with make_super', () => {
    const g = view({ type: 'sub', status: 'failed', allowedActions: ['make_super'] });
    expect(option(g, 'super').via).toBe('make_super');
  });

  it('greys out a change the server would refuse, with the reason', () => {
    const sub = view({ type: 'sub', status: 'reviewing' });
    expect(option(sub, 'same')).toMatchObject({ via: null, reason: 'A sub can only become a same before it merges' });
    const merging = view({ type: 'same', status: 'merging' });
    expect(option(merging, 'super').reason).toMatch(/swapped in planning/);
    expect(option(merging, 'sub').reason).toBe('A same can only become a sub while in planning');
    expect(option(view({ type: 'same' }), 'super', 'po')).toMatchObject({ via: null, reason: 'Only board admins can choose sub or super' });
    expect(option(view({ type: 'same', status: 'planning' }), 'sub', 'dev')).toMatchObject({ via: null, reason: 'Only board admins can choose sub or super' });
    expect(option(view({ type: 'same', status: 'planning' }), 'same', 'dev').current).toBe(true);
    expect(option(view({ type: 'sub', status: 'implementing' }), 'same', 'dev')).toMatchObject({ via: 'update', reason: null });
    expect(option(view({ type: 'sub', category: 'bug' }), 'super').reason).toBe('A bug cannot be a super');
  });

  it('never offers the current type as a change', () => {
    expect(option(view({ type: 'same' }), 'same')).toMatchObject({ current: true, via: null, reason: null });
  });
});

describe('category', () => {
  it('offers only the categories the type allows', () => {
    expect(categoryOptions('sub')).toEqual(['feature', 'task', 'bug']);
    expect(categoryOptions('super')).toEqual(['feature', 'task']);
  });

  it('saves on change with the new category, and Undo restores the old one', async () => {
    const update = vi.fn().mockResolvedValue(null);
    const saved = await saveCategory(update, 'task', 'bug');
    expect(update).toHaveBeenCalledWith({ category: 'bug' });
    expect(saved).toEqual({ saved: true, undo: 'task' });
    await saveCategory(update, 'bug', 'task');
    expect(update).toHaveBeenLastCalledWith({ category: 'task' });
  });

  it('returns the reason when the change is refused', async () => {
    const failure = { message: 'A bug cannot be a super', conflict: false };
    expect(await saveCategory(() => Promise.resolve(failure), 'task', 'bug')).toEqual({ saved: false, failure });
  });
});
