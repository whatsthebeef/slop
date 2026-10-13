/** The height a collapsed document is clipped to, in rem (about 24rem). */
export const COLLAPSED_REM = 24;

/** A document needs the More button only when its natural height is taller than the collapsed height. */
export const needsCollapse = (naturalPx: number, remPx: number): boolean => naturalPx > COLLAPSED_REM * remPx;

/** The bar's text: "Show more" while clipped, "Show less" once expanded. */
export const barLabel = (expanded: boolean): string => (expanded ? 'Show less' : 'Show more');

/** The last ~1.5 lines of a clipped box fade from full opacity to 35%: a mask on the text wrapper only, so the box's background stays solid. */
export const FADE_STYLE = {
  maskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), rgb(0 0 0 / 0.35))',
  WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), rgb(0 0 0 / 0.35))',
} as const;

/** The box's classes: it carries the solid background and padding (outside the fade mask); a long one gets a border and square bottom corners at the join with the bar, and while clipped no bottom padding, so the faded text reaches the bar. */
export const boxClass = (long: boolean, clipped = false): string =>
  long ? `rounded-t border border-b-0 bg-muted ${clipped ? 'px-3 pb-0 pt-3' : 'p-3'}` : 'rounded bg-muted p-3';

/** The full-width bar joined to the box's bottom: shared border, matching bottom radius, muted button hover and focus states. */
const BAR_BASE =
  'flex w-full items-center justify-center gap-1 rounded-b border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The bar's classes: while clipped its top border (the separator under the text) is fainter than the box's outer border. */
export const barClass = (clipped: boolean): string => (clipped ? `${BAR_BASE} border-t-border/40` : BAR_BASE);
