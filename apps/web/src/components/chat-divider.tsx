import type { KeyboardEvent, PointerEvent } from 'react';
import { clampChatWidth, DEFAULT_CHAT_WIDTH, MIN_CHAT_WIDTH, maxChatWidth, widthAfterKey } from '@/lib/chat-width';
import { cn } from '@/lib/utils';

/**
 * The line between the main area and the docked chat, as a drag handle: drag it, or focus it and use the arrow keys (Shift for
 * bigger steps, Home and End for the limits); double-click puts the width back to the default.
 */
export const ChatDivider = ({
  width,
  available,
  dragging,
  onWidth,
  onDragging,
}: {
  width: number;
  /** The window's width, which bounds how wide the panel may get. */
  available: number;
  dragging: boolean;
  onWidth: (width: number) => void;
  onDragging: (dragging: boolean) => void;
}) => {
  // The panel is flush with the window's right edge, so the pointer's distance from it is the width.
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onWidth(clampChatWidth(window.innerWidth - e.clientX, available));
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
      className={cn('absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-foreground/20 focus-visible:bg-foreground/30 focus-visible:outline-none', dragging && 'bg-foreground/30')}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDragging(true);
      }}
      onPointerMove={drag}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onDragging(false);
      }}
      onPointerCancel={() => onDragging(false)}
      onDoubleClick={() => onWidth(clampChatWidth(DEFAULT_CHAT_WIDTH, available))}
      onKeyDown={key}
    />
  );
};
