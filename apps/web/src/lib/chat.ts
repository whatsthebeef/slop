import { RequestError } from '@/lib/api';
import type { ChatCitation } from '@/lib/api';

/** What the panel says when the chat model can't answer; null for any other failure (shown as its own message). */
export const unavailableNotice = (error: unknown): string | null => {
  if (!(error instanceof RequestError) || error.body.code !== 'llm_unavailable') return null;
  const reason = error.body.reason ?? '';
  const busy = /busy/i.test(reason);
  const lead = busy ? 'The AI is busy right now. Try again in a moment.' : 'The AI is unavailable right now.';
  return reason === '' ? lead : `${lead} (${reason}${error.body.fix === undefined ? '' : `: ${error.body.fix}`})`;
};

/** A superseded decision says what replaced it; a current one says so; other sources carry no state. */
export const stateLabel = (c: ChatCitation): string | null => {
  if (c.source !== 'decision') return c.status === 'legacy' ? 'legacy' : null;
  if (c.status === 'superseded') return c.supersededBy === null ? 'superseded' : `superseded by ${c.supersededBy.title}`;
  return 'current';
};

/** Widths from this up are "wide": the chat docks beside the board and Signed Off steps aside for it. */
export const WIDE_QUERY = '(min-width: 1024px)';

/** The Signed Off column is hidden while the chat is open on a wide screen, so the other three keep their width. */
export const hideSignedOff = (chatOpen: boolean, wide: boolean): boolean => chatOpen && wide;

/** `/` or ⌘K / Ctrl+K opens the chat; `/` is left alone while someone is typing. */
export const isChatShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean => {
  if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) return true;
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target;
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return true;
  return !(el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};
