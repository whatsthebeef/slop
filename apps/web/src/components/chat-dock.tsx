import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { ChatDivider } from '@/components/chat-divider';
import { ChatPanel } from '@/components/chat-panel';
import { reducedMotion, STEP_EASING, STEP_MS } from '@/lib/card-motion';
import { clampChatWidth, DEFAULT_CHAT_WIDTH, readChatWidth, writeChatWidth } from '@/lib/chat-width';

/**
 * Where the chat sits beside the board. The dock takes its width at once (the board reflows once, not on every frame) and the panel
 * steps in and out across it like a card changing list. The width lives here, so dragging the divider re-renders neither the board
 * nor the shell: the pointer only moves the dock's own style, and the width is rendered and remembered once, when the drag ends.
 */
export const ChatDock = ({ open, wide, ...panel }: { open: boolean; wide: boolean } & Omit<ComponentProps<typeof ChatPanel>, 'divider'>) => {
  const dock = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const [savedWidth, setSavedWidth] = useState(readChatWidth);
  const [available, setAvailable] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setAvailable(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Stepping in on mount and out on close; a reopen mid-slide steps in from wherever it stopped.
  useLayoutEffect(() => {
    const el = slider.current;
    if (el === null || reducedMotion()) return;
    const motion = el.animate(
      [{ transform: open ? 'translateX(100%)' : 'none' }, { transform: open ? 'none' : 'translateX(100%)' }],
      { duration: STEP_MS, easing: STEP_EASING, fill: open ? 'backwards' : 'forwards' },
    );
    return () => motion.cancel();
  }, [open]);

  const fullScreen = panel.fullScreen;
  const width = wide ? clampChatWidth(savedWidth, available) : Math.min(DEFAULT_CHAT_WIDTH, Math.round(available * 0.85));
  const commit = (next: number) => {
    const clamped = clampChatWidth(next, available);
    setSavedWidth(clamped);
    writeChatWidth(clamped);
  };
  const preview = (next: number) => {
    if (dock.current !== null) dock.current.style.flexBasis = `${next}px`;
  };

  return (
    <div
      ref={dock}
      className='min-h-0 min-w-0 overflow-hidden'
      style={{ flexBasis: width, flexGrow: fullScreen ? 1 : 0, flexShrink: 0 }}
      data-testid='chat-dock'
    >
      <div ref={slider} className='h-full'>
        <ChatPanel
          {...panel}
          divider={wide && <ChatDivider width={width} available={available} onPreview={preview} onWidth={commit} />}
        />
      </div>
    </div>
  );
};
