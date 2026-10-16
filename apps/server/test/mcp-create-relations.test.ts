import { ArtifactService, BoardService, GlobService, IntakeService, LlmUnavailable, machine } from '@slop/core';
import type { ClassifyAtCreateInput, Glob, IntakeProposal, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Body {
  id: string;
  status?: string;
  type?: string | null;
  after?: string[];
  waiting?: boolean;
  waitingFor?: { id: string; state: string; why: string }[];
  ignoredAfter?: { id: string; why: string }[];
  holds?: { id: string; ok: boolean; why: string }[];
  supersedes?: { id: string; ok: boolean; why: string }[];
  typeNote?: string;
  suggestions?: { id: string; kind: string; text: string }[];
  relations?: { supersededBy?: { id: string } | null; supersedes?: { id: string }[] };
  code?: string;
  message?: string;
}

describe('create_glob relations over MCP (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let admin: Client;
  let dev: Client;
  let boardId: number;
  let key = 0;
  const classifyCalls: ClassifyAtCreateInput[] = [];
  let intakeStub: { propose: () => Promise<Result<IntakeProposal>> };
  let proposal: IntakeProposal;
  let spied: Client;

  const make = async (title: string): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title, type: 'same', category: 'task', group: 'grp', environment: null, autoTrigger: false, idempotencyKey: null, plan: title }));
  const merge = async (id: string): Promise<void> => {
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  };
  /** Merged with an open rollout step that holds its dependants (state `rollout`). */
  const rollingOut = async (title: string): Promise<Glob> => {
    const g = await make(title);
    await merge(g.id);
    unwrap(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Turn it on', kind: 'rollout', blocks: ['sign_off', 'dependants'] }));
    return g;
  };
  const rolledOut = async (title: string): Promise<Glob> => {
    const g = await make(title);
    await merge(g.id);
    return g;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: Body }> => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '{}';
    return { error: reply.isError === true, body: JSON.parse(text) as Body };
  };
  const create = (client: Client, args: Record<string, unknown>) =>
    call(client, 'create_glob', { board: boardId, title: `Created ${String((key += 1))}`, plan: 'plan', group: 'grp', idempotencyKey: `mcp-rel-${String(key)}`, ...args });
  const rows = (from: string) => store.transaction((tx) => tx.listRelationsFrom([from]));
  const connect = async (email: string, globsFor: GlobService, intake: unknown): Promise<Client> => {
    const outbox = new OutboxRunner(database.db, { globs: globsFor }, {}, () => undefined);
    const boards = new BoardService({ store, notifier: new HintHub(), clock: { now: () => new Date().toISOString() } });
    const server = buildServer(
      { artifacts: new ArtifactService({ store, notifier: new HintHub(), clock: { now: () => new Date().toISOString() } }), globs: globsFor, intake, outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps,
      email,
      'http://localhost',
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mcp_create_relations'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } };
    globs = new GlobService(deps);
    const boards = new BoardService({ store, notifier, clock });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    const llmOff = new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('off', 'none')) } });
    admin = await connect(ADMIN, globs, llmOff);
    dev = await connect(DEV, globs, llmOff);
    // A second server whose GlobService reports what the create-time classifier is asked, with a stubbed intake proposal.
    const spy = new GlobService({
      ...deps,
      relationScan: {
        request: () => undefined,
        classifyAtCreate: (input) => {
          classifyCalls.push(input);
          return Promise.resolve({ prerequisites: [], decided: [] });
        },
        remember: () => Promise.resolve(),
      },
    });
    intakeStub = { propose: () => Promise.resolve({ ok: true as const, value: proposal }) };
    spied = await connect(ADMIN, spy, intakeStub);
  });

  afterAll(async () => {
    await admin.close();
    await dev.close();
    await spied.close();
    await drop();
  });

  describe('after and needs survive in every mode', () => {
    const modes: readonly [string, (to: string) => Record<string, unknown>][] = [
      ['untyped (no type)', (to) => ({ after: [to], reason: 'uses its store' })],
      ['type sub', (to) => ({ type: 'sub', after: [to], reason: 'uses its store' })],
      ['needs', (to) => ({ type: 'sub', needs: [to], reason: 'uses its store' })],
    ];
    for (const [name, args] of modes) {
      it(`${name}: a target merged with a rollout step open keeps the relation, the glob waits in planning with no run`, async () => {
        const target = await rollingOut('Provider');
        const made = await create(admin, args(target.id));
        expect(made.error).toBe(false);
        expect(made.body).toMatchObject({ status: 'planning', type: 'sub', waiting: true, after: [target.id] });
        expect(made.body.waitingFor).toMatchObject([{ id: target.id, state: 'rollout' }]);
        expect(made.body.waitingFor?.[0]?.why).toContain('rollout');
        expect(made.body.ignoredAfter).toBeUndefined();
        expect((await globs.peek(made.body.id))?.runs).toEqual([]);
        expect((await rows(made.body.id)).map((r) => [r.to, r.gate, r.until, r.source, r.reason])).toEqual([[target.id, 'start', 'merged', 'agent', 'uses its store']]);
      });
    }

    it('an unmerged target waits too', async () => {
      const target = await make('Unmerged');
      const made = await create(admin, { after: [target.id], reason: 'needs its api' });
      expect(made.body).toMatchObject({ status: 'planning', after: [target.id] });
      expect(made.body.waitingFor).toMatchObject([{ id: target.id }]);
    });

    it('a target merged and fully rolled out is ignored, and ignoredAfter names it', async () => {
      const target = await rolledOut('Done provider');
      const made = await create(admin, { after: [target.id], reason: 'uses its store' });
      expect(made.error).toBe(false);
      expect(made.body.after).toBeUndefined();
      expect(made.body.waitingFor).toBeUndefined();
      expect(made.body.ignoredAfter?.map((i) => i.id)).toEqual([target.id]);
      expect(made.body.ignoredAfter?.[0]?.why).toContain(target.id);
      expect(await rows(made.body.id)).toEqual([]);
    });

    it('a non-admin leaving type unset gets a same, keeps the relation and is told (typeNote)', async () => {
      const target = await make('For a member');
      const made = await create(dev, { after: [target.id], reason: 'uses its store' });
      expect(made.error).toBe(false);
      expect(made.body.type).toBe('same');
      expect(made.body.typeNote).toEqual(expect.any(String));
      expect(made.body.after).toEqual([target.id]);
      expect(made.body.waitingFor).toMatchObject([{ id: target.id }]);
    });
  });

  describe('reasons', () => {
    it('refuses after without a reason, naming the glob and both ways to pass it, and creates nothing', async () => {
      const target = await make('No reason target');
      const before = (await globs.list(ADMIN, boardId, { include: 'all' })).ok;
      expect(before).toBe(true);
      const made = await create(admin, { type: 'sub', after: [target.id] });
      expect(made.error).toBe(true);
      expect(made.body.code).toBe('invalid_input');
      expect(made.body.message).toContain(target.id);
      expect(made.body.message).toContain('`reason`');
      expect(made.body.message).toContain('relations: [{to, reason}]');
    });

    it('a relations entry without a reason is refused; with one it is stored as source agent', async () => {
      const target = await make('Relations target');
      expect((await create(admin, { type: 'sub', relations: [{ to: target.id, gate: 'sign_off' }] })).error).toBe(true);
      const made = await create(admin, { type: 'sub', relations: [{ to: target.id, gate: 'sign_off', until: 'rolled_out', reason: 'hands over with it' }] });
      expect(made.error).toBe(false);
      expect((await rows(made.body.id)).map((r) => [r.to, r.gate, r.until, r.source, r.reason])).toEqual([[target.id, 'sign_off', 'merged', 'agent', 'hands over with it']]);
    });
  });

  describe('holds (follows_up) and supersedes', () => {
    it('holds writes a sign_off relation on the existing glob pointing at the new one (a fix for a failed rollout)', async () => {
      const failing = await rollingOut('Rollout failed');
      const made = await create(admin, { type: 'same', holds: [{ id: failing.id, reason: 'fixes the failed provisioning' }] });
      expect(made.error).toBe(false);
      expect(made.body.holds).toEqual([{ id: failing.id, ok: true, why: 'added' }]);
      expect((await rows(failing.id)).map((r) => [r.to, r.gate, r.until, r.source, r.reason])).toEqual([[made.body.id, 'sign_off', 'merged', 'agent', 'fixes the failed provisioning']]);
    });

    it('follows_up is an alias, and a bare id takes the shared reason', async () => {
      const old = await make('Merged an old plan');
      const made = await create(admin, { type: 'same', follows_up: [old.id], reason: 'finishes what it left out' });
      expect(made.body.holds).toMatchObject([{ id: old.id, ok: true }]);
      expect((await rows(old.id)).map((r) => [r.to, r.reason])).toEqual([[made.body.id, 'finishes what it left out']]);
    });

    it('holds without a reason is refused and creates nothing', async () => {
      const old = await make('Holder without reason');
      const made = await create(admin, { type: 'same', title: 'Never created', holds: [old.id] });
      expect(made.error).toBe(true);
      expect(made.body.message).toContain(old.id);
      const all = unwrap(await globs.list(ADMIN, boardId, { include: 'all' }));
      expect(all.some((g) => g.title === 'Never created')).toBe(false);
      expect(await rows(old.id)).toEqual([]);
    });

    it('supersedes dismisses the superseded glob\'s due steps and shows both sides', async () => {
      const obsolete = await make('Obsolete');
      unwrap(await globs.addHumanStep(ADMIN, obsolete.id, null, { title: 'Old step', kind: 'rollout' }));
      const made = await create(admin, { type: 'same', supersedes: [{ id: obsolete.id, reason: 'replaces it' }] });
      expect(made.error).toBe(false);
      expect(made.body.supersedes).toMatchObject([{ id: obsolete.id, ok: true }]);
      const read = await call(admin, 'get_glob', { id: obsolete.id });
      expect(read.body.relations?.supersededBy?.id).toBe(made.body.id);
      const mine = await call(admin, 'get_glob', { id: made.body.id });
      expect(mine.body.relations?.supersedes?.map((s) => s.id)).toEqual([obsolete.id]);
    });

    it('update_glob supersedes with a reason, and add_relation supersedes; both refuse a missing reason', async () => {
      const a = await make('Replacer');
      const b = await make('Replaced');
      const c = await make('Replaced too');
      const refused = await call(admin, 'add_relation', { id: a.id, supersedes: b.id });
      expect(refused.error).toBe(true);
      expect(refused.body.message).toContain(b.id);
      const added = await call(admin, 'add_relation', { id: a.id, supersedes: b.id, reason: 'same work, new plan' });
      expect(added.error).toBe(false);
      expect(added.body.relations?.supersedes?.map((s) => s.id)).toEqual([b.id]);
      const updated = await call(admin, 'update_glob', { id: a.id, version: (await globs.peek(a.id))?.version ?? 0, supersedes: [c.id], reason: 'also covers it' });
      expect(updated.error).toBe(false);
      expect((await call(admin, 'get_glob', { id: c.id })).body.relations?.supersededBy?.id).toBe(a.id);
    });
  });

  describe('update_glob and add_relation reasons', () => {
    it('update_glob after is stored as source agent and needs a reason', async () => {
      const target = await make('Update target');
      const g = await make('Update me');
      const refused = await call(admin, 'update_glob', { id: g.id, version: g.version, after: [target.id] });
      expect(refused.error).toBe(true);
      expect(refused.body.message).toContain(target.id);
      const ok = await call(admin, 'update_glob', { id: g.id, version: (await globs.peek(g.id))?.version ?? 0, after: [target.id], reason: 'needs its table' });
      expect(ok.error).toBe(false);
      expect((await rows(g.id)).map((r) => [r.source, r.reason])).toEqual([['agent', 'needs its table']]);
    });

    it('add_relation without a reason is refused with the core message', async () => {
      const a = await make('Add A');
      const b = await make('Add B');
      const refused = await call(admin, 'add_relation', { id: a.id, version: a.version, to: b.id, gate: 'sign_off' });
      expect(refused.error).toBe(true);
      expect(refused.body.message).toContain(`Relation to ${b.id} needs a one-line reason`);
    });
  });

  describe('fail_human_step', () => {
    it('leaves the step open and leaves a step_failed suggestion that get_glob lists briefly', async () => {
      const g = await make('Rollout glob');
      await merge(g.id);
      const step = unwrap(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Provision the stack', kind: 'rollout' }));
      const failed = await call(admin, 'fail_human_step', { id: g.id, stepId: step.id, note: 'the stack did not provision' });
      expect(failed.error).toBe(false);
      const read = await call(admin, 'get_glob', { id: g.id });
      expect(read.body.suggestions?.map((s) => s.kind)).toEqual(['step_failed']);
      expect(read.body.suggestions?.[0]?.text).toContain('Provision the stack');
      const again = await call(admin, 'fail_human_step', { id: g.id, stepId: 'hs_nope', note: 'x' });
      expect(again.error).toBe(true);
    });
  });

  describe('intake prerequisites', () => {
    it('an input-only create passes intake\'s prerequisites into the intake record, so the classifier is told it was answered', async () => {
      const target = await make('Prerequisite');
      const prerequisites = [{ id: target.id, gate: 'sign_off' as const, sentence: `Hand it over only after ${target.id} is in place.` }];
      proposal = {
        title: 'Hand over the profile',
        plan: `Hand over the profile. Hand it over only after ${target.id} is in place.`,
        type: 'same',
        typeReason: null,
        category: 'task',
        fix: false,
        fixSource: 'inferred',
        fixReason: null,
        workKind: 'maintenance',
        workKindSource: 'inferred',
        workKindReason: null,
        group: null,
        environment: null,
        autoTrigger: false,
        autoTriggerReason: null,
        files: [],
        suggestedAfter: [],
        prerequisites,
        questions: [],
        categoryConfidence: 'high',
        categoryReason: null,
        examples: [],
        needsConfirmation: false,
        model: 'test',
        promptVersion: 1,
      } as unknown as IntakeProposal;
      const before = classifyCalls.length;
      const made = await call(spied, 'create_glob', { board: boardId, idempotencyKey: 'mcp-intake-1', input: `Hand over the profile only after ${target.id} is in place.` });
      expect(made.error).toBe(false);
      expect(classifyCalls).toHaveLength(before + 1);
      expect(classifyCalls.at(-1)?.answered).toEqual(prerequisites);
    });

    it('an id in both suggestedAfter and prerequisites becomes a relation with no stale relation question', async () => {
      const target = await make('Both');
      proposal = {
        title: 'Do it',
        plan: `Do it only after ${target.id} is in place.`,
        type: 'same',
        typeReason: null,
        category: 'task',
        fix: false,
        fixSource: 'inferred',
        fixReason: null,
        workKind: 'maintenance',
        workKindSource: 'inferred',
        workKindReason: null,
        group: null,
        environment: null,
        autoTrigger: false,
        autoTriggerReason: null,
        files: [],
        suggestedAfter: [target.id],
        prerequisites: [{ id: target.id, gate: 'sign_off' as const, sentence: `Hand it over only after ${target.id} is in place.` }],
        questions: [],
        categoryConfidence: 'high',
        categoryReason: null,
        examples: [],
        needsConfirmation: false,
        model: 'test',
        promptVersion: 1,
      } as unknown as IntakeProposal;
      const made = await call(spied, 'create_glob', { board: boardId, idempotencyKey: 'mcp-intake-2', input: `Do it only after ${target.id} is in place.` });
      expect(made.error).toBe(false);
      const read = await call(admin, 'get_glob', { id: made.body.id });
      expect(JSON.stringify(read.body)).not.toContain('relation:');
      expect(JSON.stringify(read.body)).not.toContain('was not added as a relation');
    });
  });
});
