import type { GlobView } from './api';
import { useCardMotion } from './card-motion';
import type { CardMotionOptions } from './card-motion';
import type { LiveState } from './live';

export type { MoveTag } from './card-motion';

const initialsOf = (email: string) => {
  const [first = '', second = ''] = (email.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean);
  return (
    second === '' ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`
  ).toUpperCase();
};

/** A few words on who or what moved a glob, for a move made elsewhere. */
const describeRemote = (before: GlobView, after: GlobView): string => {
  if (after.list === 'reviewing' && before.list === 'doing') return 'merged on GitHub';
  if (after.list === 'signed_off') return 'signed off';
  if (after.list === 'planning') return 'started again';
  if (after.implementer !== null && after.implementer !== before.implementer)
    return `picked up by ${initialsOf(after.implementer)}`;
  const run = after.currentRun;
  if (run !== null && run.state !== 'ended') return 'started for a routine';
  return 'moved';
};

const GLOB_MOTION: CardMotionOptions<GlobView> = {
  attribute: 'data-glob-id',
  idOf: (glob) => glob.id,
  groupOf: (glob) => glob.list,
  describeRemote,
};

/**
 * The board's card motion (`useCardMotion`): a glob whose list changed steps across with the lock
 * flash (LCD green for your own moves, khaki for moves made elsewhere, which also get a short tag);
 * the cards it displaces glide.
 */
export const useBoardMotion = (globs: readonly GlobView[] | undefined, live: LiveState) =>
  useCardMotion(globs, live, GLOB_MOTION);
