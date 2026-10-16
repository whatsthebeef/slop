import { ArtifactService, BoardService, FindingsService, GlobService, KnowledgeService, LearningJobService, machine, MiningService, IntakeService, LlmUnavailable, RelationLearningService, SpendService } from '@slop/core';
import type { Glob, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface HoldingBody {
  relationId: string;
  to: string;
  toTitle: string | null;
  toIsDecision: boolean;
  gate: string;
  until: string;
  state: string;
  reason: string | null;
  source: string;
}
interface View {
  id: string;
  version: number;
  after?: string[];
  edges?: unknown;
  overlaps?: unknown;
  holding?: HoldingBody[];
  relations?: { holding: HoldingBody[]; holdsBack: { relationId: string; from: string; gate: string; until: string }[]; done: { to: string; how: string }[] };
  move?: { holder: string; reason: string; waitingOn?: string[] };
}

describe('relations over REST and MCP (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let client: Client;
  let app: Hono<Env>;
  let boardId: number;
  let other: number;
  let solo: number;

  const make = async (title: string, patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(DEV, { boardId, title, type: 'same', category: 'task', group: 'grp', environment: null, autoTrigger: false, idempotencyKey: null, plan: title, ...patch }));
  const rest = async (method: string, path: string, body?: unknown, as = DEV): Promise<{ status: number; body: View & { code?: string; message?: string } }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed: unknown = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {};
    return { status: res.status, body: parsed as View & { code?: string; message?: string } };
  };
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: View & { code?: string; message?: string } }> => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '{}';
    return { error: reply.isError === true, body: JSON.parse(text) as View & { code?: string; message?: string } };
  };
  const version = async (id: string): Promise<number> => (await globs.peek(id))?.version ?? 0;
  const rows = (from: string) => store.transaction((tx) => tx.listRelationsFrom([from]));
  /** A decision glob on the board, in Doing. */
  const decision = async (id: string): Promise<Glob> => {
    const base = unwrap(await globs.create(DEV, { boardId, title: 'seed', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'seed' }));
    const g: Glob = {
      ...base,
      id,
      category: 'decision',
      status: 'in_progress',
      provisioning: 'none',
      pr: null,
      attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null },
    };
    await store.transaction(async (tx) => {
      await tx.deleteGlob(base.id);
      await tx.insertGlob({ ...g, version: 1 }, null);
    });
    return g;
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('relations_api'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    const relationLearning = new RelationLearningService({ ...deps, ids: { runId: () => crypto.randomUUID() } });
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) }, relationLearning });
    const artifacts = new ArtifactService({ ...deps, relationLearning });
    const boards = new BoardService(deps);
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    other = unwrap(await boards.create(ADMIN, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    // A board only the admin is on: its globs are invisible to DEV.
    solo = unwrap(await boards.create(ADMIN, { name: 'solo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, other, DEV, 'dev'));
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: notifier,
      outbox,
      spend: new SpendService({ store, clock }),
      onBoardCreated: () => Promise.resolve(),
    });
    const mining = new MiningService(deps);
    mountKnowledge(app, {
      knowledge: new KnowledgeService({ ...deps, catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'empty', files: [] }) }, signals: mining }),
      artifacts,
      findings: new FindingsService(deps),
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'empty', files: [] }) },
      intake: new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('off', 'none')) } }),
      boards,
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining, manifests: null }),
      relationLearning,
      logError: () => undefined,
    });
    const server = buildServer({ artifacts, globs, intake: new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('off', 'none')) } }), outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  it('create_glob takes relations beside needs/after: agent-sourced, with defaults and a decision defaulting to decided', async () => {
    const a = await make('A');
    const b = await make('B');
    const d = await decision('s1k91');
    const made = await tool('create_glob', {
      board: boardId,
      title: 'Created by an agent',
      type: 'same',
      group: 'grp',
      plan: 'plan',
      idempotencyKey: 'rel-create-1',
      needs: [a.id],
      relations: [{ to: b.id, gate: 'merge', reason: 'ships with B' }, { to: d.id, reason: 'the store is open' }],
      reason: 'uses its table',
    });
    expect(made.error).toBe(false);
    const stored = await rows(made.body.id);
    expect(stored.map((r) => [r.to, r.gate, r.until, r.source, r.reason]).sort()).toEqual(
      [
        [a.id, 'start', 'merged', 'agent', 'uses its table'],
        [b.id, 'merge', 'merged', 'agent', 'ships with B'],
        [d.id, 'start', 'decided', 'agent', 'the store is open'],
      ].sort(),
    );
  });

  it('an agent relation without a reason is refused (create_glob, update_glob, add_relation); a reason in any form is accepted', async () => {
    const a = await make('Needs reason target');
    const g = await make('Needs reason holder');
    const created = await tool('create_glob', { board: boardId, title: 'No reason', type: 'same', group: 'grp', plan: 'p', idempotencyKey: 'rel-noreason', after: [a.id] });
    expect(created.error).toBe(true);
    expect(created.body.message).toContain(`Relation to ${a.id} needs a one-line reason`);
    expect((await tool('update_glob', { id: g.id, version: g.version, relations: [{ to: a.id, gate: 'merge' }] })).error).toBe(true);
    expect((await tool('add_relation', { id: g.id, version: g.version, to: a.id, gate: 'merge' })).error).toBe(true);
    expect(await rows(g.id)).toEqual([]);
    const shorthand = await tool('update_glob', { id: g.id, version: g.version, after: [a.id], reason: 'uses its helper' });
    expect(shorthand.error).toBe(false);
    expect((await rows(g.id)).map((r) => [r.source, r.reason])).toEqual([['agent', 'uses its helper']]);
  });

  it('people over REST need no reason, and until accepts rolled_out as merged (REST and MCP)', async () => {
    const a = await make('Alias A');
    const b = await make('Alias B');
    const c = await make('Alias C');
    const viaRest = await rest('POST', `/api/globs/${a.id}/relations`, { version: a.version, to: b.id, gate: 'sign_off', until: 'rolled_out' });
    expect(viaRest.status).toBe(200);
    expect(viaRest.body.relations?.holding).toMatchObject([{ to: b.id, gate: 'sign_off', until: 'merged', reason: null, source: 'person' }]);
    const viaMcp = await tool('add_relation', { id: b.id, version: b.version, to: c.id, gate: 'merge', until: 'rolled_out', reason: 'ships with C' });
    expect(viaMcp.error).toBe(false);
    expect(viaMcp.body.relations?.holding).toMatchObject([{ to: c.id, until: 'merged', source: 'agent' }]);
    const created = await rest('POST', `/api/boards/${String(boardId)}/globs`, { title: 'Alias create', plan: 'p', group: 'grp', relations: [{ to: c.id, gate: 'sign_off', until: 'rolled_out' }] });
    expect((await rows(created.body.id)).map((r) => r.until)).toEqual(['merged']);
    expect((await rest('POST', `/api/globs/${a.id}/relations`, { version: await version(a.id), to: c.id, until: 'bogus' })).status).toBe(422);
  });

  it('REST: create takes holds and supersedes, add relation takes supersedes', async () => {
    const old = await make('Old plan');
    const obsolete = await make('Obsolete one');
    const made = await rest('POST', `/api/boards/${String(boardId)}/globs`, {
      title: 'Follow-up', plan: 'p', group: 'grp', holds: [{ id: old.id, reason: 'finishes it' }], supersedes: [{ id: obsolete.id, reason: 'replaces it' }],
    });
    expect(made.status).toBe(200);
    expect((await rows(old.id)).map((r) => [r.to, r.gate, r.source])).toEqual([[made.body.id, 'sign_off', 'person']]);
    expect((await rest('GET', `/api/globs/${obsolete.id}`)).body.relations).toMatchObject({ supersededBy: { id: made.body.id, reason: 'replaces it' } });
    const replacer = await make('Replacer');
    const replaced = await make('Replaced');
    const added = await rest('POST', `/api/globs/${replacer.id}/relations`, { supersedes: replaced.id, reason: 'same work' });
    expect(added.status).toBe(200);
    expect(added.body.relations).toMatchObject({ supersedes: [{ id: replaced.id }] });
  });

  it('REST: a failed step leaves a suggestion; accepting with a glob links the fix, dismissing remembers; both routes map errors', async () => {
    const g = await make('Rolls out');
    unwrap(await globs.applyEvent(g.id, (x, c) => machine.merged(x, { sha: 'abc123' }, c)));
    const step = unwrap(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Provision it', kind: 'rollout' }));
    expect((await rest('POST', `/api/globs/${g.id}/steps/${step.id}/fail`, { note: '' })).status).toBe(422);
    expect((await rest('POST', `/api/globs/${g.id}/steps/hs_nope/fail`, { note: 'x' })).status).toBe(404);
    const failed = await rest('POST', `/api/globs/${g.id}/steps/${step.id}/fail`, { note: 'did not provision', version: null });
    expect(failed.status).toBe(200);
    const suggestions = (failed.body as unknown as { suggestions?: { id: string; kind: string; stepId?: string }[] }).suggestions ?? [];
    expect(suggestions).toMatchObject([{ kind: 'step_failed', stepId: step.id }]);
    const sid = encodeURIComponent(suggestions[0]?.id ?? '');
    // The board list carries the suggestion too.
    const list = await rest('GET', `/api/boards/${String(boardId)}/globs`);
    expect(((list.body as unknown as { id: string; suggestions?: unknown[] }[]).find((v) => v.id === g.id))?.suggestions).toHaveLength(1);
    expect((await rest('POST', `/api/globs/${g.id}/suggestions/${sid}/accept`, {})).status).toBe(422);
    const fix = await make('Fix it');
    const accepted = await rest('POST', `/api/globs/${g.id}/suggestions/${sid}/accept`, { glob: fix.id });
    expect(accepted.status).toBe(200);
    expect((await rows(g.id)).map((r) => [r.to, r.gate, r.until])).toEqual([[fix.id, 'sign_off', 'merged']]);
    expect((accepted.body as unknown as { suggestions?: unknown }).suggestions).toBeUndefined();
    // Another failure, dismissed.
    const again = await rest('POST', `/api/globs/${g.id}/steps/${step.id}/fail`, { note: 'still' });
    const next = (again.body as unknown as { suggestions?: { id: string }[] }).suggestions ?? [];
    expect(next).toHaveLength(1);
    const dismissed = await rest('POST', `/api/globs/${g.id}/suggestions/${encodeURIComponent(next[0]?.id ?? '')}/dismiss`, {});
    expect(dismissed.status).toBe(200);
    expect((dismissed.body as unknown as { suggestions?: unknown }).suggestions).toBeUndefined();
    expect((await rest('POST', `/api/globs/${g.id}/suggestions/nope/dismiss`, {})).status).toBe(404);
  });

  it('the board spend route lists relation_scan in bySource', async () => {
    await store.transaction((tx) =>
      tx.insertLlmSpend({ boardId, globId: null, source: 'relation_scan', model: 'claude-haiku-4-5', inputTokens: 2000, outputTokens: 300, costUsd: 0.0035, ref: null, createdAt: new Date().toISOString() }),
    );
    const res = await rest('GET', `/api/boards/${String(boardId)}/spend`);
    expect(res.status).toBe(200);
    expect((res.body as unknown as { bySource: Record<string, number> }).bySource.relation_scan).toBeCloseTo(0.0035);
  });

  it('get_glob and the REST read carry relations (holding, holdsBack, done) and no edges; the board list carries holding and the move', async () => {
    const a = await make('Provider');
    const g = await make('Consumer', { after: [a.id] });
    const read = await tool('get_glob', { id: g.id });
    expect(read.body.edges).toBeUndefined();
    expect(read.body.overlaps).toBeUndefined();
    expect(read.body.relations?.holding.map((h) => [h.to, h.toTitle, h.gate, h.until, h.state, h.source])).toEqual([[a.id, 'Provider', 'start', 'merged', 'planning', 'person']]);
    expect(read.body.holding?.map((h) => h.to)).toEqual([a.id]);
    const provider = await tool('get_glob', { id: a.id });
    expect(provider.body.relations?.holdsBack.map((h) => [h.from, h.gate, h.until])).toEqual([[g.id, 'start', 'merged']]);

    const single = await rest('GET', `/api/globs/${g.id}`);
    expect(single.body.edges).toBeUndefined();
    expect(single.body.relations?.holding).toHaveLength(1);

    const list = await rest('GET', `/api/boards/${String(boardId)}/globs`);
    const listed = (list.body as unknown as View[]).find((v) => v.id === g.id);
    expect(listed?.edges).toBeUndefined();
    expect(listed?.holding).toMatchObject([{ to: a.id, toTitle: 'Provider', gate: 'start', until: 'merged', reason: null, source: 'person' }]);
    // The same glob is "waiting on <id>" in the move the board shows.
    expect(listed?.move).toMatchObject({ holder: 'waiting', reason: `waiting on ${a.id}`, waitingOn: [a.id] });
    const provided = (list.body as unknown as View[]).find((v) => v.id === a.id);
    expect(provided?.holding).toEqual([]);
  });

  it('add_relation (to, with the version) and dismiss_relation over MCP; a stale version and bad shapes are refused', async () => {
    const a = await make('Needs');
    const b = await make('Other');
    const added = await tool('add_relation', { id: a.id, version: a.version, to: b.id, gate: 'sign_off', reason: 'signed off together' });
    expect(added.error).toBe(false);
    const row = added.body.relations?.holding.find((h) => h.to === b.id);
    expect(row).toMatchObject({ gate: 'sign_off', until: 'merged', reason: 'signed off together', source: 'agent' });
    expect((await tool('add_relation', { id: a.id, version: a.version, to: b.id, gate: 'merge' })).body.code).toBe('version_conflict');
    // Exactly one of `to` and `holdsBack`; `version` goes with `to`.
    expect((await tool('add_relation', { id: a.id, version: await version(a.id) })).error).toBe(true);
    expect((await tool('add_relation', { id: a.id, to: b.id })).error).toBe(true);
    const notDecision = await tool('add_relation', { id: a.id, version: await version(a.id), to: b.id, gate: 'merge', until: 'decided' });
    expect(notDecision.body.message).toContain('is not a decision');
    // a can't be signed off until b is merged, so b can't be merged until a is signed off: a cycle through two gates.
    const cycle = await tool('add_relation', { id: b.id, version: b.version, to: a.id, gate: 'merge', until: 'signed_off' });
    expect(cycle.body.message).toContain('cycle');
    const self = await tool('add_relation', { id: a.id, version: await version(a.id), to: a.id });
    expect(self.error).toBe(true);
    // A glob on a board the caller is not on answers like a missing one.
    const foreign = unwrap(
      await globs.create(ADMIN, { boardId: solo, title: 'Elsewhere', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'x' }),
    );
    expect((await tool('add_relation', { id: a.id, version: await version(a.id), to: foreign.id, reason: 'x' })).body.message).toBe(`No glob ${foreign.id}`);

    const dismissed = await tool('dismiss_relation', { id: a.id, version: await version(a.id), relationId: row?.relationId ?? '' });
    expect(dismissed.error).toBe(false);
    expect(dismissed.body.relations?.holding.find((h) => h.to === b.id)).toBeUndefined();
    expect(dismissed.body.relations?.done).toMatchObject([{ to: b.id, how: 'dismissed' }]);
    expect((await tool('dismiss_relation', { id: a.id, version: await version(a.id), relationId: 'rel_nope' })).error).toBe(true);
  });

  it('REST: POST /relations adds, POST /relations/:id/dismiss dismisses, and the old edges route is gone', async () => {
    const a = await make('Rest A');
    const b = await make('Rest B');
    const added = await rest('POST', `/api/globs/${a.id}/relations`, { version: a.version, to: b.id, gate: 'merge' });
    expect(added.status).toBe(200);
    expect(added.body.relations?.holding).toMatchObject([{ to: b.id, gate: 'merge', until: 'merged', source: 'person' }]);
    // Without a version for `to`, with both keys, or with neither: refused.
    expect((await rest('POST', `/api/globs/${a.id}/relations`, { to: b.id })).status).toBe(422);
    expect((await rest('POST', `/api/globs/${a.id}/relations`, { version: 1, to: b.id, holdsBack: b.id })).status).toBe(422);
    expect((await rest('POST', `/api/globs/${a.id}/relations`, { version: 1 })).status).toBe(422);
    expect((await rest('POST', `/api/globs/${a.id}/relations`, { version: a.version, to: b.id, gate: 'merge' })).status).toBe(409);
    const cycle = await rest('POST', `/api/globs/${b.id}/relations`, { version: b.version, to: a.id, gate: 'merge' });
    expect(cycle.status).toBe(422);
    expect(cycle.body.message).toContain('cycle');
    const dismissed = await rest('POST', `/api/globs/${a.id}/relations/${added.body.relations?.holding[0]?.relationId ?? ''}/dismiss`, { version: await version(a.id) });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.relations?.holding).toEqual([]);
    expect((await rest('POST', `/api/globs/${a.id}/edges/${b.id}/dismiss`, { version: await version(a.id) })).status).toBe(404);
  });

  it('a decision holds globs back over REST (holdsBack, no version), and the view of the decision lists what it holds back', async () => {
    const d = await decision('s1k92');
    const g = await make('Held by a decision');
    const added = await rest('POST', `/api/globs/${d.id}/relations`, { holdsBack: g.id });
    expect(added.status).toBe(200);
    expect(added.body.relations?.holdsBack).toMatchObject([{ from: g.id, gate: 'start', until: 'decided' }]);
    expect((await rows(g.id)).map((r) => [r.to, r.gate, r.until, r.source])).toEqual([[d.id, 'start', 'decided', 'person']]);
    // A decision is never the one held back.
    const refused = await rest('POST', `/api/globs/${g.id}/relations`, { holdsBack: d.id });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toContain('is a decision');
    // The same decision on the board list says "waiting on decision".
    const list = await rest('GET', `/api/boards/${String(boardId)}/globs`);
    const held = (list.body as unknown as View[]).find((v) => v.id === g.id);
    expect(held?.holding).toMatchObject([{ to: d.id, toIsDecision: true, until: 'decided' }]);
  });

  it('a decision holds a whole group back over REST and MCP (holdsBackGroup), and exactly one target is required', async () => {
    const d = await decision('s1k93');
    const a = await make('Group A', { group: 'wide' });
    const b = await make('Group B', { group: 'wide' });
    const added = await rest('POST', `/api/globs/${d.id}/relations`, { holdsBackGroup: 'Wide' });
    expect(added.status).toBe(200);
    expect((added.body as unknown as { groupHold: { held: string[]; failed: unknown[] } }).groupHold).toMatchObject({ failed: [] });
    expect(added.body.relations?.holdsBack.map((r) => r.from).sort()).toEqual([a.id, b.id].sort());
    expect((await rows(a.id)).map((r) => [r.to, r.group, r.source])).toEqual([[d.id, 'wide', 'person']]);
    const both = await rest('POST', `/api/globs/${d.id}/relations`, { holdsBackGroup: 'wide', holdsBack: a.id });
    expect(both.status).toBe(422);
    const d2 = await decision('s1k94');
    const viaMcp = await tool('add_relation', { id: d2.id, holdsBackGroup: 'wide' });
    expect(viaMcp.error).toBe(false);
    expect((await rows(b.id)).filter((r) => r.to === d2.id).map((r) => r.source)).toEqual(['agent']);
  });

  it('PATCH and POST accept relations; overlaps are not an input and not an output', async () => {
    const a = await make('Patch A');
    const b = await make('Patch B');
    const created = await rest('POST', `/api/boards/${String(boardId)}/globs`, { title: 'Posted', plan: 'p', group: 'grp', relations: [{ to: a.id, gate: 'sign_off' }], overlaps: [a.id] });
    expect(created.status).toBe(200);
    expect(created.body.overlaps).toBeUndefined();
    expect((await rows(created.body.id)).map((r) => [r.to, r.gate])).toEqual([[a.id, 'sign_off']]);
    const patched = await rest('PATCH', `/api/globs/${a.id}`, { version: a.version, relations: [{ to: b.id, gate: 'merge', reason: 'x' }] });
    expect(patched.status).toBe(200);
    expect((await rows(a.id)).map((r) => [r.to, r.gate, r.reason])).toEqual([[b.id, 'merge', 'x']]);
    expect((await rest('PATCH', `/api/globs/${a.id}`, { version: patched.body.version, relations: [{ to: b.id, gate: 'bogus' }] })).status).toBe(422);
  });

  it('a merge held for a relation is released through the outbox path (the executor calls releaseDependents)', async () => {
    const first = await make('Merges first');
    const g = await make('Armed');
    const current = await globs.peek(g.id);
    if (current === null) throw new Error('glob missing');
    const armed = { ...current, status: 'pr_open' as const, provisioning: 'ok' as const, pr: { number: 9, state: 'ready' as const, headSha: 'abcdef12345' }, headChecks: { sha: 'abcdef12345', state: 'pending' as const }, mergeMode: 'when_green' as const };
    await store.transaction(async (tx) => {
      expect(await tx.updateGlob({ ...armed, version: armed.version + 1 }, armed.version)).toBe(true);
    });
    unwrap(await globs.addRelation(DEV, g.id, null, { to: first.id, gate: 'merge' }));
    unwrap(await globs.applyEvent(g.id, (x, c, f) => machine.checksCompleted(x, { sha: 'abcdef12345', passed: true }, c, f.relations), { relations: true }));
    expect((await globs.peek(g.id))?.status).toBe('pr_open');
    expect((await globs.peek(g.id))?.mergeHold).toMatchObject({ for: [first.id] });
    unwrap(await globs.applyEvent(first.id, (x, c) => machine.merged(x, { sha: 'f00' }, c)));
    await globs.releaseDependents(first.id, boardId);
    expect((await globs.peek(g.id))?.status).toBe('merging');
  });

  describe('relation learning (s15t251)', () => {
    interface LearningBody {
      thresholds: { windowDays: number; precision: number; recall: number; minSamples: number };
      sources: { source: string; precision: number | null; posture: { posture: string; pinned: boolean } }[];
      pins: { minSamples?: number; postures?: Record<string, string> };
      code?: string;
    }
    const learning = async (method: string, body?: unknown, as = DEV, query = ''): Promise<{ status: number; body: LearningBody }> => {
      const res = await rest(method, `/api/boards/${String(boardId)}/relation-learning${query}`, body, as);
      return { status: res.status, body: res.body as unknown as LearningBody };
    };
    const weakRow = (from: string, to: string, gate: 'start' | 'merge' = 'merge') => ({
      id: `rel_weak_${from}_${to}`,
      boardId,
      from,
      to,
      gate,
      until: 'merged' as const,
      reason: `mentions ${to}`,
      evidence: [],
      source: 'mention' as const,
      kind: 'may_relate' as const,
      group: null,
      dismissedAt: null,
      dismissedPlanHash: null,
      overriddenAt: null,
      createdAt: '2026-10-05T12:00:00.000Z',
    });

    it('GET shows each source with thresholds and posture to members; only admins pin (PUT) and reset (DELETE)', async () => {
      const view = await learning('GET');
      expect(view.status).toBe(200);
      expect(view.body.thresholds).toEqual({ windowDays: 90, precision: 0.5, recall: 0.5, minSamples: 5 });
      expect(view.body.sources.map((s) => s.source)).toEqual(['mention', 'inferred', 'agent', 'person', 'learned', 'split']);

      expect((await learning('PUT', { postures: { mention: 'weak' } }, DEV)).status).toBe(403);
      const pinned = await learning('PUT', { postures: { mention: 'weak' }, minSamples: 8 }, ADMIN);
      expect(pinned.status).toBe(200);
      expect(pinned.body.thresholds.minSamples).toBe(8);
      expect(pinned.body.sources.find((s) => s.source === 'mention')?.posture).toMatchObject({ posture: 'weak', pinned: true });
      expect((await learning('PUT', { postures: { person: 'weak' } }, ADMIN)).status).toBe(422);
      expect((await learning('PUT', { windowDays: 1 }, ADMIN)).status).toBe(422);

      expect((await learning('DELETE', undefined, DEV)).status).toBe(403);
      expect((await learning('DELETE', undefined, ADMIN, '?what=mention')).body.sources.find((s) => s.source === 'mention')?.posture.pinned).toBe(false);
      const cleared = await learning('DELETE', undefined, ADMIN);
      expect(cleared.status).toBe(200);
      expect(cleared.body.thresholds.minSamples).toBe(5);
    });

    it('a weak link shows in relations.weak and holds nothing; promote makes it a gate and counts for its source', async () => {
      const a = await make('Weak A');
      const b = await make('Weak B');
      await store.transaction((tx) => tx.insertRelation(weakRow(a.id, b.id)));
      const read = await rest('GET', `/api/globs/${a.id}`);
      const weak = (read.body.relations as unknown as { weak?: { relationId: string; to: string; toTitle: string; source: string; state: string }[] }).weak;
      expect(weak).toMatchObject([{ relationId: `rel_weak_${a.id}_${b.id}`, to: b.id, toTitle: 'Weak B', source: 'mention' }]);
      expect(read.body.relations?.holding).toEqual([]);
      expect(read.body.holding ?? []).toEqual([]);

      const promoted = await rest('POST', `/api/globs/${a.id}/relations/rel_weak_${a.id}_${b.id}/promote`, { version: await version(a.id) });
      expect(promoted.status).toBe(200);
      expect(promoted.body.relations?.holding).toMatchObject([{ to: b.id, gate: 'merge', source: 'mention' }]);
      expect((promoted.body.relations as unknown as { weak?: unknown }).weak).toBeUndefined();
      const signals = await store.transaction((tx) => tx.listRelationSignals(boardId));
      expect(signals.filter((s) => s.from === a.id).map((s) => [s.source, s.signal])).toEqual([['mention', 'tp_promoted']]);
      // Nothing left to promote: a second call, an unknown id and a stale version are refused.
      expect((await rest('POST', `/api/globs/${a.id}/relations/rel_weak_${a.id}_${b.id}/promote`, { version: await version(a.id) })).status).toBe(422);
      expect((await rest('POST', `/api/globs/${a.id}/relations/rel_nope/promote`, { version: await version(a.id) })).status).toBe(422);
      expect((await rest('POST', `/api/globs/${a.id}/relations/rel_nope/promote`, {})).status).toBe(422);
    });

    it('promote refuses a weak link that would make a cycle, and MCP promote_relation does the same job', async () => {
      const a = await make('Cycle A');
      const b = await make('Cycle B');
      unwrap(await globs.addRelation(DEV, b.id, null, { to: a.id, gate: 'merge' }));
      await store.transaction((tx) => tx.insertRelation(weakRow(a.id, b.id)));
      const refused = await rest('POST', `/api/globs/${a.id}/relations/rel_weak_${a.id}_${b.id}/promote`, { version: await version(a.id) });
      expect(refused.status).toBe(422);
      expect(refused.body.message).toContain('cycle');

      const c = await make('Tool C');
      const d = await make('Tool D');
      await store.transaction((tx) => tx.insertRelation(weakRow(c.id, d.id, 'start')));
      const done = await tool('promote_relation', { id: c.id, version: await version(c.id), relationId: `rel_weak_${c.id}_${d.id}` });
      expect(done.error).toBe(false);
      expect(done.body.relations?.holding).toMatchObject([{ to: d.id, gate: 'start' }]);
      expect((await tool('promote_relation', { id: c.id, version: await version(c.id), relationId: 'rel_nope' })).error).toBe(true);
    });

    it('get_context carries relationLearning for the agent, mention and inferred sources', async () => {
      const g = await make('Context glob');
      const reply = await client.callTool({ name: 'get_context', arguments: { id: g.id } });
      const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '{}';
      const context = JSON.parse(text) as { relationLearning?: { source: string; precision: number | null; samples: number; windowDays: number; posture: string; note: string }[] };
      expect(context.relationLearning?.map((s) => s.source)).toEqual(['agent', 'mention', 'inferred']);
      // Earlier tests on this board left a signal or two: under the sample minimum the posture stays a gate.
      expect(context.relationLearning?.[0]).toMatchObject({ source: 'agent', windowDays: 90, posture: 'gate' });
      expect(context.relationLearning?.[0]?.samples).toBeLessThan(5);
      expect(context.relationLearning?.[0]?.note).toContain('concrete dependency');
    });
  });
});
