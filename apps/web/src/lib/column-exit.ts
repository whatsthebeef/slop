import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { reducedMotion, stepMotion } from './card-motion';

/** `present`: in the row. `leaving`: still mounted, animating out. `gone`: unmounted. */
export type ExitPhase = 'present' | 'leaving' | 'gone';

/** How far a leaving column slides right while it fades. */
const SLIDE_PX = 24;

/** The phase after `hidden` changes: a column leaves with an animation unless motion is reduced, and returns at once. */
export const nextPhase = (phase: ExitPhase, hidden: boolean, animate: boolean): ExitPhase => {
  if (!hidden) return 'present';
  if (phase === 'present') return animate ? 'leaving' : 'gone';
  return phase;
};

/** When the exit animation ends, a leaving column is unmounted; any other phase stays as it is. */
export const exitDone = (phase: ExitPhase): ExitPhase => (phase === 'leaving' ? 'gone' : phase);

const POSITION_STYLES = ['position', 'left', 'top', 'width', 'height', 'z-index', 'pointer-events'] as const;

/**
 * Keeps a column mounted while it animates out. The leaving column is taken out of the flow at the place it last had, so the
 * other columns lay out as they will end up and glide there (`useColumnGlide`), while it slides right and fades with the same
 * stepped motion. Showing it again mid-exit reverses the animation from where it is. Its row must be positioned (`relative`).
 * Call this before `useColumnGlide`, so the leaving column is already out of the flow when the others are measured.
 */
export const useColumnExit = <T extends HTMLElement>(hidden: boolean): { phase: ExitPhase; ref: RefObject<T | null> } => {
  const [stored, setPhase] = useState<ExitPhase>(hidden ? 'gone' : 'present');
  const phase = nextPhase(stored, hidden, !reducedMotion());
  if (phase !== stored) setPhase(phase);
  const ref = useRef<T | null>(null);
  const box = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const animation = useRef<Animation | null>(null);
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
      const out = el.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: `translateX(${String(SLIDE_PX)}px)` },
        ],
        { ...stepMotion(at.width), fill: 'forwards' },
      );
      animation.current = out;
      out.onfinish = () => {
        animation.current = null;
        setPhase((p) => exitDone(p));
      };
    } else if (phase === 'present') {
      const unwind = () => {
        for (const name of POSITION_STYLES) el.style.removeProperty(name);
      };
      if (was === 'leaving' && animation.current !== null) {
        // Back mid-exit: back in the row at once, and the animation plays backwards from where it is.
        const out = animation.current;
        unwind();
        out.onfinish = () => {
          out.cancel();
          animation.current = null;
        };
        out.reverse();
      } else if (was === 'gone' && !reducedMotion()) {
        const width = el.offsetWidth;
        el.animate(
          [
            { opacity: 0, transform: `translateX(${String(SLIDE_PX)}px)` },
            { opacity: 1, transform: 'none' },
          ],
          stepMotion(width),
        );
      }
    }
  }, [phase]);

  return {phase, ref};
};
