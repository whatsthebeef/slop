import { CHAT_CODE_MAX_CALLS, CHAT_DONT_KNOW, chatMissText, CHAT_HISTORY_LIMIT, CHAT_LIST_LIMIT, CHAT_NO_CODE, CHAT_TITLE_MAX, impliesHistory, isSmallTalk, parseActions, parseCodeCall, withoutActionsTag, withoutCodeRequests } from '../domain/chat.js';
import type { ChatAction, ChatCitation, ChatCodeCall, ChatMessage, ChatThread, PageContext } from '../domain/chat.js';
import { invalidInput, llmUnavailable, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { listOf } from '../domain/matrix.js';
import { MAX_QUERY_LENGTH, SOURCE_LABELS } from '../domain/search.js';
import type { SearchHit } from '../domain/search.js';
import type { BoardNotification } from '../domain/notifications.js';
import { startIds } from '../domain/relations.js';
import type { Glob, Relation } from '../domain/types.js';
import { isOperationalQuestion, opsStateText } from '../domain/ops-state.js';
import type { OpsHealth } from '../domain/ops-state.js';
import type { Clock, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import type { CodeViewService } from './code-view.js';
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
/** The most extra steps a miss may try before giving up (second search, code, stronger model); each also keeps the usual timeouts. */
export const CHAT_EXTRA_STEPS = 4;
const SMALL_TALK_MAX_TOKENS = 300;
/** The board's live state is one source among the numbered ones, so it is kept short. */
export const BOARD_STATE_MAX_CHARS = 4000;
const BOARD_STATE_TITLE = 'Board state (now)';
const OPS_STATE_TITLE = 'Slop status (now)';
/** What the log keeps of a reply the chat could not use. */
const LOG_REPLY_CHARS = 200;
/** What one code-view result may put in front of the model; the rest is cut. */
const CODE_OBSERVATION_CHARS = 6000;
const CODE_LIST_LINES = 80;
const CODE_CONSUMER = 'chat';
/** Earlier turns shown to the model so a follow-up ("and why not X?") makes sense. */
const RECENT_TURNS = 6;
/** A long earlier answer would crowd out the sources. */
const TURN_CHARS = 800;

const SYSTEM = `You answer questions about a software board using the numbered sources you are given: plans, decisions, implementation records, reviews and knowledge documents, and slop's own help (sources labelled "Slop help", which explain how slop itself works: globs, labels, relations, decision globs, watch signals and so on).
Rules:
- Answer from the sources when they answer the question, and cite every claim with its source number in square brackets, like [2] or [2][3].
- Questions about how to use slop are answered from the "Slop help" sources. Facts about the board (glob IDs, decisions, statuses, what was built) come only from the board's own sources.
- When the sources do not answer, give a short best answer from general knowledge and say plainly that it is not from the board's records. Never invent facts about the board: no glob IDs, decisions, statuses or dates that are not in the sources. Reply with exactly ${CHAT_DONT_KNOW} only when you have nothing useful to say at all.
- Prefer current decisions over superseded ones. When a decision you rely on is marked superseded, say so and name what replaced it.
- The source titled "Board state (now)" is the board's live state (open globs, their status and failures, active notifications), not a record of decisions: use it for questions about what is happening now.
- The source titled "Slop status (now)" is slop's own health (AI models, integrations, capabilities, slow requests, outbox backlog) plus this board's failures and deploys in the last 24 hours. For "why isn't X working", "why hasn't <glob> started" or "is slop down" questions, read it first: say what is down, failing or slow, with the fix it gives, and cite it. When everything in it is healthy, say so and point at the next thing to check (the glob's own failure or checks, the code). Never repeat anything from it that looks like a secret or a token.
- Earlier conversation turns are only for understanding follow-up questions; they are not evidence.
- When the person is viewing a page (given after the sources), "this" in their question means that page.
Reply in short Markdown (a few sentences, lists where they help). Mention a glob by its ID, like s15f25.
After the answer, you may add one last line naming the buttons worth showing under it, as <actions>create_glob, save</actions>:
- create_glob only when the answer points at work that is not on the board yet (a gap, a bug, a follow-up) or the person asked for something to be done;
- save only when the answer states something durable and cited (a convention, a decision, a how-to).
Most answers need neither: leave the line out.`;

const codeInstructions = (calls: number): string => `

You may also look at the board's code (its base branch, read-only) before you answer, when the question is about the code: where something is implemented, how it works, what calls it. Records that already answer the question need no code looks. To look, reply with one JSON object and nothing else (at most ${String(calls)} looks in all):
{"tool": "tree", "path": "<directory, empty for the root>"}
{"tool": "grep", "pattern": "<regular expression>", "path": "<optional folder or file to search under>"}
{"tool": "read", "path": "<file>", "start": <first line>, "end": <last line>}   start and end are optional; read the part you need
{"tool": "history", "path": "<file or folder>"}   the commits that changed it
{"tool": "imports", "path": "<file>", "direction": "imports" or "importedBy"}
Each file you read becomes a numbered source after the others, shown with its path and line range: cite it like any source, [n]. Grep, tree, history and imports results are for finding your way and cannot be cited. When you are ready to answer, write the answer (it never starts with "{").`;

const NO_CODE_INSTRUCTIONS = `

If the question needs the board's code to be answered (where something is implemented, how it works) and you cannot read the code, reply with exactly: ${CHAT_NO_CODE}`;

const SMALL_TALK_SYSTEM = `You are the chat of a software board. The person's message is not a question about the board's records (a greeting, thanks, or a question about the chat itself), so answer it like a friendly colleague in one or two short sentences.
If they ask what you can do: you answer questions about the board's plans, decisions, implementation records, reviews and knowledge, with their sources; you also answer how-to questions about slop itself from slop's help, cited; you know what is open on the board right now; and answers can lead to creating a glob, saving something to the knowledge base or opening a glob. Mention what fits the page they are on.
Never claim facts about the board's contents, and do not say you cannot find anything.`;

const REWRITE_SYSTEM = `You rewrite a question about a software board into a search query for its records (plans, decisions, implementation records, reviews, knowledge documents).
Fix typos, resolve words like "that", "it" or "the Slack one" from the earlier turns, and name the subject explicitly. Keep the person's meaning; add nothing they did not ask.
Also say whether the message is small talk: a greeting, thanks, or a question about the chat itself rather than about the board.
Reply with one JSON object and nothing else: {"query": string, "smallTalk": boolean}.`;

const REWRITE_ALT_SYSTEM = `A search of a software board's records (plans, decisions, implementation records, reviews, knowledge documents) for a question found nothing useful. Write a different search query for the same question: use synonyms and the key nouns only, and drop filler words. Do not repeat the earlier query.
Reply with one JSON object and nothing else: {"query": string}.`;

const FILLER = new Set(['about', 'after', 'again', 'also', 'been', 'does', 'from', 'have', 'into', 'just', 'like', 'more', 'only', 'over', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'while', 'whom', 'whose', 'will', 'with', 'would', 'could', 'should', 'tell', 'show', 'explain']);

/** The key nouns of a question: a fallback second query when no rewrite model is there to write one. */
export const keyNouns = (question: string): string =>
  [...new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [])].filter((w) => w.length > 3 && !FILLER.has(w)).join(' ');

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
  /** The person asked to look at the code ("Look at the code" under a miss): the model is told to use the code view. */
  readonly lookAtCode?: boolean;
  /** Fired when the person stops the answer: the model call ends and nothing is stored. */
  readonly signal?: AbortSignal;
}

