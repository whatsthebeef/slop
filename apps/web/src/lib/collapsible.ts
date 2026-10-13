/** The height a collapsed document is clipped to, in rem (about 24rem). */
export const COLLAPSED_REM = 24;

/** A document needs the More button only when its natural height is taller than the collapsed height. */
export const needsCollapse = (naturalPx: number, remPx: number): boolean => naturalPx > COLLAPSED_REM * remPx;

/** The bar's text: "Show more" while clipped, "Show less" once expanded. */
export const barLabel = (expanded: boolean): string => (expanded ? 'Show less' : 'Show more');

/** The box's classes: a long one gets a border, square bottom corners at the join with the bar, and clips its content; no fade. */
export const boxClass = (long: boolean): string => (long ? 'overflow-hidden rounded-t border border-b-0' : '');

/** The full-width bar joined to the box's bottom: shared border, matching bottom radius, muted button hover and focus states. */
export const BAR_CLASS =
  'flex w-full items-center justify-center gap-1 rounded-b border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
