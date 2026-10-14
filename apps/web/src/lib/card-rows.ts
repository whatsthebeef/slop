import { decisionOf } from '@slop/core';
import type { HumanStepViewer } from '@slop/core';
import type { GlobView } from './api';
import { cardTargets } from './card-targets';
import { clickTip, positionClick, statusClick, yourTurnClick } from './chip-actions';
import type { ChipClick } from './chip-actions';
import { onStandby, positionOf } from './position';
import type { Position } from './position';
import { blockedParts, chainTip, statusLine } from './status-line';
import type { BlockedParts, StatusLine } from './status-line';

/**
 * What the card's status says, decided in one place and kept pure: the one status in the card's top right (also the glob view
 * header's text), whether anything blocks the glob, and the actions row. The card only renders these.
 */

/** Which icon leads the status: the machine (spinning while a step runs), a warning, a person, an hourglass, or "needs a <person>". */
export type StatusIcon = 'machine' | 'machine-spinning' | 'alert' | 'human' | 'hourglass' | 'needs-human' | 'check';

export interface CornerStatus {
  /** What the status is about, for styling and tests: stalled, needs-human, ready, a problem's kind, machine, human, waiting, standby. */
  readonly kind: string;
  readonly icon: StatusIcon;
  /** One short phrase; the card never wraps it. The icon carries what the words would repeat ("working", "stalled"). */
  readonly text: string;
  /** The accessible name of the status. */
  readonly label: string;
  /** The full detail: every lower-priority item, what a click does, the learned reasons and the chain it waits for. */
  readonly tip: string;
  readonly tone: string;
  /** What a click does; null where the status is plain text. */
  readonly click: ChipClick | null;
}

const STANDBY_TIP = "The machine is on standby, listening to GitHub: it fixes new CI failures or review comments until it's merged.";

const PROVISIONING_TIP = 'slop could not create the branch and draft PR; it retries in the background';

const isEscalated = (glob: GlobView): boolean => glob.escalation != null && glob.status === 'planning';

/**
 * The specifics a position's label adds to its icon, without the word the icon already says: "stalled · merge conflict"
 * becomes "merge conflict", and a bare "standby" says what it is listening for.
 */
export const specifics = (label: string): string => {
  const rest = label.replace(/^stalled(\s*[·:]\s*|$)/i, '');
  return rest.toLowerCase() === 'standby' ? 'listening for CI and reviews' : rest;
};

/** The merge conflict the glob has, open or recorded on a failed merge. */
const conflictOf = (glob: GlobView) => glob.conflict ?? glob.failure?.conflict ?? null;

/** What a problem says on the card, in a few words; the sentence, files and advice stay in the tooltip and the glob view. */
const shortProblem = (status: StatusLine, glob: GlobView): string => {
  // A merge conflict is already worded short by the status line (`conflicts with main`, or the stall label).
  if (status.conflict === true) return status.text;
  switch (status.kind) {
    case 'provisioning':
      return 'branch not created';
    case 'base-red':
      return status.text;
    case 'checks':
      return 'checks failed';
    case 'failure':
      return glob.failure?.kind === 'needs_pairing' ? 'needs a person' : glob.failure?.kind === 'merge' ? 'merge failed' : 'routine run failed';
    case 'investigation-failed':
      return 'investigation failed';
    case 'stuck':
      return 'looks stuck';
    case 'behind':
      return `behind ${glob.behind?.base ?? 'the base'}`;
    default:
      return status.text;
  }
};

/** "waiting on s15f82 +2": the nearest prerequisite and how many more; the chain and the next glob are in the tooltip. */
const waitingText = (parts: BlockedParts): string => {
  const more = parts.ids.length - 1 + parts.more;
  return `waiting on ${parts.ids[0] ?? ''}${more > 0 ? ` +${String(more)}` : ''}`;
};

/** Why a Planning glob waits, from what slop learned of its needs, for the tooltip. */
const learnedReasons = (glob: GlobView): string[] =>
  (glob.impliedAfter ?? [])
    .filter((i) => i.overridden !== true && i.kind === 'needs')
    .map((i) => `${i.id}: ${i.evidence ?? 'a run failed without it'}`);

/**
 * The status without details: no elapsed times ("run failed · 18 min", "queued 3 min", "queued · 3 min") and no commit SHAs
 * ("checks running on abc1234", "merging when checks pass · abc1234"). Those live in the tooltip and the glob view.
 */
