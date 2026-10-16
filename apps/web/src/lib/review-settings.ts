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

/** The spend line on the board: "LLM spend this month $1.23" across every source, with how many calls had no price to add up. */
export const spendLine = (spend: {
  readonly usd: number;
  readonly unpricedCalls: number;
}): string => {
  const base = `LLM spend this month $${spend.usd.toFixed(2)}`;
  return spend.unpricedCalls === 0
    ? base
    : `${base} + ${String(spend.unpricedCalls)} unpriced ${spend.unpricedCalls === 1 ? 'call' : 'calls'}`;
};

/** What the tooltip calls a source whose name is not plain words. */
const SOURCE_LABELS: Readonly<Record<string, string>> = { relation_scan: 'relation_scan (automatic relations)', relation_check: 'relation_check (post-merge relation check)' };

/**
 * The board settings' line for the automatic relation pass: "Automatic relations: $0.0123 this month", with the calls that had no
 * price added when there are some. Four decimals, because most months cost cents or less.
 */
export const relationScanLine = (spend: {
  readonly bySource?: Readonly<Record<string, number>>;
  readonly unpricedBySource?: Readonly<Record<string, number>>;
}): string => {
  const unpriced = spend.unpricedBySource?.['relation_scan'] ?? 0;
  const base = `Automatic relations: $${(spend.bySource?.['relation_scan'] ?? 0).toFixed(4)} this month`;
  return unpriced === 0 ? base : `${base} + ${String(unpriced)} unpriced ${unpriced === 1 ? 'call' : 'calls'}`;
};

/**
 * The spend line's tooltip: one line per source, costliest first, with its priced cost and/or its unpriced calls
 * (such as `chat $0.42 + 1 unpriced`, or `kb_draft 3 unpriced` for a source that lost its price), then the total
 * unpriced calls. `bySource` and `unpricedBySource` are read defensively, so an older API without them shows
 * just the parts it has.
 */
export const spendBreakdown = (spend: {
  readonly bySource?: Readonly<Record<string, number>>;
  readonly unpricedBySource?: Readonly<Record<string, number>>;
  readonly unpricedCalls: number;
}): string => {
  const priced = spend.bySource ?? {};
  const unpriced = spend.unpricedBySource ?? {};
  const lines = [...new Set([...Object.keys(priced), ...Object.keys(unpriced)])]
    .map((source) => ({ source, usd: priced[source], calls: unpriced[source] ?? 0 }))
    .sort(
      (a, b) =>
        (b.usd ?? 0) - (a.usd ?? 0) || b.calls - a.calls || a.source.localeCompare(b.source),
    )
    .map(({ source, usd, calls }) => {
      const parts = [
        usd === undefined ? null : `$${usd.toFixed(2)}`,
        calls > 0 ? `${String(calls)} unpriced` : null,
      ];
      return `${SOURCE_LABELS[source] ?? source} ${parts.filter((p) => p !== null).join(' + ')}`;
    });
  if (spend.unpricedCalls > 0)
    lines.push(
      `${String(spend.unpricedCalls)} unpriced ${spend.unpricedCalls === 1 ? 'call' : 'calls'}`,
    );
  return lines.length === 0 ? 'No LLM spend yet this month' : lines.join('\n');
};
