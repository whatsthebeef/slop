import type { Glob, MergeLinePlace } from './types.js';

/**
 * The board's merge line: its `merging` globs that carry `mergeLine`, first come first served. Pure selection and place
 * derivation only; the transitions that join, promote and leave are in `machine.ts` and the lock is `Tx.lockMergeLine`.
 * Nothing here is stored: a glob that leaves `merging` leaves the line by definition, so the line can't keep a ghost.
 */

/**
 * A head with no check result for its current commit this long is asked again; a second silence this long fails the merge.
 * The same periods apply to a head whose checks passed but whose merge has not happened.
 */
export const MERGE_HEAD_STUCK_MS = 20 * 60_000;

/** Whether the glob is in its board's merge line, as the head or waiting. */
export const isInMergeLine = (glob: Glob): boolean => glob.status === 'merging' && glob.mergeLine != null;

/** Whether the glob is the head of its board's line: the one glob that updates, waits for checks and merges. */
export const isMergeHead = (glob: Glob): boolean => glob.status === 'merging' && glob.mergeLine?.head != null;

const joinedAt = (glob: Glob): string => glob.mergeLine?.joinedAt ?? glob.updatedAt;

/** First come, first served: by the time each joined, then by ID so two joins in the same instant keep one order. */
const inOrder = (a: Glob, b: Glob): number => joinedAt(a).localeCompare(joinedAt(b)) || a.id.localeCompare(b.id);

/** The board's line in order, the head (when there is one) first, then the others by when they joined. */
export const mergeLineOf = (globs: readonly Glob[]): Glob[] => {
  const line = globs.filter(isInMergeLine).sort(inOrder);
  const head = line.find(isMergeHead);
  return head === undefined ? line : [head, ...line.filter((g) => g.id !== head.id)];
};

/** The globs that could become head, in the order they would: none while the line has a head. */
export const headCandidates = (globs: readonly Glob[]): Glob[] => {
  const line = mergeLineOf(globs);
  return line.some(isMergeHead) ? [] : line;
};

/**
 * Whether the board has merging globs and nobody to merge them: no head, and either a waiting glob or an older merging glob
 * that never joined the line (it predates it). The sweep calls `advanceMergeLine` for such a board.
 */
export const mergeLineNeedsAdvance = (globs: readonly Glob[]): boolean => {
  const merging = globs.filter((g) => g.status === 'merging');
  return merging.length > 0 && !merging.some(isMergeHead);
};

/** Each line glob's place: 1 is the head, `ahead` the IDs in front of it (head first). Globs outside the line have none. */
export const mergeLinePlaces = (globs: readonly Glob[]): Map<string, MergeLinePlace> => {
  const places = new Map<string, MergeLinePlace>();
  const ids: string[] = [];
  for (const glob of mergeLineOf(globs)) {
    places.set(glob.id, { position: ids.length + 1, ahead: [...ids] });
    ids.push(glob.id);
  }
  return places;
};

/** Whether the head's checks have reported on its current commit. */
const headReported = (glob: Glob): boolean =>
  glob.pr?.headSha != null && glob.headChecks?.sha === glob.pr.headSha && glob.headChecks.state !== 'pending';

/** Whether the head's checks passed on its current commit (so the merge is due, not the checks). */
export const mergeHeadChecksPassed = (glob: Glob): boolean => headReported(glob) && glob.headChecks?.state === 'passed';

/**
 * Whether the head has gone quiet: `recheck` (nothing for its current commit since it became head, pushed or was updated:
 * ask for the result again) or `fail` (still nothing after the recheck). A head whose checks passed is quiet the same way when
 * no merge follows (the merge result changes the glob; a lost or failing `squash_merge` does not). Null for a waiting glob,
 * which holds no work, and for a head whose checks failed (that leaves the line by itself). `updatedAt` counts as a sign of life (every webhook that matters changes the glob), so the clock is
 * its later of the two; after a recheck the clock restarts at `recheckedAt`.
 */
export const mergeHeadStuck = (glob: Glob, nowMs: number): 'recheck' | 'fail' | null => {
  const head = glob.status === 'merging' ? glob.mergeLine?.head : undefined;
  if (head === undefined || (headReported(glob) && !mergeHeadChecksPassed(glob))) return null;
  if (head.recheckedAt !== undefined) return nowMs - Date.parse(head.recheckedAt) > MERGE_HEAD_STUCK_MS ? 'fail' : null;
  const quietSince = Math.max(Date.parse(head.since), Date.parse(glob.updatedAt));
  return nowMs - quietSince > MERGE_HEAD_STUCK_MS ? 'recheck' : null;
};

/** The failure a stuck head leaves the line with: how long it waited and what it waited after. */
export const mergeHeadStuckReason = (glob: Glob, nowMs: number): string => {
  const since = glob.mergeLine?.head?.since ?? glob.updatedAt;
  const minutes = Math.max(1, Math.round((nowMs - Date.parse(since)) / 60_000));
  if (mergeHeadChecksPassed(glob)) return `Not merged: no merge result ${String(minutes)} minutes after the checks passed`;
  const after = (glob.mergeUpdates ?? 0) > 0 ? 'updating the branch' : 'the last push';
  return `No check result ${String(minutes)} minutes after ${after}: recheck the checks or push again`;
};
