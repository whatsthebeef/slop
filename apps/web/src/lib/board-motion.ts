import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GlobView } from './api';
import type { LiveState } from './live';

/** The one card that changed list steps across like a block; the cards it displaces glide. */
const STEP_MS = 280;
const GLIDE_MS = 220;
const LOCK_MS = 110;
const TAG_MS = 3000;
/** Several moves at once (a burst of webhooks) play one after another, and only the first few. */
const STAGGER_MS = 150;
const MAX_ANIMATED = 5;
/** After the live connection comes back, the catch-up refetch just appears. */
const RECONNECT_QUIET_MS = 2000;

/** A copy of a record without one key. */
const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const initialsOf = (email: string) => {
  const [first = '', second = ''] = (email.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean);
  return (
    second === '' ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`
  ).toUpperCase();
};

/** A few words on who or what moved a glob, for a move made elsewhere. */
const describeRemote = (before: GlobView, after: GlobView): string => {
  if (after.list === 'reviewing' && before.list === 'doing') return 'merged on GitHub';
  if (after.list === 'signed_off') return 'signed off';
  if (after.list === 'planning') return 'started again';
  if (after.implementer !== null && after.implementer !== before.implementer)
    return `picked up by ${initialsOf(after.implementer)}`;
  const run = after.currentRun;
  if (run !== null && run.state !== 'ended') return 'started for a routine';
  return 'moved';
};

type Rects = Map<string, { x: number; y: number }>;

/**
 * Animates cards between renders by position (FLIP): before each update the board's card
 * positions are known, after it each card that moved is played from its old place to its new one.
 * Only a glob whose list changed gets the stepped, block-like move and the lock flash (LCD green
 * for your own moves, khaki for moves made elsewhere, which also get a short tag); every other
 * card it pushed or pulled glides. Nothing animates on the first load, right after a reconnect,
 * in a hidden tab, or for people who prefer reduced motion (they still get the tag).
 */
export const useBoardMotion = (globs: readonly GlobView[] | undefined, live: LiveState) => {
  const container = useRef<HTMLElement | null>(null);
  const rects = useRef<Rects>(new Map());
  const previous = useRef<Map<string, GlobView> | null>(null);
  const local = useRef(new Set<string>());
  const quietUntil = useRef(0);
  const wasLive = useRef(live);
  const [locks, setLocks] = useState<Record<string, 'local' | 'remote'>>({});
  const [tags, setTags] = useState<Record<string, string>>({});

  useEffect(() => {
    if (live === 'live' && wasLive.current !== 'live')
      quietUntil.current = Date.now() + RECONNECT_QUIET_MS;
    wasLive.current = live;
  }, [live]);

  const measure = (): Rects => {
    const root = container.current;
    const next: Rects = new Map();
    if (root === null) return next;
    const origin = root.getBoundingClientRect();
    for (const el of root.querySelectorAll<HTMLElement>('[data-glob-id]')) {
      const id = el.dataset.globId;
      if (id === undefined) continue;
      const r = el.getBoundingClientRect();
      next.set(id, {
        x: r.left - origin.left + root.scrollLeft,
        y: r.top - origin.top + root.scrollTop,
      });
    }
    return next;
  };

  // Scrolling or resizing moves cards without an update; keep the "before" positions current.
  useEffect(() => {
    const refresh = () => {
      rects.current = measure();
    };
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
    };
  }, []);

  const flash = (id: string, kind: 'local' | 'remote', tag: string | null) => {
    setLocks((l) => ({ ...l, [id]: kind }));
    setTimeout(() => setLocks((l) => without(l, id)), LOCK_MS + 20);
    if (tag !== null) {
      setTags((t) => ({ ...t, [id]: tag }));
      setTimeout(() => setTags((tg) => without(tg, id)), TAG_MS);
    }
  };

  useLayoutEffect(() => {
    const root = container.current;
    if (globs === undefined || root === null) return;
    const now = new Map(globs.map((g) => [g.id, g]));
    const before = rects.current;
    const after = measure();
    const prior = previous.current;
    previous.current = now;
    rects.current = after;
    if (prior === null) return; // first load: nothing moved, it arrived

    const movers = [...now.values()].filter((g) => {
      const was = prior.get(g.id);
      return was !== undefined && was.list !== g.list;
    });
    const quiet = Date.now() < quietUntil.current || document.visibilityState === 'hidden';
    const still = quiet || reducedMotion();

    movers.forEach((glob, index) => {
      const was = prior.get(glob.id);
      const mine = local.current.delete(glob.id);
      const tag = mine || was === undefined ? null : describeRemote(was, glob);
      const el = root.querySelector<HTMLElement>(`[data-glob-id="${glob.id}"]`);
      const from = before.get(glob.id);
      const to = after.get(glob.id);
      if (still || el === null || from === undefined || to === undefined || index >= MAX_ANIMATED) {
        if (tag !== null) setTags((t) => ({ ...t, [glob.id]: tag }));
        if (tag !== null) setTimeout(() => setTags((tg) => without(tg, glob.id)), TAG_MS);
        return;
      }
      const motion = el.animate(
        [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` }, { transform: 'none' }],
        {
          duration: STEP_MS,
          easing: 'steps(4, end)',
          delay: index * STAGGER_MS,
          fill: 'backwards',
        },
      );
      motion.onfinish = () => flash(glob.id, mine ? 'local' : 'remote', tag);
    });

    if (still) return;
    const moved = new Set(movers.map((g) => g.id));
    for (const [id, to] of after) {
      const from = before.get(id);
      if (moved.has(id) || from === undefined || (from.x === to.x && from.y === to.y)) continue;
      const el = root.querySelector<HTMLElement>(`[data-glob-id="${id}"]`);
      el?.animate(
        [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` }, { transform: 'none' }],
        {
          duration: GLIDE_MS,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        },
      );
    }
  }, [globs]);

  /** Marks a move as made on this board, so it gets your flash and no tag. */
  const markLocal = (id: string) => local.current.add(id);
  /** A local move that failed: forget it, so a later remote move isn't mistaken for it. */
  const forgetLocal = (id: string) => local.current.delete(id);

  return { container, locks, tags, markLocal, forgetLocal };
};
