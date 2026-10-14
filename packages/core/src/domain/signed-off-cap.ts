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

/**
 * A board list's order: when each glob entered the list, newest first (`listSince`, falling back to `createdAt` for an
 * API that doesn't send it), ties by ID descending. Not `updatedAt`: work on a card doesn't move it.
 */
export const byListSinceNewest = <
  T extends { readonly id: string; readonly createdAt: string; readonly listSince?: string },
>(
  items: readonly T[],
): T[] =>
  [...items].sort(
    (a, b) =>
      (b.listSince ?? b.createdAt).localeCompare(a.listSince ?? a.createdAt) ||
      b.id.localeCompare(a.id, undefined, { numeric: true }),
  );
