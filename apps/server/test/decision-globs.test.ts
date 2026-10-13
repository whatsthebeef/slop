import { readFile } from 'node:fs/promises';
import { BoardService, DecisionGlobService, GlobService, InboxService, KnowledgeService, learningSeed, SuggestService } from '@slop/core';
import type { Catalog, Effect, Glob, Llm, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { codeHostExecutors } from '../src/codehost-executors.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountDecisionGlobs } from '../src/http/decision-globs.js';
import { mountInbox } from '../src/http/inbox.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { FileRoutines } from '../src/routines.js';
import { SignedLinks } from '../src/signed-links.js';
import { suggestExecutors } from '../src/suggest-executors.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';
const PO = 'po@example.com';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

interface View {
  id: string;
  status: string;
  category: string;
  version: number;
  attributes?: { scope: { kind: string; ref: string | null }; outcome: { kind: string } | null; archived?: true; kbItemId: string | null };
  allowedActions?: string[];
}

/** Decision globs on real Postgres: the store, migration 0046, the routes with their role gates, the board list and the MCP surface. */
describe('decision globs', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let knowledge: KnowledgeService;
  let decisionGlobs: DecisionGlobService;
  let suggest: SuggestService;
  let suggestAnswer = '';
  let globs: GlobService;
  let boardId = 0;
  let sourceGlobId = '';
  let client: Client;
  const hub = new HintHub();

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('decision_globs'));
    store = new PgStore(database.db);
    const clock = { now: () => new Date().toISOString() };
    globs = new GlobService({
      store,
      notifier: hub,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boards = new BoardService({ store, notifier: hub });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub });
    decisionGlobs = new DecisionGlobService({ store, clock, notifier: hub, knowledge, globs });
    const inbox = new InboxService({ store, clock, notifier: hub });
    const fakeLlm: Llm = { complete: () => Promise.resolve(suggestAnswer) };
    suggest = new SuggestService({ store, clock, notifier: hub, knowledge, llm: fakeLlm, model: 'test-model' });
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(database.db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
      decisions: decisionGlobs,
    });
    mountDecisionGlobs(app, { decisions: decisionGlobs, suggest, globs });
    mountInbox(app, { inbox, decisionGlobs });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, PO, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    sourceGlobId = unwrap(
      await globs.create(DEV, { boardId, title: 'Source', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    ).id;
    const server = buildServer({ globs, knowledge } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  const call = (email: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer dev:${email}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const view = async (id: string) => json<View>(await call(ADMIN, 'GET', `/api/globs/${id}`));
  const submit = async (statement: string, type: 'pattern' | 'gotcha' = 'pattern') =>
    unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId, type, statement, evidence: 'Seen in review', suggestedTarget: null, document: null }));
  /** An item the pipeline gave up routing is kept as a learning when accepted (no drafting needed). */
  /** The pipeline gave up on routing the item: its job failed (it can still be decided as a learning). */
  const settle = (itemId: string) =>
    database.db.execute(sql`update outbox set state = 'failed', attempts = 3, last_error = 'The routing answer was not usable JSON' where glob_id = ${itemId} and lane = 'llm'`);
  const pickUp = async (id: string, email = ADMIN) => {
    const response = await call(email, 'POST', `/api/globs/${id}/actions/pick-up`, { version: (await view(id)).version });
    return response;
  };
  const decide = async (id: string, body: Record<string, unknown>, email = ADMIN) =>
    call(email, 'POST', `/api/globs/${id}/decision`, { version: (await view(id)).version, ...body });

  describe('the migrations', () => {
    it('leave no kb_proposals table (the items are their decision globs), with the journal in order', async () => {
      expect(await database.db.execute(sql`select to_regclass('kb_proposals') as t`)).toEqual([{ t: null }]);
      const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
      const whens = journal.entries.map((e) => e.when);
      expect(whens).toEqual([...whens].sort((a, b) => a - b));
      expect(new Set(whens).size).toBe(whens.length);
      expect(journal.entries.at(-1)?.tag).toMatch(/^\d{4}_/);
    });

    it('round-trips attributes and filters decisions out of the default list', async () => {
      const { globId } = await submit('Round trip the attributes');
      const work = unwrap(await globs.create(DEV, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      const ids = async (include?: 'work' | 'decisions' | 'all') =>
        (await store.transaction((tx) => tx.listGlobs(boardId, include === undefined ? {} : { include }))).map((g) => g.id);
      expect(await ids()).toContain(work.id);
      expect(await ids()).not.toContain(globId);
      expect(await ids('decisions')).toEqual(expect.arrayContaining([globId]));
      expect(await ids('decisions')).not.toContain(work.id);
      expect(await ids('all')).toEqual(expect.arrayContaining([globId, work.id]));
      const stored = await store.transaction((tx) => tx.getGlob(globId));
      expect(stored?.attributes).toMatchObject({ scope: { kind: 'future_work', ref: null }, channel: 'agent', outcome: null });
    });
  });

  describe('creation channels', () => {
    it('submit_learning returns the glob ID over MCP and creates a Planning decision with the proposal as its payload', async () => {
      const result = await client.callTool({
        name: 'submit_learning',
        arguments: { board: boardId, sourceGlobId, type: 'pattern', statement: 'Use cursors for every list endpoint', evidence: 'Review found offset paging' },
      });
      const [first] = result.content as { text: string }[];
      const reply = JSON.parse(first?.text ?? 'null') as { id: string; globId: string };
      // The item is its decision glob, under its own k ID.
      expect(reply.globId).toMatch(new RegExp(`^s${String(boardId)}k\\d+$`));
      expect(reply.globId).toBe(reply.id);
      const glob = await view(reply.globId);
      expect(glob).toMatchObject({ category: 'decision', status: 'planning', attributes: { origin: { kind: 'submitted' } } });
      expect(glob.id).toBe(reply.id);
      const [plan] = await store.transaction((tx) => tx.listArtifacts(reply.globId, 'plan'));
      expect(plan?.content).toContain('Use cursors');
    });

    it('submit_learning over MCP refuses the removed decision type, pointing at the implementation record', async () => {
      const result = await client.callTool({
        name: 'submit_learning',
        arguments: { board: boardId, sourceGlobId, type: 'decision', statement: 'Use cursors', evidence: 'Review found offset paging' },
      });
      expect(result.isError).toBe(true);
    });

    it('create_glob over MCP and REST refuse the decision category', async () => {
      const mcp = await client.callTool({ name: 'create_glob', arguments: { board: boardId, idempotencyKey: 'k1', title: 'X', category: 'decision' } });
      expect(mcp.isError).toBe(true);
      const rest = await call(DEV, 'POST', `/api/boards/${boardId}/globs`, { title: 'X', category: 'decision' });
      expect(rest.status).toBe(422);
    });

    it('promotes an inbox item to a decision glob once, attaching the item', async () => {
      const inbox = new InboxService({ store, clock: { now: () => new Date().toISOString() }, notifier: hub });
      const added = unwrap(await inbox.add(DEV, boardId, { text: 'We agreed in standup to freeze the schema until the launch.', title: 'Schema freeze' }));
      const path = `/api/boards/${boardId}/inbox/${String(added.id)}/promote`;
      const first = await call(DEV, 'POST', path, {});
      expect(first.status).toBe(200);
      const promoted = await json<{ glob: View }>(first);
      expect(promoted.glob).toMatchObject({ category: 'decision', status: 'planning' });
      const again = await json<{ glob: View }>(await call(DEV, 'POST', path, {}));
      expect(again.glob.id).toBe(promoted.glob.id);
      expect((await call(DEV, 'POST', `/api/boards/${boardId}/inbox/9999/promote`, {})).status).toBe(404);
    });
  });

  describe('outcomes and their role gates', () => {
    it('Planning to Doing is a pick-up for admins and POs only', async () => {
      const { globId } = await submit('Gate the pick-up');
      expect((await json<View>(await call(DEV, 'GET', `/api/globs/${globId}`))).allowedActions).not.toContain('pick_up');
      expect((await pickUp(globId, DEV)).status).toBe(403);
      const picked = await pickUp(globId, PO);
      expect(picked.status).toBe(200);
      const glob = await json<View>(picked);
      expect(glob.status).toBe('in_progress');
      expect(glob.allowedActions).toContain('decide');
    });

    it('reject needs a reason and an admin or PO, signs the glob off archived and hides it from the board and counts', async () => {
      const { globId, id } = await submit('Reject me');
      await pickUp(globId);
      expect((await decide(globId, { outcome: 'reject' })).status).toBe(422);
      expect((await decide(globId, { outcome: 'reject', reason: 'No' }, DEV)).status).toBe(403);
      const rejected = await json<View>(await decide(globId, { outcome: 'reject', reason: 'Already covered' }));
      expect(rejected).toMatchObject({ status: 'signed_off', attributes: { archived: true, outcome: { kind: 'reject' } } });
      expect((await store.transaction((tx) => learningSeed(tx).readSeeded(id)))?.status).toBe('rejected');
      const list = await json<View[]>(await call(ADMIN, 'GET', `/api/boards/${boardId}/globs`));
      expect(list.map((g) => g.id)).not.toContain(globId);
      const page = await json<{ globs: View[] }>(await call(ADMIN, 'GET', `/api/boards/${boardId}/signed-off`));
      expect(page.globs.map((g) => g.id)).not.toContain(globId);
      const before = (await json<{ total: number }>(await call(ADMIN, 'GET', `/api/boards/${boardId}/signed-off/count`))).total;
      const { globId: other } = await submit('Reject me too');
      await pickUp(other);
      await decide(other, { outcome: 'reject', reason: 'Nope' });
      expect((await json<{ total: number }>(await call(ADMIN, 'GET', `/api/boards/${boardId}/signed-off/count`))).total).toBe(before);
    });

    it('accept moves to Reviewing, reopen takes it back, sign-off finishes it and it stays on the board', async () => {
      const { globId, id } = await submit('Accept me', 'gotcha');
      await settle(id);
      await pickUp(globId);
      const accepted = await json<View>(await decide(globId, { outcome: 'accept' }));
      expect(accepted).toMatchObject({ status: 'reviewing', attributes: { outcome: { kind: 'accept' } } });
      expect((await store.transaction((tx) => learningSeed(tx).readSeeded(id)))?.status).toBe('approved');
      const reopened = await json<View>(await call(ADMIN, 'POST', `/api/globs/${globId}/actions/reopen`, { version: accepted.version }));
      expect(reopened).toMatchObject({ status: 'in_progress', attributes: { outcome: null } });
      const again = await json<View>(await decide(globId, { outcome: 'accept' }));
      expect(again.status).toBe('reviewing');
      expect((await call(DEV, 'POST', `/api/globs/${globId}/actions/sign-off`, { version: again.version })).status).toBe(403);
      const signed = await json<View>(await call(PO, 'POST', `/api/globs/${globId}/actions/sign-off`, { version: again.version }));
      expect(signed.status).toBe('signed_off');
      const list = await json<View[]>(await call(ADMIN, 'GET', `/api/boards/${boardId}/globs`));
      expect(list.map((g) => g.id)).toContain(globId);
    });

    it('needs work links a work glob and moves to Reviewing when the release_waiting executor sees it merge', async () => {
      const { globId } = await submit('Needs work first');
      await pickUp(globId);
      const work = unwrap(await globs.create(ADMIN, { boardId, title: 'Do the work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      const waiting = await json<View>(await decide(globId, { outcome: 'needs_work', linkedGlobId: work.id }));
      expect(waiting).toMatchObject({ status: 'in_progress', attributes: { outcome: { kind: 'needs_work' } } });
      const executors = codeHostExecutors(new FakeCodeHost(), (id) => store.transaction((tx) => tx.getBoard(id)), new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier: hub }));
      const merged: Glob = { ...work, status: 'signed_off' };
      const effect: Effect = { kind: 'release_waiting', globId: work.id, generation: work.generation };
      await executors.release_waiting?.(effect, merged, { globs, decisions: decisionGlobs });
      expect((await view(globId)).status).toBe('reviewing');
    });

    it('refuses decision commands on a work glob and work commands on a decision', async () => {
      const { globId } = await submit('Wrong commands');
      const work = unwrap(await globs.create(ADMIN, { boardId, title: 'Plain work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      expect((await decide(work.id, { outcome: 'reject', reason: 'x' })).status).toBe(422);
      const start = await call(ADMIN, 'POST', `/api/globs/${globId}/actions/start`, { version: 1 });
      expect(start.status).toBe(409);
    });
  });

  describe('a learning the pipeline closed', () => {
    it('is reopened by an admin from the glob view (back to Planning), and never deleted', async () => {
      const { globId, id } = await submit('Close me', 'gotcha');
      const { id: other } = await submit('The survivor', 'gotcha');
      await store.transaction(async (tx) => {
        const current = await learningSeed(tx).readSeeded(id);
        if (current === null) throw new Error('missing');
        const target = { kind: 'doc' as const, name: 'build', section: null, newDocument: null };
        await learningSeed(tx, { clock: { now: () => new Date().toISOString() } }).updateSeeded({ ...current, status: 'merged', target, duplicateOf: other, version: current.version + 1 }, current.version);
      });
      const closed = await json<View>(await call(ADMIN, 'GET', `/api/globs/${globId}`));
      expect(closed).toMatchObject({ status: 'signed_off', attributes: { closedAs: 'merged' }, links: [{ id: other, kind: 'duplicate_of' }] });
      expect(closed.allowedActions).toEqual(['reopen']);
      expect((await call(ADMIN, 'DELETE', `/api/globs/${globId}`, { version: closed.version })).status).toBe(422);
      expect((await call(PO, 'POST', `/api/globs/${globId}/actions/reopen`, { version: closed.version })).status).toBe(403);
      const reopened = await call(ADMIN, 'POST', `/api/globs/${globId}/actions/reopen`, { version: closed.version });
      expect(reopened.status).toBe(200);
      expect(await json<View>(reopened)).toMatchObject({ status: 'planning', links: [{ id: other, kind: 'kept_apart_from', source: 'explicit' }] });
      expect(await store.transaction((tx) => learningSeed(tx).readSeeded(id))).toMatchObject({ status: 'open', keptApartFrom: [other] });
    });
  });

  describe('scope, diff and assessment', () => {
    it('PATCH edits the scope only, for admins and POs', async () => {
      const { globId } = await submit('Scope me');
      const { version } = await view(globId);
      const body = { version, attributes: { scope: { kind: 'future_work', ref: null } } };
      expect((await call(DEV, 'PATCH', `/api/globs/${globId}`, body)).status).toBe(403);
      expect((await call(ADMIN, 'PATCH', `/api/globs/${globId}`, { version, attributes: { scope: { kind: 'project', ref: null }, outcome: null } })).status).toBe(422);
      expect((await call(ADMIN, 'PATCH', `/api/globs/${globId}`, { version, attributes: { scope: { kind: 'glob', ref: 's99t99' } } })).status).toBe(422);
      const changed = await json<View>(await call(PO, 'PATCH', `/api/globs/${globId}`, body));
      expect(changed.attributes?.scope).toEqual({ kind: 'future_work', ref: null });
    });

    it('GET diff answers for a decision without a draft, and 422 for a work glob', async () => {
      const { globId } = await submit('Diff me');
      const response = await call(DEV, 'GET', `/api/globs/${globId}/diff`);
      expect(response.status).toBe(200);
      expect(await json<{ preview: unknown }>(response)).toMatchObject({ preview: null });
      const work = unwrap(await globs.create(ADMIN, { boardId, title: 'Not a decision', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      expect((await call(DEV, 'GET', `/api/globs/${work.id}/diff`)).status).toBe(422);
    });

    it('POST assessment writes the assessment artifact for a member', async () => {
      const { globId } = await submit('Assess me');
      const response = await call(DEV, 'POST', `/api/globs/${globId}/assessment`);
      expect(response.status).toBe(200);
      expect(await json<{ kind: string; content: string }>(response)).toMatchObject({ kind: 'assessment' });
      expect((await view(globId)).id).toBe(globId);
    });
  });

  describe('suggest', () => {
    it('queues one llm-lane job for admins and POs, runs it with a fake model, and serves the labelled assessment version', async () => {
      const { globId } = await submit('Suggest on me');
      // Members who don't decide are refused, and nothing is queued.
      expect((await call(DEV, 'POST', `/api/globs/${globId}/suggest`)).status).toBe(403);
      expect((await call(ADMIN, 'POST', `/api/globs/${globId}/suggest`)).status).toBe(202);
      expect((await call(PO, 'POST', `/api/globs/${globId}/suggest`)).status).toBe(202);
      const queued = await database.db.execute(sql`select lane, state from outbox where kind = 'suggest_decision' and glob_id = ${globId}`);
      expect(queued).toEqual([{ lane: 'llm', state: 'pending' }]);
      expect(await json<{ pending: boolean; suggestion: unknown }>(await call(ADMIN, 'GET', `/api/globs/${globId}/suggestion`))).toMatchObject({ pending: true, suggestion: null });

      // The job as the outbox runs it: one model call, then the answer is stored as assessment/suggestion.
      suggestAnswer = JSON.stringify({ action: 'reject', reason: 'A later change made it moot.' });
      const run = suggestExecutors(suggest).suggest_decision;
      if (run === undefined) throw new Error('no executor');
      expect(await run({ kind: 'suggest_decision', globId }, null, { globs }, undefined)).toBe('done');
      const versions = await store.transaction((tx) => tx.artifactVersions(globId, 'assessment', 'suggestion'));
      expect(versions).toHaveLength(1);
      const read = await json<{ stale: boolean; suggestion: { model: string; suggestion: { action: string; reason: string } } }>(await call(PO, 'GET', `/api/globs/${globId}/suggestion`));
      expect(read).toMatchObject({ stale: false, suggestion: { model: 'test-model', suggestion: { action: 'reject', reason: 'A later change made it moot.' } } });
      // The deterministic assessment keeps its own history.
      expect((await store.transaction((tx) => tx.artifactVersions(globId, 'assessment', ''))).every((a) => !a.content.includes('## Suggestion'))).toBe(true);
    });

    it('refuses a glob that is not a decision', async () => {
      expect((await call(ADMIN, 'POST', `/api/globs/${sourceGlobId}/suggest`)).status).toBe(422);
    });
  });
});
