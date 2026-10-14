import { describe, expect, it } from 'vitest';
import { decideButtons } from '../src/lib/decide-main';

const base = { state: 'none', hasPrefill: false, canSuggest: true, choice: null } as const;

describe('the Decide block buttons', () => {
  it('leads with Suggest when nothing is suggested, the outcomes in the menu', () => {
    const b = decideButtons(base);
    expect(b.main).toEqual({ kind: 'suggest', again: false });
    expect(b.menu).toContain('accept');
    expect(b.menu).toContain('reject');
    expect(b.rejectBeside).toBe(false);
  });

  it('waits while suggesting', () => {
    expect(decideButtons({ ...base, state: 'working' }).main).toEqual({ kind: 'suggesting' });
  });

  it('leads with Apply once a suggestion is ready, Suggest again in the menu', () => {
    const b = decideButtons({ ...base, state: 'ready', hasPrefill: true });
    expect(b.main).toEqual({ kind: 'apply' });
    expect(b.suggestAgain).toBe(true);
  });

  it('leads with Suggest again for a stale suggestion', () => {
    expect(decideButtons({ ...base, state: 'stale', hasPrefill: true }).main).toEqual({ kind: 'suggest', again: true });
  });

  it('shows the applied outcome as main with Reject beside it and the rest in the menu', () => {
    const b = decideButtons({ ...base, state: 'ready', hasPrefill: true, choice: 'accept' });
    expect(b.main).toEqual({ kind: 'outcome', outcome: 'accept' });
    expect(b.rejectBeside).toBe(true);
    expect(b.menu).toEqual(['accept_with_edits', 'retarget', 'needs_work']);
    expect(b.clear).toBe(true);
  });

  it('has no separate Reject when Reject is the main', () => {
    const b = decideButtons({ ...base, choice: 'reject' });
    expect(b.main).toEqual({ kind: 'outcome', outcome: 'reject' });
    expect(b.rejectBeside).toBe(false);
    expect(b.menu).not.toContain('reject');
  });

  it('leads with Accept when the viewer cannot ask for suggestions', () => {
    const b = decideButtons({ ...base, canSuggest: false });
    expect(b.main).toEqual({ kind: 'outcome', outcome: 'accept' });
    expect(b.menu).not.toContain('accept');
  });
});
