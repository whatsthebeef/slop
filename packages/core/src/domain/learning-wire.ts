import { withProcessing } from './kb.js';
import type { DraftPreview, LearningWire, LearningWireView } from './kb.js';
import { learningWireFrom } from './kb-glob.js';
import { learningEvidenceSummary } from './learning.js';
import type { LearningRead } from './learning.js';

/** The wire form of a learning as read, in the KB item's key order. */
export const learningWire = (read: LearningRead): LearningWire =>
  withProcessing(learningWireFrom(read.glob, read.artifacts), read.jobs);

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
