import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveState } from './live';

/** The one card that changed list steps across like a block; the cards it displaces glide. */
const STEP_MS = 630;
const GLIDE_MS = 500;
const LOCK_MS = 165;
const TAG_MS = 3000;
/** Several moves at once (a burst of webhooks) play one after another, and only the first few. */
const STAGGER_MS = 225;
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

/** What a list of cards tells the motion: each card's ID, the group (list, section) it sits in, and how to word a move made elsewhere. */
export interface CardMotionOptions<T> {
  /** The attribute on each card element holding its ID, e.g. `data-glob-id`. */
  readonly attribute: string;
  readonly idOf: (item: T) => string;
  readonly groupOf: (item: T) => string;
  /** A short tag for a card another person or slop moved to another group; null for none. */
  readonly describeRemote: (before: T, after: T) => string | null;
}

/**
 * Animates cards between renders by position (FLIP): card positions are measured after every
 * commit, and when the items change each card that moved is played from its old place to its new
 * one. Only an item whose group changed gets the stepped, block-like move and the lock flash
 * (`local` for your own moves, `remote` for moves made elsewhere, which may also get a short tag);
 * every other card it pushed or pulled glides. Nothing animates on the first load, right after a
 * reconnect, in a hidden tab, or for people who prefer reduced motion (they still get the tag).
 * `items` must keep its identity while unchanged (a query's data, or memoised).
 */
export const useCardMotion = <T>(
  items: readonly T[] | undefined,
  live: LiveState,
  options: CardMotionOptions<T>,
) => {
  const { attribute, idOf, groupOf, describeRemote } = options;
  const container = useRef<HTMLElement | null>(null);
  const rects = useRef<Rects>(new Map());
  const seen = useRef<readonly T[] | undefined>(undefined);
  const previous = useRef<Map<string, T> | null>(null);
  const local = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const tagCount = useRef(0);
  const quietUntil = useRef(0);
  const wasLive = useRef(live);
  const [locks, setLocks] = useState<Record<string, 'local' | 'remote'>>({});
  const [tags, setTags] = useState<Record<string, MoveTag>>({});
  const cardAt = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`);

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
    for (const el of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      const id = el.getAttribute(attribute);
      // A card in a collapsed section has no layout to animate from or to.
      if (id === null || el.getClientRects().length === 0) continue;
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

  // After every commit: animate if the items changed, then remember where every card now is.
  useLayoutEffect(() => {
    const root = container.current;
    const before = rects.current;
    const after = measure();
    rects.current = after;
    if (items === undefined || root === null || items === seen.current) return;
    seen.current = items;
    const now = new Map(items.map((item) => [idOf(item), item]));
    const prior = previous.current;
    previous.current = now;
    if (prior === null) return; // first load: nothing moved, it arrived

    const movers = [...now.values()].filter((item) => {
      const was = prior.get(idOf(item));
      return was !== undefined && groupOf(was) !== groupOf(item);
    });
    const quiet = Date.now() < quietUntil.current || document.visibilityState === 'hidden';
    const still = quiet || reducedMotion();

    movers.forEach((item, index) => {
      const id = idOf(item);
      const was = prior.get(id);
      const mine = local.current.delete(id);
      const tag = mine || was === undefined ? null : describeRemote(was, item);
      const el = cardAt(root, id);
      const from = before.get(id);
      const to = after.get(id);
      if (still || el === null || from === undefined || to === undefined || index >= MAX_ANIMATED) {
        if (tag !== null) showTag(id, tag);
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
      motion.onfinish = () => flash(id, mine ? 'local' : 'remote', tag);
    });

    if (still) return;
    const moved = new Set(movers.map(idOf));
    for (const [id, to] of after) {
      const from = before.get(id);
      if (moved.has(id) || from === undefined || (from.x === to.x && from.y === to.y)) continue;
      cardAt(root, id)?.animate(
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
