import { MAX_REVIEW_TOOL_CAP, REVIEW_SEVERITIES } from '@slop/core';
import type { ReviewBoardSettings, ReviewSeverity } from '@slop/core';

/** The independent reviewer's settings as the form's fields hold them (text inputs). */
export interface ReviewForm {
  enabled: boolean;
  model: string;
  minSeverity: ReviewSeverity;
  /** One path glob per line. */
  ignoredPaths: string;
  toolCap: string;
}

export const reviewFormOf = (review: ReviewBoardSettings): ReviewForm => ({
  enabled: review.enabled,
  model: review.model ?? '',
  minSeverity: review.minSeverity,
  ignoredPaths: review.ignoredPaths.join('\n'),
  toolCap: review.toolCap === null ? '' : String(review.toolCap),
});

/** The form as settings: a blank model or cap means the default, blank lines in the paths are dropped. The server checks the values. */
export const reviewSettingsOfForm = (form: ReviewForm): ReviewBoardSettings => ({
  enabled: form.enabled,
  model: form.model.trim() === '' ? null : form.model.trim(),
  minSeverity: form.minSeverity,
  ignoredPaths: form.ignoredPaths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== ''),
  toolCap: form.toolCap.trim() === '' ? null : Number(form.toolCap),
});

/** True when the cap field holds something that is not a whole number (a blank means the default). The server checks the range. */
export const toolCapInvalid = (form: ReviewForm): boolean =>
  form.toolCap.trim() !== '' && !Number.isInteger(Number(form.toolCap));

export const REVIEW_SEVERITY_CHOICES = REVIEW_SEVERITIES;
export { MAX_REVIEW_TOOL_CAP };
