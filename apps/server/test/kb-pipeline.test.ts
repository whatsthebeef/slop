import { DEDUPE_SYSTEM, GlobService, KbPipeline, KnowledgeService, learningSeed, LlmBusy, LlmUnavailable, MAX_PROCESSING_ATTEMPTS, ROUTE_SYSTEM, UNPROCESSED } from '@slop/core';
import type { Effect, GlobService as Globs, LearningWire, Llm, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import type { Executor } from '../src/jobs/outbox.js';
import { kbExecutors } from '../src/kb-executors.js';
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
  const now = '2026-10-05T12:00:00.000Z';
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

  const get = async (id: string): Promise<LearningWire> => {
    const found = await store.transaction((tx) => learningSeed(tx).readSeeded(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  /** Ends every waiting pipeline job so each test starts with an empty queue. */
  const clearQueue = () => database.db.execute(sql`update outbox set state = 'done' where lane = 'llm' and state = 'pending'`);
  /** Makes an item's waiting jobs due (their backoff over); a minute back, so the database's clock running ahead of ours can't matter. */
  const due = (id: string) =>
    database.db.execute(sql`update outbox set run_after = now() - interval '1 minute' where glob_id = ${id} and state = 'pending'`);
  const jobs = async (id: string) =>
    (
      await database.db.execute(sql`select kind, lane, state, attempts, last_error, run_after from outbox where glob_id = ${id} and lane = 'llm' order by id`)
    ).map((j) => ({ kind: j.kind, lane: j.lane, state: j.state, attempts: j.attempts, lastError: j.last_error, runAfter: j.run_after }));

  const deps = { globs: {} as Globs };
  /** The `llm` lane's runner with the KB executors over a pipeline with these models (always up unless `down`). */
  const runner = (route: Llm, draft: Llm = route, settled: Effect[] = [], down: () => boolean = () => false) =>
    new OutboxRunner(
      database.db,
      deps,
      kbExecutors(new KbPipeline({ store, clock, catalog, notifier, route, draft }), { isDown: down }),
      () => undefined,
      'llm',
      (effect) => settled.push(effect),
    );
  const answers = (...queue: (string | Error)[]): Llm => ({
    complete: () => {
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error('No canned answer'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  });

  it('round-trips every KB item field through its decision glob, artifacts, attachments and links', async () => {
    const id = `s${String(boardId)}k500`;
    const item: LearningWire = {
      id,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: 'Generated files live in src/gen/',
      evidence: 'Seen in review',
      suggestedTarget: 'build',
      sourceGlobIds: [globId],
      source: 'mined',
      signal: null,
      agentSetVersion: 3,
      submittedBy: DEV,
      createdAt: '2026-10-05T12:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      processing: 'drafted',
      target: { kind: 'agent', name: 'agents/implementer.md', section: 'Testing', newDocument: null },
      catalogCandidate: true,
      catalogReason: 'Generic',
      occurrenceCount: 3,
      extraEvidence: [{ itemId: 's1k9', globIds: [globId], evidence: 'More', submittedBy: DEV, at: '2026-10-05T12:00:00.000Z' }],
      possiblyCoveredBy: { knowledgeKind: 'doc', name: 'build', section: 'Test', quote: 'Run vitest.', reason: 'Names the runner' },
      contradicts: [{ kind: 'item', ref: 's1k6', note: 'Conflicts' }],
      draft: { section: 'Testing', content: '### Testing\n\n- New rule\n' },
      draftedAgainstVersion: 4,
      rationale: 'Because',
      keptApartFrom: ['s1k5'],
      version: 1,
    };
    const writes = { clock };
    expect(await store.transaction((tx) => learningSeed(tx, writes).insertSeeded(item))).toBe(true);
    expect(await get(id)).toEqual(item);
    const closed: LearningWire = {
      ...item,
      status: 'covered',
      coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build', section: null },
      mergeNote: { by: 'consolidation', quote: 'a', survivorQuote: 'b', at: '2026-10-05T12:00:00.000Z' },
      version: 2,
    };
    expect(await store.transaction((tx) => learningSeed(tx, writes).updateSeeded(closed, 1))).toBe(true);
    // Closed, it reads as out of the pipeline.
    expect(await get(id)).toEqual({ ...closed, processing: 'none' });
    const glob = await store.transaction((tx) => tx.getGlob(id));
    expect(glob).toMatchObject({ category: 'decision', status: 'signed_off', version: 2, attributes: { closedAs: 'covered', archived: true, coveredByText: { name: 'build' } } });
    // A stale version writes nothing.
    expect(await store.transaction((tx) => learningSeed(tx, writes).updateSeeded({ ...closed, version: 3 }, 1))).toBe(false);
  });

  it('queues routing on the llm lane in the submit transaction, and reads the pipeline fields from that job', async () => {
    await clearQueue();
    const id = await submit('Queued on submit');
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', lane: 'llm', state: 'pending', attempts: 0, lastError: null }]);
    expect(await get(id)).toMatchObject({ processing: 'pending', processingAttempts: 0, processingError: null, processAfter: null });
    // One pending job per item and kind: queueing it again adds none.
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'kb_route', globId: id }, { kind: 'kb_route', globId: id }]));
    expect(await jobs(id)).toHaveLength(1);
    await database.db.execute(sql`update outbox set attempts = 2, last_error = 'Bedrock is down', run_after = '2026-10-05T12:00:20.000Z' where glob_id = ${id}`);
    expect(await get(id)).toMatchObject({ processing: 'pending', processingAttempts: 2, processingError: 'Bedrock is down', processAfter: '2026-10-05T12:00:20.000Z' });
    await database.db.execute(sql`update outbox set state = 'failed' where glob_id = ${id}`);
    expect(await get(id)).toMatchObject({ processing: 'failed', processingAttempts: 2, processingError: 'Bedrock is down', processAfter: null });
  });

  it('runs the oldest due job first, leaves one backing off until it is due, and drops a decided item\'s job', async () => {
    await clearQueue();
    const first = await submit('First');
    const second = await submit('Second');
    const third = await submit('Third');
    await database.db.execute(sql`update outbox set run_after = now() + interval '1 minute' where glob_id = ${first}`);
    unwrap(await knowledge.reject(ADMIN, second, (await get(second)).version, 'No'));
    const order: string[] = [];
    const executor: Executor = (effect) => {
      order.push(`${effect.kind} ${effect.globId}`);
      return Promise.resolve('done');
    };
    const record = new OutboxRunner(database.db, deps, { kb_route: executor, kb_draft: executor }, () => undefined, 'llm');
    await record.drain();
    expect(order).toEqual([`kb_route ${second}`, `kb_route ${third}`]);
    await due(first);
    await record.drain();
    expect(order.at(-1)).toBe(`kb_route ${first}`);

    // The real executor re-reads the item: the rejected item's step no longer applies, so its job is dropped unrun.
    const id = await submit('Rejected before routing');
    unwrap(await knowledge.reject(ADMIN, id, (await get(id)).version, 'No'));
    await runner(answers()).drain();
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'dropped', attempts: 1 }]);
  });

  it('lets only one of two llm runners run a job, and merges a near-duplicate with conditional writes', async () => {
    await clearQueue();
    const first = await submit('Run vitest with --reporter=dot');
    let routeCalls = 0;
    // The claiming runner's model call waits until the other runner has come back empty-handed (the conventions'
    // gate): once routed, the item's draft job is legitimately due, so an instant answer would let the other runner
    // claim that next step and make the test racy.
    let release = (): void => undefined;
    const otherRunnerDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    // When the claim holds the job until, read while the step is inside its model call.
    let heldUntil: number | null = null;
    const route: Llm = {
      complete: async (request) => {
        if (request.system === ROUTE_SYSTEM && heldUntil === null) {
          const [claimed] = await jobs(first);
          heldUntil = new Date(String(claimed?.runAfter)).getTime();
        }
        await otherRunnerDone;
        // Routing, then dedupe against the open items earlier tests left.
        if (request.system === ROUTE_SYSTEM) routeCalls++;
        return request.system === ROUTE_SYSTEM ? NEW_DOC : '{}';
      },
    };
    // Drafting fails at once, so the claiming runner's drain ends with the draft job backing off.
    const draft = answers(new Error('Sonnet is down'));
    const runners = [runner(route, draft), runner(route, draft)];
    const drained = runners.map((r) => r.drain());
    await Promise.race(drained.map((d, i) => d.then(() => i)));
    release();
    await Promise.all(drained);
    expect(routeCalls).toBe(1);
    // The claim holds the job for the llm lane's lease, not a few seconds: no runner takes it again mid-call.
    expect(heldUntil).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await jobs(first)).toMatchObject([
      { kind: 'kb_route', state: 'done', attempts: 1 },
      { kind: 'kb_draft', state: 'pending', attempts: 1, lastError: 'Sonnet is down' },
    ]);
    expect(await get(first)).toMatchObject({
      processing: 'routed',
      catalogCandidate: true,
      target: { kind: 'doc', name: 'testing', newDocument: { area: 'testing' } },
    });

    const second = await submit('Use the dot reporter for vitest');
    const duplicateOf = { id: first, quote: 'Run vitest with --reporter=dot', newQuote: 'Use the dot reporter for vitest' };
    await runner(answers(NEW_DOC, JSON.stringify({ checked: [{ ref: first, relation: 'same fact' }], duplicateOf }))).drain(second);
    expect(await get(second)).toMatchObject({
      status: 'merged',
      duplicateOf: first,
      mergeNote: { by: 'intake', quote: 'Use the dot reporter for vitest', survivorQuote: 'Run vitest with --reporter=dot' },
    });
    expect(await get(first)).toMatchObject({ status: 'open', occurrenceCount: 2, extraEvidence: [{ itemId: second }] });
  });

  it('reruns a job whose claim crashed once its backoff ends, with the attempt it spent', async () => {
    await clearQueue();
    const id = await submit('Crashed mid-call');
    // A runner claimed it (an attempt spent, a backoff set) and died before settling it.
    await database.db.execute(sql`update outbox set attempts = 1, run_after = now() + interval '5 seconds' where glob_id = ${id}`);
    const route = answers(NEW_DOC, '{}');
    await runner(route, answers(new Error('Sonnet is down'))).drain();
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'pending', attempts: 1 }]);
    await due(id);
    await runner(route, answers(new Error('Sonnet is down'))).drain();
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'done', attempts: 2 }, { kind: 'kb_draft' }]);
    expect(await get(id)).toMatchObject({ processing: 'routed', target: { name: 'testing' } });
  });

  it('fails a job after the llm lane\'s three attempts, the item still decidable, telling the page each time', async () => {
    await clearQueue();
    const id = await submit('Fails three times');
    const settled: Effect[] = [];
    const llm = answers('Sure! Here is my answer.', new Error('Bedrock is down'), 'not json');
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      await runner(llm, llm, settled).drain(id);
      await due(id);
    }
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'failed', attempts: MAX_PROCESSING_ATTEMPTS, lastError: 'The routing answer was not usable JSON' }]);
    expect(await get(id)).toMatchObject({
      status: 'open',
      processing: 'failed',
      processingAttempts: MAX_PROCESSING_ATTEMPTS,
      processingError: 'The routing answer was not usable JSON',
      processAfter: null,
    });
    expect(settled).toHaveLength(MAX_PROCESSING_ATTEMPTS);
    // Nothing runs it again by itself.
    await runner(answers(NEW_DOC, '{}')).drain(id);
    expect((await jobs(id)).map((j) => j.state)).toEqual(['failed']);
    unwrap(await knowledge.approve(ADMIN, id, (await get(id)).version, { as: 'learning' }));
    expect(await get(id)).toMatchObject({ status: 'approved' });
  });

  it('waits while the models are unavailable or busy, spending no attempt and keeping why, and tells the page once', async () => {
    await clearQueue();
    const id = await submit('Waits for the model');
    const settled: Effect[] = [];
    const expired = () => new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`');
    for (let probe = 0; probe < MAX_PROCESSING_ATTEMPTS + 1; probe++) {
      await runner(answers(expired()), undefined, settled).drain(id);
      await due(id);
    }
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'pending', attempts: 0, lastError: 'AI unavailable: AWS sign-in expired' }]);
    expect(await get(id)).toMatchObject({ processing: 'pending', processingAttempts: 0, processingError: 'AI unavailable: AWS sign-in expired' });
    expect(settled).toHaveLength(1);
    // A busy Bedrock backs off without spending an attempt either, however often it answers so.
    for (let round = 0; round < MAX_PROCESSING_ATTEMPTS + 1; round++) {
      await runner(answers(new LlmBusy())).drain(id);
      const [job] = await jobs(id);
      expect(job).toMatchObject({ state: 'pending', attempts: 0 });
      expect(String(job?.lastError)).toMatch(/^Waiting: Bedrock busy/);
      await due(id);
    }
    await runner(answers(NEW_DOC, '{}'), answers(new Error('Sonnet is down'))).drain(id);
    expect(await get(id)).toMatchObject({ processing: 'routed', target: { name: 'testing' } });
  });

  it('runs a job again at once when its item changes during the call, spending no attempt', async () => {
    await clearQueue();
    const id = await submit('Changes under the call');
    let calls = 0;
    const route: Llm = {
      complete: async (request) => {
        if (request.system === DEDUPE_SYSTEM) return '{}';
        calls++;
        if (calls === 1) {
          // Something else writes the item while it is being routed: the result is dropped and the step reruns.
          const current = await get(id);
          await store.transaction((tx) => learningSeed(tx, { clock }).updateSeeded({ ...current, evidence: 'More evidence', version: current.version + 1 }, current.version));
        }
        return NEW_DOC;
      },
    };
    await runner(route, answers(new Error('Sonnet is down'))).drain(id);
    expect(calls).toBe(2);
    expect(await jobs(id)).toMatchObject([{ kind: 'kb_route', state: 'done', attempts: 1 }, { kind: 'kb_draft' }]);
    expect(await get(id)).toMatchObject({ processing: 'routed', evidence: 'More evidence' });
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
    // The import re-queued the drafts of items an earlier test left on this document.
    await clearQueue();
    const target = { kind: 'doc' as const, name: 'build', section: 'Test' };
    const first = await submit('Use the dot reporter');
    const second = await submit('Use --run in CI');
    for (const id of [first, second]) unwrap(await knowledge.changeTarget(ADMIN, id, (await get(id)).version, target));
    const drafts = [
      JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.', rationale: 'Quiet' }),
      JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest --run.', rationale: 'CI' }),
    ];
    const draft: Llm = { complete: () => Promise.resolve(drafts.shift() ?? '') };
    // Both retargeted items wait for their drafts, the first queued first.
    await runner(draft).drain();
    expect(drafts).toEqual([]);
    expect(await get(first)).toMatchObject({
      processing: 'drafted',
      draft: { section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.' },
      draftedAgainstVersion: 1,
      rationale: 'Quiet',
    });
    const preview = unwrap(await knowledge.proposals(DEV, boardId)).open.find((i) => i.id === first)?.preview;
    expect(preview?.diff).toContainEqual({ op: 'added', text: 'Run vitest --reporter=dot.' });

    unwrap(await knowledge.approve(ADMIN, first, (await get(first)).version, { as: 'draft' }));
    const doc = await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'build'));
    expect(doc).toMatchObject({ area: 'build', content: '# Build\n\n## Test\n\nRun vitest --reporter=dot.\n', version: 2 });
    expect(await get(second)).toMatchObject({ status: 'open', processing: 'routed', draft: null, draftedAgainstVersion: null });
    // The approval queued its draft again.
    expect((await jobs(second)).at(-1)).toMatchObject({ kind: 'kb_draft', state: 'pending', attempts: 0 });
  });

  it('queues a fresh draft when the item is retargeted after its draft committed but before the job settled', async () => {
    await clearQueue();
    const id = await submit('Retargeted while drafted');
    unwrap(await knowledge.changeTarget(ADMIN, id, (await get(id)).version, { kind: 'doc', name: 'build', section: 'Test' }));
    let retargeted = false;
    const pipeline = new KbPipeline({ store, clock, catalog, notifier, route: answers(), draft: answers(JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest --run.', rationale: 'CI' }), new Error('Sonnet is down')) });
    // The retarget lands after the step's commit and before the runner marks the job done.
    const late = {
      runStep: async (itemId: string, step: 'route' | 'draft') => {
        const outcome = await pipeline.runStep(itemId, step);
        if (step === 'draft' && !retargeted) {
          retargeted = true;
          unwrap(await knowledge.changeTarget(ADMIN, id, (await get(id)).version, { kind: 'doc', name: 'build', section: 'Lint' }));
        }
        return outcome;
      },
    };
    await new OutboxRunner(database.db, deps, kbExecutors(late, { isDown: () => false }), () => undefined, 'llm').drain(id);
    // The first draft job finished; the retarget got a job of its own, which ran (and failed once here).
    expect((await jobs(id)).filter((j) => j.kind === 'kb_draft')).toMatchObject([
      { state: 'done', attempts: 1 },
      { state: 'pending', attempts: 1, lastError: 'Sonnet is down' },
    ]);
    expect(await get(id)).toMatchObject({ processing: 'routed', draft: null, target: { section: 'Lint' } });
  });

});
