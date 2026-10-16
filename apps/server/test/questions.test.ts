import { ArtifactService, BoardService, GlobService, IntakeService, LlmUnavailable } from '@slop/core';
import type { Glob, NewQuestion, OpenQuestion, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { questionExecutors } from '../src/question-executors.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Questions {
  open: OpenQuestion[];
  answered: OpenQuestion[];
}
interface Context {
  questions: Questions;
  attachments: { label: string; content: string }[];
}
const NO_VIEW: View = { id: '', version: 0, status: '' };

interface View {
  id: string;
  version: number;
  status: string;
  questions?: OpenQuestion[];
  allowedActions?: string[];
  artifacts?: { kind: string; label: string; version: number }[];
  humanSteps?: { id: string; kind: string }[];
  code?: string;
  message?: string;
}

const ask = (patch: Partial<NewQuestion> = {}): NewQuestion => ({
  text: 'Does the scope include prod?',
  options: ['Yes', 'No'],
  blocking: 'start',
  source: 'create',
  raisedBy: { kind: 'intake', actor: null },
  ...patch,
});

describe('open questions over REST, MCP and the outbox (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let client: Client;
  let adminClient: Client;
  let intakeAnswer = '{}';
  let app: Hono<Env>;
  let boardId: number;

  const make = async (patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'Plan v1', ...patch }));
  const rest = async (method: string, path: string, body?: unknown, as = DEV): Promise<{ status: number; body: View }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // The wire shape of the glob view, as the other API tests read it.
    const parsed = text.startsWith('{') ? (JSON.parse(text) as View) : NO_VIEW;
    return { status: res.status, body: parsed };
  };
  const textOf = (reply: Awaited<ReturnType<Client['callTool']>>): string => {
    const first: unknown = Array.isArray(reply.content) ? reply.content[0] : undefined;
    return typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string' ? first.text : '{}';
  };
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: Record<string, unknown> & View }> => {
    const reply = await client.callTool({ name, arguments: args });
    return { error: reply.isError === true, body: JSON.parse(textOf(reply)) as Record<string, unknown> & View };
  };
  const contextOf = async (id: string): Promise<Context> => {
    return JSON.parse(textOf(await client.callTool({ name: 'get_context', arguments: { id } }))) as Context;
  };
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('questions'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService(deps);
    const boards = new BoardService(deps);
    await store.transaction(async (tx) => {
      for (const email of [DEV, ADMIN, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: notifier,
      outbox,
      onBoardCreated: () => Promise.resolve(),
    });
    const server = buildServer({ artifacts, globs, intake: new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('off', 'none')) } }), outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    // An admin's session with a scripted intake model: only an admin's unchosen sub stays a sub.
    const adminServer = buildServer({ artifacts, globs, intake: new IntakeService({ store, llm: { complete: () => Promise.resolve(intakeAnswer) } }), outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, ADMIN, 'http://localhost');
    const [c, d] = InMemoryTransport.createLinkedPair();
    adminClient = new Client({ name: 'admin', version: '0' });
    await Promise.all([adminServer.connect(c), adminClient.connect(d)]);
  });

  afterAll(async () => {
    await client.close();
    await adminClient.close();
    await drop();
  });

  describe('REST', () => {
    it('answers a held sub: it starts, Clarifications is written, and the view carries the questions and the answer step before', async () => {
      const held = await make({ questions: [ask()] });
      const before = await rest('GET', `/api/globs/${held.id}`);
      expect(before.body.questions?.map((q) => [q.id, q.blocking])).toEqual([['q1', 'start']]);
      expect(before.body.allowedActions).toContain('start_anyway');
      expect(before.body.humanSteps?.map((s) => s.id)).toContain('machine:answer:q1');

      const answered = await rest('POST', `/api/globs/${held.id}/questions/q1/answer`, { option: 'No' });
      expect(answered.status).toBe(200);
      expect(answered.body.status).toBe('implementing');
      expect(answered.body.questions?.[0]?.answer).toMatchObject({ text: 'No', option: 'No', by: DEV });
      expect(answered.body.artifacts?.find((a) => a.label === 'Clarifications')).toMatchObject({ kind: 'attachment', version: 1 });
      expect(answered.body.humanSteps?.map((s) => s.id) ?? []).not.toContain('machine:answer:q1');
    });

    it('dismisses with a note and releases', async () => {
      const held = await make({ questions: [ask()] });
      const dismissed = await rest('POST', `/api/globs/${held.id}/questions/q1/dismiss`, { note: 'Out of scope' });
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.status).toBe('implementing');
      expect(dismissed.body.questions?.[0]?.dismissed).toMatchObject({ by: DEV, note: 'Out of scope' });
    });

    it('a person raises a merge question, and 404, 403 and bad bodies are refused', async () => {
      const g = await make();
      const raised = await rest('POST', `/api/globs/${g.id}/questions`, { text: 'Is prod in scope?', blocking: 'merge', options: ['Yes', 'No'] });
      expect(raised.status).toBe(200);
      expect(raised.body.questions?.[0]).toMatchObject({ id: 'q1', blocking: 'merge', raisedBy: { kind: 'person', actor: DEV }, source: 'other' });
      expect((await rest('POST', `/api/globs/s${String(boardId)}t999/questions`, { text: 'x' })).status).toBe(404);
      expect((await rest('POST', `/api/globs/${g.id}/questions/q1/answer`, { answer: 'x' }, OUTSIDER)).status).toBe(403);
      expect((await rest('POST', `/api/globs/${g.id}/questions`, { text: '' })).status).toBe(422);
      expect((await rest('POST', `/api/globs/${g.id}/questions/q9/answer`, { answer: 'x' })).status).toBe(422);
      expect((await rest('POST', `/api/globs/${g.id}/questions/q1/answer`, {})).status).toBe(422);
    });
  });

  describe('MCP', () => {
    it('raise_question, then get_context lists it open; a person answers it and it moves to answered', async () => {
      const g = await make();
      const runId = (await current(g.id)).runs[0]?.id ?? '';
      const raised = await tool('raise_question', { id: g.id, text: 'Assumed staging only; is prod in scope?', options: ['Yes', 'No'], runId });
      expect(raised.error).toBe(false);
      expect(raised.body).toMatchObject({ question: { id: 'q1', blocking: 'merge', options: ['Yes', 'No'] } });
      expect((await current(g.id)).questions?.[0]).toMatchObject({ source: 'run', raisedBy: { kind: 'routine', actor: DEV, runId } });

      expect((await contextOf(g.id)).questions.open.map((q) => q.id)).toEqual(['q1']);

      expect((await rest('POST', `/api/globs/${g.id}/questions/q1/answer`, { answer: 'Staging only' })).status).toBe(200);
      const after = await contextOf(g.id);
      expect(after.questions.open).toEqual([]);
      expect(after.questions.answered.map((q) => [q.id, q.answer?.text])).toEqual([['q1', 'Staging only']]);
      expect(after.attachments.find((a) => a.label === 'Clarifications')?.content).toContain('Staging only');
    });

    it('a stale run ID is ignored, and a repeated key returns the same question', async () => {
      const g = await make();
      const stale = await tool('raise_question', { id: g.id, text: 'Late?', runId: 'run-long-gone' });
      expect(stale.error).toBe(false);
      expect(stale.body).toMatchObject({ ignored: true });
      expect((await current(g.id)).questions ?? []).toEqual([]);
      const first = await tool('raise_question', { id: g.id, text: 'Prod?', key: 'prod', blocking: 'none' });
      const second = await tool('raise_question', { id: g.id, text: 'Prod?', key: 'prod', blocking: 'none' });
      expect((first.body['question'] as { id: string }).id).toBe('q1');
      expect((second.body['question'] as { id: string }).id).toBe('q1');
      expect((await current(g.id)).questions).toHaveLength(1);
    });

    it('a start question on a started glob is a notice and says so', async () => {
      const g = await make();
      const raised = await tool('raise_question', { id: g.id, text: 'Prod?', blocking: 'start' });
      expect(raised.body).toMatchObject({ downgraded: true, question: { blocking: 'none' } });
    });

    it('answer_question and dismiss_question refuse a call that names one of the glob\'s runs, and work without one', async () => {
      const g = await make();
      const runId = (await current(g.id)).runs[0]?.id ?? '';
      await tool('raise_question', { id: g.id, text: 'Prod?', runId });
      const answer = await tool('answer_question', { id: g.id, questionId: 'q1', answer: 'go on', runId });
      expect(answer.error).toBe(true);
      expect(answer.body.code).toBe('forbidden');
      const dismiss = await tool('dismiss_question', { id: g.id, questionId: 'q1', runId });
      expect(dismiss.error).toBe(true);
      expect(dismiss.body.code).toBe('forbidden');
      expect((await current(g.id)).questions?.[0]?.answer).toBeUndefined();

      const person = await tool('answer_question', { id: g.id, questionId: 'q1', answer: 'No, staging only' });
      expect(person.error).toBe(false);
      expect(person.body.questions?.[0]?.answer?.text).toBe('No, staging only');
      const dismissed = await tool('dismiss_question', { id: g.id, questionId: 'q1' });
      expect(dismissed.error).toBe(true);
      expect(dismissed.body.code).toBe('invalid_transition');
    });

    it('get_glob carries the questions', async () => {
      const g = await make();
      await tool('raise_question', { id: g.id, text: 'Prod?', blocking: 'none' });
      const read = await tool('get_glob', { id: g.id });
      expect(read.body.questions?.map((q) => q.id)).toEqual(['q1']);
    });
  });

  describe('create_glob raisers', () => {
    const adminTool = async (args: Record<string, unknown>): Promise<{ error: boolean; body: Record<string, unknown> & View }> => {
      const reply = await adminClient.callTool({ name: 'create_glob', arguments: { board: boardId, ...args } });
      return { error: reply.isError === true, body: JSON.parse(textOf(reply)) as Record<string, unknown> & View };
    };
    const modelAnswer = (extra: Record<string, unknown>): string =>
      JSON.stringify({ title: 'Do it', plan: 'Do it.', type: 'sub', category: 'task', group: null, autoTrigger: false, autoTriggerQuote: null, files: [], questions: [], ...extra });

    it('a title-less create carries the intake model\'s questions: the reply shows them and the glob is held with no run', async () => {
      intakeAnswer = modelAnswer({ questions: [{ kind: 'scope', text: 'Is prod in scope?', options: ['Yes', 'No'], blocking: 'start' }] });
      const made = await adminTool({ input: 'Roll the thing out', idempotencyKey: 'q-intake-1' });
      expect(made.error).toBe(false);
      expect(made.body).toMatchObject({ status: 'planning', type: 'sub', held: true, waiting: true, questions: [{ id: 'q1', text: 'Is prod in scope?', options: ['Yes', 'No'], blocking: 'start' }] });
      expect((await current(made.body.id)).questions?.[0]).toMatchObject({ source: 'create', raisedBy: { kind: 'intake' }, key: 'intake:scope:1' });
      expect((await current(made.body.id)).runs).toEqual([]);
    });

    it('a title-less create with no question starts as before, with no questions field', async () => {
      intakeAnswer = modelAnswer({});
      const made = await adminTool({ input: 'Rename a helper', idempotencyKey: 'q-intake-2' });
      expect(made.body.status).not.toBe('planning');
      expect(made.body.questions).toBeUndefined();
      expect(made.body.held).toBeUndefined();
    });

    it('a glob the request waits for is only suggested: a notice question offers to add the relation', async () => {
      const first = await make();
      intakeAnswer = modelAnswer({});
      const made = await adminTool({ input: `Add docs once ${first.id} is merged`, idempotencyKey: 'q-intake-3' });
      expect(made.body.suggestedAfter).toEqual([first.id]);
      expect(made.body.questions).toMatchObject([{ options: ['add relation', 'not a prerequisite'], blocking: 'none' }]);
      expect(JSON.stringify(made.body.questions)).toContain(first.id);
      expect((await current(made.body.id)).questions?.[0]).toMatchObject({ key: `relation:${first.id}`, source: 'relation' });
    });

    it('a titled create with no mode that matches a risk area is held with a type question', async () => {
      intakeAnswer = modelAnswer({});
      const made = await adminTool({ title: 'Rotate tokens', plan: 'Change src/auth/login.ts to rotate tokens.', idempotencyKey: 'q-intake-4' });
      expect(made.body).toMatchObject({ status: 'planning', type: 'sub', held: true, questions: [{ options: ['same', 'sub'], blocking: 'start' }] });
      expect(JSON.stringify(made.body.questions)).toContain('Auth and security');
      const chosen = await adminTool({ title: 'Rotate tokens', mode: 'sub', plan: 'Change src/auth/login.ts to rotate tokens.', idempotencyKey: 'q-intake-5' });
      expect(chosen.body.questions).toBeUndefined();
    });
  });

  describe('the REST create route', () => {
    it('passes the intake proposal\'s questions to the new glob; the glob is held', async () => {
      const created = await rest(
        'POST',
        `/api/boards/${String(boardId)}/globs`,
        { title: 'Roll out', type: 'same', plan: 'Roll out.', group: '', questions: [{ text: 'Which environment?', options: ['int', 'prod'], blocking: 'start', key: 'intake:environment:1' }] },
        ADMIN,
      );
      expect(created.status).toBe(200);
      expect(created.body.questions).toMatchObject([{ id: 'q1', text: 'Which environment?', blocking: 'start', source: 'create', raisedBy: { kind: 'intake' }, key: 'intake:environment:1' }]);
      expect((await rest('POST', `/api/boards/${String(boardId)}/globs`, { title: 'Bad', type: 'same', group: '', questions: [{ text: '' }] }, ADMIN)).status).toBe(422);
    });
  });

  describe('the plan_changed_question executor', () => {
    it('raises the merge question once however often it runs, and drops what has merged or is gone', async () => {
      const executors = questionExecutors(globs);
      const run = executors.plan_changed_question;
      const g = await make({ type: 'same', autoTrigger: true });
      // The run was queued now; a plan saved after it names the version the run used.
      await new Promise((resolve) => setTimeout(resolve, 20));
      unwrap(await artifacts.putPlan(DEV, g.id, 'Plan v2', 1));
      const queued = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['ArtifactAdded'], [g.id]));
      expect(queued.length).toBeGreaterThan(0);
      const effect = { kind: 'plan_changed_question' as const, globId: g.id, version: 2 };
      expect(await run?.(effect, await current(g.id), { globs })).toBe('done');
      expect(await run?.(effect, await current(g.id), { globs })).toBe('done');
      const raised = (await current(g.id)).questions ?? [];
      expect(raised.map((q) => [q.key, q.blocking])).toEqual([['plan:v2', 'merge']]);
      expect(raised[0]?.text).toContain('the run used v1');

      // A glob that is gone has nothing to ask; another effect kind is not this executor's.
      expect(await run?.({ ...effect, globId: `s${String(boardId)}t9999` }, null, { globs })).toBe('done');
      expect(await run?.({ kind: 'recheck_overlaps', globId: 'board-1', boardId: 1 }, null, { globs })).toBe('dropped');
    });

    it('is queued by the plan save, in the same transaction, and not by a plan saved before any run', async () => {
      const g = await make({ type: 'same', autoTrigger: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      unwrap(await artifacts.putPlan(DEV, g.id, 'Plan v2', 1));
      const jobsOf = (id: string) => database.db.select().from(schema.outbox).where(and(eq(schema.outbox.globId, id), eq(schema.outbox.kind, 'plan_changed_question')));
      expect((await jobsOf(g.id)).map((j) => [j.effect, j.state])).toEqual([[{ kind: 'plan_changed_question', globId: g.id, version: 2 }, 'pending']]);
      const planning = await make({ type: 'same' });
      unwrap(await artifacts.putPlan(DEV, planning.id, 'Plan v2', 1));
      expect(await jobsOf(planning.id)).toEqual([]);
    });
  });

  it('the QuestionRaised, QuestionAnswered and QuestionDismissed events are stored (the events type column is text)', async () => {
    const g = await make({ questions: [ask(), ask({ key: 'second', text: 'Second?' })] });
    unwrap(await globs.answerQuestion(DEV, g.id, 'q1', { answer: 'No' }));
    unwrap(await globs.dismissQuestion(DEV, g.id, 'q2', {}));
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['QuestionRaised', 'QuestionAnswered', 'QuestionDismissed'], [g.id]));
    expect(events.map((e) => e.type)).toEqual(['QuestionRaised', 'QuestionRaised', 'QuestionAnswered', 'QuestionDismissed']);
  });
});
