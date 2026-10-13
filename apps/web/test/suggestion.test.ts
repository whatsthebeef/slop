import type { SuggestionView } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { APPLY_HINT_TEXT, applyPrefill, suggestionState } from '../src/lib/suggestion';

const view = (patch: Partial<SuggestionView> = {}): SuggestionView => ({
  suggestion: {
    suggestion: { action: 'approve_with_edit', reason: 'Trim it.', editedDraft: 'Shorter text', mergeInto: null, mergedText: null },
    model: 'm',
    at: '2026-10-12T00:00:00.000Z',
    stamp: { draftVersion: 1, targetVersion: 2, promptVersion: 1 },
  },
  stale: false,
  pending: false,
  error: null,
  ...patch,
});

describe('the Suggest card', () => {
  it('is empty before a suggestion, working while a job waits, ready, or stale once the draft or target moved', () => {
    expect(suggestionState(undefined)).toBe('none');
    expect(suggestionState(view({ suggestion: null }))).toBe('none');
    expect(suggestionState(view({ suggestion: null, pending: true }))).toBe('working');
    expect(suggestionState(view())).toBe('ready');
    expect(suggestionState(view({ stale: true }))).toBe('stale');
  });

  it('applies by pre-filling the decide form, never by deciding', () => {
    expect(applyPrefill(undefined)).toBeNull();
    expect(applyPrefill(view({ suggestion: null }))).toBeNull();
    expect(applyPrefill(view())).toEqual({ outcome: 'accept_with_edits', editedDraft: 'Shorter text' });
  });
});

describe('APPLY_HINT_TEXT', () => {
  it('does not claim the form is below the assessment', () => {
    expect(APPLY_HINT_TEXT).not.toMatch(/below/i);
    expect(APPLY_HINT_TEXT).toMatch(/above/);
  });
});
