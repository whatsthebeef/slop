import { isRepoPath, SCRIPT_LINE } from './rollout.js';
import { safeRepoPath } from './review-tools.js';

/** The script an action runs, and whether it is on the board's base branch (null: slop could not check). */
export interface ActionScript {
  readonly path: string;
  readonly onBase: boolean | null;
}

/**
 * The repo path of the script an action runs: the first `script: <repo path>` line of its plan (the grammar of a rollout
 * step's script line; a bullet, bold label and backticks are fine), outside code fences. A path that could leave the repo is
 * never a script, so it is not checked and not read.
 */
export const scriptPathOf = (plan: string): string | null => {
  let fence: string | null = null;
  for (const line of plan.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker.charAt(0);
      else if (fence === marker.charAt(0)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const path = SCRIPT_LINE.exec(line)?.[1];
    if (path === undefined) continue;
    return isRepoPath(path) && safeRepoPath(path) === path ? path : null;
  }
  return null;
};

/** Why an action can't be done: its script is not on the base branch yet. */
export const scriptMissingText = (script: ActionScript, baseBranch: string): string | null =>
  script.onBase === false ? `script not on ${baseBranch} yet: ${script.path}` : null;

/** What the service learned about an open action's script: the script, and the base branch it was looked up on. */
export interface ScriptCheck {
  readonly script: ActionScript;
  readonly baseBranch: string;
}
