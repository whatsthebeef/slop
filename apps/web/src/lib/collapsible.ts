/** The height a collapsed document is clipped to, in rem (about 24rem). */
export const COLLAPSED_REM = 24;

/** A document needs the More button only when its natural height is taller than the collapsed height. */
export const needsCollapse = (naturalPx: number, remPx: number): boolean => naturalPx > COLLAPSED_REM * remPx;
