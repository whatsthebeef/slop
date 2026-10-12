import {
  kbItems,
  ArtifactService,
  BoardService,
  DecisionGlobService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MAX_PROCESSING_ATTEMPTS,
  MiningService,
} from '@slop/core';
import type { Catalog, KbItem, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountDecisionGlobs } from '../src/http/decision-globs.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

/**
 * The wire contract of the KB routes and MCP tools: every response that carries a learning, as full JSON, key order
 * included. Recorded before the knowledge service moved off the KbItem adapter (s15t72) and kept as the contract the
 * Knowledge page and agents rely on.
 */

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-05T12:00:00.000Z';
const WRITES = { clock: { now: () => NOW } };

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by the knowledge routes'));

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

/** A learning's keys in the order the wire has them. */
const ITEM_KEYS = [
  'id',
  'boardId',
  'status',
  'type',
  'statement',
  'evidence',
  'suggestedTarget',
  'sourceGlobIds',
  'source',
  'signal',
  'agentSetVersion',
  'submittedBy',
  'createdAt',
  'decidedBy',
  'decidedAt',
  'decisionReason',
  'document',
  'outcome',
  'processing',
  'processingError',
  'processingAttempts',
  'processAfter',
  'target',
  'catalogCandidate',
  'catalogReason',
  'occurrenceCount',
  'extraEvidence',
  'duplicateOf',
  'suppressedBy',
  'coveredBy',
  'possiblyCoveredBy',
  'contradicts',
  'draft',
  'draftedAgainstVersion',
  'rationale',
  'staleSince',
  'staleReason',
  'staleDismissedAt',
  'keptApartFrom',
  'mergeNote',
  'effectCheck',
  'version',
];
const VIEW_KEYS = [...ITEM_KEYS, 'preview', 'evidenceCount', 'lastEvidenceAt'];

const TESTING_DOC = '---\narea: build\ndescription: How to test.\n---\n## Test\n\nRun vitest.\n';
const TARGET = { kind: 'doc', name: 'testing', section: 'Test', newDocument: null } as const;
const DRAFT = { section: 'Test', content: '## Test\n\nRun vitest with --reporter=dot.\n' };

