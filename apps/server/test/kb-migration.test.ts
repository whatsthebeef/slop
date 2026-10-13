import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionGlobTitle, failedBecauseBusy, GlobService, isArchivedDecision, learningSeed, KnowledgeService, proposalText, UNPROCESSED, withProcessing } from '@slop/core';
import type { LearningWire, OutboxJob, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, PgStore, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { kbProposalRow, kbProposals } from './support/kb-proposals.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_kbmigration_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const QUEUE = '0048_kb_queue_outbox';
const MOVE = '0049_kb_items_to_decision_globs';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** A time `days` before the test runs, as stored (milliseconds kept). */
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const statements = async (tag: string) =>
  (await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8')).split('--> statement-breakpoint');

/**
 * The migration that makes KB items their decision globs, against Postgres: a database migrated up to the one before
 * it, with rows in the old table (and the queue migration run over them), then the migration itself.
 */
describe('KB items become decision globs (migration 0049)', () => {
  let admin: Database;
  let database: Database;
  let store: PgStore;
  let folder: string;
  let boardId: number;
  let otherBoard: number;
  let workGlob: string;
  const id = (n: number, board = boardId) => `s${String(board)}k${String(n)}`;
  const target = { kind: 'doc' as const, name: 'build', section: 'Test', newDocument: null };

  const base = (n: number, patch: Partial<LearningWire> = {}): LearningWire => ({
    id: id(n),
    boardId,
    status: 'open',
    type: 'gotcha',
    statement: `Learning ${String(n)}`,
    evidence: `Evidence ${String(n)}`,
    suggestedTarget: null,
    sourceGlobIds: [workGlob],
    source: 'submitted',
    signal: null,
    agentSetVersion: null,
    submittedBy: DEV,
    createdAt: ago(10),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    document: null,
    outcome: null,
    ...UNPROCESSED,
    version: 3,
    ...patch,
  });
  const drafted = (n: number, patch: Partial<LearningWire> = {}) =>
    base(n, { target, draft: { section: 'Test', content: '## Test\n\nRun vitest --run.' }, draftedAgainstVersion: 1, rationale: 'Why', processing: 'drafted', ...patch });

  const signal = {
    key: 'ci_after_local',
    kind: 'ci_after_local' as const,
    agent: 'implementer',
    label: 'CI failing after local checks passed',
    window: { from: ago(20), to: ago(10) },
    figures: { affected: 2, eligible: 3, rate: 0.667, count: 2 },
    globIds: ['s1t1'],
    examples: ['x'],
    measuredAt: ago(10),
  };
  const effectCheck = {
    state: 'watching' as const,
    key: 'ci_after_local',
    label: 'CI failing after local checks passed',
    basis: { kind: 'time' as const, since: ago(3) },
    n: 3,
    before: null,
    after: null,
    worse: [],
    checkedAt: ago(1),
    raisedItemId: null,
  };
  const hint = () => ({ kind: 'item' as const, id: id(20), quote: 'Run vitest', shortQuote: true as const, claim: 'duplicate' as const, ownQuote: 'Use vitest', tooShort: 'both' as const, alsoTarget: { quote: 't', reason: 'r' }, via: id(21) });
  const document = { name: 'architecture', area: 'architecture', audience: ['implementer'], description: 'How it fits', content: '# Architecture\n\nLayers.\n' };

  /** The rows, as the old pipeline left them. */
  const rows = (): LearningWire[] => [
    // Open, in four shapes.
    base(1),
    base(2, { target, processing: 'routed', suggestedTarget: 'build' }),
    drafted(3, { draftedAgainstVersion: 4 }),
    base(4, { document, target: { kind: 'doc', name: 'architecture', section: null, newDocument: { area: 'architecture', audience: ['implementer'], description: 'How it fits' } }, processing: 'drafted', sourceGlobIds: [] }),
    // Open, failed: an ordinary failure, one only Bedrock's being busy caused, and a claim left mid-call.
    base(5, { target, processing: 'failed', processingAttempts: 3, processingError: 'The draft answer was not usable JSON' }),
    base(6, { processing: 'failed', processingAttempts: 3, processingError: 'Too many requests, please wait before trying again.' }),
    base(7, { processing: 'pending', processingAttempts: 1, processingError: 'Bedrock is down', processAfter: '2099-01-01T00:00:00.000Z' }),
    // Decided: approved 3 and 45 days ago, rejected.
    drafted(8, { status: 'approved', decidedBy: ADMIN, decidedAt: ago(3), decisionReason: 'Good', outcome: { kind: 'applied', target: 'doc', name: 'build', version: 2 }, signal, effectCheck }),
    drafted(9, { status: 'approved', decidedBy: ADMIN, decidedAt: ago(45), outcome: { kind: 'learning' } }),
    base(10, { status: 'rejected', decidedBy: ADMIN, decidedAt: ago(2), decisionReason: 'Too vague' }),
    // Closed by the pipeline.
    base(11, { status: 'merged', target, duplicateOf: id(3), mergeNote: { by: 'intake', quote: 'Learning 11', survivorQuote: 'Learning 3', at: ago(9) } }),
    base(12, { status: 'suppressed', target, suppressedBy: id(10), mergeNote: { by: 'intake', quote: 'a', survivorQuote: 'b', at: ago(9) } }),
    base(13, { status: 'covered', target, coveredBy: { kind: 'item', id: id(9) } }),
    base(14, { status: 'covered', target, coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build', section: 'Test' } }),
    // Every link kind, and the fields with their own mapping.
    drafted(15, {
      possiblyCoveredBy: hint(),
      contradicts: [
        { kind: 'knowledge', ref: 'build § Test', note: 'Says vitest' },
        { kind: 'item', ref: id(3), note: 'Conflicts' },
      ],
      keptApartFrom: [id(11), id(12)],
      extraEvidence: [
        { itemId: id(30), globIds: [workGlob], evidence: 'First', submittedBy: 'a@example.com', at: ago(9) },
        { itemId: id(31), globIds: [], evidence: 'Second', submittedBy: 'b@example.com', at: ago(8) },
        { itemId: id(30), globIds: [], evidence: 'Third', submittedBy: 'a@example.com', at: ago(7) },
      ],
      staleSince: ago(5),
      staleReason: 'no_recent_evidence',
      staleDismissedAt: ago(60),
      catalogCandidate: true,
      catalogReason: 'Holds anywhere',
      occurrenceCount: 4,
      source: 'mined',
      agentSetVersion: 6,
      suggestedTarget: 'build doc',
    }),
    drafted(16, { possiblyCoveredBy: { knowledgeKind: 'doc', name: 'build', section: 'Test', quote: 'Run vitest', reason: 'Says it' } }),
    // Titles the cut must agree on.
    base(17, { statement: '\n\n   Leading blank lines\nsecond line' }),
    base(18, { statement: 'Windows line\r\nnext' }),
    base(19, { statement: 'x'.repeat(120) }),
    base(22, { statement: 'y'.repeat(121) }),
    base(23, { statement: '' }),
    // A learning on another board.
    { ...base(1), id: id(1, otherBoard), boardId: otherBoard, sourceGlobIds: [] },
  ];

  const item = (n: number, board = boardId) => store.transaction((tx) => learningSeed(tx).readSeeded(id(n, board)));
  const glob = (n: number, board = boardId) => store.transaction((tx) => tx.getGlob(id(n, board)));
  const jobs = async (n: number) =>
    (await database.db.execute(sql`select kind, state, attempts, last_error, run_after from outbox where glob_id = ${id(n)} and lane = 'llm' order by id`)).map((j) => ({
      kind: j.kind,
      state: j.state,
      attempts: j.attempts,
      lastError: j.last_error,
      runAfter: j.run_after,
    }));
  const artifacts = async (n: number) =>
    database.db.execute(sql`select kind, label, version, content, provenance, created_at from artifacts where glob_id = ${id(n)} order by id`);
  /** What the adapter should read for a seeded row: the row with its pipeline fields from its jobs. */
  const expected = async (row: LearningWire): Promise<LearningWire> => {
    const found = await database.db.execute(sql`select distinct on (kind) id, glob_id, kind, state, attempts, last_error, run_after from outbox where glob_id = ${row.id} order by kind, id desc`);
    const latest: OutboxJob[] = found.map((j) => ({
      id: Number(j.id),
      globId: String(j.glob_id),
      kind: j.kind === 'kb_route' ? 'kb_route' : 'kb_draft',
      state: j.state === 'failed' ? 'failed' : j.state === 'done' ? 'done' : j.state === 'dropped' ? 'dropped' : 'pending',
      attempts: Number(j.attempts),
      lastError: typeof j.last_error === 'string' ? j.last_error : null,
      runAfter: new Date(String(j.run_after)).toISOString(),
    }));
    return withProcessing(row, latest);
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    // Migrated up to the one before: a copy of the migrations without its journal entry.
    folder = await mkdtemp(join(tmpdir(), 'kb-migration-'));
    const drizzleDir = new URL('../drizzle', import.meta.url).pathname;
    await cp(drizzleDir, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag !== MOVE);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    store = new PgStore(database.db);
    const globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    [boardId, otherBoard] = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const ids: number[] = [];
      for (const name of ['one', 'two']) {
        const board = await tx.insertBoard({ name, repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
        await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
        await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
        ids.push(board.id);
      }
      return [ids[0] ?? 0, ids[1] ?? 0];
    });
    workGlob = unwrap(
      await globs.create(DEV, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    ).id;
    // The old table's rows, and what else referred to them by ID.
    await database.db.insert(kbProposals).values(rows().map(kbProposalRow));
    // Rows the old schema allowed but the pipeline never wrote: a decision without its time, evidence entries missing
    // their time or text, a merge note whose time doesn't parse.
    await database.db.insert(kbProposals).values([
      kbProposalRow(drafted(40, { status: 'approved', decidedBy: ADMIN, decidedAt: null, outcome: { kind: 'learning' } })),
      kbProposalRow(base(41)),
      kbProposalRow(base(42, { status: 'merged', target, duplicateOf: id(3) })),
    ]);
    await database.db.execute(sql`update kb_proposals set extra_evidence = ${JSON.stringify([{ itemId: id(30) }, { evidence: 'No time', submittedBy: 'c@example.com', at: 'some time last week' }])}::jsonb where id = ${id(41)}`);
    await database.db.execute(sql`update kb_proposals set merge_note = ${JSON.stringify({ by: 'intake', quote: 'a', survivorQuote: 'b', at: 'not a time' })}::jsonb where id = ${id(42)}`);
    await database.db.execute(sql`insert into id_counters (board_id, letter, n) values (${boardId}, 'k', 5) on conflict (board_id, letter) do update set n = 5`);
    await store.transaction((tx) =>
      tx.saveKnowledge({ boardId, kind: 'doc', name: 'build', area: 'build', audience: [], description: 'Build', content: '# Build\n\n## Test\n\nRun vitest.\n', layer: 'file', version: 1, source: `kb:${id(8)}`, updatedBy: ADMIN, updatedAt: ago(3) }),
    );
    // A glob an earlier build of this change put in front of an item (a development database).
    await database.db.execute(sql`
      insert into globs (id, board_id, version, status, type, group_name, planner, implementer, creation_key, data, updated_at)
      values (${id(1)}, ${boardId}, 1, 'planning', 'same', null, ${DEV}, null, ${`kb:${id(1)}`},
        ${JSON.stringify({ id: id(1), boardId, category: 'decision', attributes: { source: { kind: 'kb_item', id: id(1) }, kbItemId: id(1) } })}::jsonb, now())`);
    await database.db.execute(sql`insert into artifacts (glob_id, kind, label, version, content, provenance, created_at) values (${id(1)}, 'plan', '', 1, 'old', '{"by":"human","actor":"x","runId":null,"agentSetVersion":null}'::jsonb, now())`);
    // The queue migration over these rows, then the move.
    // Each in one transaction, as drizzle's migrator runs them.
    for (const tag of [QUEUE, MOVE]) {
      const parts = await statements(tag);
      await database.db.transaction(async (t) => {
        for (const statement of parts) await t.execute(sql.raw(statement));
      });
    }
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('drops kb_proposals, and every row reads back through the adapter as it was, its pipeline fields from its jobs', async () => {
    expect(await database.db.execute(sql`select to_regclass('kb_proposals') as t`)).toEqual([{ t: null }]);
    for (const row of rows()) {
      const read = await store.transaction((tx) => learningSeed(tx).readSeeded(row.id));
      expect(read, row.id).toEqual(await expected(row));
    }
    // One glob per learning, on its own board, with the creation key and no other.
    const counted = await database.db.execute(sql`select count(*)::int as n from globs where data->>'category' = 'decision'`);
    expect(counted[0]?.n).toBe(rows().length + 3);
    expect(await glob(1, otherBoard)).toMatchObject({ boardId: otherBoard });
    // The wrapper glob that stood in front of an item is replaced, its old artifacts gone.
    expect((await artifacts(1)).map((a) => a.content)).toEqual([proposalText(base(1))]);
  });

  it('queues each open learning\'s step: busy-only failures start over, other failures stay failed, a claim left mid-call is due at once', async () => {
    const pick = async (n: number) => (await jobs(n)).map((j) => ({ kind: j.kind, state: j.state, attempts: j.attempts, lastError: j.lastError }));
    expect(await pick(1)).toEqual([{ kind: 'kb_route', state: 'pending', attempts: 0, lastError: null }]);
    expect(await pick(2)).toEqual([{ kind: 'kb_draft', state: 'pending', attempts: 0, lastError: null }]);
    expect(await pick(3)).toEqual([]);
    expect(await pick(4)).toEqual([]);
    expect(await pick(5)).toEqual([{ kind: 'kb_draft', state: 'failed', attempts: 3, lastError: 'The draft answer was not usable JSON' }]);
    expect(await pick(6)).toEqual([{ kind: 'kb_route', state: 'pending', attempts: 0, lastError: null }]);
    expect(await pick(7)).toEqual([{ kind: 'kb_route', state: 'pending', attempts: 1, lastError: 'Bedrock is down' }]);
    const [claimed] = await jobs(7);
    expect(new Date(String(claimed?.runAfter)).getTime()).toBeLessThan(Date.now() + 60_000);
    for (const n of [8, 9, 10, 11, 12, 13, 14]) expect(await pick(n)).toEqual([]);
    // The SQL's busy test agrees with the one the pipeline used (`failedBecauseBusy`).
    for (const row of rows().filter((r) => r.status === 'open' && r.processing === 'failed')) {
      expect((await jobs(Number(row.id.split('k')[1]))).map((j) => j.state)).toEqual([failedBecauseBusy(row) ? 'pending' : 'failed']);
    }
    expect(await item(5)).toMatchObject({ processing: 'failed', processingAttempts: 3, processingError: 'The draft answer was not usable JSON' });
    expect(await item(6)).toMatchObject({ processing: 'pending', processingAttempts: 0, processingError: null });
  });

  it('puts open learnings in Planning with their payload, draft and document evidence', async () => {
    for (const n of [1, 2, 3, 4]) expect(await glob(n)).toMatchObject({ status: 'planning', category: 'decision', type: 'same', provisioning: 'none', version: 3, implementer: null, signedOffAt: null });
    expect(await glob(1)).toMatchObject({ attributes: { scope: { kind: 'future_work', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null } });
    const drafts = (await artifacts(3)).filter((a) => a.kind === 'draft');
    expect(drafts).toMatchObject([{ version: 1, content: '## Test\n\nRun vitest --run.', provenance: { draft: { targetVersion: 4, section: 'Test', rationale: 'Why' } } }]);
    const doc = await artifacts(4);
    expect(doc.map((a) => [a.kind, a.label, a.content])).toEqual([
      ['plan', '', document.content],
      ['attachment', 'evidence', 'Evidence 4'],
    ]);
    // The payload and the title are what the TypeScript writes.
    for (const row of rows().filter((r) => r.boardId === boardId)) {
      const g = await store.transaction((tx) => tx.getGlob(row.id));
      expect(g?.title, row.id).toBe(decisionGlobTitle(row.statement));
      const [plan] = (await artifacts(Number(row.id.split('k')[1]))).filter((a) => a.kind === 'plan');
      expect(plan?.content, row.id).toBe(proposalText(row));
    }
    expect((await glob(19))?.title).toBe('x'.repeat(120));
    expect((await glob(22))?.title).toBe(`${'y'.repeat(117)}...`);
    expect((await glob(23))?.title).toBe('Untitled decision');
    expect((await glob(17))?.title).toBe('Leading blank lines');
    expect((await glob(18))?.title).toBe('Windows line');
  });

  it('signs approvals off, archiving those older than 30 days but still reading them as approved', async () => {
    const recent = await glob(8);
    expect(recent).toMatchObject({ status: 'signed_off', implementer: ADMIN, signedOffAt: ago(3), attributes: { outcome: { kind: 'accept', by: ADMIN, at: ago(3), reason: 'Good' } } });
    expect(recent === null ? null : isArchivedDecision(recent)).toBe(false);
    const recentArtifacts = await artifacts(8);
    expect(recentArtifacts.find((a) => a.kind === 'outcome')).toMatchObject({ provenance: { kbOutcome: { kind: 'applied', name: 'build' }, actor: ADMIN } });
    expect(recentArtifacts.find((a) => a.kind === 'effect_check')).toMatchObject({ provenance: { effectCheck: { state: 'watching' } } });
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', undefined, [id(8)]));
    expect(events.map((e) => e.type)).toEqual(['GlobCreated', 'StatusChanged', 'DecisionDecided']);
    expect(events[2]).toMatchObject({ actor: ADMIN, at: ago(3), data: { via: 'migration', outcome: { kind: 'accept', reason: 'Good' } } });
    expect(await item(8)).toMatchObject({ status: 'approved', decidedBy: ADMIN, decidedAt: ago(3), decisionReason: 'Good' });

    const old = await glob(9);
    expect(old).toMatchObject({ status: 'signed_off', attributes: { archived: true } });
    expect(await item(9)).toMatchObject({ status: 'approved' });
    const approved = await store.transaction((tx) => learningSeed(tx).listSeeded(boardId, 'approved'));
    // (s1k40 is an approval that lost its time, below.)
    expect(approved.map((i) => i.id)).toEqual([id(40), id(8), id(9)]);
  });

  it('archives rejections with their reason, and closures with closedAs and the link to what closed them', async () => {
    expect(await glob(10)).toMatchObject({ status: 'signed_off', implementer: ADMIN, attributes: { archived: true, outcome: { kind: 'reject', reason: 'Too vague' } } });
    expect(await item(10)).toMatchObject({ status: 'rejected', decisionReason: 'Too vague' });
    const merged = await glob(11);
    expect(merged).toMatchObject({
      status: 'signed_off',
      implementer: null,
      signedOffAt: ago(9),
      attributes: { archived: true, closedAs: 'merged', outcome: { kind: 'closed', by: 'slop' } },
      links: [{ id: id(3), kind: 'duplicate_of', source: 'pipeline' }],
    });
    expect((await artifacts(11)).find((a) => a.label === 'merge_note')).toMatchObject({ provenance: { mergeNote: { by: 'intake', survivorQuote: 'Learning 3' } } });
    expect(await glob(12)).toMatchObject({ attributes: { closedAs: 'suppressed' }, links: [{ id: id(10), kind: 'suppressed_by' }] });
    expect(await glob(13)).toMatchObject({ attributes: { closedAs: 'covered' }, links: [{ id: id(9), kind: 'covered_by' }] });
    const byText = await glob(14);
    expect(byText).toMatchObject({ attributes: { closedAs: 'covered', coveredByText: { name: 'build', section: 'Test' } }, links: [] });
    expect(await item(14)).toMatchObject({ status: 'covered', coveredBy: { kind: 'knowledge', name: 'build' } });
  });

  it('keeps every link kind apart from the dependency edges, each naming a learning on the same board', async () => {
    const g = await glob(15);
    expect(g?.links).toEqual([
      { id: id(20), kind: 'possibly_covered_by', source: 'pipeline', detail: { quote: 'Run vitest', shortQuote: true, claim: 'duplicate', ownQuote: 'Use vitest', tooShort: 'both', alsoTarget: { quote: 't', reason: 'r' }, via: id(21) } },
      { id: id(3), kind: 'contradicts', source: 'pipeline', detail: { note: 'Conflicts', position: 1 } },
      { id: id(11), kind: 'kept_apart_from', source: 'explicit' },
      { id: id(12), kind: 'kept_apart_from', source: 'explicit' },
    ]);
    expect(g?.after ?? []).toEqual([]);
    expect(g?.attributes).toMatchObject({ contradictsText: [{ kind: 'knowledge', ref: 'build § Test' }], evidenceCount: 4, catalogCandidate: true, agentSetVersion: 6, origin: { kind: 'mined' }, channel: 'mined' });
    expect((await glob(16))?.attributes).toMatchObject({ possiblyCoveredByText: { name: 'build', quote: 'Run vitest' } });
    // Evidence from near-duplicates: one attachment each, labels distinct, in order.
    expect((await artifacts(15)).filter((a) => String(a.label).startsWith('evidence:')).map((a) => a.label)).toEqual([`evidence:${id(30)}`, `evidence:${id(31)}`, `evidence:${id(30)}#2`]);
    for (const link of g?.links ?? []) {
      if (link.id === id(20) || link.id === id(21)) continue;
      expect((await store.transaction((tx) => tx.getGlob(link.id)))?.boardId).toBe(boardId);
    }
  });

  it('keeps the k counter ahead of every item, and leaves what referred to items by ID alone', async () => {
    const [counter] = await database.db.execute(sql`select n from id_counters where board_id = ${boardId} and letter = 'k'`);
    // The highest item number on the board (k42), over a counter left behind at 5.
    expect(counter?.n).toBe(42);
    expect((await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'build')))?.source).toBe(`kb:${id(8)}`);
    const knowledge = new KnowledgeService({ store, clock: { now: () => new Date().toISOString() }, catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h', files: [] }) }, notifier: { publish: () => undefined } });
    const next = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: workGlob, type: 'gotcha', statement: 'After the move', evidence: 'x' }));
    expect(next.id).toBe(id(43));
  });

  it('approves a migrated drafted learning end to end, and reopens a merged one with the pair kept apart', async () => {
    const knowledge = new KnowledgeService({ store, clock: { now: () => new Date().toISOString() }, catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h', files: [] }) }, notifier: { publish: () => undefined } });
    const drafted15 = await item(15);
    if (drafted15 === null) throw new Error('missing');
    const approved = unwrap(await knowledge.approve(ADMIN, drafted15.id, drafted15.version, { as: 'draft' }));
    expect(approved).toMatchObject({ status: 'approved', outcome: { kind: 'applied', name: 'build' } });
    expect(await glob(15)).toMatchObject({ status: 'reviewing', attributes: { outcome: { kind: 'accept', by: ADMIN } } });
    expect((await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'build')))?.content).toContain('Run vitest --run.');

    const merged = await item(11);
    if (merged === null) throw new Error('missing');
    const reopened = unwrap(await knowledge.reopen(ADMIN, merged.id, merged.version));
    expect(reopened).toMatchObject({ status: 'open', duplicateOf: null, keptApartFrom: [id(3)] });
    expect(await glob(11)).toMatchObject({ status: 'planning', links: [{ id: id(3), kind: 'kept_apart_from', source: 'explicit' }] });
    expect((await item(3))?.keptApartFrom).toContain(id(11));
    expect((await jobs(11)).at(-1)).toMatchObject({ kind: 'kb_draft', state: 'pending' });
  });

  it('moves rows the old schema allowed but the pipeline never wrote, dating what has no usable time by the submission', async () => {
    const created = base(40).createdAt;
    expect(await glob(40)).toMatchObject({ status: 'signed_off', signedOffAt: created, attributes: { outcome: { kind: 'accept', at: created } } });
    expect(await item(40)).toMatchObject({ status: 'approved', decidedBy: ADMIN, decidedAt: created });
    const evidence = (await artifacts(41)).filter((a) => String(a.label).startsWith('evidence:'));
    expect(evidence.map((a) => [a.label, a.content, new Date(String(a.created_at)).toISOString()])).toEqual([
      [`evidence:${id(30)}`, '', created],
      ['evidence:', 'No time', created],
    ]);
    expect((await item(41))?.extraEvidence).toMatchObject([{ itemId: id(30), evidence: '' }, { itemId: '', evidence: 'No time', submittedBy: 'c@example.com' }]);
    expect(await glob(42)).toMatchObject({ status: 'signed_off', signedOffAt: created, attributes: { closedAs: 'merged' } });
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['DecisionDecided'], [id(42)]));
    // The shape `closeDecision` writes.
    expect(events.map((e) => e.data)).toEqual([
      { outcome: { kind: 'closed', reason: 'The knowledge pipeline closed the item as merged' }, closedAs: 'merged', link: { id: id(3), kind: 'duplicate_of', source: 'pipeline' } },
    ]);
  });
});
