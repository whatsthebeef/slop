/** Below `sm` the board's lists sit side by side in a scroll-snap row, one per screen, with this gap (Tailwind's `gap-3`) between them. */
export const LIST_GAP_PX = 12;

/** Which list the snap row is showing: the one whose left edge is nearest the row's left edge. */
export const visibleListIndex = (scrollLeft: number, rowWidth: number, count: number): number => {
  if (count <= 0 || rowWidth <= 0) return 0;
  const index = Math.round(scrollLeft / (rowWidth + LIST_GAP_PX));
  return Math.min(count - 1, Math.max(0, index));
};

/** Where the snap row scrolls to for list `index` to fill it. */
export const listScrollLeft = (index: number, rowWidth: number): number => index * (rowWidth + LIST_GAP_PX);
