import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { reducedMotion, stepMotion } from './card-motion';

const columns = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid^="list-"]')];

/**
 * When `trigger` changes, the layout changes at once (a column hides or the board gets narrower) and each column that stayed
 * steps from its old place to its new one with a transform, like the cards, so the board never animates its layout.
 */
export const useColumnGlide = (container: RefObject<HTMLElement | null>, trigger: unknown) => {
  const lefts = useRef(new Map<string, number>());
  const last = useRef(trigger);
  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const before = lefts.current;
    const next = new Map<string, number>();
    for (const el of columns(root)) next.set(el.dataset.testid ?? '', el.getBoundingClientRect().left);
    lefts.current = next;
    if (Object.is(last.current, trigger)) return;
    last.current = trigger;
    if (reducedMotion()) return;
    for (const el of columns(root)) {
      const was = before.get(el.dataset.testid ?? '');
      const now = next.get(el.dataset.testid ?? '');
      if (was === undefined || now === undefined || was === now) continue;
      el.animate([{ transform: `translateX(${was - now}px)` }, { transform: 'none' }], stepMotion(was - now));
    }
  });
};
