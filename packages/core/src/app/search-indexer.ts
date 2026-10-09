import { chunkDocument, contentHash } from '../domain/chunking.js';
import type { ChunkInput } from '../domain/chunking.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { parseFrontmatter } from '../domain/knowledge.js';
import type { Artifact, ArtifactKind } from '../domain/knowledge.js';
import { SOURCE_TYPES } from '../domain/search.js';
import type { AuthorityTier, KnowledgeItem, NewChunk, NewKnowledgeItem, SourceType } from '../domain/search.js';
import type { Board, Glob } from '../domain/types.js';
import type { ChangeSource, Clock, Embedder, Store, Tx } from '../ports.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { LLM_TIMEOUT_MS, LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from './kb-pipeline.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { hash } from './text-hash.js';

/** Chunks embedded per call to the embedder (and per `processNext` step). */
export const EMBED_BATCH = 32;
/** How long a claimed summary is held before another worker may take it. */
const LEASE_MS = 5 * 60_000;
const backoffMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
/** After an embedding error that isn't "unavailable" (throttling, a bad response), how long embedding rests. */
const EMBED_BACKOFF_MS = 30_000;
/** One source text is indexed up to this many characters (an attachment can be a whole log). */
const TEXT_LIMIT = 100_000;
/** The files line of a change is cut here, so it stays one chunk with its summary. */
const FILES_LINE_LIMIT = 1_500;
const PLAN_PROMPT_LIMIT = 6_000;
const SUMMARY_MAX_TOKENS = 400;
const SINCE_ALWAYS = '1970-01-01T00:00:00.000Z';

export const CHANGE_SUMMARY_SYSTEM = `You write one short note for a software project's search index, saying why a change was made, from the plan of the work and the files the change touched.

Rules:
- At most 150 words of plain prose, no headings or lists.
- Say what the change was for and which areas it touched.
- Don't invent anything the plan and the file list don't support. If the plan gives no reason, say that, and say what the files suggest.`;

/** What one source item needs to be indexed: its facts and its text, before chunking. */
interface Desired {
  readonly sourceType: SourceType;
  readonly externalRef: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly authority: AuthorityTier;
  readonly globIds: readonly string[];
  readonly globGroup: string | null;
  readonly externalUrl: string | null;
  readonly text: string;
}

const globLink = (boardId: number, globId: string) => `/boards/${String(boardId)}?glob=${encodeURIComponent(globId)}`;

/** The hash that decides re-indexing: the chunked content plus the metadata filters and citations use. */
const itemHash = (d: Desired): string => {
  const input: ChunkInput = { sourceType: d.sourceType, date: d.occurredAt, title: d.title, text: d.text };
  return hash([contentHash(input), d.authority, d.globIds.join(','), d.globGroup ?? '', d.externalUrl ?? ''].join('|'));
};

const itemOf = (boardId: number, d: Desired, state: NewKnowledgeItem['state'] = 'ready'): NewKnowledgeItem => ({
  boardId,
  sourceType: d.sourceType,
  externalRef: d.externalRef,
  title: d.title,
  occurredAt: d.occurredAt,
  authority: d.authority,
  status: 'active',
  supersededBy: null,
  globIds: d.globIds,
  globGroup: d.globGroup,
  externalUrl: d.externalUrl,
  contentHash: itemHash(d),
  state,
});

const chunksOf = (d: Desired): NewChunk[] =>
  chunkDocument({ sourceType: d.sourceType, date: d.occurredAt, title: d.title, text: d.text });

/** The artifact kinds as search sources; a super's implementation plan is its decision log (spec). */
const artifactSource = (kind: ArtifactKind, glob: Glob): SourceType => {
  switch (kind) {
    case 'plan':
      return 'glob_plan';
    case 'implementation_plan':
      return glob.type === 'super' ? 'decision_log' : 'implementation_plan';
    case 'postplan':
      return 'postplan';
    case 'local_review':
      return 'local_review';
    case 'attachment':
      return 'attachment';
  }
};

const authorityOf = (source: SourceType): AuthorityTier => {
  switch (source) {
    case 'change_summary':
    case 'postplan':
      return 'merged_code';
    case 'local_review':
    case 'attachment':
    case 'code_review':
      return 'discussion';
    case 'glob_plan':
    case 'glob_summary':
    case 'implementation_plan':
    case 'decision_log':
    case 'kb_doc':
    case 'learning':
      return 'approved_plan';
  }
};