export const plainText = (text: string): string =>
  text
    .replace(/\s*·\s*\d+ min\b/g, '')
    .replace(/\s+\d+ min\b/g, '')
    .replace(/\s*·\s*[0-9a-f]{7,40}\b/g, '')
    .replace(/\s+on [0-9a-f]{7,40}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether the glob is merged and waits for a person's sign-off: a label is still to be approved. */
const awaitingSignOff = (glob: GlobView): boolean =>
  glob.status === 'reviewing' && Object.values(glob.labels).some((state) => state !== 'approved');

/**
 * True when the glob needs a person now: its status shows the human outline (Your turn, a due rollout step, awaiting
 * sign-off, an escalation in Planning). A decision glob has no corner status, so its turn is the status line's.
 */
export const needsPerson = (glob: GlobView, now: string, viewer?: HumanStepViewer): boolean => {
  if (decisionOf(glob) !== null) return statusLine(glob, now, viewer)?.kind === 'ready';
  const icon = cornerStatus(glob, now, viewer)?.icon;
  return icon === 'human' || icon === 'needs-human';
};

/**
 * The card's one status (and the glob view header's text), or null when there is nothing to say. Highest priority wins the
 * words, the rest go in the tooltip: a stall, an escalation in Planning, your turn, a problem, the machine running, the
 * prerequisites it waits on, any other waiting, standby. Decision globs have none.
 */
export const cornerStatus = (glob: GlobView, now: string, viewer?: HumanStepViewer, repo?: string): CornerStatus | null => {
  if (decisionOf(glob) !== null) return null;
  // Signed off is the glob's whole state: nothing else shows, and the date lives in the tooltip.
  if (glob.status === 'signed_off') {
    const when = glob.signedOffAt == null ? '' : ` ${new Date(glob.signedOffAt).toLocaleString()}`;
    const tip = `Signed off${when}`;
    return { kind: 'signed-off', icon: 'check', text: 'signed off', label: 'signed off', tip, tone: 'text-muted-foreground', click: null };
  }
  const status = statusLine(glob, now, viewer);
  const position = positionOf(glob, now, viewer);
  const blocked = blockedParts(glob);
  const standby = onStandby(glob);
  const escalation = glob.escalation;
  const escalated = isEscalated(glob);

  const make = (kind: string, icon: StatusIcon, text: string, tone: string, click: ChipClick | null, lead: string[]): CornerStatus => {
    const rest = [
      ...(status === null ? [] : [status.tip]),
      ...(position === null ? [] : [position.tip]),
      ...(kind !== 'needs-human' && escalated && escalation != null ? [`Needs a person: ${escalation.reason}`] : []),
      ...(blocked === null || kind === 'waiting-on' ? [] : [`Waits for, in order: ${chainTip(glob)}`]),
      ...(standby === null || kind === 'standby' ? [] : [STANDBY_TIP]),
    ];
    const hint =
      click === null || kind === 'needs-human' ? [] : [kind === 'waiting-on' ? "Opens this glob's related globs" : clickTip(click)];
    const shown = plainText(text);
    // What the text dropped (a time, a commit) stays in the tooltip.
    const detail = shown === text ? [] : [text];
    const tip = [...new Set([...lead, ...detail, ...rest, ...hint].filter((t) => t !== ''))].join('\n');
    return { kind, icon, text: shown, label: kind === 'needs-human' ? 'Needs a person' : shown, tip, tone, click };
  };

  if (position?.holder === 'stalled') {
    const cause = specifics(position.label) || specifics(position.text) || 'nobody on it';
    // A cause that already carries its age ("no progress 12 min") is not given it twice.
    const minutes = position.minutes !== null && position.minutes > 0 && !/\d+ min/.test(cause) ? ` · ${String(position.minutes)} min` : '';
    // The stall's next step is a person's (the viewer's turn): the human outline with that action, not the warning.
    if (status !== null && status.kind === 'ready') {
      const turn = yourTurnClick(status, glob);
      const click: ChipClick = turn.kind === 'act' ? { kind: 'section', target: cardTargets.actions() } : turn;
      return make('ready', 'human', status.text, status.tone, click, [position.tip, `Stalled: ${cause}${minutes}`, status.tip]);
    }
    // A failed provisioning stalls the glob; it says what failed, with the click that retries it (the actions section).
    if (glob.provisioning === 'failed') {
      return make('stalled', 'alert', 'provisioning failed', 'text-red', { kind: 'section', target: cardTargets.actions() }, [
        PROVISIONING_TIP,
        position.tip,
      ]);
    }
    return make('stalled', 'alert', `${cause}${minutes}`, position.tone, positionClick(position, glob, repo), [position.tip]);
  }
  if (escalated && escalation != null) {
    return make('needs-human', 'needs-human', 'needs a', 'text-required', { kind: 'section', target: cardTargets.escalation() }, [
      `Needs a person: ${escalation.reason}. Opens the reason`,
    ]);
  }
  if (glob.provisioning === 'failed') {
    return make('provisioning', 'alert', 'provisioning failed', 'text-red', { kind: 'section', target: cardTargets.actions() }, [
      PROVISIONING_TIP,
    ]);
  }
  if (status !== null && status.kind === 'ready') {
    // Your turn only ever opens the glob view from here; Merge and Done are run by the actions row's button.
    const turn = yourTurnClick(status, glob);
    const click: ChipClick = turn.kind === 'act' ? { kind: 'section', target: cardTargets.actions() } : turn;
    return make('ready', 'human', status.text, status.tone, click, [status.tip]);
  }
  if (status !== null && position?.holder === 'machine' && (status.conflict === true || status.kind === 'checks' || status.kind === 'stuck' || status.kind === 'behind')) {
    // Someone is on the problem: say what the machine is doing ("fixing the conflict"), with the problem in the tooltip.
    const icon = position.spinning ? 'machine-spinning' : 'machine';
    return make('machine', icon, position.label, position.tone, positionClick(position, glob, repo), [position.tip, status.tip]);
  }
  if (status !== null) {
    const icon = status.kind === 'base-red' || status.kind === 'merge-waits' ? 'hourglass' : status.kind === 'rollout' ? 'human' : 'alert';
    return make(status.kind, icon, shortProblem(status, glob), status.tone, statusClick(status), [status.tip]);
  }
  if (awaitingSignOff(glob) && position === null) {
    return make('sign-off', 'human', 'sign off', 'text-signal-strong', { kind: 'section', target: cardTargets.label() }, [
      'Merged; the labels are waiting for a person to approve them',
    ]);
  }
  if (position?.holder === 'machine') {
    const icon = position.spinning ? 'machine-spinning' : 'machine';
    const isStandby = position.label.toLowerCase() === 'standby';
    return make(isStandby ? 'standby' : 'machine', icon, position.label, position.tone, positionClick(position, glob, repo), [position.tip]);
  }
  if (blocked !== null) {
    return make('waiting-on', 'hourglass', waitingText(blocked), 'text-muted-foreground', { kind: 'section', target: cardTargets.related() }, [
      `Waits for, in order: ${chainTip(glob)}`,
      ...learnedReasons(glob),
    ]);
  }
  if (position !== null) {
    const waiting = position.holder === 'waiting';
    return make(
      waiting ? 'waiting' : 'human',
      waiting ? 'hourglass' : 'human',
      position.label,
      position.tone,
      positionClick(position, glob, repo),
      [position.tip],
    );
  }
  if (standby !== null) return make('standby', 'machine', 'standby', 'text-muted-foreground', null, [STANDBY_TIP]);
  return null;
};

/**
 * Whether something blocks the glob, so the card offers no action and the status line says what is wrong: unmerged needs, a
 * conflict, failed checks, a stall, or an escalation or step waiting on a decision. A glob that is merely behind or
 * clashes with another, or whose checks are still running is not blocked.
 */
export const hasBlocker = (glob: GlobView, now: string, viewer?: HumanStepViewer): boolean => {
  const status = statusLine(glob, now, viewer);
  const position: Position | null = positionOf(glob, now, viewer);
  if (blockedParts(glob) !== null) return true;
  if (glob.status === 'planning' && position?.holder === 'waiting') return true;
  if (conflictOf(glob) != null) return true;
  if (position?.holder === 'stalled') return true;
  if (isEscalated(glob) || status?.turn === 'decide') return true;
  return status !== null && ['provisioning', 'base-red', 'checks', 'stuck'].includes(status.kind);
};

/** The Your turn step the card runs itself: Merge (after a confirming click) or Done. Anything else needs input in the glob view. */
export const turnButton = (
  glob: GlobView,
  now: string,
  viewer: HumanStepViewer | undefined,
  blocked: boolean,
): { readonly status: StatusLine; readonly click: Extract<ChipClick, { kind: 'act' }> } | null => {
  if (blocked || decisionOf(glob) !== null) return null;
  const status = statusLine(glob, now, viewer);
  if (status === null || status.kind !== 'ready') return null;
  const click = yourTurnClick(status, glob);
  return click.kind === 'act' ? { status, click } : null;
};
