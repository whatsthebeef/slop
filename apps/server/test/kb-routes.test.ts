import {
  ArtifactService,
  BoardService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  MAX_PROCESSING_ATTEMPTS,
} from '@slop/core';
import type { Catalog, KbItem, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeHost } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by the knowledge routes'));

/** The knowledge routes only read `configured` and `connection` (repo connection); nothing here calls them. */
const host: CodeHost = {
  configured: false,
  connection: unused,
  provision: unused,
  openDraftPr: unused,
  syncLabels: unused,
  closePr: unused,
  deleteBranch: unused,
  reopenPr: unused,
  mergeState: unused,
  conflictFiles: unused,
  completedCheckRun: unused,
  readFile: unused,
  markReady: unused,
  diffSummary: unused,
  squashMerge: unused,
  commentOnce: unused,
};

const TS_V2 =
  '---\ncatalog: typescript_conventions\nversion: 2\narea: conventions\ndescription: TS.\n---\nNo any.\nNo casts.\n';

const catalog: Catalog = {
  kbEntries: () =>
    Promise.resolve([
      {
        id: 'typescript_conventions',
        version: 2,
        fileName: 'typescript_conventions.md',
        content: TS_V2,
      },
    ]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

describe('KB routes: retrying failed items and catalog updates', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let knowledge: KnowledgeService;
  let app: Hono<Env>;
  let boardId: number;
  let globId: string;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_routes'));
    store = new PgStore(database.db);
    const deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    knowledge = new KnowledgeService({ ...deps, catalog });
    const globs = new GlobService({
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
      host,
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

  const post = (path: string, body: unknown, email = ADMIN) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-email': email },
      body: JSON.stringify(body),
    });

  it('POST /api/kb/:id/retry re-queues a failed item for admins, conditional on its version', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: globId,
        type: 'gotcha',
        statement: 'Retry me',
        evidence: 'Seen',
      }),
    );
    await database.db.execute(
      sql`update kb_proposals set processing = 'failed', processing_error = 'Haiku is down', processing_attempts = ${MAX_PROCESSING_ATTEMPTS}, version = 2 where id = ${id}`,
    );
    expect((await post(`/api/kb/${id}/retry`, { version: 2 }, DEV)).status).toBe(403);
    expect((await post(`/api/kb/${id}/retry`, {})).status).toBe(422);
    const stale = await post(`/api/kb/${id}/retry`, { version: 1 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentItem: KbItem }).currentItem.version).toBe(2);

    const response = await post(`/api/kb/${id}/retry`, { version: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      processing: 'pending',
      processingError: null,
      processingAttempts: 0,
      version: 3,
    });
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({
      processing: 'pending',
      processingAttempts: 0,
      version: 3,
    });
    // Only failed items: retrying again is refused.
    expect((await post(`/api/kb/${id}/retry`, { version: 3 })).status).toBe(422);
  });

  it('POST /api/kb/:id/reopen sends a covered item back to drafting for admins, conditional on its version', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, { sourceGlobId: globId, type: 'gotcha', statement: 'Reopen me', evidence: 'Seen' }),
    );
    const target = { kind: 'doc', name: 'testing', section: null, newDocument: null };
    const coveredBy = { kind: 'knowledge', knowledgeKind: 'doc', name: 'testing', section: null };
    await database.db.execute(
      sql`update kb_proposals set status = 'covered', processing = 'routed', target = ${JSON.stringify(target)}::jsonb, covered_by = ${JSON.stringify(coveredBy)}::jsonb, version = 2 where id = ${id}`,
    );
    expect((await post(`/api/kb/${id}/reopen`, { version: 2 }, DEV)).status).toBe(403);
    expect((await post(`/api/kb/${id}/reopen`, {})).status).toBe(422);
    expect((await post(`/api/kb/${id}/reopen`, { version: 1 })).status).toBe(409);

    const response = await post(`/api/kb/${id}/reopen`, { version: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: 'open', coveredBy: null, processing: 'routed', target, version: 3 });
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({ status: 'open', coveredBy: null, processing: 'routed' });
    // Only closed items: reopening an open one is refused.
    expect((await post(`/api/kb/${id}/reopen`, { version: 3 })).status).toBe(422);
  });

  it('GET /api/boards/:b/kb/proposals lists open items and the newest decided ones up to the limit, with totals', async () => {
    const rejected: string[] = [];
    for (const statement of ['Old rule', 'Newer rule']) {
      const { id } = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: globId, type: 'gotcha', statement, evidence: 'Seen' }));
      unwrap(await knowledge.reject(ADMIN, id, 1, 'No'));
      rejected.push(id);
    }
    const get = (query: string) => app.request(`/api/boards/${boardId}/kb/proposals${query}`, { headers: { 'x-test-email': DEV } });
    const response = await get('?limit=1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { open: KbItem[]; decided: { items: KbItem[]; total: number }; closed: { total: number } };
    expect(body.decided.items.map((i) => i.id)).toEqual([rejected[1]]);
    expect(body.decided.total).toBe(2);
    expect(body.open.every((i) => i.status === 'open')).toBe(true);
    expect((await get('')).status).toBe(200);
    expect((await get('?limit=0')).status).toBe(422);
    expect((await get('?limit=1001')).status).toBe(422);

    // Ordered by decision, not submission: the older item decided last leads the page.
    await database.db.execute(sql`update kb_proposals set decided_at = now() + interval '1 hour' where id = ${rejected[0]}`);
    const redecided = (await (await get('?limit=1')).json()) as { decided: { items: KbItem[] } };
    expect(redecided.decided.items.map((i) => i.id)).toEqual([rejected[0]]);
  });

  it('GET /api/boards/:b/kb lists documents forked from an older catalog version', async () => {
    const kb = async () => {
      const response = await app.request(`/api/boards/${String(boardId)}/kb`, {
        headers: { 'x-test-email': DEV },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { catalogUpdates: unknown[] };
    };
    unwrap(await knowledge.importCatalogEntries(ADMIN, boardId, ['typescript_conventions']));
    expect((await kb()).catalogUpdates).toEqual([]);
    await database.db.execute(
      sql`update knowledge set source = 'catalog:typescript_conventions@1', content = ${'No any.\n'} where board_id = ${boardId} and name = 'typescript_conventions'`,
    );
    expect((await kb()).catalogUpdates).toEqual([
      {
        name: 'typescript_conventions',
        catalogId: 'typescript_conventions',
        forkedVersion: 1,
        catalogVersion: 2,
        board: 'No any.\n',
        catalog: 'No any.\nNo casts.\n',
      },
    ]);
  });

  it('GET /api/globs/:id/findings shows members the glob\'s findings and refuses others', async () => {
    const outsider = 'outsider@example.com';
    await store.transaction((tx) => tx.upsertUser({ email: outsider, name: 'Outsider', active: true }));
    const get = (email: string, id = globId) => app.request(`/api/globs/${id}/findings`, { headers: { 'x-test-email': email } });
    const member = await get(DEV);
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ findings: [], byClass: [], pending: 0, failed: 0, sources: { pending: 0, failed: 0 }, waiting: null });
    expect((await get(outsider)).status).toBe(403);
    expect((await get(DEV, 's999t1')).status).toBe(404);
  });
});
