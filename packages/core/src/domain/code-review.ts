import type { KnowledgeDoc } from './knowledge.js';

/** A board knowledge document in this area is the board's review guide (`get_review_guide`). */
export const REVIEW_GUIDE_AREA = 'review_guide';

/** Whether a knowledge document is a review guide. */
export const isReviewGuide = (doc: Pick<KnowledgeDoc, 'kind' | 'area'>): boolean =>
  doc.kind === 'doc' && doc.area?.toLowerCase() === REVIEW_GUIDE_AREA;
