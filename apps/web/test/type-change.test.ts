import { describe, expect, it, vi } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  categoryOptions,
  saveCategory,
  subConfirmation,
  typeActionChanges,
  typeActions,
  typeChangeBlocker,
} from '../src/lib/type-change';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;

describe('type actions', () => {
  it('shows only the changes the server allows', () => {
    expect(typeActions(view({ type: 'same' }), 'dev').map((a) => a.label)).toEqual(['Make it a sub', 'Pair on it']);
    expect(typeActions(view({ type: 'same', status: 'in_progress' }), 'dev').map((a) => a.label)).toEqual(['Pair on it']);
    expect(typeActions(view({ type: 'sub', status: 'implementing' }), 'dev').map((a) => a.label)).toEqual(['Make it a same']);
    expect(typeActions(view({ type: 'same', status: 'merging' }), 'dev')).toEqual([]);
  });

  it('says what follows in each tooltip', () => {
    const tips = Object.fromEntries(typeActions(view({ type: 'sub', status: 'implementing' }), 'dev').map((a) => [a.to, a.tip]));
    expect(tips['same']).toBe('A person merges it.');
    const same = typeActions(view({ type: 'same' }), 'dev');
    expect(same[0]?.tip).toBe('Starts a routine run now and merges itself when ready.');
    expect(same[1]?.tip).toBe('You and the PO work on it together; no routine run.');
  });

  it('says a sub with dependencies waits for them', () => {
    const [sub] = typeActions(view({ type: 'same', after: ['s1t2'] }), 'dev');
    expect(sub?.tip).toBe('Waits for s1t2 to merge, then starts a routine run and merges itself when ready.');
  });

  it('offers a feature the task sub, and sends type and category together', () => {
    const [sub] = typeActions(view({ type: 'same', category: 'feature' }), 'dev');
    if (sub === undefined) throw new Error('no sub action');
    expect(sub).toMatchObject({ to: 'sub', category: 'task' });
    expect(subConfirmation(sub)).toMatch(/^A feature can't be a sub\. Make it a task sub\?/);
    expect(typeActionChanges(sub)).toEqual({ type: 'sub', category: 'task' });
  });

  it('confirms a plain sub without the task change', () => {
    const [sub] = typeActions(view({ type: 'same', category: 'task' }), 'dev');
    if (sub === undefined) throw new Error('no sub action');
    expect(subConfirmation(sub)).toMatch(/^Make it a sub\? /);
    expect(typeActionChanges(sub)).toEqual({ type: 'sub' });
  });

  it('explains on the type label why no change is offered', () => {
    expect(typeChangeBlocker(view({ type: 'same' }), 'dev')).toBeNull();
    expect(typeChangeBlocker(view({ type: 'sub', status: 'reviewing' }), 'dev')).toBe('A sub can only become a same before it merges');
    expect(typeChangeBlocker(view({ type: 'same', status: 'merging' }), 'dev')).toMatch(/swapped in planning/);
  });
});

describe('category', () => {
  it('offers only the categories the type allows', () => {
    expect(categoryOptions('sub')).toEqual(['task', 'bug']);
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
