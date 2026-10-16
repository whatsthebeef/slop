import type { GlobView } from './api';
import type { StatusLine } from './status-line';

/** A short, stable fingerprint of a message's text, for the kinds whose situation has no field of its own to key on. */
export const fingerprint = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** A work step's key: the step and its state, so a step that moves on shows again. */
export const stepKey = (step: { readonly id: string; readonly state: string }): string => `step:${step.id}:${step.state}`;

/** The Your turn headline's reason, keyed by the move it explains. */
export const turnKey = (move: { readonly reason: string; readonly since: string | null }): string =>
  `turn:${move.since ?? ''}:${fingerprint(move.reason)}`;

/** True when the viewer dismissed this message on the glob (only the Your turn reason can be; problem blocks have no dismiss). */
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

/** A problem's short label (the card line, the problem block's title): the cause in a few words. */
export const shortLabel = (line: StatusLine): string => (line.conflict === true ? 'merge conflict' : (SHORT[line.kind] ?? line.text));
