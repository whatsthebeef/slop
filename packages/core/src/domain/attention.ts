import type { Glob } from './types.js';

/**
 * Whether a glob is waiting on a person to move on: it failed, it's a same or super ready to
 * merge (merging is human; a sub the gate converted is a same by then), or a sign-off label
 * waits for its reviewer (required) or its developer (items added). Derived from state alone, so
 * every board counts the same things.
 */
export const needsHuman = (glob: Glob): boolean => {
  if (glob.status === 'failed' || glob.failure !== null) return true;
  if (glob.status === 'pr_open' && glob.type !== 'sub' && glob.pr?.state === 'ready') return true;
  if (glob.status === 'reviewing') {
    return Object.values(glob.labels).some((state) => state === 'required' || state === 'added');
  }
  return false;
};

/**
 * Whether a glob is yours for the status bar: you planned it (kicked it off) or you're
 * implementing it. Slop has no reviewer assignment yet, so its sign-off reviews count as yours too.
 */
export const isMine = (glob: Glob, email: string): boolean =>
  glob.planner === email || glob.implementer === email;
