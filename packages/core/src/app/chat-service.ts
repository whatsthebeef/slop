import { CHAT_DONT_KNOW, CHAT_HISTORY_LIMIT } from '../domain/chat.js';
import type { ChatCitation, ChatMessage } from '../domain/chat.js';
import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { listOf } from '../domain/matrix.js';
import { MAX_QUERY_LENGTH, SOURCE_LABELS } from '../domain/search.js';
import type { SearchHit } from '../domain/search.js';
import type { BoardNotification } from '../domain/notifications.js';
import type { Glob } from '../domain/types.js';
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
/** The rewrite is a cheap call that must not hold the question up: past this the original question is searched. */
export const REWRITE_TIMEOUT_MS = 10_000;
const REWRITE_MAX_TOKENS = 200;
/** The board's live state is one source among the numbered ones, so it is kept short. */
export const BOARD_STATE_MAX_CHARS = 4000;
const BOARD_STATE_TITLE = 'Board state (now)';
/** What the log keeps of a reply the chat could not use. */
const LOG_REPLY_CHARS = 200;
/** Earlier turns shown to the model so a follow-up ("and why not X?") makes sense. */
const RECENT_TURNS = 6;
/** A long earlier answer would crowd out the sources. */
const TURN_CHARS = 800;

const SYSTEM = `You answer questions about a software board using ONLY the numbered sources you are given: plans, decisions, implementation records, reviews and knowledge documents.
Rules:
- Use nothing but the sources. If they do not answer the question, set "used" to [] and say you don't know.
- Cite every claim with its source number in square brackets, like [2].
- Prefer current decisions over superseded ones. When a decision you rely on is marked superseded, say so and name what replaced it.
- The source titled "Board state (now)" is the board's live state (open globs, their status and failures, active notifications), not a record of decisions: use it for questions about what is happening now.
- Earlier conversation turns are only for understanding follow-up questions; they are not evidence.
Reply with one JSON object and nothing else: {"answer": string, "used": number[]} where "used" lists the numbers of the sources the answer relies on.`;

const REWRITE_SYSTEM = `You rewrite a question about a software board into a search query for its records (plans, decisions, implementation records, reviews, knowledge documents).
Fix typos, resolve words like "that", "it" or "the Slack one" from the earlier turns, and name the subject explicitly. Keep the person's meaning; add nothing they did not ask.
Reply with one JSON object and nothing else: {"query": string}.`;

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

const oneLine = (s: string, max = 160): string => {
  const first = (s.split('\n')[0] ?? '').trim();
  return first.length > max ? `${first.slice(0, max)}...` : first;
};

const globLine = (g: Glob): string => {
  const run = g.runs[g.runs.length - 1];
  const parts = [
    `${g.id} "${oneLine(g.title, 100)}"`,
    `${g.type} ${g.category}`,
    `status ${g.status} (${listOf(g.status)})`,
  ];
  if (g.group !== null) parts.push(`group ${g.group}`);
  if (g.after !== undefined && g.after.length > 0) parts.push(`waiting for ${g.after.join(', ')}`);
  if (run !== undefined && run.state !== 'ended') parts.push(`run ${run.state}`);
  if (g.failure !== null) parts.push(`failed: ${oneLine(g.failure.reason)}`);
  else if (run?.failureReason != null && run.failureReason !== '') parts.push(`run failed: ${oneLine(run.failureReason)}`);
  if (g.headChecks !== null) {
    const failing = g.headChecks.failure === undefined ? '' : ` (${g.headChecks.failure.name})`;
    parts.push(`checks ${g.headChecks.state}${failing}`);
  }
  return `- ${parts.join('; ')}`;
};

