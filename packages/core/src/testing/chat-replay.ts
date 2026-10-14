import type { ChatCitation } from '../domain/chat.js';
import type { ChatTestCase } from '../domain/chat-feedback.js';
import type { ChatService } from '../app/chat-service.js';

export interface ReplayAnswer {
  readonly answer: string;
  readonly answered: boolean;
  readonly citations: readonly ChatCitation[];
}

export interface ReplayResult extends ReplayAnswer {
  readonly case: ChatTestCase;
  /** The answer text differs from the stored 👎 one. */
  readonly changed: boolean;
  /** Why the case still fails; null when it passes. */
  readonly problem: string | null;
}

/** A case passes when the chat now gives a cited answer (the rule the extra steps stop on). */
export const citedAnswerCheck = (_case: ChatTestCase, replay: ReplayAnswer): string | null => {
  if (!replay.answered) return 'The chat still gives no answer';
  return replay.citations.length > 0 ? null : 'The answer cites no source';
};

/**
 * Asks the chat each 👎 question again, one at a time, as `email` (a member of the board). Nothing is stored, but each
 * call spends like any answer, so replay against a real model is for a person to run on purpose.
 */
export const replayChatCases = async (
  chat: Pick<ChatService, 'answer'>,
  email: string,
  cases: readonly ChatTestCase[],
  options: { check?: (testCase: ChatTestCase, replay: ReplayAnswer) => string | null } = {},
): Promise<ReplayResult[]> => {
  const check = options.check ?? citedAnswerCheck;
  const results: ReplayResult[] = [];
  for (const testCase of cases) {
    const result = await chat.answer(email, {
      boardId: testCase.boardId,
      question: testCase.question,
      ...(testCase.page === null ? {} : { page: testCase.page }),
    });
    if (!result.ok) {
      results.push({
        case: testCase,
        answer: '',
        answered: false,
        citations: [],
        changed: false,
        problem: `${result.error.code}: ${result.error.message}`,
      });
      continue;
    }
    const { answer, answered, citations } = result.value;
    results.push({
      case: testCase,
      answer,
      answered,
      citations,
      changed: answer !== testCase.answer,
      problem: check(testCase, { answer, answered, citations }),
    });
  }
  return results;
};

export const replayFailures = (results: readonly ReplayResult[]): ReplayResult[] =>
  results.filter((r) => r.problem !== null);
