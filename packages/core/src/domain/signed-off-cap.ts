/** How many signed-off globs the board's Signed Off column keeps; older ones stay on the Signed off tab and in search. */
export const SIGNED_OFF_ON_BOARD = 25;

/** The most recently signed-off items first (by `signedOffAt`, not `updatedAt`: editing an old glob doesn't bring it back). */
export const bySignedOffNewest = <
  T extends { readonly id: string; readonly signedOffAt: string | null },
>(
  items: readonly T[],
): T[] =>
  [...items].sort(
    (a, b) => (b.signedOffAt ?? '').localeCompare(a.signedOffAt ?? '') || b.id.localeCompare(a.id),
  );

/** The ones the Signed Off column keeps. */
export const latestSignedOff = <
  T extends { readonly id: string; readonly signedOffAt: string | null },
>(
  items: readonly T[],
): T[] => bySignedOffNewest(items).slice(0, SIGNED_OFF_ON_BOARD);
