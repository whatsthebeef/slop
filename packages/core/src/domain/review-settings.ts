import { REVIEW_SEVERITIES } from './independent-review.js';
import type { ReviewSeverity } from './independent-review.js';
import { DEFAULT_REVIEW_MIN_SEVERITY } from './review-publish.js';

/** What an admin sets for the independent reviewer; stored on the board. */
export interface ReviewBoardSettings {
  /** Off stops the automatic reviews; "Review now" still works. */
  readonly enabled: boolean;
  /** The Bedrock model id; null follows the server's default. */
  readonly model: string | null;
  /** Findings at or above this are inline comments on GitHub. */
  readonly minSeverity: ReviewSeverity;
  /** Path globs the reviewer never reads, on top of the merge policy's size-ignored paths. */
  readonly ignoredPaths: readonly string[];
  /** The cap on the reviewer's tool calls; null for the default. */
  readonly toolCap: number | null;
}

/** What a review runs with: the board's settings resolved against the server and merge policy defaults. */
export interface ReviewSettings {
  /** The Bedrock model that reviews (not a Claude model). */
  readonly model: string;
  readonly minSeverity: ReviewSeverity;
  readonly ignoredPaths: readonly string[];
  readonly toolCap: number | null;
}

export const DEFAULT_REVIEW_BOARD_SETTINGS: ReviewBoardSettings = {
  enabled: true,
  model: null,
  minSeverity: DEFAULT_REVIEW_MIN_SEVERITY,
  ignoredPaths: [],
  toolCap: null,
};

/** A stored value as settings: a missing or unrecognised key reads as its default. */
export const reviewSettingsOf = (
  stored: Partial<ReviewBoardSettings> | null | undefined,
): ReviewBoardSettings => {
  const d = DEFAULT_REVIEW_BOARD_SETTINGS;
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : d.enabled,
    model: typeof stored?.model === 'string' && stored.model.trim() !== '' ? stored.model : d.model,
    minSeverity: REVIEW_SEVERITIES.find((s) => s === stored?.minSeverity) ?? d.minSeverity,
    ignoredPaths: Array.isArray(stored?.ignoredPaths) ? stored.ignoredPaths : d.ignoredPaths,
    toolCap: typeof stored?.toolCap === 'number' ? stored.toolCap : d.toolCap,
  };
};

/** A settings change over the current settings: keys the change leaves out (or undefined) stay as they are. */
export const mergeReviewSettings = (
  current: ReviewBoardSettings,
  change: Partial<ReviewBoardSettings>,
): ReviewBoardSettings => ({
  enabled: change.enabled ?? current.enabled,
  model: change.model === undefined ? current.model : change.model,
  minSeverity: change.minSeverity ?? current.minSeverity,
  ignoredPaths: change.ignoredPaths ?? current.ignoredPaths,
  toolCap: change.toolCap === undefined ? current.toolCap : change.toolCap,
});

/** The board's settings as a review uses them. The merge policy's ignored paths always apply; the board's add to them. */
export const resolveReviewSettings = (
  review: ReviewBoardSettings,
  defaults: { readonly defaultModel: string; readonly mergePolicyIgnoredPaths: readonly string[] },
): ReviewSettings => ({
  model: review.model ?? defaults.defaultModel,
  minSeverity: review.minSeverity,
  ignoredPaths: [...new Set([...defaults.mergePolicyIgnoredPaths, ...review.ignoredPaths])],
  toolCap: review.toolCap,
});
