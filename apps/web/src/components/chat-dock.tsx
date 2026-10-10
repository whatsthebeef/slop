import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { ChatDivider } from '@/components/chat-divider';
import { ChatPanel } from '@/components/chat-panel';
import { reducedMotion, stepMotion } from '@/lib/card-motion';
import { clampChatWidth, DEFAULT_CHAT_WIDTH, readChatWidth, writeChatWidth } from '@/lib/chat-width';

/**
 * Where the chat sits beside the board. The dock's own width steps open and shut in the cards' motion, so the panel's edge and the board's
 * right edge move together (no blank strip, no jump): the board reflows only at each step, not every frame, and the panel keeps its
 * full width inside the dock, so its text never reflows. The width lives here, so dragging the divider re-renders neither the board
 * nor the shell: the pointer only moves the dock's own style, and the width is rendered and remembered once, when the drag ends.
 */
export const ChatDock = ({ open, wide, onExited, ...panel }: { open: boolean; wide: boolean; onExited: () => void } & Omit<ComponentProps<typeof ChatPanel>, 'divider'>) => {
  const dock = useRef<HTMLDivElement>(null);
  const [savedWidth, setSavedWidth] = useState(readChatWidth);
  const [available, setAvailable] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setAvailable(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const fullScreen = panel.fullScreen;
  const width = wide ? clampChatWidth(savedWidth, available) : Math.min(DEFAULT_CHAT_WIDTH, Math.round(available * 0.85));
  const commit = (next: number) => {
    const clamped = clampChatWidth(next, available);
    setSavedWidth(clamped);
    writeChatWidth(clamped);
  };
  // The dock's width as last settled; the next move steps from it (or from wherever an unfinished one had got to).
  const settled = useRef(0);
  const running = useRef<Animation | null>(null);
  const exited = useRef(onExited);
  exited.current = onExited;
  // Stepping open on mount, shut on close, and to and from full screen; a change mid-step carries on from where it had reached.
  useLayoutEffect(() => {
    const el = dock.current;
    if (el === null) return;
    const target = open ? (fullScreen ? (el.parentElement?.clientWidth ?? width) : width) : 0;
    const from = running.current?.playState === 'running' ? el.getBoundingClientRect().width : settled.current;
    running.current?.cancel();
    settled.current = target;
    if (reducedMotion() || from === target) {
      running.current = null;
      if (!open) exited.current();
      return;
    }
    const motion = el.animate([{ flexBasis: `${from}px` }, { flexBasis: `${target}px` }], {
      ...stepMotion(target - from),
      fill: open ? 'backwards' : 'forwards',
    });
    running.current = motion;
    motion.onfinish = () => {
      if (!open) exited.current();
    };
  }, [open, fullScreen]);
  // A dragged or resized width is where the dock rests, with no motion.
  useLayoutEffect(() => {
    if (open && !fullScreen) settled.current = width;
  }, [open, fullScreen, width]);
  useEffect(() => () => running.current?.cancel(), []);
  useEffect(() => () => exited.current(), []);
  // One style write per frame, however fast the pointer reports.
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const preview = (next: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (dock.current !== null) dock.current.style.flexBasis = `${next}px`;
    });
  };

  return (
    <div
      ref={dock}
      className='min-h-0 min-w-0 overflow-hidden'
      style={{ flexBasis: fullScreen ? '100%' : width, flexGrow: 0, flexShrink: 0 }}
      data-testid='chat-dock'
    >
      <div className='ml-auto h-full' style={{ width: fullScreen ? '100%' : width }}>
        <ChatPanel
          {...panel}
          divider={wide && <ChatDivider width={width} available={available} onPreview={preview} onWidth={commit} />}
        />
      </div>
    </div>
  );
};
