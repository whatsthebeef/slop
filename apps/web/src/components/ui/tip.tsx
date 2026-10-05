import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Card icons and indicators explain themselves after a deliberate pause, not on every pass. */
const DELAY_MS = 2000;

/**
 * A tooltip shown after hovering or focusing for two seconds. It renders in a layer above the
 * page (so lists and scroll areas can't clip it). Screen readers get the text straight away from a
 * hidden description linked to the child (the button, when the child is one); the visible tooltip
 * is only for sighted users. Escape dismisses it.
 */
export const Tip = ({ text, children }: { text: string; children: ReactNode }) => {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setAt(null);
  };

  const arm = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (r !== undefined) setAt({ x: r.left + r.width / 2, y: r.top });
    }, DELAY_MS);
  };

  useEffect(() => cancel, []);

  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [at]);

  const described = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' '),
      })
    : children;

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={arm}
      onMouseLeave={cancel}
      onFocus={arm}
      onBlur={cancel}
      onPointerDown={cancel}
    >
      {described}
      <span id={id} className="sr-only">
        {text}
      </span>
      {at !== null &&
        createPortal(
          <span
            role="tooltip"
            aria-hidden="true"
            className="pointer-events-none fixed z-50 max-w-64 -translate-x-1/2 -translate-y-full rounded-sm border border-foreground/80 bg-card px-2 py-1 font-mono text-[11px] leading-snug text-foreground shadow-[2px_2px_0_var(--edge)]"
            style={{ left: at.x, top: at.y - 6 }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
};
