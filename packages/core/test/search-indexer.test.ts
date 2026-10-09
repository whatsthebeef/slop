import { beforeEach, describe, expect, it } from 'vitest';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import { EMBED_BATCH, SearchIndexer } from '../src/app/search-indexer.js';
import type { Artifact, ArtifactKind } from '../src/domain/knowledge.js';
import { LLM_WAITING_PREFIX, UNPROCESSED } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { SourceType } from '../src/domain/search.js';
import type { Board, Glob } from '../src/domain/types.js';
import type { ChangeSource } from '../src/ports.js';
import { FakeEmbedder } from '../src/testing/fake-embedder.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const START = '2026-10-05T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

class FakeLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answers: (string | Error)[] = []) {}
  answer(...answers: (string | Error)[]): void {
    this.answers.push(...answers);
  }
  complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

class FakeChanges implements ChangeSource {
  diff: { changedLines: number; files: string[] } | null = { changedLines: 42, files: ['src/sync/retry.ts', 'src/sync/queue.ts'] };
  readonly calls: string[] = [];
  mergedDiff(_board: Board, sha: string) {
    this.calls.push(sha);
    return Promise.resolve(this.diff);
  }
}

const SHA = 'abcdef0123456789';

describe('SearchIndexer', () => {
  let store: MemoryStore;
  let embedder: FakeEmbedder;
  let llm: FakeLlm;
  let changes: FakeChanges;
  let indexer: SearchIndexer;
  let now: string;
  let boardId: number;

  const items = () => [...store.state.searchItems.values()];
  const byRef = (ref: string) => {
    const found = items().find((i) => i.externalRef === ref);
    if (found === undefined) throw new Error(`No item ${ref}`);
    return found;
  };
  const chunksOf = (ref: string) => store.state.searchChunks.filter((c) => c.itemId === byRef(ref).id);

  const addGlob = async (patch: Partial<Glob> = {}) => {
    const g = makeGlob({ boardId, ...patch });
    await store.transaction((tx) => tx.insertGlob(g, null));
    return g;
  };
  const addArtifact = (globId: string, kind: ArtifactKind, content: string, label = ''): Promise<Artifact> =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind,
        label,
        content,
        link: null,
        commitSha: null,
        provenance: { by: 'sessionator', actor: 'dev@example.com', runId: null, agentSetVersion: null },
        createdAt: now,
      }),
    );
  const merge = (globId: string, sha = SHA) =>
    store.transaction((tx) => tx.appendEvents([{ type: 'Merged', globId, actor: null, at: now, data: { sha } }]));

  beforeEach(async () => {
    store = new MemoryStore();
    embedder = new FakeEmbedder();
    llm = new FakeLlm();
    changes = new FakeChanges();
    now = START;
    indexer = new SearchIndexer({ store, clock: { now: () => now }, embedder, changes, llm });
    boardId = (
      await store.transaction((tx) =>
        tx.insertBoard({ name: 'demo', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] }),
      )
    ).id;
  });

  /** One of every source on the board. */
  const populate = async () => {
    const task = await addGlob({ id: 's1t1', title: 'Sync retries', summary: 'Retry failed syncs three times.', group: 'sync' });
    const sup = await addGlob({ id: 's1f2', title: 'Billing rework', type: 'super', category: 'feature', summary: 'Rework billing.' });
    await addArtifact(task.id, 'plan', '## Approach\n\nRetry with backoff.');
    await addArtifact(task.id, 'implementation_plan', 'Change the job runner.');
    await addArtifact(sup.id, 'implementation_plan', 'Decision: use invoices.');
    await addArtifact(task.id, 'postplan', 'Shipped the retry.');
    await addArtifact(task.id, 'local_review', 'Looks fine.');
    await addArtifact(task.id, 'attachment', 'Design notes body.', 'notes');
    await store.transaction((tx) =>
      tx.upsertCodeReviewComment({
        boardId,
        globId: task.id,
        prNumber: 7,
        externalId: 'coderabbit:review_comment:1',
        kind: 'inline',
        author: 'coderabbit',
        commitSha: null,
        path: 'src/sync/retry.ts',
        line: '10',
        body: 'The loop never ends.',
        url: 'https://github.com/acme/app/pull/7#discussion_r1',
        createdAt: START,
        updatedAt: START,
      }),
    );
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'doc',
        name: 'build_test_lint',
        area: 'build',
        audience: [],
        description: 'Build',
        content: '---\narea: build\n---\n# Build\n\nRun pnpm test.',
        layer: 'file',
        version: 1,
        source: 'edit',
        updatedBy: 'admin@example.com',
        updatedAt: START,
      }),
    );
    const learning: KbItem = {
      id: 's1k1',
      boardId,
      status: 'approved',
      type: 'gotcha',
      statement: 'The test database needs pgvector.',
      evidence: 'Migration failed without it.',
      suggestedTarget: null,
      sourceGlobIds: [task.id, sup.id],
      source: 'submitted',
      signal: null,
      agentSetVersion: null,
      submittedBy: 'dev@example.com',
      createdAt: START,
      decidedBy: 'admin@example.com',
      decidedAt: START,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      processing: 'drafted',
      version: 2,
    };
    await store.transaction((tx) => tx.insertKbItem(learning));
    await merge(task.id);
    return { task, sup };
  };

  it('indexes every kind of source with its facts and citations', async () => {
    await populate();
    const result = await indexer.syncBoard(boardId);
    expect(result).toEqual({ written: 11, removed: 0, queued: 1 });
    const types = new Map<SourceType, number>();
    for (const item of items()) types.set(item.sourceType, (types.get(item.sourceType) ?? 0) + 1);
    expect(Object.fromEntries(types)).toEqual({
      glob_summary: 2,
      glob_plan: 1,
      implementation_plan: 2,
      postplan: 1,
      local_review: 1,
      attachment: 1,
      code_review: 1,
      kb_doc: 1,
      learning: 1,
      change_summary: 1,
    });
    expect(byRef('artifact:s1t1:plan:')).toMatchObject({
      authority: 'approved_plan',
      globIds: ['s1t1'],
      globGroup: 'sync',
      externalUrl: '/boards/1?glob=s1t1',
      state: 'ready',
    });
    expect(byRef('artifact:s1t1:postplan:').authority).toBe('merged_code');
    expect(byRef('artifact:s1t1:local_review:').authority).toBe('discussion');
    expect(byRef('artifact:s1f2:implementation_plan:')).toMatchObject({ sourceType: 'implementation_plan', authority: 'merged_code' });
    expect(byRef('review:coderabbit:review_comment:1').externalUrl).toBe('https://github.com/acme/app/pull/7#discussion_r1');
    expect(byRef('kb:build_test_lint').globIds).toEqual([]);
    expect(chunksOf('kb:build_test_lint')).toMatchObject([{ header: '[Knowledge · 2026-10-05 · "build_test_lint" · Build]', text: 'Run pnpm test.' }]);
    expect(byRef('learning:s1k1').globIds).toEqual(['s1t1', 's1f2']);
    expect(byRef(`change:${SHA}`)).toMatchObject({ state: 'pending_summary', externalUrl: `https://github.com/acme/app/commit/${SHA}` });
    expect(chunksOf('artifact:s1t1:plan:')[0]?.header).toBe('[Plan · 2026-10-05 · "s1t1 Sync retries" · Approach]');
    // Chunks start without a vector.
    expect(store.state.searchChunks.every((c) => c.embedding === null)).toBe(true);
  });

  it('writes nothing when nothing changed', async () => {
    await populate();
    await indexer.syncBoard(boardId);
    const before = JSON.stringify([items(), store.state.searchChunks]);
    expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
    expect(JSON.stringify([items(), store.state.searchChunks])).toBe(before);
  });

  it('re-chunks only the item that was edited, dropping its old vectors', async () => {
    const { task } = await populate();
    await indexer.syncBoard(boardId);
    while ((await indexer.processNext()) !== null) now = at(1);
    const untouched = chunksOf('artifact:s1t1:postplan:');
    expect(chunksOf('artifact:s1t1:plan:')[0]?.embedding).not.toBeNull();

    await addArtifact(task.id, 'plan', '## Approach\n\nRetry with jitter.');
    expect(await indexer.syncBoard(boardId)).toEqual({ written: 1, removed: 0, queued: 0 });
    expect(chunksOf('artifact:s1t1:plan:')).toMatchObject([{ text: 'Retry with jitter.', embedding: null }]);
    expect(chunksOf('artifact:s1t1:postplan:')).toEqual(untouched);
  });

  it('follows a glob group change', async () => {
    const { task } = await populate();
    await indexer.syncBoard(boardId);
    await store.transaction(async (tx) => {
      const current = await tx.getGlob(task.id);
      if (current !== null) await tx.updateGlob({ ...current, group: 'payments', version: current.version + 1 }, current.version);
    });
    const result = await indexer.syncBoard(boardId);
    expect(result.written).toBeGreaterThan(0);
    expect(byRef('artifact:s1t1:plan:').globGroup).toBe('payments');
  });

  it('removes items whose source is gone, and a deleted glob takes its own items but not a shared learning', async () => {
    const { task } = await populate();
    await indexer.syncBoard(boardId);
    await store.transaction((tx) => tx.deleteKnowledge(boardId, 'doc', 'build_test_lint'));
    expect(await indexer.syncBoard(boardId)).toMatchObject({ removed: 1 });
    expect(items().some((i) => i.sourceType === 'kb_doc')).toBe(false);

    await store.transaction(async (tx) => {
      await tx.deleteGlob(task.id);
      await tx.deleteEvents(task.id);
    });
    expect(items().filter((i) => i.globIds.includes(task.id))).toEqual([]);
    expect(byRef('learning:s1k1').globIds).toEqual(['s1f2']);
    // Chunks went with their items.
    const ids = new Set(items().map((i) => i.id));
    expect(store.state.searchChunks.every((c) => ids.has(c.itemId))).toBe(true);
    expect(await indexer.syncBoard(boardId)).toMatchObject({ written: 1 });
    expect(byRef('learning:s1k1').globIds).toEqual(['s1f2']);
    expect(items().some((i) => i.sourceType === 'change_summary')).toBe(false);
    expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
  });

  it('does not index empty text or another board', async () => {
    await addGlob({ id: 's1t1', summary: '   ' });
    const other = (
      await store.transaction((tx) =>
        tx.insertBoard({ name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] }),
      )
    ).id;
    await store.transaction((tx) => tx.insertGlob(makeGlob({ id: 's2t1', boardId: other, summary: 'Other board.' }), null));
    await indexer.syncBoard(boardId);
    expect(items()).toEqual([]);
    await indexer.syncAll();
    expect(items().map((i) => i.boardId)).toEqual([other]);
  });

  describe('embedding', () => {
    it('embeds chunks in batches, header and text together', async () => {
      const g = await addGlob({ id: 's1t1', summary: 'One.' });
      for (let i = 0; i < EMBED_BATCH + 3; i++) await addArtifact(g.id, 'attachment', `Notes ${String(i)}.`, `a${String(i)}`);
      await indexer.syncBoard(boardId);
      expect(await indexer.processNext()).toBe('embed');
      expect(embedder.calls[0]).toHaveLength(EMBED_BATCH);
      expect(embedder.calls[0]?.[0]).toContain('[Summary');
      expect(store.state.searchChunks.filter((c) => c.embedding === null)).toHaveLength(4);
      expect(await indexer.processNext()).toBe('embed');
      expect(await indexer.processNext()).toBeNull();
      expect(store.state.searchChunks.every((c) => c.embedding?.length === 1024)).toBe(true);
    });

    it('leaves chunks pending, without any attempt count, while the embedder is unavailable, then recovers', async () => {
      await addGlob({ id: 's1t1', summary: 'Retry failed syncs.' });
      await indexer.syncBoard(boardId);
      embedder.unavailable = new LlmUnavailable('AWS sign-in expired', 'Sign in again');

      expect(await indexer.processNext()).toBe('embed');
      expect(embedder.calls).toEqual([]);
      expect(store.state.searchChunks.every((c) => c.embedding === null)).toBe(true);
      expect(items().every((i) => i.attempts === 0 && i.lastError === null)).toBe(true);
      // It rests rather than calling the embedder again at once.
      now = at(LLM_WAIT_MS - 1);
      expect(await indexer.processNext()).toBeNull();

      embedder.unavailable = null;
      now = at(LLM_WAIT_MS);
      expect(await indexer.processNext()).toBe('embed');
      expect(store.state.searchChunks.every((c) => c.embedding !== null)).toBe(true);
    });

    it('rethrows other embedding errors and rests before trying again', async () => {
      await addGlob({ id: 's1t1', summary: 'Retry failed syncs.' });
      await indexer.syncBoard(boardId);
      const failing = { model: 'x', dimensions: 1024 as const, embed: () => Promise.reject(new Error('throttled')) };
      const flaky = new SearchIndexer({ store, clock: { now: () => now }, embedder: failing, changes, llm });
      await expect(flaky.processNext()).rejects.toThrow('throttled');
      expect(await flaky.processNext()).toBeNull();
    });
  });

  describe('change summaries', () => {
    const queue = async () => {
      const g = await addGlob({ id: 's1t1', title: 'Sync retries', summary: '' });
      await addArtifact(g.id, 'plan', 'Retry failed syncs because the queue stalled.');
      await merge(g.id);
      await indexer.syncBoard(boardId);
    };

    it('writes the why from the plan and the files, keeping the files line for path search', async () => {
      await queue();
      expect(chunksOf(`change:${SHA}`)[0]?.text).toBe('Merged change for s1t1: Sync retries.');
      llm.answer('  It retries failed syncs so the queue no longer stalls.  ');
      expect(await indexer.processNext()).toBe(`change:${SHA}`);
      expect(changes.calls).toEqual([SHA]);
      expect(llm.calls[0]?.prompt).toContain('Retry failed syncs because the queue stalled.');
      expect(llm.calls[0]?.prompt).toContain('src/sync/retry.ts');
      expect(byRef(`change:${SHA}`)).toMatchObject({ state: 'ready', attempts: 0, lastError: null });
      expect(chunksOf(`change:${SHA}`)).toMatchObject([
        { text: 'Files: src/sync/retry.ts, src/sync/queue.ts\n\nIt retries failed syncs so the queue no longer stalls.', embedding: null },
      ]);
      // The finished change isn't queued or rewritten by the next sync.
      expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
      expect(llm.calls).toHaveLength(1);
    });

    it('says the files are unknown when the repository cannot be read', async () => {
      await queue();
      changes.diff = null;
      llm.answer('Retries failed syncs.');
      await indexer.processNext();
      expect(llm.calls[0]?.prompt).toContain('Files changed: unknown');
      expect(chunksOf(`change:${SHA}`)[0]?.text).toBe('Retries failed syncs.');
    });

    it('waits without counting an attempt while the model is unavailable, then recovers', async () => {
      await queue();
      llm.answer(new LlmUnavailable('No model access', 'Enable Haiku'));
      expect(await indexer.processNext()).toBe(`change:${SHA}`);
      expect(byRef(`change:${SHA}`)).toMatchObject({
        state: 'pending_summary',
        attempts: 0,
        processAfter: at(LLM_WAIT_MS),
        lastError: `${LLM_WAITING_PREFIX}No model access`,
      });
      // Not due yet: the step falls through to embedding and the model isn't called again.
      now = at(LLM_WAIT_MS - 1);
      expect(await indexer.processNext()).toBe('embed');
      expect(llm.calls).toHaveLength(1);

      now = at(LLM_WAIT_MS);
      llm.answer('Retries failed syncs.');
      expect(await indexer.processNext()).toBe(`change:${SHA}`);
      expect(byRef(`change:${SHA}`)).toMatchObject({ state: 'ready', attempts: 0, lastError: null });
    });

    it('retries other failures with backoff and gives up after the last attempt, leaving the files searchable', async () => {
      await queue();
      for (let attempt = 1; attempt < MAX_PROCESSING_ATTEMPTS; attempt++) {
        llm.answer(new Error('bad answer'));
        await indexer.processNext();
        expect(byRef(`change:${SHA}`)).toMatchObject({ state: 'pending_summary', attempts: attempt, lastError: 'bad answer' });
        const due = byRef(`change:${SHA}`).processAfter;
        expect(due).not.toBeNull();
        // Still backing off one millisecond before.
        now = at(Date.parse(due ?? START) - Date.parse(START) - 1);
        expect(await indexer.processNext()).not.toBe(`change:${SHA}`);
        expect(llm.calls).toHaveLength(attempt);
        now = due ?? START;
      }
      llm.answer(new Error('bad answer'));
      await indexer.processNext();
      expect(byRef(`change:${SHA}`)).toMatchObject({ state: 'ready', lastError: 'bad answer' });
      expect(chunksOf(`change:${SHA}`)[0]?.text).toBe('Files: src/sync/retry.ts, src/sync/queue.ts');
      expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
    });
  });
});
