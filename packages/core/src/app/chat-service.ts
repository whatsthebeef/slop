import { CHAT_DONT_KNOW, CHAT_HISTORY_LIMIT } from '../domain/chat.js';
import type { ChatCitation, ChatMessage } from '../domain/chat.js';
import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { MAX_QUERY_LENGTH, SOURCE_LABELS } from '../domain/search.js';
import type { SearchHit } from '../domain/search.js';
import type { Clock, Store } from '../ports.js';
import { memberOf } from './access.js';
import { LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { completeWithDeadline } from './llm-call.js';
import { field, list, parseJson, text } from './llm-json.js';
import type { SearchService } from './search-service.js';

/** A stalled call fails the question well before a browser or MCP client gives up. */
export const CHAT_LLM_TIMEOUT_MS = 60_000;
const CHAT_MAX_TOKENS = 1500;
/** Earlier turns shown to the model so a follow-up ("and why not X?") makes sense. */
const RECENT_TURNS = 6;
/** A long earlier answer would crowd out the sources. */
const TURN_CHARS = 800;

const SYSTEM = `You answer questions about a software board using ONLY the numbered sources you are given: plans, decisions, implementation records, reviews and knowledge documents.
Rules:
- Use nothing but the sources. If they do not answer the question, set "used" to [] and say you don't know.
- Cite every claim with its source number in square brackets, like [2].
- Prefer current decisions over superseded ones. When a decision you rely on is marked superseded, say so and name what replaced it.
- Earlier conversation turns are only for understanding follow-up questions; they are not evidence.
Reply with one JSON object and nothing else: {"answer": string, "used": number[]} where "used" lists the numbers of the sources the answer relies on.`;

export interface ChatRequest {
  readonly boardId: number;
  readonly question: string;
  readonly globId?: string;
  readonly group?: string;
  /** Include history: search all time rather than favouring current material. */
  readonly history?: boolean;
}

export interface ChatAnswer {
  readonly question: ChatMessage;
  readonly reply: ChatMessage;
  /** False when the board's records didn't answer. */
  readonly answered: boolean;
}

const sourceBlock = (hit: SearchHit, n: number): string => {
  const c = hit.citation;
  const state = hit.label === null ? '' : ` (${hit.label})`;
  return `[${n}] ${SOURCE_LABELS[c.source]}: ${c.title}${state}, ${c.date.slice(0, 10)}\n${hit.header}\n${hit.text}`;
};

const citationOf = (hit: SearchHit, n: number): ChatCitation => ({
  n,
  source: hit.citation.source,
  sourceLabel: SOURCE_LABELS[hit.citation.source],
  title: hit.citation.title,
  date: hit.citation.date,
  link: hit.citation.link,
  globId: hit.citation.globId,
  status: hit.status,
  supersededBy: hit.supersededBy,
});

const clip = (s: string): string => (s.length > TURN_CHARS ? `${s.slice(0, TURN_CHARS)}...` : s);

/** The model's answer and the source numbers it says it used, or null when it isn't usable JSON. */
const parseAnswer = (raw: string): { answer: string; used: readonly number[] } | null => {
  const parsed = parseJson(raw);
  const answer = text(field(parsed, 'answer'))?.trim() ?? '';
  if (answer === '') return null;
  const used = list(field(parsed, 'used')).filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
  return { answer, used };
};

/**
 * Board chat (spec, Chat): one retrieval over the board's records, one model call that answers from them, and
 * citations taken from what was retrieved, never from the model's text. A person's conversation is theirs alone.
 */
export class ChatService {
  constructor(private readonly deps: { store: Store; clock: Clock; search: SearchService; llm: Llm; llmTimeoutMs?: number }) {}

  /** A question in the person's conversation: answered from the board's records, then both turns are stored. */
  async ask(email: string, request: ChatRequest): Promise<Result<ChatAnswer>> {
    const recent = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, request.boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listChatMessages(request.boardId, email, RECENT_TURNS));
    });
    if (!recent.ok) return recent;
    const composed = await this.compose(email, request, recent.value);
    if (!composed.ok) return composed;
    const { question, answer, citations } = composed.value;
    // Nothing is stored for a failed call: the person asks again.
    return this.deps.store.transaction(async (tx) => {
      // Membership could have been removed while the model ran.
      const actor = await memberOf(tx, email, request.boardId);
      if (!actor.ok) return actor;
      const now = this.deps.clock.now();
      const asked = await tx.addChatMessage({ boardId: request.boardId, email, role: 'user', content: question, citations: null, createdAt: now });
      const reply = await tx.addChatMessage({ boardId: request.boardId, email, role: 'assistant', content: answer, citations, createdAt: now });
      return ok({ question: asked, reply, answered: answer !== CHAT_DONT_KNOW });
    });
  }

  /** A one-off question (the MCP tool): same retrieval and citations, but no conversation is read or stored. */
  async answer(email: string, request: ChatRequest): Promise<Result<{ answer: string; answered: boolean; citations: readonly ChatCitation[] }>> {
    const composed = await this.compose(email, request, []);
    if (!composed.ok) return composed;
    const { answer, citations } = composed.value;
    return ok({ answer, answered: answer !== CHAT_DONT_KNOW, citations });
  }

  private async compose(
    email: string,
    request: ChatRequest,
    recent: readonly ChatMessage[],
  ): Promise<Result<{ question: string; answer: string; citations: ChatCitation[] }>> {
    const question = request.question.trim();
    if (question === '') return invalidInput('question must not be empty');
    if (question.length > MAX_QUERY_LENGTH) return invalidInput(`question must be at most ${MAX_QUERY_LENGTH} characters`);

    const filters = {
      boardId: request.boardId,
      query: question,
      mode: request.history === true ? ('all_time' as const) : ('current' as const),
      ...(request.globId === undefined ? {} : { globId: request.globId }),
      ...(request.group === undefined ? {} : { group: request.group }),
    };
    let hits: readonly SearchHit[];
    try {
      const found = await this.deps.search.board(email, filters);
      if (!found.ok) return found;
      hits = found.value.hits;
    } catch {
      // An embedder failure that isn't "unavailable" must not fail the question: answer from keyword matches.
      try {
        const found = await this.deps.search.text(email, filters);
        if (!found.ok) return found;
        hits = found.value;
      } catch {
        return llmUnavailable('The search did not complete', 'Try again shortly');
      }
    }

    let answer = CHAT_DONT_KNOW;
    const citations: ChatCitation[] = [];
    if (hits.length > 0) {
      let raw: string;
      try {
        raw = await completeWithDeadline(
          this.deps.llm,
          { system: SYSTEM, prompt: this.prompt(question, hits, recent), maxTokens: CHAT_MAX_TOKENS },
          this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
        // Throttling and timeouts are ordinary errors from the adapter: nothing the asker did wrong, and it passes.
        return llmUnavailable('The model did not answer', 'Try again shortly');
      }
      const parsed = parseAnswer(raw);
      // An index outside 1..n is the model's invention: dropped, never linked.
      const used = new Set((parsed?.used ?? []).filter((n) => n >= 1 && n <= hits.length));
      if (parsed !== null && used.size > 0) {
        answer = parsed.answer;
        const seen = new Set<number>();
        for (const n of [...used].sort((a, b) => a - b)) {
          const hit = hits[n - 1];
          if (hit === undefined || seen.has(hit.itemId)) continue;
          seen.add(hit.itemId);
          citations.push(citationOf(hit, n));
        }
      }
    }
    return ok({ question, answer, citations });
  }

  /** The person's conversation on the board, oldest first. */
  async history(email: string, boardId: number): Promise<Result<readonly ChatMessage[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listChatMessages(boardId, email, CHAT_HISTORY_LIMIT));
    });
  }

  async clear(email: string, boardId: number): Promise<Result<null>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      await tx.clearChat(boardId, email);
      return ok(null);
    });
  }

  private prompt(question: string, hits: readonly SearchHit[], recent: readonly ChatMessage[]): string {
    const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
    return [
      'Sources:',
      hits.map((hit, i) => sourceBlock(hit, i + 1)).join('\n\n'),
      turns === '' ? '' : `Earlier in this conversation:\n${turns}`,
      `Question: ${question}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
  }
}
