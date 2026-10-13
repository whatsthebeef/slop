import type { GlobView } from './api';

/** What the card's split chip says for a glob cut from another: nothing on the first part, "split from <source>" on the rest. */
export const splitChip = (
  glob: Pick<GlobView, 'id' | 'split'>,
): { source: string; tip: string } | null => {
  const split = glob.split;
  if (split === undefined || split.part === 0) return null;
  const others = split.parts.filter((id) => id !== glob.id);
  return {
    source: split.source,
    tip: `Split from ${split.source}; part ${split.part + 1} of ${split.parts.length}; the other parts: ${others.join(', ')}`,
  };
};
