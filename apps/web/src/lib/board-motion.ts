import type { GlobView } from './api';
import { useCardMotion } from './card-motion';
import type { CardMotionOptions, RemoteTag } from './card-motion';
import type { LiveState } from './live';

export type { MoveTag } from './card-motion';

const initialsOf = (email: string) => {
  const [first = '', second = ''] = (email.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean);
  return (
    second === '' ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`
  ).toUpperCase();
};

/**
 * Up to three words on what moved a glob made elsewhere, from the event behind the move. A merge that went through slop passed
 * through `merging`; one that skipped it came from GitHub outside slop.
 */
export const describeRemote = (before: GlobView, after: GlobView): RemoteTag => {
  if (after.list === 'reviewing' && before.list === 'doing') return { text: before.status === 'merging' ? 'merged' : 'merged on GitHub' };
  if (after.list === 'signed_off') return { text: 'signed off' };
  if (after.list === 'planning') return { text: 'back to planning' };
  if (after.implementer !== null && after.implementer !== before.implementer)
    return { text: `picked up by ${initialsOf(after.implementer)}`, icon: 'human' };
  const run = after.currentRun;
  if (run !== null && run.state !== 'ended')
    return { text: run.purpose === 'investigate' ? 'investigating' : 'machine started', icon: 'machine' };
  return { text: 'moved' };
};

const GLOB_MOTION: CardMotionOptions<GlobView> = {
  attribute: 'data-glob-id',
  idOf: (glob) => glob.id,
  groupOf: (glob) => glob.list,
  describeRemote,
};

/**
 * The board's card motion (`useCardMotion`): a glob whose list changed steps across with the lock
 * flash (LCD green for your own moves, khaki for moves made elsewhere, which also show a short tag in the card's status slot);
 * the cards it displaces glide.
 */
export const useBoardMotion = (globs: readonly GlobView[] | undefined, live: LiveState) =>
  useCardMotion(globs, live, GLOB_MOTION);
