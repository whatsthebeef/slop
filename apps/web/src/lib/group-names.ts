/** The board's groups for suggestions: most used by open globs first, then by name. */
export const groupNames = (globs: readonly { group: string | null; list: string }[]): string[] => {
  const open = new Map<string, number>();
  for (const { group, list } of globs) {
    if (group === null) continue;
    open.set(group, (open.get(group) ?? 0) + (list === 'signed_off' ? 0 : 1));
  }
  return [...open.keys()].sort((a, b) => (open.get(b) ?? 0) - (open.get(a) ?? 0) || a.localeCompare(b));
};
