import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { MAX_QUERY_LENGTH, matchesFilters, rankCandidates, rrfFuse, toHit, withinBudget } from '../domain/search.js';
import type { Candidate, SearchHit, SearchMode, SearchQuery } from '../domain/search.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Embedder, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import { LlmUnavailable } from './intake-service.js';

/** Candidates fetched per arm before ranking trims them to the result budget. */
const POOL = 50;
/** `related` fetches deeper because the glob's own items are dropped afterwards. */
const RELATED_POOL = 30;
export const RELATED_LIMIT = 5;
/** How many current decisions `related` puts first, before the other hits. */
export const RELATED_DECISIONS = 3;
/** `get_context` must stay quick when the embedder is slow: past this the related section is keyword-only. */
const RELATED_EMBED_TIMEOUT_MS = 5_000;

/** What a caller asks for; `mode` defaults to `current`. */
export type SearchRequest = Omit<SearchQuery, 'mode'> & { readonly mode?: SearchMode };

export interface BoardSearch {
  readonly hits: readonly SearchHit[];
  /** `unavailable`: the embedder is down, so these are keyword results only. */
  readonly semantic: 'ok' | 'unavailable';
}

/**
 * The read side of the search store (spec, Knowledge and context): every method checks board membership first, and
 * the candidate queries always filter on the board, so a glob or group filter can't reach another board's material.
 */
export class SearchService {
  constructor(private readonly deps: { store: Store; clock: Clock; embedder: Embedder }) {}

  /** `search_text`: keyword and trigram matches, ranked. */
  async text(email: string, request: SearchRequest): Promise<Result<readonly SearchHit[]>> {
    return this.deps.store.transaction(async (tx) => {
      const q = await this.query(tx, email, request);
      if (!q.ok) return q;
      return ok(this.rank(await tx.keywordCandidates(q.value, POOL), q.value));
    });
  }

  /** `search_semantic`: nearest chunks by meaning; an `llm_unavailable` error while the embedder is down. */
  async semantic(email: string, request: SearchRequest): Promise<Result<readonly SearchHit[]>> {
    const checked = await this.deps.store.transaction((tx) => this.query(tx, email, request));
    if (!checked.ok) return checked;
    // The embedder is a network call, so it runs outside the transaction.
    const embedding = await this.embed(checked.value.query);
    if (embedding instanceof LlmUnavailable) return llmUnavailable(embedding.reason, embedding.fix);
    return this.deps.store.transaction(async (tx) => {
      // Membership could have been removed while the embedder ran.
      const again = await this.query(tx, email, request);
      if (!again.ok) return again;
      return ok(this.rank(await tx.vectorCandidates(again.value, embedding, POOL), again.value));
    });
  }

  /** `search_changes`: merged changes with the reason they were made, newest first, within the date range. */
  async changes(email: string, request: SearchRequest): Promise<Result<readonly SearchHit[]>> {
    return this.deps.store.transaction(async (tx) => {
      const q = await this.query(tx, email, request, true);
      if (!q.ok) return q;
      const candidates = await tx.changeCandidates(q.value, POOL);
      return ok(withinBudget(candidates.map((c) => toHit(c, c.relevance))));
    });
  }

  /** The board search box: keyword and semantic results fused, or keyword alone while the embedder is down. */
  async board(email: string, request: SearchRequest): Promise<Result<BoardSearch>> {
    const checked = await this.deps.store.transaction((tx) => this.query(tx, email, request));
    if (!checked.ok) return checked;
    const embedding = await this.embed(checked.value.query);
    return this.deps.store.transaction(async (tx) => {
      const q = await this.query(tx, email, request);
      if (!q.ok) return q;
      return ok(await this.fuse(tx, q.value, q.value.query, embedding instanceof LlmUnavailable ? null : embedding, POOL));
    });
  }

  /**
   * The related section of `get_context`, inside its transaction (the caller has checked membership): what the board
   * already knows about this glob's title and summary, current mode, without the glob's own items. The keyword arm
   * uses the title alone, because a whole summary as a keyword query would have to match every word of it. Current
   * decisions on the topic come first (up to RELATED_DECISIONS), then the other hits, where a superseded decision
   * appears labelled as history; the glob's own decisions are returned separately (`decisions` of the bundle).
   */
  async related(tx: Tx, glob: Glob): Promise<readonly SearchHit[]> {
    const text = `${glob.title}\n${glob.summary}`.trim().slice(0, MAX_QUERY_LENGTH);
    const q: SearchQuery = { boardId: glob.boardId, query: glob.title, mode: 'current' };
    let embedding: number[] | null = null;
    try {
      const vector = await this.embed(text, AbortSignal.timeout(RELATED_EMBED_TIMEOUT_MS));
      embedding = vector instanceof LlmUnavailable ? null : vector;
    } catch {
      // Related is a bonus on the context bundle: a slow or failing embedder must not fail it.
    }
    const notOwn = (c: Candidate) => !c.globIds.includes(glob.id);
    const current = await this.fuse(tx, { ...q, sourceTypes: ['decision'] }, q.query, embedding, RELATED_POOL, (c) => notOwn(c) && c.status === 'active');
    const first = current.hits.slice(0, RELATED_DECISIONS);
    const { hits } = await this.fuse(tx, q, q.query, embedding, RELATED_POOL, notOwn);
    const seen = new Set(first.map((h) => h.itemId));
    return [...first, ...hits.filter((h) => !seen.has(h.itemId))].slice(0, RELATED_LIMIT);
  }

  private async fuse(
    tx: Tx,
    q: SearchQuery,
    keyword: string,
    embedding: number[] | null,
    pool: number,
    keep: (c: Candidate) => boolean = () => true,
  ): Promise<BoardSearch> {
    const lists = [await tx.keywordCandidates({ ...q, query: keyword }, pool)];
    if (embedding !== null) lists.push(await tx.vectorCandidates(q, embedding, pool));
    const fused = lists.length === 1 ? lists[0] ?? [] : rrfFuse(lists);
    const hits = this.rank(fused.filter(keep), q);
    return { hits, semantic: embedding === null ? 'unavailable' : 'ok' };
  }

  private rank(candidates: readonly Candidate[], q: SearchQuery): SearchHit[] {
    // The store filters too; this keeps every store honest about the filters.
    const allowed = candidates.filter((c) => matchesFilters(c, q));
    return withinBudget(rankCandidates(allowed, q.mode, this.deps.clock.now()));
  }

  /** The query for a request from `email`, or why they can't run it. `blankOk`: a changes listing needs no words. */
  private async query(tx: Tx, email: string, request: SearchRequest, blankOk = false): Promise<Result<SearchQuery>> {
    const actor = await memberOf(tx, email, request.boardId);
    if (!actor.ok) return actor;
    if (!blankOk && request.query.trim() === '') return invalidInput('query must not be empty');
    if (request.query.length > MAX_QUERY_LENGTH) return invalidInput(`query must be at most ${MAX_QUERY_LENGTH} characters`);
    return ok({ ...request, mode: request.mode ?? 'current' });
  }

  /** The query's vector, or why the embedder can't give one right now. */
  private async embed(text: string, signal?: AbortSignal): Promise<number[] | LlmUnavailable> {
    try {
      const [vector] = await this.deps.embedder.embed([text], signal);
      return vector ?? new LlmUnavailable('The embedding model returned no vector', 'Try again shortly');
    } catch (error) {
      if (error instanceof LlmUnavailable) return error;
      throw error;
    }
  }
}
