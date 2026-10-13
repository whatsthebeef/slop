import type { Handover } from '@slop/core';
import type { GlobView } from './api';
import { handoverSignature } from './handover';
import type { StatusLine } from './status-line';

/** A short, stable fingerprint of a message's text, for the kinds whose situation has no field of its own to key on. */
export const fingerprint = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** The handover brief's key: it changes when its causes or first step do, so a new brief shows in full. */
export const handoverKey = (brief: Handover): string => `handover:${fingerprint(handoverSignature(brief))}`;

/** A work step's key: the step and its state, so a step that moves on shows again. */
export const stepKey = (step: { readonly id: string; readonly state: string }): string => `step:${step.id}:${step.state}`;

/** The Your turn headline's reason, keyed by the move it explains. */
export const turnKey = (move: { readonly reason: string; readonly since: string | null }): string =>
  `turn:${move.since ?? ''}:${fingerprint(move.reason)}`;

/**
 * The key of the message a status line shows. It names the situation (the failure's time, the conflict's time, the stall's
 * cause and start), never the wording or the clock, so it is the same on every read until the situation changes. Keys are
 * opaque to the server.
 */
export const statusKey = (glob: GlobView, line: StatusLine): string => {
  switch (line.kind) {
    case 'failure':
    case 'provisioning':
      return `failure:${glob.failure?.at ?? fingerprint(line.full)}`;
    case 'stuck':
      return glob.failure === null && glob.conflict != null
        ? `conflict:${glob.conflict.at}`
        // `move` is on the board list only, so the stall is keyed by what both views have: the hint's wording (its minutes
        // dropped, they tick), the PR head and the latest run, so a stall that comes back after a new run shows again.
        : `stall:${fingerprint(line.full.replace(/\d+/g, '#'))}:${glob.pr?.headSha ?? ''}:${glob.runs.at(-1)?.id ?? ''}`;
    case 'checks':
    case 'base-red':
      return `${line.kind}:${glob.pr?.headSha ?? fingerprint(line.full)}`;
    case 'ready':
      return `turn:${line.turn ?? 'merge'}:${fingerprint(line.tip)}`;
    default:
      return `${line.kind}:${fingerprint(line.full)}`;
  }
};

/** True when the viewer dismissed this message on the glob. */
export const isDismissed = (glob: Pick<GlobView, 'dismissedKeys'>, key: string): boolean =>
  glob.dismissedKeys?.includes(key) ?? false;

const SHORT: Partial<Record<StatusLine['kind'], string>> = {
  provisioning: "branch couldn't be created",
  'base-red': 'base is red',
  checks: 'checks failed',
  failure: 'run failed',
  'investigation-failed': 'investigation failed',
  stuck: 'looks stuck',
  behind: 'behind the base',
  'merge-waits': 'merge waits',
};

/** The label a dismissed message keeps (the card line, the glob view's headline): the cause in a few words. */
export const shortLabel = (line: StatusLine): string => (line.conflict === true ? 'merge conflict' : (SHORT[line.kind] ?? line.text));

/**
 * Whether a status line can be dismissed. Your turn is the main action's chip and a rollout is open work, so neither
 * collapses: dismissing hides the explanation, never what to do.
 */
export const dismissible = (line: StatusLine): boolean => line.kind !== 'ready' && line.kind !== 'rollout';

/** The status line as the viewer should see it: dismissed, it keeps the short label, muted, and drops the long text. */
export const collapsed = (glob: GlobView, line: StatusLine): { readonly key: string; readonly dismissed: boolean; readonly label: string } => {
  const key = statusKey(glob, line);
  const dismissed = dismissible(line) && isDismissed(glob, key);
  return { key, dismissed, label: dismissed ? shortLabel(line) : line.text };
};