/** What the answer streams: pieces of text as the model writes them. */
export type ChatDelta = (text: string) => void;

/** A line that says what the chat is doing while extra steps run ("Searching again…"); the text streamed so far is dropped. */
export type ChatProgress = (line: string) => void;

export interface ChatAnswer {
  readonly chat: ChatThread;
  readonly question: ChatMessage;
  readonly reply: ChatMessage;
  /** False when the answer cites nothing (a miss, or text that is not from the records: `reply.uncited`). */
  readonly answered: boolean;
}

/** What `compose` returns: the reply as it is stored, with how it came about. */
interface Composed {
  readonly question: string;
  readonly answer: string;
  readonly citations: ChatCitation[];
  readonly tools: string[];
  readonly actions: ChatAction[];
  /** Text from the model that cites no source (shown as not from the records). */
  readonly uncited: boolean;
  /** Nothing answered: `answer` names what was searched. */
  readonly miss: boolean;
  /** Whether the reply answers the question (small talk does, a miss or uncited text does not). */
  readonly answered: boolean;
  /** What the miss sentence would say here (what was searched); the MCP answer uses it when the model's text cites nothing. */
  readonly searched: string;
}

/** What a later step changes about the first pass. */
interface Pass {
  /** Search with this query instead of rewriting the question. */
  readonly query?: string;
  /** Steps already shown, which this pass's own lines follow. */
  readonly tools?: readonly string[];
}

/** The most slop-help chunks the chat adds to the board's hits, so a how-to question always has them. */
const HELP_HITS = 3;

