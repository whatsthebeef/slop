import { withProcessing } from './kb.js';
import type { DraftPreview, KbItem, KbItemView } from './kb.js';
import { kbItemFrom } from './kb-glob.js';
import { learningEvidenceSummary } from './learning.js';
import type { LearningRead } from './learning.js';

/**
 * A learning as the Knowledge page and agents receive it (`/api/kb/*`, `list_kb_items`, `decide_kb_item`, a version
 * conflict's `currentItem`). An output format: the services' own decisions use the helpers in `domain/learning.ts`. The
 * KB item adapter also returns it, so pipeline stages that still read through the adapter read it until they move onto
 * the helpers (parts 2–4; the adapter goes in part 6). The shape is the KB item's until the Knowledge page's proposals
 * view goes (part 5).
 */
export type LearningWire = KbItem;

/** A learning as the Knowledge page lists it: with its draft's preview, its evidence count and its freshest evidence. */
export type LearningWireView = KbItemView;

/** The wire form of a learning as read, in the KB item's key order. */
export const learningWire = (read: LearningRead): LearningWire =>
  withProcessing(kbItemFrom(read.glob, read.artifacts), read.jobs);

/** The listed form of a learning: its wire form with `preview` and its evidence summary. */
export const learningWireView = (
  read: LearningRead,
  preview: DraftPreview | null,
): LearningWireView => {
  const evidence = learningEvidenceSummary(read.glob, read.artifacts);
  return {
    ...learningWire(read),
    preview,
    evidenceCount: evidence.count,
    lastEvidenceAt: evidence.lastAt,
  };
};
