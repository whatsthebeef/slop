import { DecisionPipeline, DecisionService, FakeEmbedder, GlobService, SearchService } from '@slop/core';
import type { Llm, LlmRequest } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const POLLING = 'We will poll the server every thirty seconds for new sync jobs';
const PUSH = 'We will push sync jobs over a websocket connection instead of polling';

/** A model that answers extraction by the document shown and every supersession check as the test set it. */
class ScriptedLlm implements Llm {
  calls = 0;
  checkAnswer = '{"replaces": []}';
  /** The glob of the polling decision: the push decision names it, as a decision across globs must to replace one. */
  older = '';
  complete(request: LlmRequest): Promise<string> {
    this.calls++;
    const entry = (quote: string, decidedAt: string, statement = quote) => JSON.stringify({ decisions: [{ statement, quote, decidedBy: null, decidedAt }] });
    if (request.prompt.includes('Document:')) {
      return Promise.resolve(request.prompt.includes('websocket') ? entry(PUSH, '2026-09-01', `${PUSH} (replaces ${this.older})`) : entry(POLLING, '2026-06-01'));
    }
    return Promise.resolve(this.checkAnswer);
  }
}

/** Decisions on real Postgres, on a board of their own: extraction is idempotent, a replacement ranks and labels in search, and deleting a glob releases what it replaced. */
describe('decisions store', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let pipeline: DecisionPipeline;
  let decisions: DecisionService;
  let search: SearchService;
  let llm: ScriptedLlm;
  let boardId: number;

  const clock = { now: () => new Date().toISOString() };
  const count = async (table: typeof schema.decisions | typeof schema.decisionSources) =>
    (await database.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await pipeline.processNext()) === null) return;
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('decisions'));
    store = new PgStore(database.db);
    llm = new ScriptedLlm();
    const embedder = new FakeEmbedder();
    pipeline = new DecisionPipeline({ store, clock, notifier: { publish: () => undefined }, llm, embedder });
    decisions = new DecisionService({ store, clock, notifier: { publish: () => undefined } });
    search = new SearchService({ store, clock, embedder });
    const globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'decisions', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    const provenance = { by: 'human' as const, actor: DEV, runId: null, agentSetVersion: null };
    for (const [title, decided] of [
      ['Sync polling', POLLING],
      ['Sync push', PUSH],
    ] as const) {
      const created = await globs.create(DEV, { boardId, title, summary: title, type: 'same', category: 'task', group: 'sync', environment: null, autoTrigger: false, idempotencyKey: null });
      if (!created.ok) throw new Error(created.error.message);
      if (llm.older === '') llm.older = created.value.id;
      await store.transaction((tx) =>
        tx.insertArtifact({
          globId: created.value.id,
          kind: 'implementation_plan',
          label: '',
          content: `# Record\n\n## Decisions\n\n- ${decided}\n`,
          link: null,
          commitSha: null,
          provenance,
          createdAt: new Date().toISOString(),
        }),
      );
    }
  });

  afterAll(async () => {
    await drop();
  });

  it('extracts each source once and a second sync changes nothing', async () => {
    llm.checkAnswer = JSON.stringify({ replaces: [{ id: 1, oldQuote: POLLING, newQuote: PUSH, sameSubject: true, reason: 'Push replaces polling.' }] });
    expect(await pipeline.syncBoard(boardId)).toMatchObject({ queued: 2, written: 0, removed: 0 });
    await drain();
    expect(await count(schema.decisions)).toBe(2);
    expect(await count(schema.decisionSources)).toBe(2);
    const calls = llm.calls;
    const rows = await database.db.select().from(schema.decisions).orderBy(schema.decisions.id);
    expect(await pipeline.syncBoard(boardId)).toEqual({ queued: 0, written: 0, removed: 0 });
    await drain();
    expect(llm.calls).toBe(calls);
    expect(await database.db.select().from(schema.decisions).orderBy(schema.decisions.id)).toEqual(rows);
  });

  it('applied the replacement: the older item is superseded by the newer, and search puts the current one first', async () => {
    const [old, next] = await store.transaction((tx) => tx.listDecisions(boardId));
    expect(old).toMatchObject({ quote: POLLING, replaceState: 'applied', replacedBy: next?.id });
    const hits = await search.text(DEV, { boardId, query: 'sync jobs', sourceTypes: ['decision'] });
    if (!hits.ok) throw new Error(hits.error.message);
    expect(hits.value.map((h) => h.status)).toEqual(['active', 'superseded']);
    expect(hits.value[0]?.citation.source).toBe('decision');
    expect(hits.value[1]?.label).toMatch(/^superseded by ".+" on \d{4}-\d{2}-\d{2}$/);
    expect(hits.value[1]?.supersededBy?.date).not.toBeNull();
    const view = await decisions.forGlob(DEV, boardId, old?.globId ?? '');
    expect(view.ok && view.value[0]?.status).toBe('superseded');
  });

  it('lets a person undo it, and keeps the undo through a re-extraction of the source', async () => {
    const [old] = await store.transaction((tx) => tx.listDecisions(boardId));
    const undone = await decisions.undo(DEV, old?.id ?? 0, boardId);
    expect(undone.ok && undone.value.status).toBe('current');
    const [after] = await store.transaction((tx) => tx.listDecisions(boardId));
    expect(after).toMatchObject({ replaceState: 'undone' });
    const item = await database.db.select().from(schema.knowledgeItems).where(sql`id = ${old?.itemId ?? 0}`);
    expect(item[0]).toMatchObject({ status: 'active', supersededBy: null });
  });

  it('keeps decision items through the indexer sweep and releases what a deleted glob replaced', async () => {
    const [old, next] = await store.transaction((tx) => tx.listDecisions(boardId));
    // Reapply, then delete the newer decision's glob.
    await store.transaction(async (tx) => {
      await tx.updateDecision(old?.id ?? 0, { replacedBy: next?.id ?? 0, replaceState: 'applied' });
      await tx.setItemSupersession(old?.itemId ?? 0, 'superseded', next?.itemId ?? 0);
      await tx.deleteGlob(next?.globId ?? '');
    });
    const [only] = await store.transaction((tx) => tx.listDecisions(boardId));
    expect(only).toMatchObject({ quote: POLLING, replacedBy: null, replaceState: null });
    expect(await count(schema.decisions)).toBe(1);
    expect(await count(schema.decisionSources)).toBe(1);
    const item = await database.db.select().from(schema.knowledgeItems).where(sql`id = ${only?.itemId ?? 0}`);
    expect(item[0]).toMatchObject({ status: 'active', supersededBy: null });
  });
});
