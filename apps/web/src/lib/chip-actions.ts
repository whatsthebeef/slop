import type { Action } from '@slop/core';
import type { GlobView } from './api';
import { cardTargets } from './card-targets';
import type { GlobTarget } from './glob-section';
import type { Position } from './position';
import type { StatusLine } from './status-line';

/** How long a Merge chip stays on "Confirm merge" before it reverts. */
export const CONFIRM_MS = 4000;

/** What clicking a chip does: run an action, open the glob view at a section, or open a page in a new tab. */
export type ChipClick =
  | { readonly kind: 'act'; readonly action: Action; readonly confirm: boolean }
  | { readonly kind: 'section'; readonly target: GlobTarget }
  | { readonly kind: 'link'; readonly url: string };

/** The glob's PR on GitHub, or null while there is no PR. */
export const prUrl = (repo: string | undefined, glob: Pick<GlobView, 'pr'>): string | null =>
  repo === undefined || glob.pr === null ? null : `https://github.com/${repo}/pull/${String(glob.pr.number)}`;

/** The page the glob's PR checks are on, or null while there is no PR. */
export const checksUrl = (repo: string | undefined, glob: Pick<GlobView, 'pr'>): string | null => {
  const url = prUrl(repo, glob);
  return url === null ? null : `${url}/checks`;
};

/**
 * What the Your turn chip does. Merge and Done run their action (Merge after a confirming click) when the glob's
 * allowed actions include it, which is the same list the glob view's main button reads; every other step needs input,
 * so the click opens the glob view where it is done.
 */
export const yourTurnClick = (status: StatusLine, glob: Pick<GlobView, 'allowedActions'> & Partial<Pick<GlobView, 'currentRun'>>): ChipClick => {
  const allowed = glob.allowedActions ?? [];
  // A stored work step (a rollout) is ticked in the Human steps section, whatever its kind.
  if (status.work === true) return { kind: 'section', target: cardTargets.humanSteps() };
  // A step that names its action runs it (or opens the run's session); the action is only used while the glob view still offers it.
  if (status.action === 'open_session') {
    const session = glob.currentRun?.state === 'ended' ? null : (glob.currentRun?.sessionUrl ?? null);
    return session === null ? { kind: 'section', target: cardTargets.actions() } : { kind: 'link', url: session };
  }
  if (status.turn === 'unstick' && status.action !== undefined)
    return allowed.includes(status.action) ? { kind: 'act', action: status.action, confirm: false } : { kind: 'section', target: cardTargets.actions() };
  switch (status.turn) {
    // The card's corner is status only: Merge and Done are bottom buttons on the card and the glob view's main button.
    case 'merge':
    case 'done':
      return { kind: 'section', target: cardTargets.actions() };
    case 'decide':
      return { kind: 'section', target: cardTargets.decision() };
    case 'sign_off':
    case 'review_label':
      return { kind: 'section', target: cardTargets.label() };
    case 'resolve_conflict':
      return { kind: 'section', target: cardTargets.conflict() };
    default:
      return { kind: 'section', target: cardTargets.actions() };
  }
};

/** What clicking the position indicator does: the PR's checks, the run's session in a new tab, or the actions section. */
export const positionClick = (position: Position, glob: GlobView, repo: string | undefined): ChipClick => {
  if (position.onChecks) {
    const url = checksUrl(repo, glob);
    if (url !== null) return { kind: 'link', url };
  }
  if (position.sessionUrl !== null) return { kind: 'link', url: position.sessionUrl };
  return { kind: 'section', target: cardTargets.actions() };
};

/** What clicking a problem on the status line does: its failing check, its session, or the section it is about. */
export const statusClick = (status: StatusLine): ChipClick => {
  if (status.kind === 'rollout') return { kind: 'section', target: cardTargets.humanSteps() };
  if (status.url !== null) return { kind: 'link', url: status.url };
  if (status.sessionUrl !== null) return { kind: 'link', url: status.sessionUrl };
  return { kind: 'section', target: cardTargets.actions() };
};

/** A tooltip line as a sentence: it ends in a full stop unless it already ends in `.`, `!`, `?`, `…` or `:`; a blank line is dropped. */
export const sentence = (line: string): string => {
  const text = line.trimEnd();
  if (text === '') return '';
  return /[.!?…:]$/.test(text) ? text : `${text}.`;
};

/** Tooltip lines joined by newlines, each a sentence, so one line never runs into the next. */
export const tipLines = (lines: readonly string[]): string =>
  lines
    .flatMap((l) => l.split('\n'))
    .map(sentence)
    .filter((l) => l !== '')
    .join('\n');

/** The line a chip's tooltip ends with, saying what the click does. */
export const clickTip = (click: ChipClick, confirming = false): string => {
  if (click.kind === 'act') return confirming ? 'Click again to merge.' : click.confirm ? 'Asks you to confirm.' : 'Runs it.';
  return click.kind === 'link' ? 'Opens it in a new tab.' : 'Opens the glob.';
};

/** What a click on the Your turn chip does now: ask for the second click, or run the click. */
export const turnStep = (click: ChipClick, confirming: boolean): 'confirm' | 'run' =>
  click.kind === 'act' && click.confirm && !confirming ? 'confirm' : 'run';
