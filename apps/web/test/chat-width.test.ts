import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampChatWidth, DEFAULT_CHAT_WIDTH, MIN_CHAT_WIDTH, maxChatWidth, readChatWidth, widthAfterKey, writeChatWidth } from '../src/lib/chat-width';

const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
  });
  return data;
};

afterEach(() => vi.unstubAllGlobals());

describe('chat panel width', () => {
  it('stays between 20rem and what leaves three minimum-width columns', () => {
    expect(clampChatWidth(100, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(5000, 1600)).toBe(maxChatWidth(1600));
    expect(maxChatWidth(1600)).toBe(1600 - (3 * 260 + 24 + 40));
    expect(clampChatWidth(500, 1600)).toBe(500);
  });

  it('never goes below the minimum, even in a window too narrow for the board', () => {
    expect(maxChatWidth(900)).toBe(MIN_CHAT_WIDTH);
  });

  it('is widened by ArrowLeft, narrowed by ArrowRight, and Shift takes bigger steps', () => {
    expect(widthAfterKey('ArrowLeft', false, 480, 1600)).toBe(504);
    expect(widthAfterKey('ArrowRight', false, 480, 1600)).toBe(456);
    expect(widthAfterKey('ArrowLeft', true, 480, 1600)).toBe(576);
    expect(widthAfterKey('Home', false, 480, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(widthAfterKey('End', false, 480, 1600)).toBe(maxChatWidth(1600));
    expect(widthAfterKey('a', false, 480, 1600)).toBeNull();
  });

  it('is remembered, and falls back to the default when missing, unusable or storage throws', () => {
    store();
    expect(readChatWidth()).toBe(DEFAULT_CHAT_WIDTH);
    writeChatWidth(600);
    expect(readChatWidth()).toBe(600);
    store({ 'slop.chat-width': 'wide' });
    expect(readChatWidth()).toBe(DEFAULT_CHAT_WIDTH);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readChatWidth()).toBe(DEFAULT_CHAT_WIDTH);
    expect(() => writeChatWidth(600)).not.toThrow();
  });
});