const firstLine = (text: string, max: number): string => {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const filesLine = (files: readonly string[]): string => {
  let line = 'Files: ';
  let shown = 0;
  for (const file of files) {
    const next = shown === 0 ? file : `, ${file}`;
    if (line.length + next.length > FILES_LINE_LIMIT) break;
    line += next;
    shown++;
  }
  return shown < files.length ? `${line}, +${String(files.length - shown)} more` : line;
};

/**
 * The search index builder (spec, Knowledge and context). The index is derived: `syncBoard` reads the board's
 * existing material (glob summaries and plans, artifacts, CodeRabbit items, KB documents, approved learnings, merged
 * changes), writes one item per source with a content hash, and re-chunks only what changed, so the first run is the
 * backfill and every later run is cheap and idempotent. Chunks are keyword-searchable the moment they are written;
 * `processNext` then writes each merged change's "why" (one cheap model call) and embeds chunks for semantic search.
 * When a model is unavailable, items wait (nothing is failed, no attempt counted) and keep what they already have.
 */
export class SearchIndexer {
  private readonly busy = new BusyBackoff();

  /** While the embedder is down or backing off, embedding is skipped until this time (ms). */
  private embedWaitUntil = 0;

  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      embedder: Embedder;
      changes: ChangeSource;
      /** Writes the "why" of merged changes. */
      llm: Llm;
      /** Deadline for each model call; defaults to LLM_TIMEOUT_MS. */
      llmTimeoutMs?: number;
    },
  ) {}

  /** Brings every board's index up to date; boards that fail don't stop the others (the first error is rethrown after). */
  async syncAll(): Promise<void> {
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    let failure: Error | null = null;
    for (const board of boards) {
      try {
        await this.syncBoard(board.id);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure !== null) throw failure;
  }

  /** Brings one board's index up to date with its sources; returns what it wrote. */
  async syncBoard(boardId: number): Promise<{ written: number; removed: number; queued: number }> {
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return { written: 0, removed: 0, queued: 0 };
      const hashes = await tx.itemHashes(boardId);
      const desired = await this.desired(tx, board);
      let written = 0;
      for (const d of desired) {
        const item = itemOf(boardId, d);
        if (hashes.get(d.externalRef) === item.contentHash) continue;
        await tx.replaceItem(item, chunksOf(d));
        written++;
      }
      const queued = await this.queueChanges(tx, board, hashes);
      let removed = 0;
      for (const sourceType of SOURCE_TYPES) {
        const refs = new Set(desired.filter((d) => d.sourceType === sourceType).map((d) => d.externalRef));
        if (sourceType === 'change_summary') for (const ref of await this.changeRefs(tx, boardId)) refs.add(ref);
        removed += await tx.deleteItemsNotIn(boardId, sourceType, refs);
      }
      return { written, removed, queued };
    });
  }

  /**
   * One step of background work: writes the "why" of one merged change that is due, else embeds one batch of chunks.
   * Returns what it did (a change's ref, or `embed`), or null when nothing is due (or embedding is resting).
   */
  async processNext(): Promise<string | null> {
    const now = this.deps.clock.now();
    const claimed = await this.deps.store.transaction(async (tx) => {
      const item = await tx.nextItemToSummarise(now);
      if (item === null) return null;
      await tx.setItemProgress(item.id, { attempts: item.attempts, processAfter: this.later(now, LEASE_MS), lastError: item.lastError });
      return item;
    });
    if (claimed !== null) {
      await this.summarise(claimed);
      return claimed.externalRef;
    }
    return this.embedBatch(now);
  }

  private async embedBatch(now: string): Promise<string | null> {
    if (Date.parse(now) < this.embedWaitUntil) return null;
    const chunks = await this.deps.store.transaction((tx) => tx.chunksToEmbed(EMBED_BATCH));
    if (chunks.length === 0) return null;
    try {
      const vectors = await this.deps.embedder.embed(chunks.map((c) => `${c.header}\n${c.text}`));
      const rows = chunks.flatMap((c, i) => {
        const embedding = vectors[i];
        return embedding === undefined ? [] : [{ id: c.id, embedding }];
      });
      await this.deps.store.transaction((tx) => tx.setEmbeddings(rows));
      this.busy.clear('embed');
    } catch (error) {
      // The chunks stay as they are (keyword-searchable, no embedding) and are tried again later.
      this.embedWaitUntil =
        Date.parse(now) + (error instanceof LlmBusy ? this.busy.next('embed') : error instanceof LlmUnavailable ? LLM_WAIT_MS : EMBED_BACKOFF_MS);
      if (error instanceof LlmUnavailable) return 'embed';
      throw error;
    }
    return 'embed';
  }

  /** Items the sources call for, as they should be indexed now (changes aside: their text is generated). */
  private async desired(tx: Tx, board: Board): Promise<Desired[]> {
    const globs = await tx.listGlobs(board.id, {});
    const byId = new Map(globs.map((g) => [g.id, g]));
    const out: Desired[] = [];
    const push = (d: Desired) => {
      const text = d.text.trim().slice(0, TEXT_LIMIT);
      if (text !== '') out.push({ ...d, text });
    };
    for (const glob of globs) {
      push({
        sourceType: 'glob_summary',
        externalRef: `glob:${glob.id}:summary`,
        title: `${glob.id} ${glob.title}`,
        occurredAt: glob.createdAt,
        authority: authorityOf('glob_summary'),
        globIds: [glob.id],
        globGroup: glob.group,
        externalUrl: globLink(board.id, glob.id),
        text: glob.summary,
      });
    }
    for (const artifact of await tx.listLatestArtifacts(board.id)) {
      const glob = byId.get(artifact.globId);
      if (glob === undefined) continue;
      push(this.artifactItem(board.id, glob, artifact));
    }
    const comments = globs.length === 0 ? [] : await tx.listCodeReviewComments(board.id, globs.map((g) => g.id));
    for (const c of comments) {
      const glob = byId.get(c.globId);
      push({
        sourceType: 'code_review',
        externalRef: `review:${c.externalId}`,
        title: `${c.globId} ${c.kind}${c.path === null ? '' : ` on ${c.path}`}`,
        occurredAt: c.createdAt,
        authority: authorityOf('code_review'),
        globIds: [c.globId],
        globGroup: glob?.group ?? null,
        externalUrl: c.url ?? globLink(board.id, c.globId),
        text: c.body,
      });
    }
    for (const doc of await tx.listKnowledge(board.id, ['doc'])) {
      push({
        sourceType: 'kb_doc',
        externalRef: `kb:${doc.name}`,
        title: doc.name,
        occurredAt: doc.updatedAt,
        authority: authorityOf('kb_doc'),
        globIds: [],
        globGroup: null,
        externalUrl: `/boards/${String(board.id)}/knowledge`,
        text: parseFrontmatter(doc.content).body,
      });
    }
    for (const item of await tx.listKbItems(board.id, 'approved')) {
      // A whole-document proposal became a knowledge document; its text is indexed as that.
      if (item.document !== null) continue;
      push({
        sourceType: 'learning',
        externalRef: `learning:${item.id}`,
        title: firstLine(item.statement, 80),
        occurredAt: item.decidedAt ?? item.createdAt,
        authority: authorityOf('learning'),
        // Only globs still on the board: a deleted glob's link is dropped with it.
        globIds: item.sourceGlobIds.filter((id) => byId.has(id)),
        globGroup: null,
        externalUrl: `/boards/${String(board.id)}/knowledge`,
        text: `${item.statement}\n\nEvidence: ${item.evidence}`,
      });
    }
    return out;
  }

  private artifactItem(boardId: number, glob: Glob, artifact: Artifact): Desired {
    const sourceType = artifactSource(artifact.kind, glob);
    return {
      sourceType,
      externalRef: `artifact:${glob.id}:${artifact.kind}:${artifact.label}`,
      title: artifact.label === '' ? `${glob.id} ${glob.title}` : `${glob.id} ${glob.title}: ${artifact.label}`,
      occurredAt: artifact.createdAt,
      authority: authorityOf(sourceType),
      globIds: [glob.id],
      globGroup: glob.group,
      externalUrl: artifact.link ?? globLink(boardId, glob.id),
      text: artifact.content,
    };
  }

  /** The merge commits recorded for the board's globs: one `change:<sha>` ref each. */
  private async mergeEvents(tx: Tx, boardId: number) {
    const events = await tx.listBoardEvents(boardId, SINCE_ALWAYS, ['Merged']);
    return events.flatMap((event) => {
      const sha = event.data.sha;
      return typeof sha === 'string' && sha !== '' ? [{ event, sha }] : [];
    });
  }

  private async changeRefs(tx: Tx, boardId: number): Promise<string[]> {
    return (await this.mergeEvents(tx, boardId)).map(({ sha }) => `change:${sha}`);
  }

  /**
   * Adds an item, awaiting its summary, for each merge not indexed yet. Its title alone is searchable meanwhile. Not
   * hash-compared afterwards: a generated summary is written once.
   */
  private async queueChanges(tx: Tx, board: Board, hashes: ReadonlyMap<string, string>): Promise<number> {
    let queued = 0;
    for (const { event, sha } of await this.mergeEvents(tx, board.id)) {
      const ref = `change:${sha}`;
      if (hashes.has(ref)) continue;
      const glob = await tx.getGlob(event.globId);
      if (glob === null) continue;
      const d: Desired = {
        sourceType: 'change_summary',
        externalRef: ref,
        title: `${glob.id} ${glob.title}`,
        occurredAt: event.at,
        authority: authorityOf('change_summary'),
        globIds: [glob.id],
        globGroup: glob.group,
        externalUrl: board.repo === null ? globLink(board.id, glob.id) : `https://github.com/${board.repo}/commit/${sha}`,
        text: `Merged change for ${glob.id}: ${glob.title}.`,
      };
      await tx.replaceItem(itemOf(board.id, d, 'pending_summary'), chunksOf(d));
      queued++;
    }
    return queued;
  }

  /** Writes a pending change's "why"; the model being unavailable makes it wait, other failures retry with backoff. */
  private async summarise(item: KnowledgeItem): Promise<void> {
    const now = this.deps.clock.now();
    const sha = item.externalRef.slice('change:'.length);
    const context = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(item.boardId);
      const glob = await tx.getGlob(item.globIds[0] ?? '');
      const plan = glob === null ? undefined : (await tx.listArtifacts(glob.id, 'plan'))[0];
      return { board, glob, plan: plan?.content ?? '' };
    });
    let files: readonly string[] | null = null;
    try {
      const diff = context.board === null ? null : await this.deps.changes.mergedDiff(context.board, sha);
      files = diff?.files ?? null;
      const answer = await completeWithDeadline(
        this.deps.llm,
        {
          system: CHANGE_SUMMARY_SYSTEM,
          prompt: summaryPrompt(item.title, context.glob?.summary ?? '', context.plan, diff),
          maxTokens: SUMMARY_MAX_TOKENS,
        },
        this.deps.llmTimeoutMs ?? LLM_TIMEOUT_MS,
      );
      const summary = answer.trim();
      if (summary === '') throw new Error('The model wrote no summary');
      await this.finish(item, files, summary, null);
    } catch (error) {
      if (error instanceof LlmUnavailable) {
        const processAfter = this.later(now, error instanceof LlmBusy ? this.busy.next(item.id) : LLM_WAIT_MS);
        const lastError = error instanceof LlmBusy ? busyMessage(processAfter) : `${LLM_WAITING_PREFIX}${error.reason}`;
        await this.deps.store.transaction((tx) =>
          tx.setItemProgress(item.id, { attempts: item.attempts, processAfter, lastError: lastError.slice(0, 500) }),
        );
        return;
      }
      const attempts = item.attempts + 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (attempts >= MAX_PROCESSING_ATTEMPTS) {
        // Given up: the change stays findable by its files (when they were read) and its title.
        await this.finish(item, files, null, message);
        return;
      }
      await this.deps.store.transaction((tx) =>
        tx.setItemProgress(item.id, { attempts, processAfter: this.later(now, backoffMs(attempts)), lastError: message }),
      );
    }
  }

  /** Replaces a pending change with its final chunk (`Files:` line, then the summary when there is one). */
  private async finish(item: KnowledgeItem, files: readonly string[] | null, summary: string | null, error: string | null): Promise<void> {
    const parts = [...(files === null || files.length === 0 ? [] : [filesLine(files)]), ...(summary === null ? [] : [summary])];
    const text = parts.length === 0 ? `Merged change: ${item.title}.` : parts.join('\n\n');
    const d: Desired = {
      sourceType: item.sourceType,
      externalRef: item.externalRef,
      title: item.title,
      occurredAt: item.occurredAt,
      authority: item.authority,
      globIds: item.globIds,
      globGroup: item.globGroup,
      externalUrl: item.externalUrl,
      text,
    };
    await this.deps.store.transaction(async (tx) => {
      await tx.replaceItem({ ...itemOf(item.boardId, d), status: item.status, supersededBy: item.supersededBy }, chunksOf(d));
      // The row keeps its ID, so the give-up reason lands on it (replacing reset the progress).
      if (error !== null) await tx.setItemProgress(item.id, { attempts: item.attempts + 1, processAfter: null, lastError: error });
    });
  }

  private later(now: string, ms: number): string {
    return new Date(Date.parse(now) + ms).toISOString();
  }
}

const summaryPrompt = (
  title: string,
  summary: string,
  plan: string,
  diff: { readonly changedLines: number; readonly files: readonly string[] } | null,
): string =>
  [
    `Change: ${title}`,
    summary.trim() === '' ? '' : `Task summary: ${summary.trim()}`,
    '',
    `Plan:\n<<<\n${plan.trim() === '' ? '(none)' : plan.slice(0, PLAN_PROMPT_LIMIT)}\n>>>`,
    '',
    diff === null
      ? 'Files changed: unknown (the repository could not be read).'
      : `Files changed (${String(diff.changedLines)} lines):\n${diff.files.slice(0, 60).join('\n')}`,
  ].join('\n');
