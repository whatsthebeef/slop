/**
 * The core documents every board should have (spec, knowledge base): a build document, conventions and an
 * architecture overview. A board is missing one when no knowledge document has its area.
 */
export const CORE_DOC_AREAS = ['build', 'conventions', 'architecture'] as const;
export type CoreDocArea = (typeof CORE_DOC_AREAS)[number];

/** The core areas no document has, in `CORE_DOC_AREAS` order. */
export const missingCoreAreas = (documents: readonly { readonly area: string | null }[]): CoreDocArea[] =>
  CORE_DOC_AREAS.filter((area) => !documents.some((d) => d.area === area));

/** The notice for a missing core area, with how to fix it. */
export const missingCoreDocNotice = (area: CoreDocArea, boardId: number): string =>
  `No ${area} document. Run \`/kb-bootstrap ${String(boardId)}\` in a checkout of the board's repo; it proposes one for you to approve.`;

/** Mining raises a missing core area once it has been missing this long, on a board with at least this many merged globs. */
export const MISSING_DOC_MIN_DAYS = 7;
export const MISSING_DOC_MIN_MERGED_GLOBS = 5;
/** A rejected learning for a missing area is raised again once the area is still missing after this long. */
export const MISSING_DOC_RERAISE_DAYS = 60;
