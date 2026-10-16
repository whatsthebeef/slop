import { BoardService, GlobService, invalidInput, machine } from '@slop/core';
import type { Effect, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import * as schema from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';
// Looks like a GitHub token: the note masks it before it is stored.
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Body {
  id: string;
  version: number;
  status: string;
  generation?: number;
  allowedActions?: string[];
  humanSteps?: { id: string; title: string; state: string }[];
  code?: string;
  message?: string;
}

/** Rollout steps of a same over REST and MCP: failing a step, Merge and continue, the merge gate (Postgres). */
describe('rollout steps: report a failed step, Merge and continue', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let app: Hono<Env>;
  let client: Client;
  let boardId: number;
  let globId = '';
  let gateCalls = 0;
  let gateRefuses = false;
  const effects: string[] = [];

  const rest = async (path: string, body: unknown = {}, as = DEV) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : {}) as Body };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '{}';
    return {
      error: reply.isError === true,
      body: (text.startsWith('{') ? JSON.parse(text) : { message: text }) as Body,
    };
  };
  const current = async () => unwrap(await globs.get(DEV, globId));
  const stepsOf = () => store.transaction((tx) => tx.listHumanSteps(boardId, [globId]));
  const attachments = async () =>
    (await database.db.select().from(schema.artifacts).where(eq(schema.artifacts.globId, globId)))
      .filter((a) => a.kind === 'attachment' && a.label.startsWith('Rollout step failed'))
      .map((a) => a.content);

  /** A same whose PR #7 passed its checks, with one rollout step. Merge and continue then lands it. */
  const readySame = async () => {
    const created = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Rollout same',
        type: 'same',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    const id = unwrap(await globs.pickUp(DEV, created.id, created.version, false)).id;
    await globs.applyEvent(id, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: HEAD } }, ctx),
    );
    await globs.applyEvent(id, (g, ctx) =>
      machine.prReadyForReview(g, { number: 7, headSha: HEAD }, ctx),
    );
    await globs.applyEvent(id, (g, ctx) =>
      machine.checksCompleted(g, { sha: HEAD, passed: true }, ctx),
    );
    globId = id;
    const added = await rest(`/api/globs/${id}/human-steps`, {
      title: 'Roll out the host',
      who: 'admin',
      kind: 'rollout',
    });
    expect(added.status).toBe(200);
    return added.body.humanSteps?.find((s) => s.title === 'Roll out the host')?.id ?? '';
  };
  const land = async () => {
    expect(
      (
        await rest(`/api/globs/${globId}/actions/merge`, {
          version: (await current()).glob.version,
        })
      ).status,
    ).toBe(200);
    await globs.applyEvent(globId, (g, ctx) => machine.merged(g, { sha: 'm1', number: 7 }, ctx));
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('rollout_continue'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boards = new BoardService({ store, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    await store.transaction((tx) =>
      tx.upsertUser({ email: 'outsider@example.com', name: 'Out', active: true }),
    );
    boardId = unwrap(
      await boards.create(DEV, {
        name: 'b',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    const record = (kind: string) => (e: Effect) => {
      effects.push(`${kind}:${e.globId}`);
      return Promise.resolve('done' as const);
    };
    const outbox = new OutboxRunner(
      database.db,
      { globs },
      {
        provision: record('provision'),
        delete_branch: record('delete_branch'),
        fire_routine: record('fire_routine'),
        squash_merge: record('squash_merge'),
      },
      () => undefined,
    );
    const mergeGate = () => {
      gateCalls += 1;
      return Promise.resolve(
        gateRefuses ? invalidInput('Empty diff') : ({ ok: true, value: null } as const),
      );
    };
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: notifier,
      outbox,
      mergeGate,
      onBoardCreated: () => Promise.resolve(),
    });
    const server = buildServer(
      {
        globs,
        outbox,
        boards,
        mergeGate,
        deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) },
      } as unknown as McpDeps,
      DEV,
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

  beforeEach(() => {
    gateCalls = 0;
    gateRefuses = false;
    effects.length = 0;
  });

  it('offers Merge, never merge_continue, for a same with steps (glob view and board list); merge runs the merge gate', async () => {
    await readySame();
    const view = (await current()).allowedActions;
    expect(view).toContain('merge');
    expect(view).not.toContain('merge_continue');
    const listRes = await app.request(`/api/boards/${boardId}/globs`, {
      headers: { authorization: `Bearer dev:${DEV}` },
    });
    const list = (await listRes.json()) as Body[];
    expect(list.find((g) => g.id === globId)?.allowedActions).toContain('merge');
    expect(list.find((g) => g.id === globId)?.allowedActions).not.toContain('merge_continue');

    gateRefuses = true;
    const refused = await rest(`/api/globs/${globId}/actions/merge`, {
      version: (await current()).glob.version,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(gateCalls).toBe(1);
    expect((await current()).glob.status).toBe('pr_open');
  });

  it('Merge and continue lands the same open; failing the step over REST masks the note, starts the next generation and reopens the step', async () => {
    gateRefuses = false;
    const stepId = (await stepsOf()).find((s) => s.title === 'Roll out the host')?.id ?? '';
    await land();
    const merged = await current();
    expect(merged.glob.status).toBe('reviewing');
    expect(merged.allowedActions).toContain('pick_up');
    await rest(`/api/globs/${globId}/human-steps/${stepId}/complete`, {
      note: `ran it, token ${TOKEN}`,
    });
    expect((await stepsOf()).find((s) => s.id === stepId)?.state).toBe('done');

    const failed = await rest(`/api/globs/${globId}/steps/${stepId}/fail`, {
      note: `AccessDenied on iam:PassRole\nAWS_SECRET=${TOKEN}`,
      version: merged.glob.version,
    });
    expect(failed.status).toBe(200);
    expect(failed.body.generation).toBe(merged.glob.generation + 1);
    expect(failed.body.humanSteps?.find((s) => s.id === stepId)?.state).not.toBe('done');
    const stored = await attachments();
    expect(stored.some((c) => c.includes('AccessDenied on iam:PassRole'))).toBe(true);
    expect(stored.join('\n')).not.toContain(TOKEN);
    // The next generation is provisioned from the outbox (a fresh branch from master).
    for (let i = 0; i < 50 && !effects.includes(`provision:${globId}`); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(effects).toContain(`provision:${globId}`);
    // The masked note is on the glob only: the board list carries no attachment text.
    const list = await app.request(`/api/boards/${boardId}/globs`, {
      headers: { authorization: `Bearer dev:${DEV}` },
    });
    expect(JSON.stringify(await list.json())).not.toContain('AccessDenied on iam:PassRole');
    const events = await store.transaction((tx) =>
      tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['RolloutStepFailed'], [globId]),
    );
    expect(events.map((e) => e.type)).toContain('RolloutStepFailed');
  });

  it('refuses a failed report from a non-member, an empty note, a stale version and an unknown step', async () => {
    const stepId = (await stepsOf())[0]?.id ?? '';
    expect(
      (
        await rest(
          `/api/globs/${globId}/steps/${stepId}/fail`,
          { note: 'x' },
          'outsider@example.com',
        )
      ).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await rest(`/api/globs/${globId}/steps/${stepId}/fail`, { note: '' })).status).toBe(
      422,
    );
    expect(
      (await rest(`/api/globs/${globId}/steps/${stepId}/fail`, { note: 'x', version: 999 })).status,
    ).toBe(409);
    expect((await rest(`/api/globs/${globId}/steps/hs_nope/fail`, { note: 'x' })).status).toBe(404);
  });

  it('fail_human_step over MCP: masked, next generation, step reopened; complete_human_step takes a note', async () => {
    const stepId = await readySame();
    await land();
    const before = await current();
    const done = await tool('complete_human_step', {
      id: globId,
      stepId,
      note: `done by hand ${TOKEN}`,
    });
    expect(done.error).toBe(false);
    const reported = await tool('fail_human_step', {
      id: globId,
      stepId,
      note: `boom ${TOKEN}`,
      version: before.glob.version,
    });
    expect(reported.error).toBe(false);
    expect(reported.body.generation ?? (await current()).glob.generation).toBe(
      before.glob.generation + 1,
    );
    const after = await current();
    expect(after.glob.generation).toBe(before.glob.generation + 1);
    expect((await stepsOf()).find((s) => s.id === stepId)?.state).not.toBe('done');
    const stored = await attachments();
    expect(stored.some((c) => c.includes('boom'))).toBe(true);
    expect(stored.join('\n')).not.toContain(TOKEN);
    const events = await store.transaction((tx) =>
      tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['RolloutStepFailed'], [globId]),
    );
    expect(events.filter((e) => e.type === 'RolloutStepFailed')).toHaveLength(1);
    // An empty note is refused by the tool's schema.
    expect((await tool('fail_human_step', { id: globId, stepId, note: '' })).error).toBe(true);
  });

  it('merge, fail the step, merge again: the steps are due again and sign-off waits', async () => {
    const stepId = await readySame();
    await land();
    expect(
      (await rest(`/api/globs/${globId}/steps/${stepId}/fail`, { note: 'it failed' })).status,
    ).toBe(200);
    // The new generation: a new PR, checks pass, Merge and continue again.
    await globs.applyEvent(globId, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: 9, headSha: 'f00dfeed' } }, ctx),
    );
    await globs.applyEvent(globId, (g, ctx) =>
      machine.prReadyForReview(g, { number: 9, headSha: 'f00dfeed' }, ctx),
    );
    await globs.applyEvent(globId, (g, ctx) =>
      machine.checksCompleted(g, { sha: 'f00dfeed', passed: true }, ctx),
    );
    expect((await current()).allowedActions).toContain('merge');
    expect(
      (
        await rest(`/api/globs/${globId}/actions/merge`, {
          version: (await current()).glob.version,
        })
      ).status,
    ).toBe(200);
    await globs.applyEvent(globId, (g, ctx) => machine.merged(g, { sha: 'm2', number: 9 }, ctx));
    const after = await current();
    expect(after.glob.status).toBe('reviewing');
    expect((await stepsOf()).find((s) => s.id === stepId)?.state).toBe('open');
    // Ticking the re-run step is what releases sign-off; its labels are not approved here, so the glob stays in review.
    const view = (await rest(`/api/globs/${globId}/human-steps/${stepId}/complete`, {})).body;
    expect(view.humanSteps?.find((s) => s.id === stepId)?.state).toBe('done');
    expect(view.status).toBe('reviewing');
  });
});
