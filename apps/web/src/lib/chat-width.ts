/** The docked chat's width in px: the default (30rem), no narrower than 20rem, and never so wide that the board's three columns fall under their minimum card width. */
export const DEFAULT_CHAT_WIDTH = 480;
export const MIN_CHAT_WIDTH = 320;
const MIN_CARD_WIDTH = 260;
/** The board's three columns, the gaps between them and its side padding. */
const BOARD_CHROME = 3 * MIN_CARD_WIDTH + 2 * 12 + 2 * 20;
export const KEY_STEP = 24;
export const KEY_STEP_LARGE = 96;
const STORAGE_KEY = 'slop.chat-width';

/** The widest the panel may be in a window of this width (never below the minimum). */
export const maxChatWidth = (available: number): number => Math.max(MIN_CHAT_WIDTH, available - BOARD_CHROME);

export const clampChatWidth = (width: number, available: number): number =>
  Math.round(Math.min(maxChatWidth(available), Math.max(MIN_CHAT_WIDTH, width)));

/** The remembered width, or the default when nothing usable is stored (or storage is unavailable). */
export const readChatWidth = (): number => {
  try {
    const n = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(n) && n >= MIN_CHAT_WIDTH ? n : DEFAULT_CHAT_WIDTH;
  } catch {
    return DEFAULT_CHAT_WIDTH;
  }
};

export const writeChatWidth = (width: number): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Private mode or blocked storage: the width just isn't remembered.
  }
};

/** What a key does to the width: arrows nudge (Shift for more), Home and End go to the limits; null for any other key. */
export const widthAfterKey = (key: string, shift: boolean, width: number, available: number): number | null => {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  // The panel is on the right, so ArrowLeft widens it.
  if (key === 'ArrowLeft') return clampChatWidth(width + step, available);
  if (key === 'ArrowRight') return clampChatWidth(width - step, available);
  if (key === 'Home') return MIN_CHAT_WIDTH;
  if (key === 'End') return maxChatWidth(available);
  return null;
};