const sourceBlock = (hit: SearchHit, n: number): string => {
  const c = hit.citation;
  const state = hit.label === null ? '' : ` (${hit.label})`;
  return `[${n}] ${SOURCE_LABELS[c.source]}: ${c.title}${state}, ${c.date.slice(0, 10)}\n${hit.header}\n${hit.text}`;
};

const oneLine = (s: string, max = 160): string => {
  const first = (s.split('\n')[0] ?? '').trim();
  return first.length > max ? `${first.slice(0, max)}...` : first;
};

const globLine = (g: Glob, relations: readonly Relation[]): string => {
  const run = g.runs[g.runs.length - 1];
  const parts = [
    `${g.id} "${oneLine(g.title, 100)}"`,
    `${g.type} ${g.category}`,
    `status ${g.status} (${listOf(g.status)})`,
  ];
  if (g.group !== null) parts.push(`group ${g.group}`);
  const waits = startIds(relations.filter((r) => r.from === g.id));
  if (waits.length > 0) parts.push(`waiting for ${waits.join(', ')}`);
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
const boardStateText = (globs: readonly Glob[], notifications: readonly BoardNotification[], relations: readonly Relation[]): string => {
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
    const line = globLine(g, relations);
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

const opsStateCitation = (boardId: number, now: string, n: number): ChatCitation => ({
  n,
  source: 'ops_state',
  sourceLabel: 'Slop status',
  title: OPS_STATE_TITLE,
  date: now,
  link: `/boards/${String(boardId)}`,
  globId: null,
  status: 'active',
  supersededBy: null,
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

/** A file the model read through the code view; its source number follows the records' and the board state's. */
interface CodeSource {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

const codeCitation = (file: CodeSource, n: number, now: string): ChatCitation => ({
  n,
  source: 'code',
  sourceLabel: 'Code',
  title: `${file.path}:${String(file.start)}-${String(file.end)}`,
  date: now,
  link: null,
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
      /** The board's code, read through a capped loop of model-chosen calls; without one chat answers from records alone. */
      code?: Pick<CodeViewService, 'tree' | 'read' | 'grep' | 'history' | 'imports'>;
      /**
       * Slop's own health (the facts `/api/health` reports); `admin` is whether the asker is a board admin, who also sees request
       * timing and the outbox. Without it the status source says health is not available. The board's failures and deploys are read here.
       */
      opsHealth?: (admin: boolean) => Promise<OpsHealth>;
      /** Sends an answer to the board's proposal queue (the knowledge service's `submitLearning`). */
      submitLearning?: (email: string, boardId: number, learning: NewLearning) => Promise<Result<{ id: string }>>;
      /** The most extra steps a miss may try (see `CHAT_EXTRA_STEPS`); left out, a miss ends the question as before. */
      extraSteps?: number;
      /** Where a reply the chat could not use is logged. */
      warn?: (message: string) => void;
    },
  ) {}

  /**
   * A question in a conversation (a new one when `chatId` is left out): answered from the board's records, then both
   * turns are stored. `onText` receives the answer as the model writes it; the stored answer is the final one.
   */
  async ask(email: string, request: ChatRequest, onText?: ChatDelta, onProgress?: ChatProgress): Promise<Result<ChatAnswer>> {
    const recent = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, request.boardId);
      if (!actor.ok) return actor;
      if (request.chatId === undefined) return ok<ChatMessage[]>([]);
      const chat = await tx.getChat(request.chatId);
      if (chat?.boardId !== request.boardId || chat.email !== email) return notFound(`No conversation ${String(request.chatId)}`);
      return ok(await tx.listChatMessages(chat.id, RECENT_TURNS));
    });
    if (!recent.ok) return recent;
    const composed = await this.compose(email, request, recent.value, onText, onProgress);
    if (!composed.ok) return composed;
    if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
    const { question, answer, citations, tools, actions, uncited, miss, answered } = composed.value;
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
      const reply = await tx.addChatMessage({ ...base, role: 'assistant', content: answer, citations, tools, actions, ...(uncited ? { uncited } : {}), ...(miss ? { miss } : {}) });
      return ok({ chat, question: asked, reply, answered });
    });
  }

  /** A one-off question (the MCP tool): same retrieval and citations, but no conversation is read or stored. */
  async answer(
    email: string,
    request: ChatRequest,
  ): Promise<Result<{ answer: string; answered: boolean; citations: readonly ChatCitation[]; uncitedAnswer?: string }>> {
    const composed = await this.compose(email, request, []);
    if (!composed.ok) return composed;
    const { answer, citations, uncited, answered, searched } = composed.value;
    // Text that cites nothing is not the records' answer: it is returned apart, so an agent can tell.
    return ok(uncited ? { answer: searched, answered, citations, uncitedAnswer: answer } : { answer, answered, citations });
  }

  private async compose(
    email: string,
    request: ChatRequest,
    recent: readonly ChatMessage[],
    onText?: ChatDelta,
    onProgress?: ChatProgress,
  ): Promise<Result<Composed>> {
    const question = request.question.trim();
    if (question === '') return invalidInput('question must not be empty');
    if (question.length > MAX_QUERY_LENGTH) return invalidInput(`question must be at most ${MAX_QUERY_LENGTH} characters`);
    const first = await this.attempt(email, request, recent, question, {}, onText);
    const budget = Math.min(this.deps.extraSteps ?? 0, CHAT_EXTRA_STEPS);
    if (!first.ok || first.value.answered || budget <= 0) return first;
    return this.moreSteps(email, request, recent, question, first.value, budget, onProgress);
  }

  /**
   * After a first pass that cited nothing, tries within `budget` extra steps, stopping at the first cited answer: a second
   * search (other words, all time), the code, then the stronger model with all of that. Each step is listed in `tools`.
   * A step that fails never fails the question: the best result so far stands.
   */
  private async moreSteps(
    email: string,
    request: ChatRequest,
    recent: readonly ChatMessage[],
    question: string,
    first: Composed,
    budget: number,
    onProgress?: ChatProgress,
  ): Promise<Result<Composed>> {
    let best = first;
    let left = budget;
    let query: string | undefined;
    let step: ChatRequest = { ...request, history: true };
    const run = async (line: string, progress: string): Promise<boolean> => {
      if (request.signal?.aborted === true) return false;
      left -= 1;
      onProgress?.(progress);
      const next = await this.attempt(email, step, recent, question, { ...(query === undefined ? {} : { query }), tools: [...best.tools, line] }).catch(() => null);
      if (next === null || !next.ok) return false;
      best = next.value;
      return next.value.answered;
    };
    const other = await this.otherQuery(request.boardId, question, recent);
    if (left > 0 && (other !== question || request.history !== true)) {
      query = other;
      if (await run(`Searched again with other words, all time included: "${oneLine(other, 80)}"`, 'Searching again…')) return ok(best);
    }
    if (left > 0 && request.lookAtCode !== true && (await this.codeReadable(request.boardId))) {
      step = { ...step, lookAtCode: true };
      if (await run('Looked at the code', 'Looking at the code…')) return ok(best);
    }
    if (left > 0 && request.thinkHarder !== true && this.deps.deepLlm !== undefined) {
      step = { ...step, thinkHarder: true };
      if (await run('Tried the stronger model with everything gathered', 'Thinking harder…')) return ok(best);
    }
    if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
    return ok(best);
  }

  /** A second query for the same question: the rewrite model's other words, else the question's key nouns. */
  private async otherQuery(boardId: number, question: string, recent: readonly ChatMessage[]): Promise<string> {
    const nouns = keyNouns(question);
    const fallback = nouns === '' ? question : nouns;
    const llm = this.deps.rewriteLlm;
    if (llm === undefined) return fallback;
    try {
      const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
      const raw = await completeWithDeadline(
        llm,
        {
          system: REWRITE_ALT_SYSTEM,
          prompt: `${turns === '' ? '' : `Earlier in this conversation:\n${turns}\n\n`}Question: ${question}`,
          maxTokens: REWRITE_MAX_TOKENS,
          spend: { boardId, source: 'chat' },
        },
        this.deps.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS,
      );
      const other = text(field(parseJson(raw), 'query'))?.trim() ?? '';
      return other === '' ? fallback : other.slice(0, MAX_QUERY_LENGTH);
    } catch {
      return fallback;
    }
  }

  /** One pass: search, then answer. `pass.query` skips the rewrite (a later step searching with other words). */
  private async attempt(
    email: string,
    request: ChatRequest,
    recent: readonly ChatMessage[],
    question: string,
    pass: Pass,
    onText?: ChatDelta,
  ): Promise<Result<Composed>> {
    const tools: string[] = [...(pass.tools ?? [])];
    // Obvious small talk skips the rewrite call too; anything else lets that one call classify the message.
    const rewritten =
      pass.query !== undefined
        ? { query: pass.query, smallTalk: false }
        : isSmallTalk(question)
          ? { query: question, smallTalk: true }
          : await this.rewrite(request.boardId, question, recent);
    if (rewritten.smallTalk) return this.smallTalk(question, request, onText);
    const query = rewritten.query;
    if (pass.query === undefined && query !== question) tools.push('Rewrote the question for search');
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
        const found = await this.deps.search.text(email, filters, false);
        if (!found.ok) return found;
        hits = found.value;
      } catch {
        return llmUnavailable('The search did not complete', 'Try again shortly');
      }
    }
    // Slop's own help is indexed on every board; a second search over it alone makes sure a how-to question has it, whatever the records rank above it.
    const helpCount = (hs: readonly SearchHit[]) => hs.filter((h) => h.citation.source === 'slop_help').length;
    const helpHits = await this.searchHelp(email, request.boardId, query, hits);
    hits = [...hits, ...helpHits];
    const helpFound = helpCount(hits);
    const recordsFound = hits.length - helpFound;
    tools.push(`Searched the board's records (${allTime ? 'all time, including history' : 'current'}${request.globId === undefined ? '' : `, ${request.globId} only`}): ${String(recordsFound)} found`);
    if (helpFound > 0) tools.push(`Searched slop's help: ${String(helpFound)} found`);

    // The live state is built from the store, not from search, and goes in every question; it is last so a source
    // number from search keeps its place. With no open globs and no notifications there is nothing to add.
    const state = await this.boardState(request.boardId);
    const stateN = state === '' ? 0 : hits.length + 1;
    if (stateN > 0) tools.push('Read the board\'s live state');
    // Slop's own health and the board's recent failures and deploys go in when the question is about something not working.
    const ops = isOperationalQuestion(question) || isOperationalQuestion(query) ? await this.opsState(email, request.boardId) : '';
    const opsN = ops === '' ? 0 : hits.length + (stateN > 0 ? 1 : 0) + 1;
    if (opsN > 0) tools.push("Checked slop's status (health, recent failures, deploys)");
    const extras = (stateN > 0 ? 1 : 0) + (opsN > 0 ? 1 : 0);
    const page = await this.pageLine(request.boardId, request.page);

    // Chat reads the code only for a board with a repository.
    const codeOn = await this.codeReadable(request.boardId);
    const missFacts = { query, records: recordsFound, help: helpFound, state: stateN > 0 || opsN > 0, codeAvailable: codeOn };
    const deepOffered = request.thinkHarder !== true && this.deps.deepLlm !== undefined;
    // A true miss names what was searched and offers what could still help; the model never asks for these buttons.
    const miss = (codeLooked: boolean): Composed => {
      const searched = chatMissText({ ...missFacts, codeLooked });
      const offered: ChatAction[] = [
        ...(deepOffered ? (['think_harder'] as const) : []),
        ...(codeOn && request.lookAtCode !== true ? (['look_at_code'] as const) : []),
        'create_glob',
      ];
      return { question, answer: searched, citations: [], tools, actions: offered, uncited: false, miss: true, answered: false, searched };
    };
    // With nothing to show the model (no hits, no live state, no code view) the model is not called: there is nothing to answer from.
    if (hits.length === 0 && stateN === 0 && opsN === 0 && !codeOn) return ok(miss(false));
    const deep = request.thinkHarder === true && this.deps.deepLlm !== undefined;
    if (deep) tools.push('Thought harder (stronger model)');
    const llm = deep && this.deps.deepLlm !== undefined ? this.deps.deepLlm : this.deps.llm;
    const lookHint = codeOn && request.lookAtCode === true ? '\n\nThe person asked you to look at the code: use the code view before you answer.' : '';
    const llmRequest: Omit<LlmRequest, 'signal'> = { system: SYSTEM + (codeOn ? codeInstructions(CHAT_CODE_MAX_CALLS) + lookHint : NO_CODE_INSTRUCTIONS), prompt: this.prompt(question, hits, state, ops, recent, page), maxTokens: CHAT_MAX_TOKENS, spend: { boardId: request.boardId, source: 'chat' } };
    const timeout = deep ? (this.deps.deepTimeoutMs ?? CHAT_THINK_TIMEOUT_MS) : (this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS);
    let raw: string;
    const read: CodeSource[] = [];
    const toolsBefore = tools.length;
    try {
      raw = codeOn
        ? await this.generateWithCode(email, request, llm, llmRequest, timeout, hits.length + extras, read, tools, onText)
        : await this.generate(llm, llmRequest, timeout, onText === undefined ? undefined : withoutActionsTag(onText), request.signal);
    } catch (error) {
      if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      // Throttling and timeouts are ordinary errors from the adapter: nothing the asker did wrong, and it passes.
      return llmUnavailable('The model did not answer', 'Try again shortly');
    }
    const codeLooked = tools.length > toolsBefore;
    const parsed = parseActions(raw);
    const text = parsed.text;
    // A number outside 1..n is the model's invention: dropped, never linked.
    const total = hits.length + extras + read.length;
    const used = citedNumbers(text).filter((n) => n >= 1 && n <= total);
    if (text.startsWith(CHAT_NO_CODE)) {
      // The question needed the code and it could not be read: said as it is, with no sources.
      tools.push("Couldn't read the code");
      return ok({ question, answer: CHAT_NO_CODE, citations: [], tools, actions: [], uncited: false, miss: false, answered: true, searched: CHAT_NO_CODE });
    }
    // A model that still asks for the code after its looks ran out has said nothing: that is a miss, not an answer.
    if (text === '' || text.startsWith(CHAT_DONT_KNOW) || parseCodeCall(text) !== null) {
      if (text === '') {
        this.deps.warn?.(`chat: unusable reply on board ${String(request.boardId)} (${String(hits.length)} hits, empty): ${raw.slice(0, LOG_REPLY_CHARS)}`);
      }
      return ok(miss(codeLooked));
    }
    if (used.length === 0) {
      // Text that uses no source is kept, but shown (and returned) as not from the records. No buttons: there is nothing cited to act on.
      this.deps.warn?.(`chat: reply without a source on board ${String(request.boardId)} (${String(hits.length)} hits): ${raw.slice(0, LOG_REPLY_CHARS)}`);
      return ok({ question, answer: text, citations: [], tools, actions: [], uncited: true, miss: false, answered: false, searched: chatMissText({ ...missFacts, codeLooked }) });
    }
    const citations: ChatCitation[] = [];
    const seen = new Set<number>();
    const cited: SearchHit[] = [];
    for (const n of [...used].sort((a, b) => a - b)) {
      if (n === stateN) {
        citations.push(boardStateCitation(request.boardId, this.deps.clock.now(), n));
        continue;
      }
      if (n === opsN) {
        citations.push(opsStateCitation(request.boardId, this.deps.clock.now(), n));
        continue;
      }
      const file = read[n - hits.length - extras - 1];
      if (file !== undefined) {
        citations.push(codeCitation(file, n, this.deps.clock.now()));
        continue;
      }
      const hit = hits[n - 1];
      if (hit === undefined || seen.has(hit.itemId)) continue;
      seen.add(hit.itemId);
      citations.push(citationOf(hit, n));
      cited.push(hit);
    }
    // A choice the answer cites was returned to chat: counted once per answer, on the glob the question is about.
    await this.deps.store.transaction((tx) => this.deps.search.recordUse(tx, request.boardId, cited, request.globId ?? null));
    return ok({ question, answer: text, citations, tools, actions: citations.length === 0 ? [] : parsed.actions, uncited: false, miss: false, answered: citations.length > 0, searched: '' });
  }

  /** The best slop-help chunks for a query that the board's own hits don't already hold; a failed search adds none. */
  private async searchHelp(email: string, boardId: number, query: string, have: readonly SearchHit[]): Promise<SearchHit[]> {
    try {
      const found = await this.deps.search.board(email, { boardId, query, mode: 'all_time', sourceTypes: ['slop_help'] });
      if (!found.ok) return [];
      const key = (h: SearchHit) => `${String(h.itemId)}|${h.header}`;
      const held = new Set(have.map(key));
      return found.value.hits.filter((h) => !held.has(key(h))).slice(0, HELP_HITS);
    } catch {
      return [];
    }
  }

  /** True when the board has a repository and chat has a code view to read it with. */
  private async codeReadable(boardId: number): Promise<boolean> {
    if (this.deps.code === undefined) return false;
    try {
      const board = await this.deps.store.transaction((tx) => tx.getBoard(boardId));
      return board?.repo != null && board.repo !== '';
    } catch {
      return false;
    }
  }

  /**
   * The answering call with a capped code loop: the model may ask for code-view calls (`parseCodeCall`), each result is
   * fed back with the others, and the loop ends on an answer or after `CHAT_CODE_MAX_CALLS` calls. One deadline covers the
   * whole loop and the person's stop ends it; only a turn that is an answer streams. Files read are added to `read`.
   */
  private async generateWithCode(
    email: string,
    request: ChatRequest,
    llm: Llm,
    base: Omit<LlmRequest, 'signal'>,
    timeoutMs: number,
    sourceCount: number,
    read: CodeSource[],
    tools: string[],
    onText?: ChatDelta,
  ): Promise<string> {
    const started = Date.now();
    const looked: string[] = [];
    for (let calls = 0; ; calls++) {
      const spent = calls >= CHAT_CODE_MAX_CALLS;
      const prompt = [
        base.prompt,
        looked.length === 0 ? '' : `Code you have looked at:\n${looked.join('\n\n')}`,
        spent ? 'You may not look at the code any more: answer now.' : '',
      ]
        .filter((part) => part !== '')
        .join('\n\n');
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      const raw = await this.generate(llm, { ...base, prompt }, remaining, onText === undefined ? undefined : withoutCodeRequests(withoutActionsTag(onText)), request.signal);
      const call = spent ? null : parseCodeCall(raw);
      if (call === null) return raw;
      if ('problem' in call) {
        looked.push(`That request could not be made: ${call.problem}`);
        continue;
      }
      looked.push(await this.lookAtCode(email, request.boardId, call, sourceCount, read, tools));
    }
  }

  /** One code-view call for the loop: what the model sees of it, and the line for the answer's steps. */
  private async lookAtCode(email: string, board: number, call: ChatCodeCall, sourceCount: number, read: CodeSource[], tools: string[]): Promise<string> {
    const code = this.deps.code;
    if (code === undefined) return 'The code is not available.';
    const cut = (s: string): string => (s.length > CODE_OBSERVATION_CHARS ? `${s.slice(0, CODE_OBSERVATION_CHARS)}\n(cut)` : s);
    const where = (path: string): string => (path === '' ? '(root)' : path);
    try {
      switch (call.tool) {
        case 'tree': {
          const found = await code.tree(email, { board, path: call.path, consumer: CODE_CONSUMER });
          if (!found.ok) return `tree ${where(call.path)}: ${found.error.message}`;
          const { entries } = found.value;
          tools.push(`Listed ${where(call.path)}: ${String(entries.length)} entries`);
          return cut(`tree ${where(call.path)}:\n${entries.slice(0, CODE_LIST_LINES).map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('\n')}`);
        }
        case 'grep': {
          const found = await code.grep(email, { board, pattern: call.pattern, paths: call.paths, limit: 30, consumer: CODE_CONSUMER });
          if (!found.ok) return `grep ${call.pattern}: ${found.error.message}`;
          const { hits } = found.value;
          tools.push(`Searched the code for ${oneLine(call.pattern, 60)}: ${String(hits.length)} hits`);
          return cut(`grep ${call.pattern}:\n${hits.map((h) => `${h.path}:${String(h.line)}:${h.text.slice(0, 160)}`).join('\n') || 'no matches'}`);
        }
        case 'read': {
          const found = await code.read(email, { board, path: call.path, ...(call.start === undefined ? {} : { start: call.start }), ...(call.end === undefined ? {} : { end: call.end }), consumer: CODE_CONSUMER });
          if (!found.ok) return `read ${call.path}: ${found.error.message}`;
          const file = found.value;
          if (file.binary) return `read ${call.path}: a binary file`;
          read.push({ path: file.path, start: file.startLine, end: file.endLine });
          tools.push(`Read ${file.path}:${String(file.startLine)}-${String(file.endLine)}`);
          return cut(`[${String(sourceCount + read.length)}] ${file.path}:${String(file.startLine)}-${String(file.endLine)} of ${String(file.totalLines)} lines${file.truncated ? ' (cut)' : ''}\n${file.content}`);
        }
        case 'history': {
          const found = await code.history(email, { board, path: call.path, limit: 10, consumer: CODE_CONSUMER });
          if (!found.ok) return `history ${call.path}: ${found.error.message}`;
          tools.push(`Looked up the history of ${call.path}: ${String(found.value.length)} commits`);
          return cut(`history ${call.path}:\n${found.value.map((c) => `${c.sha.slice(0, 7)} ${c.date.slice(0, 10)} ${oneLine(c.subject, 100)}${c.globId === null ? '' : ` (${c.globId})`}`).join('\n') || 'no commits'}`);
        }
        case 'imports': {
          const found = await code.imports(email, { board, path: call.path, direction: call.direction, consumer: CODE_CONSUMER });
          if (!found.ok) return `imports ${call.path}: ${found.error.message}`;
          tools.push(`Looked up ${call.direction === 'importedBy' ? 'what imports' : 'what is imported by'} ${call.path}: ${String(found.value.length)} files`);
          return cut(`${call.direction} ${call.path}:\n${found.value.map((r) => r.path).join('\n') || 'none'}`);
        }
      }
    } catch {
      return `${call.tool}: the code could not be read.`;
    }
  }

  /** A greeting or a question about the chat: one short model call with no search, no sources and no actions. */
  private async smallTalk(
    question: string,
    request: ChatRequest,
    onText?: ChatDelta,
  ): Promise<Result<Composed>> {
    const page = await this.pageLine(request.boardId, request.page);
    const prompt = `${question}${page === '' ? '' : `\n\n${page}`}`;
    let raw: string;
    try {
      raw = await this.generate(this.deps.llm, { system: SMALL_TALK_SYSTEM, prompt, maxTokens: SMALL_TALK_MAX_TOKENS, spend: { boardId: request.boardId, source: 'chat' } }, this.deps.llmTimeoutMs ?? CHAT_LLM_TIMEOUT_MS, onText, request.signal);
    } catch (error) {
      if (request.signal?.aborted === true) return invalidInput('The answer was stopped');
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      return llmUnavailable('The model did not answer', 'Try again shortly');
    }
    const answer = raw.trim();
    return ok({ question, answer: answer === '' ? 'Hello! Ask me about this board.' : answer, citations: [], tools: [], actions: [], uncited: false, miss: false, answered: true, searched: '' });
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
  private async rewrite(boardId: number, question: string, recent: readonly ChatMessage[]): Promise<{ query: string; smallTalk: boolean }> {
    const llm = this.deps.rewriteLlm;
    if (llm === undefined) return { query: question, smallTalk: false };
    try {
      const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
      const raw = await completeWithDeadline(
        llm,
        {
          system: REWRITE_SYSTEM,
          prompt: `${turns === '' ? '' : `Earlier in this conversation:\n${turns}\n\n`}Question: ${question}`,
          maxTokens: REWRITE_MAX_TOKENS,
          spend: { boardId, source: 'search' },
        },
        this.deps.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS,
      );
      const json = parseJson(raw);
      const rewritten = text(field(json, 'query'))?.trim() ?? '';
      return { query: rewritten === '' ? question : rewritten.slice(0, MAX_QUERY_LENGTH), smallTalk: field(json, 'smallTalk') === true };
    } catch {
      return { query: question, smallTalk: false };
    }
  }

  /**
   * Slop's status as one source: the server's health plus this board's recent failures and deploys, read by board so another
   * board's globs cannot appear. A failure to read any of it leaves the source out; it never fails the question.
   */
  private async opsState(email: string, boardId: number): Promise<string> {
    try {
      const board = await this.deps.store.transaction(async (tx) => {
        const actor = await memberOf(tx, email, boardId);
        if (!actor.ok) return null;
        // Request timing and the outbox are admin-only (stricter than /api/health, which gates them on any board's admin role).
        return { admin: actor.value.role === 'admin', globs: await tx.listGlobs(boardId, {}), notifications: await tx.listNotifications(boardId), deploys: await tx.listDeploys(boardId, { limit: 20 }) };
      });
      if (board === null) return '';
      let health: OpsHealth | null = null;
      try {
        health = (await this.deps.opsHealth?.(board.admin)) ?? null;
      } catch {
        // Health is context only: the failures and deploys still answer.
      }
      return opsStateText({ health, globs: board.globs, deploys: board.deploys, notifications: board.notifications, now: this.deps.clock.now() });
    } catch {
      return '';
    }
  }

  private async boardState(boardId: number): Promise<string> {
    try {
      return await this.deps.store.transaction(async (tx) =>
        boardStateText(await tx.listGlobs(boardId, {}), await tx.listNotifications(boardId), await tx.listRelations(boardId)),
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
    if (reply.miss === true || reply.content === CHAT_DONT_KNOW) return invalidInput('There is nothing to save: the board had no answer');
    if (reply.uncited === true) return invalidInput('There is nothing to save: the answer is not from the board\'s records');
    const sourceGlobId = reply.citations?.find((c) => c.globId !== null)?.globId ?? pageGlobId;
    if (sourceGlobId === undefined) return invalidInput('This answer cites no glob; open a glob and save from there');
    const sources = (reply.citations ?? []).map((c) => `[${String(c.n)}] ${c.sourceLabel}: ${c.title} (${c.date.slice(0, 10)})`).join('\n');
    return submit(email, boardId, {
      sourceGlobId,
      type: 'pattern',
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

  private prompt(question: string, hits: readonly SearchHit[], state: string, ops: string, recent: readonly ChatMessage[], page: string): string {
    const turns = recent.map((m) => `${m.role === 'user' ? 'Asker' : 'Assistant'}: ${clip(m.content)}`).join('\n');
    return [
      'Sources:',
      [
        ...hits.map((hit, i) => sourceBlock(hit, i + 1)),
        ...(state === '' ? [] : [`[${hits.length + 1}] ${BOARD_STATE_TITLE}\n${state}`]),
        ...(ops === '' ? [] : [`[${hits.length + (state === '' ? 0 : 1) + 1}] ${OPS_STATE_TITLE}\n${ops}`]),
      ].join('\n\n'),
      turns === '' ? '' : `Earlier in this conversation:\n${turns}`,
      page,
      `Question: ${question}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
  }
}
