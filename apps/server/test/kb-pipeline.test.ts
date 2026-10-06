import { readFile } from 'node:fs/promises';
import { GlobService, KbPipeline, KnowledgeService, ROUTE_SYSTEM } from '@slop/core';
import type { KbItem, Llm, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'empty', files: [] }) };

const NEW_DOC = JSON.stringify({
  target: { kind: 'document', name: 'testing', section: null, newDocument: { area: 'testing', audience: ['tester'], description: 'Tests' } },
  catalogCandidate: true,
  catalogReason: 'Generic',
});

describe('KB pipeline in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let knowledge: KnowledgeService;
  let boardId: number;
  let globId: string;
  let now = '2026-10-05T12:00:00.000Z';
  const clock = { now: () => now };
  const notifier = { publish: () => undefined };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_pipeline'));
    store = new PgStore(database.db);
    knowledge = new KnowledgeService({ store, notifier, clock, catalog });
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Source',
        summary: '',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
  });

  afterAll(async () => {
    await drop();
  });

  const submit = async (statement: string) =>
    unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: globId, type: 'gotcha', statement, evidence: 'Seen in review' })).id;

  const get = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  /** Marks every pending item routed so each test starts with an empty queue. */
  const clearQueue = () =>
    database.db.execute(sql`update kb_proposals set processing = 'drafted' where processing in ('pending', 'routed')`);

  it('round-trips the pipeline columns', async () => {
    const id = await submit('Generated files live in src/gen/');
    const item = await get(id);
    expect(item).toMatchObject({
      processing: 'pending',
      processingError: null,
      processingAttempts: 0,
      processAfter: null,
      target: null,
      catalogCandidate: false,
      occurrenceCount: 1,
      extraEvidence: [],
      contradicts: [],
      draft: null,
    });
    const updated: KbItem = {
      ...item,
      status: 'merged',
      processing: 'drafted',
      processingError: 'once failed',
      processingAttempts: 2,
      processAfter: '2026-10-05T12:05:00.000Z',
      target: { kind: 'agent', name: 'agents/implementer.md', section: 'Testing', newDocument: null },
      catalogCandidate: true,
      catalogReason: 'Generic',
      occurrenceCount: 3,
      extraEvidence: [{ itemId: 's1k9', globIds: [globId], evidence: 'More', submittedBy: DEV, at: '2026-10-05T12:00:00.000Z' }],
      duplicateOf: 's1k8',
      suppressedBy: 's1k7',
      coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build', section: null },
      contradicts: [{ kind: 'item', ref: 's1k6', note: 'Conflicts' }],
      draft: { section: 'Testing', content: '### Testing\n\n- New rule\n' },
      draftedAgainstVersion: 4,
      rationale: 'Because',
      version: item.version + 1,
    };
    expect(await store.transaction((tx) => tx.updateKbItem(updated, item.version))).toBe(true);
    expect(await get(id)).toEqual(updated);
  });

  it('finds the oldest open item that is due for routing or drafting', async () => {
    await clearQueue();
    expect(await store.transaction((tx) => tx.nextKbItemToProcess(now))).toBeNull();
    const first = await submit('First');
    const second = await submit('Second');
    const third = await submit('Third');
    const held = await get(first);
    await store.transaction((tx) =>
      tx.updateKbItem({ ...held, processAfter: '2026-10-05T12:01:00.000Z', version: held.version + 1 }, held.version),
    );
    unwrap(await knowledge.reject(ADMIN, second, (await get(second)).version, 'No'));
    expect((await store.transaction((tx) => tx.nextKbItemToProcess(now)))?.id).toBe(third);
    expect((await store.transaction((tx) => tx.nextKbItemToProcess('2026-10-05T12:01:00.000Z')))?.id).toBe(first);
    // Routed items wait for their draft; drafted and failed ones wait for nothing.
    const routed = await get(third);
    await store.transaction((tx) =>
      tx.updateKbItem({ ...routed, processing: 'routed', version: routed.version + 1 }, routed.version),
    );
    expect((await store.transaction((tx) => tx.nextKbItemToProcess(now)))?.id).toBe(third);
    for (const processing of ['drafted', 'failed'] as const) {
      const current = await get(third);
      await store.transaction((tx) => tx.updateKbItem({ ...current, processing, version: current.version + 1 }, current.version));
      expect(await store.transaction((tx) => tx.nextKbItemToProcess(now))).toBeNull();
    }
  });

  it('lets only one of two concurrent workers claim an item, and merges a near-duplicate with conditional writes', async () => {
    await clearQueue();
    const first = await submit('Run vitest with --reporter=dot');
    let routeCalls = 0;
    const route: Llm = {
      complete: (request) => {
        // Routing, then dedupe against the open items earlier tests left.
        if (request.system === ROUTE_SYSTEM) routeCalls++;
        return Promise.resolve(request.system === ROUTE_SYSTEM ? NEW_DOC : '{}');
      },
    };
    const workers = [0, 1].map(() => new KbPipeline({ store, clock, catalog, notifier, route, draft: route }));
    const results = await Promise.all(workers.map((w) => w.processNext()));
    expect(results.filter((r) => r === first)).toHaveLength(1);
    expect(routeCalls).toBe(1);
    expect(await get(first)).toMatchObject({
      processing: 'routed',
      catalogCandidate: true,
      target: { kind: 'doc', name: 'testing', newDocument: { area: 'testing' } },
    });

    const second = await submit('Use the dot reporter for vitest');
    const answers = [NEW_DOC, JSON.stringify({ duplicateOf: first })];
    const dedupe: Llm = { complete: () => Promise.resolve(answers.shift() ?? '') };
    await new KbPipeline({ store, clock, catalog, notifier, route: dedupe, draft: dedupe }).process(second);
    expect(await get(second)).toMatchObject({ status: 'merged', duplicateOf: first });
    expect(await get(first)).toMatchObject({ status: 'open', occurrenceCount: 2, extraEvidence: [{ itemId: second }] });
  });

  it('drafts routed items, applies a draft in one click and re-queues another draft on the same document', async () => {
    await clearQueue();
    unwrap(
      await knowledge.importDocuments(
        ADMIN,
        boardId,
        [{ fileName: 'build.md', content: '---\narea: build\ndescription: Build\n---\n# Build\n\n## Test\n\nRun vitest.\n' }],
        'upload',
      ),
    );
    const target = { kind: 'doc' as const, name: 'build', section: 'Test' };
    const first = await submit('Use the dot reporter');
    const second = await submit('Use --run in CI');
    for (const id of [first, second]) unwrap(await knowledge.changeTarget(ADMIN, id, (await get(id)).version, target));
    const answers = [
      JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.', rationale: 'Quiet' }),
      JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest --run.', rationale: 'CI' }),
    ];
    const draft: Llm = { complete: () => Promise.resolve(answers.shift() ?? '') };
    const pipeline = new KbPipeline({ store, clock, catalog, notifier, route: draft, draft });
    expect(await pipeline.processNext()).toBe(first);
    expect(await pipeline.processNext()).toBe(second);
    expect(await get(first)).toMatchObject({
      processing: 'drafted',
      draft: { section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.' },
      draftedAgainstVersion: 1,
      rationale: 'Quiet',
    });
    const preview = unwrap(await knowledge.proposals(DEV, boardId, 'open')).find((i) => i.id === first)?.preview;
    expect(preview?.diff).toContainEqual({ op: 'added', text: 'Run vitest --reporter=dot.' });

    unwrap(await knowledge.approve(ADMIN, first, (await get(first)).version, { as: 'draft' }));
    const doc = await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'build'));
    expect(doc).toMatchObject({ area: 'build', content: '# Build\n\n## Test\n\nRun vitest --reporter=dot.\n', version: 2 });
    expect(await get(second)).toMatchObject({ status: 'open', processing: 'routed', draft: null, draftedAgainstVersion: null });
  });

  it('migration 0013 marks decided items routed and leaves open ones pending for the job; re-running is harmless', async () => {
    const open = await submit('Still open');
    const decided = await submit('Decided');
    unwrap(await knowledge.approve(ADMIN, decided, (await get(decided)).version, { as: 'learning' }));
    // As before the migration: every row pending.
    await database.db.execute(sql`update kb_proposals set processing = 'pending'`);
    const migration = await readFile(new URL('../drizzle/0013_kb_routing.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await database.db.execute(sql.raw(statement));
    expect((await get(open)).processing).toBe('pending');
    expect((await get(decided)).processing).toBe('routed');
    now = '2026-10-05T13:00:00.000Z';
  });
});
