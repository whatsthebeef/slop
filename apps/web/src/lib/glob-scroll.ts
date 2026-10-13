import type { GlobSection } from './glob-section';

/** How long to wait for a section to render (its data may still be loading) before giving up. */
export const SCROLL_WAIT_MS = 3000;
const POLL_MS = 100;

/** The element a section's wrapper renders, or null when it is absent or empty (nothing to show). */
export const findSection = (root: ParentNode, section: GlobSection): HTMLElement | null => {
  const el = root.querySelector<HTMLElement>(`[data-section="${section}"]`);
  return el !== null && el.childElementCount > 0 ? el : null;
};

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Scrolls to a section once it has rendered: checks now, then every 100 ms until `waitMs` has passed.
 * `scroll` runs at most once. Returns a cancel function; an unknown or never-rendered section does nothing.
 */
export const scrollWhenReady = (
  find: () => HTMLElement | null,
  waitMs: number = SCROLL_WAIT_MS,
  timers: Timers = realTimers,
): (() => void) => {
  const start = timers.now();
  let handle: unknown = null;
  let cancelled = false;
  const attempt = () => {
    if (cancelled) return;
    const el = find();
    if (el !== null) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
    if (timers.now() - start >= waitMs) return;
    handle = timers.set(attempt, POLL_MS);
  };
  attempt();
  return () => {
    cancelled = true;
    if (handle !== null) timers.clear(handle);
  };
};
