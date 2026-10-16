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

/**
 * The commands a person runs for an action: the lines of the first fenced block under the plan's `## Do this` heading (a leading
 * `$ ` prompt is dropped, blank lines and comments-only lines stay out of the way). Empty when the plan has no such block.
 */
export const doThisCommands = (plan: string): string[] => {
  const lines = plan.split('\n');
  const start = lines.findIndex((l) => /^##\s+do this\s*$/i.test(l.trim()));
  if (start < 0) return [];
  let fence: string | null = null;
  const commands: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) {
        fence = marker.charAt(0);
        continue;
      }
      if (fence === marker.charAt(0)) return commands;
    }
    if (fence === null) {
      if (/^##\s/.test(line)) return commands;
      continue;
    }
    const text = line.replace(/^\s*\$\s+/, '').trimEnd();
    if (text.trim() !== '') commands.push(text);
  }
  return commands;
};

/** The line that fetches what a prepared action runs: the branch for a branch record, the stored script for an artifact record. */
export const fetchCommandFor = (id: string, record: 'branch' | 'artifact' | 'attachment', label?: string | null): string | null => {
  if (record === 'branch') return `sstor --glob ${id}`;
  if (record === 'artifact') return `slop get-artifact ${id} rollout_script${label == null || label === '' ? '' : ` --label ${JSON.stringify(label)}`} --out ${id}-run.sh`;
  return null;
};
