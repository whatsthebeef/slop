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

/** A short note on a card moved elsewhere; `n` changes per move so its fade restarts. */
export interface MoveTag {
  readonly text: string;
  readonly n: number;
}

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

/** An element's layout position: offsets ignore transforms, so a card mid-animation measures true. */
const layoutPosition = (el: HTMLElement): { x: number; y: number } => {
  let x = 0;
  let y = 0;
  for (let node: Element | null = el; node instanceof HTMLElement; node = node.offsetParent) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
};

/**
 * Animates cards between renders by position (FLIP): the board's card positions are measured
 * after every commit, and when the globs change each card that moved is played from its old
 * place to its new one. Only a glob whose list changed gets the stepped, block-like move and the
 * lock flash (LCD green for your own moves, khaki for moves made elsewhere, which also get a short
 * tag); every other card it pushed or pulled glides. Nothing animates on the first load, right
 * after a reconnect, in a hidden tab, or for people who prefer reduced motion (they still get the tag).
 */
export const useBoardMotion = (globs: readonly GlobView[] | undefined, live: LiveState) => {
  const container = useRef<HTMLElement | null>(null);
  const rects = useRef<Rects>(new Map());
  const seen = useRef<readonly GlobView[] | undefined>(undefined);
  const previous = useRef<Map<string, GlobView> | null>(null);
  const local = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const tagCount = useRef(0);
  const quietUntil = useRef(0);
  const wasLive = useRef(live);
  const [locks, setLocks] = useState<Record<string, 'local' | 'remote'>>({});
  const [tags, setTags] = useState<Record<string, MoveTag>>({});

  useEffect(() => {
    if (live === 'live' && wasLive.current !== 'live')
      quietUntil.current = Date.now() + RECONNECT_QUIET_MS;
    wasLive.current = live;
  }, [live]);

  /** One timer per key: a repeat move replaces the earlier timer instead of being cut short by it. */
  const later = (key: string, run: () => void, ms: number) => {
    const existing = timers.current.get(key);
    if (existing !== undefined) clearTimeout(existing);
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        run();
      }, ms),
    );
  };

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const measure = (): Rects => {
    const root = container.current;
    const next: Rects = new Map();
    if (root === null) return next;
    const origin = layoutPosition(root);
    for (const el of root.querySelectorAll<HTMLElement>('[data-glob-id]')) {
      const id = el.dataset.globId;
      if (id === undefined) continue;
      const at = layoutPosition(el);
      next.set(id, { x: at.x - origin.x, y: at.y - origin.y });
    }
    return next;
  };

  // Layout can change without a commit (window size, web fonts arriving); keep positions current.
  useEffect(() => {
    const refresh = () => {
      rects.current = measure();
    };
    window.addEventListener('resize', refresh);
    void document.fonts.ready.then(refresh);
    return () => window.removeEventListener('resize', refresh);
  }, []);

  const showTag = (id: string, text: string) => {
    tagCount.current += 1;
    const tag: MoveTag = { text, n: tagCount.current };
    setTags((t) => ({ ...t, [id]: tag }));
    later(`tag:${id}`, () => setTags((t) => without(t, id)), TAG_MS);
  };

  const flash = (id: string, kind: 'local' | 'remote', tag: string | null) => {
    setLocks((l) => ({ ...l, [id]: kind }));
    later(`lock:${id}`, () => setLocks((l) => without(l, id)), LOCK_MS + 20);
    if (tag !== null) showTag(id, tag);
  };

  // After every commit: animate if the globs changed, then remember where every card now is.
  useLayoutEffect(() => {
    const root = container.current;
    const before = rects.current;
    const after = measure();
    rects.current = after;
    if (globs === undefined || root === null || globs === seen.current) return;
    seen.current = globs;
    const now = new Map(globs.map((g) => [g.id, g]));
    const prior = previous.current;
    previous.current = now;
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
        if (tag !== null) showTag(glob.id, tag);
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
  });

  /** Marks a move as made on this board, so it gets your flash and no tag. */
  const markLocal = (id: string) => local.current.add(id);
  /** A local move that failed: forget it, so a later remote move isn't mistaken for it. */
  const forgetLocal = (id: string) => local.current.delete(id);

  return { container, locks, tags, markLocal, forgetLocal };
};
