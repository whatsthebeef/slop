import type { Artifact, ArtifactKind } from '../../domain/knowledge.js';

export interface ArtifactListing {
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly version: number;
  readonly commitSha: string | null;
  /** Characters of content. */
  readonly size: number;
  /** The first line of the content, or the link. */
  readonly description: string;
}

/** Attachments with these labels always come inline: agents must follow them and pass them verbatim. */
export const INLINE_LABELS = new Set(['clarifications', 'assumptions']);

/** Label prefixes that also come inline: a failed rollout step's note, or a failed action run's output, is the next round's feedback. */
const INLINE_LABEL_PREFIXES = ['rollout step failed', 'action run failed'];

export const isInlineLabel = (label: string): boolean => {
  const lower = label.toLowerCase();
  return INLINE_LABELS.has(lower) || INLINE_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/** `include` entries: a kind (`local_review`, `local_review`, ...), `attachment:<label>`, or `all`. */
export const wanted = (include: readonly string[], a: Artifact): boolean =>
  include.includes('all') ||
  include.includes(a.kind) ||
  (a.kind === 'attachment' && include.some((i) => i.toLowerCase() === `attachment:${a.label}`.toLowerCase()));

export const describe = (a: Artifact): string => {
  const line = a.content.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l !== '');
  const text = line ?? a.link ?? '';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};