/** The board's live state as one source: open globs (latest first) and active notifications, cut at the cap. */
const boardStateText = (globs: readonly Glob[], notifications: readonly BoardNotification[]): string => {
  const open = globs
    .filter((g) => g.status !== 'signed_off' && g.pr?.state !== 'merged')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (open.length === 0 && notifications.length === 0) return '';
  const lines: string[] = [];
  if (notifications.length > 0) {
    lines.push('Active notifications:');
    for (const n of notifications) lines.push(`- ${n.severity}: ${oneLine(n.title, 100)} (${oneLine(n.detail)})`);
  }
  lines.push(open.length === 0 ? 'No open globs.' : 'Open globs, most recently updated first:');
  let text = lines.join('\n');
  let shown = 0;
  for (const g of open) {
    const line = globLine(g);
    if (text.length + line.length + 1 > BOARD_STATE_MAX_CHARS - 60) break;
    text += `\n${line}`;
    shown += 1;
  }
  if (shown < open.length) text += `\n(${open.length - shown} more open globs not shown)`;
  return text;
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

const boardStateCitation = (boardId: number, now: string, n: number): ChatCitation => ({
  n,
  source: 'board_state',
  sourceLabel: 'Board state',
  title: BOARD_STATE_TITLE,
  date: now,
  link: `/boards/${String(boardId)}`,
  globId: null,
  status: 'active',
  supersededBy: null,
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
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      search: SearchService;
      llm: Llm;
      llmTimeoutMs?: number;
      /** A cheap model that rewrites the question for search; without one the question is searched as typed. */
      rewriteLlm?: Llm;
      rewriteTimeoutMs?: number;
      /** Where a reply the chat could not use is logged. */
      warn?: (message: string) => void;
    },
  ) {}

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

    const query = await this.rewrite(question, recent);
    const filters = {
      boardId: request.boardId,
      query,
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

    // The live state is built from the store, not from search, and goes in every question; it is last so a source
    // number from search keeps its place. With no open globs and no notifications there is nothing to add.
    const state = await this.boardState(request.boardId);
    const stateN = state === '' ? 0 : hits.length + 1;

    let answer = CHAT_DONT_KNOW;
    const citations: ChatCitation[] = [];
    if (hits.length > 0 || stateN > 0) {
      let raw: string;
      try {
        raw = await completeWithDeadline(
          this.deps.llm,
          { system: SYSTEM, prompt: this.prompt(question, hits, state, recent), maxTokens: CHAT_MAX_TOKENS },
          this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
        // Throttling and timeouts are ordinary errors from the adapter: nothing the asker did wrong, and it passes.
        return llmUnavailable('The model did not answer', 'Try again shortly');
      }
      const parsed = parseAnswer(raw);
      // An index outside 1..n is the model's invention: dropped, never linked.
      const used = new Set((parsed?.used ?? []).filter((n) => n >= 1 && n <= hits.length + (stateN > 0 ? 1 : 0)));
      if (parsed === null || (used.size === 0 && parsed.answer !== CHAT_DONT_KNOW)) {
        this.deps.warn?.(
          `chat: unusable reply on board ${String(request.boardId)} (${String(hits.length)} hits, ${parsed === null ? 'not readable' : 'no source used'}): ${raw.slice(0, LOG_REPLY_CHARS)}`,
        );
      }
      if (parsed !== null && used.size > 0) {
        answer = parsed.answer;
        const seen = new Set<number>();
        for (const n of [...used].sort((a, b) => a - b)) {
          if (n === stateN) {
            citations.push(boardStateCitation(request.boardId, this.deps.clock.now(), n));
            continue;
          }
          const hit = hits[n - 1];
          if (hit === undefined || seen.has(hit.itemId)) continue;
          seen.add(hit.itemId);
          citations.push(citationOf(hit, n));
        }
      }
    }
    return ok({ question, answer, citations });
  }

  /**
   * The question as search should see it: typos fixed and follow-ups resolved from the recent turns. Any failure
   * (no model, a timeout, an unreadable reply) searches the question as typed; a rewrite never fails a question.
   */
  private async rewrite(question: string, recent: readonly ChatMessage[]): Promise<string> {
    const llm = this.deps.rewriteLlm;
    if (llm === undefined) return question;
    try {
      const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
      const raw = await completeWithDeadline(
        llm,
        { system: REWRITE_SYSTEM, prompt: `${turns === '' ? '' : `Earlier in this conversation:\n${turns}\n\n`}Question: ${question}`, maxTokens: REWRITE_MAX_TOKENS },
        this.deps.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS,
      );
      const rewritten = text(field(parseJson(raw), 'query'))?.trim() ?? '';
      return rewritten === '' ? question : rewritten.slice(0, MAX_QUERY_LENGTH);
    } catch {
      return question;
    }
  }

  private async boardState(boardId: number): Promise<string> {
    try {
      return await this.deps.store.transaction(async (tx) =>
        boardStateText(await tx.listGlobs(boardId, {}), await tx.listNotifications(boardId)),
      );
    } catch {
      return '';
    }
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

  private prompt(question: string, hits: readonly SearchHit[], state: string, recent: readonly ChatMessage[]): string {
    const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
    return [
      'Sources:',
      [...hits.map((hit, i) => sourceBlock(hit, i + 1)), ...(state === '' ? [] : [`[${hits.length + 1}] ${BOARD_STATE_TITLE}\n${state}`])].join('\n\n'),
      turns === '' ? '' : `Earlier in this conversation:\n${turns}`,
      `Question: ${question}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
  }
}
