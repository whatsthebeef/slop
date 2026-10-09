import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { clampChatWidth, DEFAULT_CHAT_WIDTH, MIN_CHAT_WIDTH, maxChatWidth, widthAfterKey } from '@/lib/chat-width';

/**
 * The line between the main area and the docked chat, as a drag handle: drag it, or focus it and use the arrow keys (Shift for
 * bigger steps, Home and End for the limits); double-click puts the width back to the default.
 */
export const ChatDivider = ({
  width,
  available,
  onPreview,
  onWidth,
}: {
  width: number;
  /** The window's width, which bounds how wide the panel may get. */
  available: number;
  /** Called on every pointer move while dragging; must only touch the DOM, so the drag costs no render. */
  onPreview: (width: number) => void;
  /** Called once with the final width (end of a drag, or a key press): the place to render and remember it. */
  onWidth: (width: number) => void;
}) => {
  const dragged = useRef<number | null>(null);
  // The panel is flush with the window's right edge, so the pointer's distance from it is the width.
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (dragged.current === null) return;
    dragged.current = clampChatWidth(window.innerWidth - e.clientX, available);
    onPreview(dragged.current);
  };
  const end = () => {
    const width = dragged.current;
    dragged.current = null;
    if (width !== null) onWidth(width);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = widthAfterKey(e.key, e.shiftKey, width, available);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onWidth(next);
  };
  return (
    <div
      role='separator'
      aria-orientation='vertical'
      aria-label='Resize the chat'
      aria-valuenow={width}
      aria-valuemin={MIN_CHAT_WIDTH}
      aria-valuemax={maxChatWidth(available)}
      tabIndex={0}
      data-testid='chat-divider'
      className='absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-foreground/20 focus-visible:bg-foreground/30 focus-visible:outline-none active:bg-foreground/30'
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragged.current = width;
      }}
      onPointerMove={drag}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        end();
      }}
      onPointerCancel={end}
      onDoubleClick={() => onWidth(clampChatWidth(DEFAULT_CHAT_WIDTH, available))}
      onKeyDown={key}
    />
  );
};
