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

/** A question handed to the chat panel from outside it (the search box's Ask); `id` tells a repeat of the same text from the first. */
export interface ChatRequest {
  id: number;
  question: string;
  history: boolean;
}

/** The request Ask makes from the search box text and its "Include history" setting; null while the box is empty. */
export const askRequest = (text: string, history: boolean, id: number): ChatRequest | null => {
  const question = text.trim();
  return question === '' ? null : { id, question, history };
};

/** Shift+Enter asks; a plain Enter keeps its search behaviour (the results already follow the text). */
export const isAskKey = (e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean =>
  e.key === 'Enter' && e.shiftKey && e.isComposing !== true;
