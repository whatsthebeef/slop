import { prefillOf } from '@slop/core';
import type { SuggestAction, SuggestionPrefill, SuggestionView } from '@slop/core';

export const SUGGESTION_ACTION_TEXT: Readonly<Record<SuggestAction, string>> = {
  approve: 'Approve as drafted',
  approve_with_edit: 'Approve with an edit',
  merge_into: 'Merge into another learning',
  reject: 'Reject',
};

/** What the Suggest card shows: nothing yet, a job working (or waiting for the model), a usable suggestion, or one the draft or target has outgrown. */
export type SuggestionState = 'none' | 'working' | 'ready' | 'stale';

export const suggestionState = (view: SuggestionView | undefined): SuggestionState => {
  if (view === undefined) return 'none';
  if (view.pending) return 'working';
  if (view.suggestion === null) return 'none';
  return view.stale ? 'stale' : 'ready';
};

/** What Apply fills into the decide form, or null when there is no suggestion to apply. */
export const applyPrefill = (view: SuggestionView | undefined): SuggestionPrefill | null =>
  view?.suggestion == null ? null : prefillOf(view.suggestion.suggestion);

/** While a job is queued the card checks now and then, in case a live hint was lost (the board closes its stream in a hidden tab). */
export const SUGGEST_POLL_MS = 4_000;
