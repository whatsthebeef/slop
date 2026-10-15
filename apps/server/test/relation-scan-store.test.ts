import { ArtifactService, BoardService, GlobService, LlmUnavailable, RELATION_SCAN_DEBOUNCE_MS, RelationScanService, SpendService, globIdsIn } from '@slop/core';
import type { AutomaticAdd, LlmRequest, Result } from '@slop/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { spendRecorder } from '../src/llm.js';
import { relationScanExecutors } from '../src/relation-scan-executors.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const HAIKU = 'global.anthropic.claude-haiku-4-5';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** The relation scan's storage and wiring on Postgres: cache rows, the debounce on the real outbox, the llm lane, and one ledger row per pass. */
describe('relation scan in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let db: Awaited<ReturnType<typeof createTestDatabase>>['database']['db'];
  let globs: GlobService;
  let artifacts: ArtifactService;
  let scan: RelationScanService;
  let runner: OutboxRunner;
  let boardId = 0;
  let calls: LlmRequest[];
  let answer: (request: LlmRequest) => string | Error;
  let applied: AutomaticAdd[][];

  const jobs = (globId: string) => db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId));
  const scans = (globId: string) => store.transaction((tx) => tx.listRelationScans(globId));
  const ledger = (globId: string) => db.select().from(schema.llmSpend).where(eq(schema.llmSpend.globId, globId));
  const create = async (title: string) =>
    unwrap(await globs.create(DEV, { boardId, title, type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
  const dueNow = (globId: string) => db.update(schema.outbox).set({ runAfter: sql`now() - interval '1 second'` }).where(eq(schema.outbox.globId, globId));

  beforeAll(async () => {
    const test = await createTestDatabase('relation_scan_store');
    drop = test.drop;
    db = test.database.db;
    store = new PgStore(db);
    const clock = { now: () => new Date().toISOString() };
    const notifier = { publish: () => undefined };
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const spend = new SpendService({ store, clock });
    const recordUsage = spendRecorder(spend, () => undefined);
    calls = [];
    applied = [];
    answer = () => JSON.stringify({ decisions: [] });
    scan = new RelationScanService({
      store,
      clock,
      // What BedrockLlm does after a call: report the usage under the request's own tag.
      llm: {
        complete: async (request) => {
          calls.push(request);
          const reply = answer(request);
          if (reply instanceof Error) throw reply;
          await recordUsage({ model: HAIKU, input: 2_000, output: 300 }, request.spend);
          return reply;
        },
      },
      automatic: {
        applyAutomatic: (_globId, _hash, adds) => {
          applied.push([...adds]);
          return Promise.resolve({ added: adds.map((a) => a.to), skipped: [], stale: false });
        },
      },
      model: HAIKU,
    });
    artifacts = new ArtifactService({ store, clock, notifier, relationScan: scan });
    runner = new OutboxRunner(db, { globs }, relationScanExecutors(scan), () => undefined, 'llm');
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(async () => {
    await drop();
  });

  const verdicts = (verdict: string, gate = 'sign_off') => (request: LlmRequest): string =>
    JSON.stringify({
      decisions: [...request.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].flatMap((m) => globIdsIn(m[2] ?? '').map((id) => ({ id, sentence: Number(m[1]), verdict, gate }))),
    });

  it('many saves with ids are one pending llm-lane job with a pushed run time; saves without ids queue none', async () => {
    const me = await create('Debounced');
    await artifacts.putPlan(DEV, me.id, 'A plan with no ids at all.');
    expect(await jobs(me.id)).toEqual([]);
    const before = Date.now();
    for (let i = 0; i < 10; i++) unwrap(await artifacts.putPlan(DEV, me.id, `Version ${String(i)} waits for s1t99.`));
    const queued = await jobs(me.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'scan_relations', lane: 'llm', state: 'pending', attempts: 0 });
    expect(queued[0]?.runAfter.getTime()).toBeGreaterThanOrEqual(before + RELATION_SCAN_DEBOUNCE_MS - 1_000);
  });

  it('the llm lane runs the job: cache rows are written, the pair is not asked twice, and exactly one ledger row is written per pass', async () => {
    const me = await create('Mine');
    const target = await create('Prerequisite');
    answer = verdicts('prerequisite');
    calls.length = 0;
    applied.length = 0;
    unwrap(await artifacts.putPlan(DEV, me.id, `Hand the prod profile to sessions only after ${target.id} is in place.`));
    await dueNow(me.id);

    await runner.drain(me.id);

    expect((await jobs(me.id))[0]).toMatchObject({ state: 'done' });
    expect(calls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.[0]).toMatchObject({ to: target.id, gate: 'sign_off', until: 'merged' });
    expect(await scans(me.id)).toEqual([expect.objectContaining({ mentionedId: target.id, decision: 'added', state: 'done', model: HAIKU, kind: 'mention' })]);
    const rows = await ledger(me.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'relation_scan', globId: me.id, boardId, model: HAIKU, inputTokens: 2_000, outputTokens: 300 });
    // 2000 input and 300 output tokens at the global Haiku 4.5 price ($1 and $5 per million).
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(0.0035);

    // Another pass over the same text: the pair is cached, so no call and no second ledger row.
    unwrap(await artifacts.putPlan(DEV, me.id, `Hand the prod profile to sessions only after ${target.id} is in place.\nOne more line.`));
    await dueNow(me.id);
    await runner.drain(me.id);
    expect(calls).toHaveLength(1);
    expect(await ledger(me.id)).toHaveLength(1);
  });

  it('no usable answer writes nothing and the job is retried; an unavailable model waits without spending an attempt', async () => {
    const me = await create('Retried');
    const target = await create('T');
    calls.length = 0;
    answer = () => 'I cannot do that';
    unwrap(await artifacts.putPlan(DEV, me.id, `Only after ${target.id} is in place.`));
    await dueNow(me.id);

    await runner.drain(me.id);

    const [job] = await jobs(me.id);
    expect(job).toMatchObject({ state: 'pending', attempts: 1 });
    expect(job?.lastError).toMatch(/no usable answer/);
    expect(await scans(me.id)).toEqual([]);

    // Later, with an answer, the retry decides.
    answer = verdicts('history');
    await dueNow(me.id);
    await runner.drain(me.id);
    expect((await jobs(me.id))[0]).toMatchObject({ state: 'done' });
    expect(await scans(me.id)).toEqual([expect.objectContaining({ decision: 'history' })]);

    const waiting = await create('Waits for the model');
    unwrap(await artifacts.putPlan(DEV, waiting.id, `Only after ${target.id} is in place.`));
    answer = () => new LlmUnavailable('AWS sign-in expired', 'Sign in');
    await dueNow(waiting.id);
    await runner.drain(waiting.id);
    expect((await jobs(waiting.id))[0]).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a job for a deleted glob is dropped', async () => {
    const me = await create('Short lived');
    unwrap(await artifacts.putPlan(DEV, me.id, 'Waits for s1t99.'));
    await db.delete(schema.globs).where(eq(schema.globs.id, me.id));
    await dueNow(me.id);
    await runner.drain(me.id);
    expect((await jobs(me.id))[0]).toMatchObject({ state: 'dropped' });
  });
});
