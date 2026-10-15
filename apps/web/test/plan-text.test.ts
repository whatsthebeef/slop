import { describe, expect, it, vi } from 'vitest';
import { copyOrSelect, listedArtifacts, planBaseline, planText, planVersionLabel, planVersionLine } from '@/lib/plan-text';

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

describe('plan version label', () => {
  const at = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const created = '2026-10-14T12:00:00.000Z';
  const saved = { version: 3, createdAt: created, provenance: { by: 'human', actor: 'john@example.com' } };

  it('names the version, the author without the domain and the local date', () => {
    expect(planVersionLabel(saved)).toBe(`v3 · john · ${at(created)}`);
    expect(planVersionLabel({ ...saved, provenance: { by: 'human', actor: 'john.bower@thepocketlab.com' } })).toContain('· john.bower ·');
  });

  it('keeps machine authors as they are', () => {
    expect(planVersionLabel({ ...saved, provenance: { by: 'sessionator', actor: 'slop' } })).toBe(`v3 · slop · ${at(created)}`);
  });

  it('marks an unsaved draft', () => {
    expect(planVersionLine(saved)).toBe(`v3 · john · ${at(created)}`);
    expect(planVersionLine(saved, true)).toBe(`v3 · john · ${at(created)} · unsaved`);
    expect(planVersionLine(null)).toBe('not written yet');
    expect(planVersionLine(null, true)).toBe('not written yet · unsaved');
  });
});

describe('listedArtifacts', () => {
  const all = [{ kind: 'plan' }, { kind: 'implementation_plan' }];
  it('leaves plan.md out until the glob is signed off', () => {
    expect(listedArtifacts(all, false)).toEqual([{ kind: 'implementation_plan' }]);
    expect(listedArtifacts(all, true)).toEqual(all);
  });
  it('always leaves the test plan out, as it has its own tab', () => {
    const withTestPlan = [...all, { kind: 'test_plan' }];
    expect(listedArtifacts(withTestPlan, false)).toEqual([{ kind: 'implementation_plan' }]);
    expect(listedArtifacts(withTestPlan, true)).toEqual(all);
  });
});
