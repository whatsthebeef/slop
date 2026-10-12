import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { reducedMotion, stepMotion } from './card-motion';

/** `present`: in the row. `leaving`: still mounted, stepping out. `gone`: unmounted. `entering`: back in the row, stepping in. */
export type ExitPhase = 'present' | 'leaving' | 'gone' | 'entering';

/** The gap between columns, added to a column's width so it steps fully clear of its place. */
const GAP_PX = 24;

/** The distance a column travels to or from off the board's right edge. */
export const exitDistance = (width: number): number => width + GAP_PX;

/** The keyframes of a move between the column's place and off to the right: no fade, only a stepped slide. */
export const exitKeyframes = (distance: number): Keyframe[] => [{ transform: 'none' }, { transform: `translateX(${String(distance)}px)` }];

/** The phase after `hidden` changes: a column leaves and returns with an animation unless motion is reduced. */
export const nextPhase = (phase: ExitPhase, hidden: boolean, animate: boolean): ExitPhase => {
  if (hidden) return phase === 'present' || phase === 'entering' ? (animate ? 'leaving' : 'gone') : phase;
  if (phase === 'gone') return animate ? 'entering' : 'present';
  return phase === 'leaving' ? 'present' : phase;
};

/** When the exit animation ends, a leaving column is unmounted; any other phase stays as it is. */
export const exitDone = (phase: ExitPhase): ExitPhase => (phase === 'leaving' ? 'gone' : phase);

/** When the entry animation ends, an entering column is settled in the row; any other phase stays as it is. */
export const enterDone = (phase: ExitPhase): ExitPhase => (phase === 'entering' ? 'present' : phase);

const POSITION_STYLES = ['position', 'left', 'top', 'width', 'height', 'z-index', 'pointer-events'] as const;

/**
 * Keeps a column mounted while it animates out. The leaving column is taken out of the flow at the place it last had, so the
 * other columns lay out as they will end up and glide there (`useColumnGlide`), while it steps out to the right with no fade, and on
 * return it steps back in. Toggling mid-move reverses the animation from where it is. Its row must be positioned (`relative`).
 * Call this before `useColumnGlide`, so the leaving column is already out of the flow when the others are measured.
 */
export const useColumnExit = <T extends HTMLElement>(hidden: boolean): { phase: ExitPhase; ref: RefObject<T | null> } => {
  const [stored, setPhase] = useState<ExitPhase>(hidden ? 'gone' : 'present');
  const phase = nextPhase(stored, hidden, !reducedMotion());
  if (phase !== stored) setPhase(phase);
  const ref = useRef<T | null>(null);
  const box = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const animation = useRef<Animation | null>(null);
  const distance = useRef(0);
  const previous = useRef<ExitPhase>(phase);

  // Where the column is while it is in the row, observed so that the last value is from before the layout that hides it.
  const mounted = phase !== 'gone';
  useEffect(() => {
    const el = ref.current;
    if (!mounted || el === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (el.style.position === 'absolute') return;
      box.current = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);

  useLayoutEffect(() => {
    const el = ref.current;
    const was = previous.current;
    previous.current = phase;
    if (was === phase || el === null) return;
    const unwind = () => {
      for (const name of POSITION_STYLES) el.style.removeProperty(name);
    };
    if (phase === 'leaving') {
      const at = box.current;
      if (at === null) {
        setPhase('gone');
        return;
      }
      el.style.position = 'absolute';
      el.style.left = `${String(at.left)}px`;
      el.style.top = `${String(at.top)}px`;
      el.style.width = `${String(at.width)}px`;
      el.style.height = `${String(at.height)}px`;
      el.style.zIndex = '1';
      el.style.pointerEvents = 'none';
      const out = animation.current;
      if (was === 'entering' && out !== null) {
        // Hidden again mid-entry: it steps back out from where it is.
        out.onfinish = () => {
          animation.current = null;
          setPhase((p) => exitDone(p));
        };
        out.reverse();
        return;
      }
      distance.current = exitDistance(at.width);
      const move = el.animate(exitKeyframes(distance.current), { ...stepMotion(distance.current), fill: 'forwards' });
      animation.current = move;
      move.onfinish = () => {
        animation.current = null;
        setPhase((p) => exitDone(p));
      };
    } else if (phase === 'entering') {
      distance.current = exitDistance(el.offsetWidth);
      const move = el.animate([...exitKeyframes(distance.current)].reverse(), stepMotion(distance.current));
      animation.current = move;
      move.onfinish = () => {
        animation.current = null;
        setPhase((p) => enterDone(p));
      };
    } else if (phase === 'present' && was === 'leaving' && animation.current !== null) {
      // Back mid-exit: back in the row at once, and the animation plays backwards from where it is.
      const out = animation.current;
      unwind();
      out.onfinish = () => {
        out.cancel();
        animation.current = null;
      };
      out.reverse();
    }
  }, [phase]);

  return {phase, ref};
};
