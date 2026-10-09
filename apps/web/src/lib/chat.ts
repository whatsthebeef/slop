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
