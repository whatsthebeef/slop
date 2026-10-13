import { describe, expect, it, vi } from 'vitest';
import { copyOrSelect, listedArtifacts, planBaseline, planText, planVersionLine } from '@/lib/plan-text';

describe('plan text', () => {
  it('is empty when no version is saved', () => {
    expect(planText(null, null)).toBe('');
  });

  it('shows the saved plan, then the draft in preference to it', () => {
    expect(planText(null, 'saved')).toBe('saved');
    expect(planText('draft', 'saved')).toBe('draft');
  });

  it('offers Save only once the text differs from the baseline', () => {
    const differs = (draft: string, saved: string | null) => draft !== planBaseline(saved);
    expect(differs('', null)).toBe(false);
    expect(differs('new', null)).toBe(true);
    expect(differs('saved', 'saved')).toBe(false);
  });
});

describe('copyOrSelect', () => {
  it('copies the shown text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const select = vi.fn();
    expect(await copyOrSelect('hello', { writeText }, select)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(select).not.toHaveBeenCalled();
  });

  it('selects the text when the clipboard refuses', async () => {
    const select = vi.fn();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await copyOrSelect('hello', { writeText }, select)).toBe(false);
    expect(select).toHaveBeenCalledOnce();
  });

  it('selects the text when there is no clipboard', async () => {
    const select = vi.fn();
    expect(await copyOrSelect('hello', undefined, select)).toBe(false);
    expect(select).toHaveBeenCalledOnce();
  });
});

describe('plan version line', () => {
  const saved = { version: 3, createdAt: '2026-10-08T19:52:08.000Z', provenance: { by: 'human', actor: 'a@x.com' } };

  it('says which version is shown and who saved it', () => {
    expect(planVersionLine(saved)).toBe('version 3 · saved by a@x.com · 2026-10-08 19:52 UTC');
    expect(planVersionLine({ ...saved, provenance: { by: 'routine', actor: 'a@x.com' } })).toContain('a@x.com (routine)');
  });

  it('says what Save will make while editing', () => {
    expect(planVersionLine(saved, true)).toMatch(/Save makes version 4$/);
    expect(planVersionLine(null)).toBe('not written yet');
    expect(planVersionLine(null, true)).toBe('not written yet · Save makes version 1');
  });
});

describe('listedArtifacts', () => {
  const all = [{ kind: 'plan' }, { kind: 'implementation_plan' }];
  it('leaves plan.md out until the glob is signed off', () => {
    expect(listedArtifacts(all, false)).toEqual([{ kind: 'implementation_plan' }]);
    expect(listedArtifacts(all, true)).toEqual(all);
  });
});
