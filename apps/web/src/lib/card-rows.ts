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
 * What the card's rows say, decided in one place and kept pure: the one corner marker, the one status line, whether anything
 * blocks the glob, and the actions row. The card only renders these.
 */

/** The one actor or position marker in the card's top-right corner. Highest first: stalled, needs a human, working, standby. */
export type CornerKind = 'stalled' | 'needs-human' | 'working' | 'standby';

export interface CornerMarker {
  readonly kind: CornerKind;
  /** One short word or two; the card never wraps it. */
  readonly text: string;
  /** The full text: the stall's reason, the escalation's reason, and standby where it applies. */
  readonly tip: string;
  readonly tone: string;
  /** What a click does; null where the marker is plain text. */
  readonly click: ChipClick | null;
}

const STANDBY_TIP = "The machine is on standby, listening to GitHub: it fixes new CI failures or review comments until it's merged.";

const isEscalated = (glob: GlobView): boolean => glob.escalation != null && glob.status === 'planning';

/** The single marker for the corner, or null. A stalled glob never also shows standby: its tooltip says so instead. */
export const cornerMarker = (glob: GlobView, now: string, viewer?: HumanStepViewer, repo?: string): CornerMarker | null => {
  const position = positionOf(glob, now, viewer);
  const standby = onStandby(glob);
  const escalation = glob.escalation;
  if (position?.holder === 'stalled') {
    return {
      kind: 'stalled',
      text: 'stalled',
      tip: [position.tip, ...(standby === null ? [] : [STANDBY_TIP]), ...(escalation != null && isEscalated(glob) ? [`Needs a person: ${escalation.reason}`] : [])].join('\n'),
      tone: position.tone,
      click: positionClick(position, glob, repo),
    };
  }
  if (escalation != null && isEscalated(glob)) {
    return { kind: 'needs-human', text: 'needs a human', tip: `Needs a person: ${escalation.reason}. Opens the reason`, tone: 'text-required', click: { kind: 'section', target: cardTargets.escalation() } };
  }
  if (position?.holder === 'machine') {
    return { kind: 'working', text: 'working', tip: position.tip, tone: 'text-muted-foreground', click: positionClick(position, glob, repo) };
  }
  if (standby !== null) return { kind: 'standby', text: 'standby', tip: STANDBY_TIP, tone: 'text-muted-foreground', click: null };
  return null;
};

/**
 * The specifics a position's label adds to the corner marker, without the marker's own word: "stalled · merge conflict"
 * becomes "merge conflict", and a bare "standby" says what it is listening for.
 */
export const specifics = (label: string): string => {
  const rest = label.replace(/^stalled(\s*[·:]\s*|$)/i, '');
  return rest.toLowerCase() === 'standby' ? 'listening for CI and reviews' : rest;
};

/** The glob view's Now headline for a stalled or machine position: the corner marker's word and the line's specifics, joined once. */
export const nowHeadline = (holder: 'stalled' | 'machine', label: string): string => {
  const line = specifics(label);
  const word = holder === 'stalled' ? 'stalled' : label.toLowerCase() === 'standby' ? 'standby' : 'working';
  return line === '' ? word : `${word} · ${line}`;
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

/** The first item of the line: what is wrong or what is next, with what a click on it does. */
export interface StatusHead {
  readonly kind: string;
  readonly text: string;
  readonly tone: string;
  readonly click: ChipClick;
}

/** What the glob waits on, said once: the nearest unmerged needs, how many more, and what to start next. */
export interface StatusWaiting extends BlockedParts {
  readonly text: string;
}

export interface CardStatus {
  /** The head's kind (a status kind, a holder, or `waiting`), for styling and tests. */
  readonly kind: string;
  readonly head: StatusHead | null;
  readonly waiting: StatusWaiting | null;
  /** The whole visible line, items separated by " · " most important first. */
  readonly text: string;
  readonly tip: string;
}

const waitingText = (parts: BlockedParts): string =>
  `waiting on ${parts.ids.join(', ')}${parts.more > 0 ? ` +${String(parts.more)}` : ''}${parts.next === null ? '' : ` · next: ${parts.next}`}`;

/** Why a Planning glob waits, from what slop learned of its needs, for the waiting item's tooltip. */
const learnedReasons = (glob: GlobView): string[] =>
  (glob.impliedAfter ?? [])
    .filter((i) => i.overridden !== true && i.kind === 'needs')
    .map((i) => `${i.id}: ${i.evidence ?? 'a run failed without it'}`);

/**
 * The card's one status line, or null when there is nothing to say (no row then). Priority, so that a cut-off line loses the
 * least important item: (1) a stall, else Your turn, else the problem, else where the glob is; (2) what it waits on.
 * Decision globs have none.
 */
export const cardStatus = (glob: GlobView, now: string, viewer?: HumanStepViewer, repo?: string): CardStatus | null => {
  if (decisionOf(glob) !== null) return null;
  const status = statusLine(glob, now, viewer);
  const position = positionOf(glob, now, viewer);
  const blocked = blockedParts(glob);
  const escalated = isEscalated(glob);
  const tips: string[] = [];
  let head: StatusHead | null = null;

  if (position?.holder === 'stalled') {
    // One mention: the stall's own short label, with the problem's detail (files included) in the tooltip.
    head = { kind: 'stalled', text: specifics(position.label), tone: position.tone, click: positionClick(position, glob, repo) };
    tips.push(position.tip, ...(status === null ? [] : [status.tip]));
  } else if (status !== null && status.kind === 'ready') {
    // The status line only ever opens the glob view; Merge and Done are run by the actions row's button.
    const turn = yourTurnClick(status, glob);
    const click: ChipClick = turn.kind === 'act' ? { kind: 'section', target: cardTargets.actions() } : turn;
    head = { kind: 'ready', text: `Your turn · ${status.text}`, tone: status.tone, click };
    tips.push(status.tip);
  } else if (status !== null && position?.holder === 'machine' && (status.conflict === true || status.kind === 'checks' || status.kind === 'stuck')) {
    // Someone is on the problem: say what the machine is doing ("fixing the conflict"), with the problem in the tooltip.
    head = { kind: 'machine', text: specifics(position.label), tone: position.tone, click: positionClick(position, glob, repo) };
    tips.push(position.tip, status.tip);
  } else if (status !== null) {
    const click = statusClick(status);
    head = { kind: status.kind, text: shortProblem(status, glob), tone: status.tone, click };
    tips.push(status.tip);
  } else if (position !== null && !(escalated && position.holder === 'human') && !(blocked !== null && position.holder === 'waiting')) {
    head = { kind: position.holder, text: specifics(position.label), tone: position.tone, click: positionClick(position, glob, repo) };
    tips.push(position.tip);
    if (position.holder === 'waiting') tips.push(...learnedReasons(glob));
  }
  if (head !== null) tips.push(clickTip(head.click));

  let waiting: StatusWaiting | null = null;
  if (blocked !== null) {
    waiting = { ...blocked, text: waitingText(blocked) };
    tips.push(`Waits for, in order: ${chainTip(glob)}`, ...learnedReasons(glob), `Opens this glob's prerequisites; each ID opens that glob`);
  }
  if (head === null && waiting === null) return null;
  return {
    kind: head?.kind ?? 'waiting',
    head,
    waiting,
    text: [head?.text, waiting?.text].filter((t): t is string => t !== undefined).join(' · '),
    tip: tips.join('\n'),
  };
};

/**
 * Whether something blocks the glob, so the card offers no action and the status line says what is wrong: unmerged needs, a
 * conflict, failed checks, a stall, or an escalation or step waiting on a decision. A glob that is merely behind, overlaps or
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