describe('the KB wire contract', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let knowledge: KnowledgeService;
  let globs: GlobService;
  let app: Hono<Env>;
  let client: Client;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_wire'));
    store = new PgStore(database.db);
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => NOW } };
    knowledge = new KnowledgeService({ ...deps, catalog });
    globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? ADMIN);
      await next();
    });
    mountKnowledge(app, {
      knowledge,
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards: new BoardService(deps),
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining: new MiningService(deps), manifests: null }),
      logError: () => undefined,
    });
    mountDecisionGlobs(app, {
      decisions: new DecisionGlobService({ ...deps, knowledge, globs }),
      globs,
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
    });
    const server = buildServer(
      { globs, knowledge } as unknown as McpDeps,
      ADMIN,
      'http://localhost',
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  /** A board of its own (so lists hold only the test's items), with a `testing` document and a source glob. */
  const newBoard = async (): Promise<{ boardId: number; sourceGlobId: string }> => {
    const boardId = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'wire',
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
    unwrap(
      await knowledge.importDocuments(
        ADMIN,
        boardId,
        [{ fileName: 'testing.md', content: TESTING_DOC }],
        'upload',
      ),
    );
    const source = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Source',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    return { boardId, sourceGlobId: source.id };
  };

  const submit = async (
    boardId: number,
    sourceGlobId: string,
    statement: string,
  ): Promise<string> =>
    unwrap(
      await knowledge.submitLearning(ADMIN, boardId, {
        sourceGlobId,
        type: 'gotcha',
        statement,
        evidence: 'Seen in review',
      }),
    ).id;

  const read = async (id: string): Promise<KbItem> => {
    const item = await store.transaction((tx) => kbItems(tx).getKbItem(id));
    if (item === null) throw new Error(`missing ${id}`);
    return item;
  };
  /** Writes the item through the adapter, as the pipeline would. */
  const write = async (id: string, patch: Partial<KbItem>): Promise<void> => {
    const current = await read(id);
    const written = await store.transaction((tx) =>
      kbItems(tx, WRITES).updateKbItem(
        { ...current, ...patch, version: current.version + 1 },
        current.version,
      ),
    );
    if (!written) throw new Error(`lost the write to ${id}`);
  };
  const drafted = (id: string) =>
    write(id, { target: TARGET, draft: DRAFT, draftedAgainstVersion: 1, rationale: 'Says how' });

  const post = (path: string, body: unknown, email = ADMIN) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-email': email },
      body: JSON.stringify(body),
    });
  const get = (path: string, email = ADMIN) =>
    app.request(path, { headers: { 'x-test-email': email } });
  const tool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { text: string }[];
    return { isError: result.isError === true, body: JSON.parse(first?.text ?? 'null') as unknown };
  };

  /** A learning as the wire has it: a submitted gotcha nobody has touched, with `patch` over it. */
  const item = (
    id: string,
    boardId: number,
    sourceGlobId: string,
    patch: Record<string, unknown> = {},
  ) => ({
    id,
    boardId,
    status: 'open',
    type: 'gotcha',
    statement: 'Generated files live in src/gen/',
    evidence: 'Seen in review',
    suggestedTarget: null,
    sourceGlobIds: [sourceGlobId],
    source: 'submitted',
    signal: null,
    agentSetVersion: null,
    submittedBy: ADMIN,
    createdAt: NOW,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    document: null,
    outcome: null,
    processing: 'pending',
    processingError: null,
    processingAttempts: 0,
    processAfter: null,
    target: null,
    catalogCandidate: false,
    catalogReason: null,
    occurrenceCount: 1,
    extraEvidence: [],
    duplicateOf: null,
    suppressedBy: null,
    coveredBy: null,
    possiblyCoveredBy: null,
    contradicts: [],
    draft: null,
    draftedAgainstVersion: null,
    rationale: null,
    staleSince: null,
    staleReason: null,
    staleDismissedAt: null,
    keptApartFrom: [],
    mergeNote: null,
    effectCheck: null,
    version: 1,
    ...patch,
  });
  const draftedFields = {
    processing: 'drafted',
    target: TARGET,
    draft: DRAFT,
    draftedAgainstVersion: 1,
    rationale: 'Says how',
    version: 2,
  };
  const PREVIEW = {
    version: 1,
    stale: false,
    diff: [
      { op: 'same', text: '## Test' },
      { op: 'same', text: '' },
      { op: 'removed', text: 'Run vitest.' },
      { op: 'added', text: 'Run vitest with --reporter=dot.' },
    ],
  };
  const keysOf = (value: unknown): string[] =>
    typeof value === 'object' && value !== null ? Object.keys(value) : [];

  it('submit_learning answers with the ID twice; list_kb_items lists open items by evidence with their previews', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const submitted = await tool('submit_learning', {
      board: boardId,
      sourceGlobId,
      type: 'gotcha',
      statement: 'Generated files live in src/gen/',
      evidence: 'Seen in review',
    });
    expect(submitted.isError).toBe(false);
    const id = `s${String(boardId)}k1`;
    expect(submitted.body).toEqual({ id, globId: id });
    expect(keysOf(submitted.body)).toEqual(['id', 'globId']);

    const second = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await drafted(second);
    const listed = await tool('list_kb_items', { board: boardId });
    expect(listed.isError).toBe(false);
    const view = { evidenceCount: 1, lastEvidenceAt: NOW };
    expect(listed.body).toEqual([
      { ...item(id, boardId, sourceGlobId), preview: null, ...view },
      { ...item(second, boardId, sourceGlobId, draftedFields), preview: PREVIEW, ...view },
    ]);
    expect(Array.isArray(listed.body) ? listed.body.map(keysOf) : null).toEqual([
      VIEW_KEYS,
      VIEW_KEYS,
    ]);
  });

  it('GET proposals lists open, decided and closed items, each as a view', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const open = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await drafted(open);
    const rejected = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    unwrap(await knowledge.reject(ADMIN, rejected, 1, 'Not a rule'));
    const covered = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await write(covered, {
      status: 'covered',
      target: TARGET,
      coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'testing', section: null },
    });

    const response = await get(`/api/boards/${String(boardId)}/kb/proposals`, DEV);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const view = { evidenceCount: 1, lastEvidenceAt: NOW };
    expect(body).toEqual({
      open: [{ ...item(open, boardId, sourceGlobId, draftedFields), preview: PREVIEW, ...view }],
      decided: {
        items: [
          {
            ...item(rejected, boardId, sourceGlobId, {
              status: 'rejected',
              decidedBy: ADMIN,
              decidedAt: NOW,
              decisionReason: 'Not a rule',
              processing: 'none',
              version: 2,
            }),
            preview: null,
            ...view,
          },
        ],
        total: 1,
      },
      closed: {
        items: [
          {
            ...item(covered, boardId, sourceGlobId, {
              status: 'covered',
              processing: 'none',
              target: TARGET,
              coveredBy: {
                kind: 'knowledge',
                knowledgeKind: 'doc',
                name: 'testing',
                section: null,
              },
              version: 2,
            }),
            preview: null,
            ...view,
          },
        ],
        total: 1,
      },
    });
    expect(keysOf(body)).toEqual(['open', 'decided', 'closed']);
  });

  it('POST target answers the routed item; a stale version answers the conflict with the current item', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const id = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await drafted(id);
    const target = { kind: 'doc', name: 'testing', section: null, newDocument: null };
    const response = await post(`/api/kb/${id}/target`, { version: 2, target });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(
      item(id, boardId, sourceGlobId, { processing: 'routed', target, version: 3 }),
    );
    expect(keysOf(body)).toEqual(ITEM_KEYS);

    const stale = await post(`/api/kb/${id}/target`, { version: 2, target });
    expect(stale.status).toBe(409);
    const conflict: unknown = await stale.json();
    expect(conflict).toEqual({
      code: 'version_conflict',
      message: `${id} has changed`,
      currentItem: item(id, boardId, sourceGlobId, { processing: 'routed', target, version: 3 }),
    });
    expect(keysOf(conflict)).toEqual(['code', 'message', 'currentItem']);
  });

  it('POST retry answers the item waiting again', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const id = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await database.db.execute(
      sql`update outbox set state = 'failed', last_error = 'Haiku is down', attempts = ${MAX_PROCESSING_ATTEMPTS} where glob_id = ${id} and kind = 'kb_route'`,
    );
    expect(await read(id)).toMatchObject({
      processing: 'failed',
      processingError: 'Haiku is down',
      processingAttempts: MAX_PROCESSING_ATTEMPTS,
    });
    const response = await post(`/api/kb/${id}/retry`, { version: 1 });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(item(id, boardId, sourceGlobId, { version: 2 }));
    expect(keysOf(body)).toEqual(ITEM_KEYS);
  });

  it('POST target to the same target while drafting failed answers the item as failed: nothing was queued (s15t72)', async () => {
    // The one intended wire change of s15t72: the answer is the learning as stored. Before, it was a built value that
    // claimed `routed` although the retarget queued no job (the step and target were unchanged).
    const { boardId, sourceGlobId } = await newBoard();
    const id = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await write(id, { target: TARGET });
    await database.db.execute(
      sql`update outbox set state = 'failed', last_error = 'Opus is down', attempts = ${MAX_PROCESSING_ATTEMPTS} where glob_id = ${id} and kind = 'kb_draft'`,
    );
    const response = await post(`/api/kb/${id}/target`, {
      version: 2,
      target: { kind: 'doc', name: 'testing', section: 'Test', newDocument: null },
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(
      item(id, boardId, sourceGlobId, {
        processing: 'failed',
        processingError: 'Opus is down',
        processingAttempts: MAX_PROCESSING_ATTEMPTS,
        target: TARGET,
        version: 3,
      }),
    );
    expect(keysOf(body)).toEqual(ITEM_KEYS);
    // No new drafting job: the failed one is still the newest.
    const jobs = await database.db.execute(
      sql`select state from outbox where glob_id = ${id} and kind = 'kb_draft' order by id`,
    );
    expect(jobs.map((j) => j.state)).toEqual(['failed']);
  });

  it('POST reopen answers a reopened merge, kept apart from the item it was merged into', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const survivor = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const merged = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const note = {
      by: 'intake',
      quote: 'Generated files live in src/gen/',
      survivorQuote: 'Generated files live in src/gen/',
      at: NOW,
    } as const;
    await write(merged, {
      status: 'merged',
      target: TARGET,
      duplicateOf: survivor,
      mergeNote: note,
    });
    expect(await read(merged)).toMatchObject({ status: 'merged', mergeNote: note });
    const response = await post(`/api/kb/${merged}/reopen`, { version: 2 });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(
      item(merged, boardId, sourceGlobId, {
        processing: 'routed',
        target: TARGET,
        keptApartFrom: [survivor],
        version: 3,
      }),
    );
    expect(keysOf(body)).toEqual(ITEM_KEYS);
    expect(await read(survivor)).toMatchObject({ keptApartFrom: [merged], version: 2 });
  });

  it('POST keep answers the item with its stale flag dismissed', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const id = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await write(id, { staleSince: NOW, staleReason: 'no_recent_evidence' });
    const response = await post(`/api/kb/${id}/keep`, { version: 2 });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(item(id, boardId, sourceGlobId, { staleDismissedAt: NOW, version: 3 }));
    expect(keysOf(body)).toEqual(ITEM_KEYS);
  });

  it('POST approve and reject answer the decided item; get_conventions serves the approved learning', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const approved = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const response = await post(`/api/kb/${approved}/approve`, {
      version: 1,
      as: 'learning',
      statement: 'Generated files live in src/generated/',
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(
      item(approved, boardId, sourceGlobId, {
        status: 'approved',
        statement: 'Generated files live in src/generated/',
        decidedBy: ADMIN,
        decidedAt: NOW,
        outcome: { kind: 'learning' },
        processing: 'none',
        version: 2,
      }),
    );
    expect(keysOf(body)).toEqual(ITEM_KEYS);

    const rejected = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const refused = await post(`/api/kb/${rejected}/reject`, { version: 1, reason: 'Not a rule' });
    expect(refused.status).toBe(200);
    const rejection: unknown = await refused.json();
    expect(rejection).toEqual(
      item(rejected, boardId, sourceGlobId, {
        status: 'rejected',
        decidedBy: ADMIN,
        decidedAt: NOW,
        decisionReason: 'Not a rule',
        processing: 'none',
        version: 2,
      }),
    );
    expect(keysOf(rejection)).toEqual(ITEM_KEYS);

    const conventions = await tool('get_conventions', { board: boardId });
    expect(conventions.isError).toBe(false);
    expect(conventions.body).toEqual({
      documents: [
        {
          name: 'testing',
          area: 'build',
          audience: [],
          description: 'How to test.',
          version: 1,
          source: 'upload',
        },
      ],
      learnings: [
        {
          id: approved,
          type: 'gotcha',
          statement: 'Generated files live in src/generated/',
          sourceGlobIds: [sourceGlobId],
          approvedAt: NOW,
        },
      ],
    });
  });

  it('decide_kb_item approves a draft and rejects with a reason, as the agent; list_kb_items lists the decided ones', async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const approved = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    await drafted(approved);
    const approval = await tool('decide_kb_item', {
      id: approved,
      version: 2,
      decision: 'approve',
    });
    expect(approval.isError).toBe(false);
    const approvedItem = item(approved, boardId, sourceGlobId, {
      ...draftedFields,
      status: 'approved',
      decidedBy: ADMIN,
      decidedAt: NOW,
      outcome: { kind: 'applied', target: 'doc', name: 'testing', version: 2, via: 'agent' },
      processing: 'none',
      version: 3,
    });
    expect(approval.body).toEqual(approvedItem);
    expect(keysOf(approval.body)).toEqual(ITEM_KEYS);

    const rejected = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const rejection = await tool('decide_kb_item', {
      id: rejected,
      version: 1,
      decision: 'reject',
      reason: 'Not a rule',
    });
    expect(rejection.isError).toBe(false);
    const rejectedItem = item(rejected, boardId, sourceGlobId, {
      status: 'rejected',
      decidedBy: ADMIN,
      decidedAt: NOW,
      decisionReason: 'Not a rule',
      outcome: { kind: 'rejected', via: 'agent' },
      processing: 'none',
      version: 2,
    });
    expect(rejection.body).toEqual(rejectedItem);
    expect(keysOf(rejection.body)).toEqual(ITEM_KEYS);

    const stale = await tool('decide_kb_item', {
      id: rejected,
      version: 1,
      decision: 'reject',
      reason: 'Again',
    });
    expect(stale.isError).toBe(true);
    expect(stale.body).toEqual({
      code: 'version_conflict',
      message: `${rejected} has changed`,
      currentItem: rejectedItem,
    });

    const view = { preview: null, evidenceCount: 1, lastEvidenceAt: NOW };
    expect((await tool('list_kb_items', { board: boardId, status: 'approved' })).body).toEqual([
      { ...approvedItem, ...view },
    ]);
    expect((await tool('list_kb_items', { board: boardId, status: 'rejected' })).body).toEqual([
      { ...rejectedItem, ...view },
    ]);
  });

  it("GET a decision's diff answers its target, draft and preview", async () => {
    const { boardId, sourceGlobId } = await newBoard();
    const id = await submit(boardId, sourceGlobId, 'Generated files live in src/gen/');
    const before: unknown = await (await get(`/api/globs/${id}/diff`)).json();
    expect(before).toEqual({ target: null, currentVersion: null, preview: null, draft: null });
    await drafted(id);
    const response = await get(`/api/globs/${id}/diff`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ target: TARGET, currentVersion: 1, preview: PREVIEW, draft: DRAFT });
    expect(keysOf(body)).toEqual(['target', 'currentVersion', 'preview', 'draft']);
  });
});
