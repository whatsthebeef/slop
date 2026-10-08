import { describe, expect, it, vi } from 'vitest';
import { copyOrSelect, planBaseline, planText } from '@/lib/plan-text';

describe('plan text', () => {
  it('starts from the summary when no version is saved, so it is selectable text', () => {
    expect(planText(null, null, 'the summary')).toBe('the summary');
  });

  it('shows the saved plan, then the draft, in preference to the summary', () => {
    expect(planText(null, 'saved', 'the summary')).toBe('saved');
    expect(planText('draft', 'saved', 'the summary')).toBe('draft');
  });

  it('offers Save only once the text differs from the baseline', () => {
    const summary = 'the summary';
    const differs = (draft: string, saved: string | null) => draft !== planBaseline(saved, summary);
    expect(differs(summary, null)).toBe(false);
    expect(differs(`${summary}!`, null)).toBe(true);
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
