import { presentGlob, waitingOnOwn } from '@slop/core';
import type { Action, CardPrimary, HumanStepViewer, PendingAction, Presentation } from '@slop/core';
import type { GlobView } from './api';

/** What the web adds to a glob to present it: who is looking, the board's facts and a click this client has sent but the glob does not show yet. */
export interface PresentOptions {
  readonly viewer?: HumanStepViewer;
  /** The board's base branch, for "merging from <base>". */
  readonly base?: string;
  /** The board's GitHub repo, for the activity's links. */
  readonly repo?: string | null;
  /** How many globs in Planning wait for this one; the glob's own count when the board does not pass one. */
  readonly waitingOnThis?: number;
  /** A click this client sent whose result the glob does not carry yet, in the stored shape. */
  readonly pending?: PendingAction | null;
  /** False for a learning whose outcome is already in. */
  readonly learningOpen?: boolean;
  /** An ISO time; now when absent. */
  readonly now?: string;
}

/**
 * The one way the web asks what to show for a glob: the card, the glob view's header, action row and activity all call it, so
 * their status, buttons and notice cannot disagree. A thin adapter over core's `presentGlob`.
 */
export const presentOf = (glob: GlobView, options: PresentOptions = {}): Presentation =>
  presentGlob({
    glob,
    now: options.now ?? new Date().toISOString(),
    waitingOnThis: options.waitingOnThis ?? waitingOnOwn(glob),
    ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.pending === undefined ? {} : { pending: options.pending }),
    ...(options.learningOpen === undefined ? {} : { learningOpen: options.learningOpen }),
  });

/** A click as this client sends it: the stored shape, so the glob and the client say "pending" the same way. */
export const clickOf = (kind: Action, by: string): PendingAction => ({
  kind,
  at: new Date().toISOString(),
  by,
});

/** One move the card can make: a state-machine action. Pick up and Start move the card into Doing; Merge and Fix conflict run in place. */
export interface CardMove {
  readonly action: Action;
  /** `none`: the action runs in place and the card stays in its list, so it has no ▸ and no ghost piece. */
  readonly direction: 'right' | 'none';
  /** A first click only arms the button ("Confirm merge"); a second one within a few seconds runs it. */
  readonly confirm: boolean;
  /** The verb on the button, e.g. "Pick up ▸". */
  readonly label: string;
  /** What it does, for screen readers and the tooltip. */
  readonly description: string;
  readonly icon: CardPrimary['icon'];
}

/** The card's move for its primary button. */
export const cardMoveOf = (primary: CardPrimary): CardMove =>
  primary.confirm
    ? {
        action: primary.action,
        direction: 'none',
        confirm: true,
        label: primary.label,
        description: primary.tip,
        icon: primary.icon,
      }
    : {
        action: primary.action,
        direction: 'right',
        confirm: false,
        label: `${primary.label} ▸`,
        description: primary.tip,
        icon: primary.icon,
      };
