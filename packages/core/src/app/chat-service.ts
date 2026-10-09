import { CHAT_DONT_KNOW, CHAT_HISTORY_LIMIT, CHAT_LIST_LIMIT, CHAT_TITLE_MAX, impliesHistory, isSmallTalk, parseActions, withoutActionsTag } from '../domain/chat.js';
import type { ChatAction, ChatCitation, ChatMessage, ChatThread, PageContext } from '../domain/chat.js';
import { invalidInput, llmUnavailable, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { listOf } from '../domain/matrix.js';
import { MAX_QUERY_LENGTH, SOURCE_LABELS } from '../domain/search.js';
import type { SearchHit } from '../domain/search.js';
import type { BoardNotification } from '../domain/notifications.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import { LlmUnavailable } from './intake-service.js';
import type { Llm, LlmRequest } from './intake-service.js';
import { completeWithDeadline } from './llm-call.js';
import { field, parseJson, text } from './llm-json.js';
import type { NewLearning } from './knowledge-service.js';
import type { SearchService } from './search-service.js';

/** A stalled call fails the question well before a browser or MCP client gives up. */
export const CHAT_LLM_TIMEOUT_MS = 60_000;
const CHAT_MAX_TOKENS = 1500;
/** Think harder may reason longer before it answers, so it gets more time. */
export const CHAT_THINK_TIMEOUT_MS = 120_000;
/** The rewrite is a cheap call that must not hold the question up: past this the original question is searched. */
export const REWRITE_TIMEOUT_MS = 10_000;
const REWRITE_MAX_TOKENS = 200;
const SMALL_TALK_MAX_TOKENS = 300;
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
- Use nothing but the sources. If they do not answer the question, reply with exactly: ${CHAT_DONT_KNOW}
- Cite every claim with its source number in square brackets, like [2] or [2][3].
- Prefer current decisions over superseded ones. When a decision you rely on is marked superseded, say so and name what replaced it.
- The source titled "Board state (now)" is the board's live state (open globs, their status and failures, active notifications), not a record of decisions: use it for questions about what is happening now.
- Earlier conversation turns are only for understanding follow-up questions; they are not evidence.
- When the person is viewing a page (given after the sources), "this" in their question means that page.
- If the sources do not answer, the reply names what you looked for: ${CHAT_DONT_KNOW}
Reply in short Markdown (a few sentences, lists where they help). Mention a glob by its ID, like s15f25.
After the answer, you may add one last line naming the buttons worth showing under it, as <actions>create_glob, save</actions>:
- create_glob only when the answer points at work that is not on the board yet (a gap, a bug, a follow-up) or the person asked for something to be done;
- save only when the answer states something durable and cited (a convention, a decision, a how-to).
Most answers need neither: leave the line out.`;

const SMALL_TALK_SYSTEM = `You are the chat of a software board. The person's message is not a question about the board's records (a greeting, thanks, or a question about the chat itself), so answer it like a friendly colleague in one or two short sentences.
If they ask what you can do: you answer questions about the board's plans, decisions, implementation records, reviews and knowledge, with their sources; you know what is open on the board right now; and answers can lead to creating a glob, saving something to the knowledge base or opening a glob. Mention what fits the page they are on.
Never claim facts about the board's contents, and do not say you cannot find anything.`;

const REWRITE_SYSTEM = `You rewrite a question about a software board into a search query for its records (plans, decisions, implementation records, reviews, knowledge documents).
Fix typos, resolve words like "that", "it" or "the Slack one" from the earlier turns, and name the subject explicitly. Keep the person's meaning; add nothing they did not ask.
Also say whether the message is small talk: a greeting, thanks, or a question about the chat itself rather than about the board.
Reply with one JSON object and nothing else: {"query": string, "smallTalk": boolean}.`;

export interface ChatRequest {
  readonly boardId: number;
  readonly question: string;
  readonly globId?: string;
  readonly group?: string;
  /** Include history: search all time rather than favouring current material. Left out, the question decides (see `impliesHistory`). */
  readonly history?: boolean;
  /** The conversation to add to; without one a new conversation starts. */
  readonly chatId?: number;
  /** The page the person is asking from. */
  readonly page?: PageContext;
  /** One answer from the stronger model. */
  readonly thinkHarder?: boolean;
  /** Fired when the person stops the answer: the model call ends and nothing is stored. */
  readonly signal?: AbortSignal;
}

/** What the answer streams: pieces of text as the model writes them. */
export type ChatDelta = (text: string) => void;

export interface ChatAnswer {
  readonly chat: ChatThread;
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

/** The source numbers an answer cites, as `[n]` markers, in order of first use. */
export const citedNumbers = (answer: string): number[] => {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) seen.add(Number(m[1]));
  return [...seen];
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
      /** The stronger model for one answer ("think harder"); without one the usual model answers. */
      deepLlm?: Llm;
      deepTimeoutMs?: number;
      /** A cheap model that rewrites the question for search; without one the question is searched as typed. */
      rewriteLlm?: Llm;
      rewriteTimeoutMs?: number;
      /** Sends an answer to the board's proposal queue (the knowledge service's `submitLearning`). */
      submitLearning?: (email: string, boardId: number, learning: NewLearning) => Promise<Result<{ id: string }>>;
      /** Where a reply the chat could not use is logged. */
      warn?: (message: string) => void;
    },
  ) {}

  /**
   * A question in a conversation (a new one when `chatId` is left out): answered from the board's records, then both
   * turns are stored. `onText` receives the answer as the model writes it; the stored answer is the final one.
   */
  async ask(email: string, request: ChatRequest, onText?: ChatDelta): Promise<Result<ChatAnswer>> {
    const recent = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, request.boardId);
      if (!actor.ok) return actor;
      if (request.chatId === undefined) return ok<ChatMessage[]>([]);
      const chat = await tx.getChat(request.chatId);
      if (chat?.boardId !== request.boardId || chat.email !== email) return notFound(`No conversation ${String(request.chatId)}`);
      return ok(await tx.listChatMessages(chat.id, RECENT_TURNS));
    });
    if (!recent.ok) return recent;
    const composed = await this.compose(email, request, recent.value, onText);
    if (!composed.ok) return composed;
    if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
    const { question, answer, citations, tools, actions } = composed.value;
    // Nothing is stored for a failed call: the person asks again.
    return this.deps.store.transaction(async (tx) => {
      // Membership could have been removed while the model ran.
      const actor = await memberOf(tx, email, request.boardId);
      if (!actor.ok) return actor;
      const now = this.deps.clock.now();
      let chat: ChatThread | null;
      if (request.chatId === undefined) {
        const title = question.length > CHAT_TITLE_MAX ? `${question.slice(0, CHAT_TITLE_MAX - 3)}...` : question;
        chat = await tx.createChat({ boardId: request.boardId, email, title, createdAt: now });
      } else {
        chat = await tx.getChat(request.chatId);
        if (chat === null) return notFound(`No conversation ${String(request.chatId)}`);
        await tx.touchChat(chat.id, now);
        chat = { ...chat, updatedAt: now };
      }
      const base = { chatId: chat.id, boardId: request.boardId, email, createdAt: now };
      const asked = await tx.addChatMessage({ ...base, role: 'user', content: question, citations: null });
      const reply = await tx.addChatMessage({ ...base, role: 'assistant', content: answer, citations, tools, actions });
      return ok({ chat, question: asked, reply, answered: answer !== CHAT_DONT_KNOW });
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
    onText?: ChatDelta,
  ): Promise<Result<{ question: string; answer: string; citations: ChatCitation[]; tools: string[]; actions: ChatAction[] }>> {
    const question = request.question.trim();
    if (question === '') return invalidInput('question must not be empty');
    if (question.length > MAX_QUERY_LENGTH) return invalidInput(`question must be at most ${MAX_QUERY_LENGTH} characters`);

    const tools: string[] = [];
    // Obvious small talk skips the rewrite call too; anything else lets that one call classify the message.
    const rewritten = isSmallTalk(question) ? { query: question, smallTalk: true } : await this.rewrite(question, recent);
    if (rewritten.smallTalk) return this.smallTalk(question, request, onText);
    const query = rewritten.query;
    if (query !== question) tools.push('Rewrote the question for search');
    const allTime = request.history ?? impliesHistory(question);
    const filters = {
      boardId: request.boardId,
      query,
      mode: allTime ? ('all_time' as const) : ('current' as const),
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
    tools.push(`Searched the board's records (${allTime ? 'all time, including history' : 'current'}${request.globId === undefined ? '' : `, ${request.globId} only`}): ${String(hits.length)} found`);

    // The live state is built from the store, not from search, and goes in every question; it is last so a source
    // number from search keeps its place. With no open globs and no notifications there is nothing to add.
    const state = await this.boardState(request.boardId);
    const stateN = state === '' ? 0 : hits.length + 1;
    if (stateN > 0) tools.push('Read the board\'s live state');
    const page = await this.pageLine(request.boardId, request.page);

    let answer = CHAT_DONT_KNOW;
    let actions: ChatAction[] = [];
    const citations: ChatCitation[] = [];
    if (hits.length > 0 || stateN > 0) {
      const deep = request.thinkHarder === true && this.deps.deepLlm !== undefined;
      if (deep) tools.push('Thought harder (stronger model)');
      const llm = deep && this.deps.deepLlm !== undefined ? this.deps.deepLlm : this.deps.llm;
      const llmRequest = { system: SYSTEM, prompt: this.prompt(question, hits, state, recent, page), maxTokens: CHAT_MAX_TOKENS };
      const timeout = deep ? (this.deps.deepTimeoutMs ?? CHAT_THINK_TIMEOUT_MS) : (this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS);
      let raw: string;
      try {
        raw = await this.generate(llm, llmRequest, timeout, onText === undefined ? undefined : withoutActionsTag(onText), request.signal);
      } catch (error) {
        if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
        if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
        // Throttling and timeouts are ordinary errors from the adapter: nothing the asker did wrong, and it passes.
        return llmUnavailable('The model did not answer', 'Try again shortly');
      }
      const parsed = parseActions(raw);
      const text = parsed.text;
      // A number outside 1..n is the model's invention: dropped, never linked.
      const total = hits.length + (stateN > 0 ? 1 : 0);
      const used = citedNumbers(text).filter((n) => n >= 1 && n <= total);
      if (text === '' || (used.length === 0 && !text.startsWith(CHAT_DONT_KNOW))) {
        this.deps.warn?.(
          `chat: unusable reply on board ${String(request.boardId)} (${String(hits.length)} hits, ${text === '' ? 'empty' : 'no source used'}): ${raw.slice(0, LOG_REPLY_CHARS)}`,
        );
      }
      if (used.length > 0) {
        answer = text;
        // Nothing is offered under "couldn't find"; saving needs sources to point at.
        if (!text.startsWith(CHAT_DONT_KNOW)) actions = parsed.actions;
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
    if (citations.length === 0) actions = [];
    return ok({ question, answer, citations, tools, actions });
  }

  /** A greeting or a question about the chat: one short model call with no search, no sources and no actions. */
  private async smallTalk(
    question: string,
    request: ChatRequest,
    onText?: ChatDelta,
  ): Promise<Result<{ question: string; answer: string; citations: ChatCitation[]; tools: string[]; actions: ChatAction[] }>> {
    const page = await this.pageLine(request.boardId, request.page);
    const prompt = `${question}${page === '' ? '' : `\n\n${page}`}`;
    let raw: string;
    try {
      raw = await this.generate(this.deps.llm, { system: SMALL_TALK_SYSTEM, prompt, maxTokens: SMALL_TALK_MAX_TOKENS }, this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS, onText, request.signal);
    } catch (error) {
      if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      return llmUnavailable('The model did not answer', 'Try again shortly');
    }
    const answer = raw.trim();
    return ok({ question, answer: answer === '' ? 'Hello! Ask me about this board.' : answer, citations: [], tools: [], actions: [] });
  }

  /** One model call, streamed when the adapter can and someone is listening; the deadline and the person's stop both end it. */
  private async generate(llm: Llm, request: Omit<LlmRequest, 'signal'>, timeoutMs: number, onText?: ChatDelta, stop?: AbortSignal): Promise<string> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = stop === undefined ? deadline : AbortSignal.any([deadline, stop]);
    try {
      if (onText === undefined || llm.stream === undefined) {
        const raw = await llm.complete({ ...request, signal });
        onText?.(raw);
        return raw;
      }
      return await llm.stream({ ...request, signal }, onText);
    } catch (error) {
      if (error instanceof LlmUnavailable) throw error;
      if (deadline.aborted && stop?.aborted !== true) throw new Error(`The model did not answer within ${timeoutMs / 1000} s`, { cause: error });
      throw error;
    }
  }

  /** What the person is looking at, for the prompt; empty when the page says nothing the model needs. */
  private async pageLine(boardId: number, page: PageContext | undefined): Promise<string> {
    if (page === undefined || page.type === 'board') return '';
    if (page.type === 'glob' && page.id !== undefined) {
      try {
        const glob = await this.deps.store.transaction((tx) => tx.getGlob(page.id ?? ''));
        if (glob?.boardId === boardId) return `The person is viewing glob ${glob.id} "${oneLine(glob.title, 100)}" (status ${glob.status}).`;
      } catch {
        // The page line is context only; the question is answered without it.
      }
      return `The person is viewing glob ${page.id}.`;
    }
    return `The person is viewing the ${page.type.replace('_', ' ')} page${page.id === undefined ? '' : ` (${page.id})`}.`;
  }

  /**
   * The question as search should see it: typos fixed and follow-ups resolved from the recent turns. Any failure
   * (no model, a timeout, an unreadable reply) searches the question as typed; a rewrite never fails a question.
   */
  private async rewrite(question: string, recent: readonly ChatMessage[]): Promise<{ query: string; smallTalk: boolean }> {
    const llm = this.deps.rewriteLlm;
    if (llm === undefined) return { query: question, smallTalk: false };
    try {
      const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
      const raw = await completeWithDeadline(
        llm,
        { system: REWRITE_SYSTEM, prompt: `${turns === '' ? '' : `Earlier in this conversation:\n${turns}\n\n`}Question: ${question}`, maxTokens: REWRITE_MAX_TOKENS },
        this.deps.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS,
      );
      const json = parseJson(raw);
      const rewritten = text(field(json, 'query'))?.trim() ?? '';
      return { query: rewritten === '' ? question : rewritten.slice(0, MAX_QUERY_LENGTH), smallTalk: field(json, 'smallTalk') === true };
    } catch {
      return { query: question, smallTalk: false };
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

  /** The person's conversations on the board, most recently used first. */
  async chats(email: string, boardId: number): Promise<Result<readonly ChatThread[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listChats(boardId, email, CHAT_LIST_LIMIT));
    });
  }

  /** One of the person's conversations, oldest message first. Someone else's is not found. */
  async history(email: string, boardId: number, chatId: number): Promise<Result<readonly ChatMessage[]>> {
    return this.deps.store.transaction(async (tx) => {
      const chat = await this.own(tx, email, boardId, chatId);
      if (!chat.ok) return chat;
      return ok(await tx.listChatMessages(chatId, CHAT_HISTORY_LIMIT));
    });
  }

  async remove(email: string, boardId: number, chatId: number): Promise<Result<null>> {
    return this.deps.store.transaction(async (tx) => {
      const chat = await this.own(tx, email, boardId, chatId);
      if (!chat.ok) return chat;
      await tx.deleteChat(chatId);
      return ok(null);
    });
  }

  /**
   * Save to knowledge: the answer goes to the board's proposal queue as a learning for admins to approve. It is never
   * indexed on its own. The learning needs a source glob: the first glob the answer cites, else the page's.
   */
  async saveToKnowledge(email: string, boardId: number, chatId: number, messageId: number, pageGlobId?: string): Promise<Result<{ id: string }>> {
    const submit = this.deps.submitLearning;
    if (submit === undefined) return invalidInput('Saving to knowledge is not available');
    const found = await this.deps.store.transaction(async (tx) => {
      const chat = await this.own(tx, email, boardId, chatId);
      if (!chat.ok) return chat;
      const messages = await tx.listChatMessages(chatId, CHAT_HISTORY_LIMIT);
      const index = messages.findIndex((m) => m.id === messageId && m.role === 'assistant');
      const reply = messages[index];
      if (reply === undefined) return notFound(`No answer ${String(messageId)} in conversation ${String(chatId)}`);
      return ok({ reply, asked: messages[index - 1] });
    });
    if (!found.ok) return found;
    const { reply, asked } = found.value;
    if (reply.content === CHAT_DONT_KNOW) return invalidInput('There is nothing to save: the board had no answer');
    const sourceGlobId = reply.citations?.find((c) => c.globId !== null)?.globId ?? pageGlobId;
    if (sourceGlobId === undefined) return invalidInput('This answer cites no glob; open a glob and save from there');
    const sources = (reply.citations ?? []).map((c) => `[${String(c.n)}] ${c.sourceLabel}: ${c.title} (${c.date.slice(0, 10)})`).join('\n');
    return submit(email, boardId, {
      sourceGlobId,
      type: 'decision',
      statement: reply.content,
      evidence: `Answer from the board chat${asked === undefined ? '' : ` to "${asked.content}"`}, saved by ${email}.${sources === '' ? '' : `\nSources:\n${sources}`}`,
    });
  }

  private async own(tx: Tx, email: string, boardId: number, chatId: number): Promise<Result<ChatThread>> {
    const actor = await memberOf(tx, email, boardId);
    if (!actor.ok) return actor;
    const chat = await tx.getChat(chatId);
    // Someone else's conversation looks the same as none.
    if (chat?.boardId !== boardId || chat.email !== email) return notFound(`No conversation ${String(chatId)}`);
    return ok(chat);
  }

  private prompt(question: string, hits: readonly SearchHit[], state: string, recent: readonly ChatMessage[], page: string): string {
    const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
    return [
      'Sources:',
      [...hits.map((hit, i) => sourceBlock(hit, i + 1)), ...(state === '' ? [] : [`[${hits.length + 1}] ${BOARD_STATE_TITLE}\n${state}`])].join('\n\n'),
      turns === '' ? '' : `Earlier in this conversation:\n${turns}`,
      page,
      `Question: ${question}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
  }
}
