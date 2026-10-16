import { BoardService, GlobService, SpendService } from '@slop/core';
import type { Board, Result } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth, SESSION_COOKIE } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const NOW = '2026-10-15T12:00:00.000Z';

describe('review settings and the spend line over HTTP (s15f43)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: Hono<Env>;
  let boardId: number;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    db = await createTestDatabase('review_settings_routes');
    const store = new PgStore(db.database.db);
    const hub = new HintHub();
    const boards = new BoardService({ store, notifier: hub });
    const globs = new GlobService({
      store,
      notifier: hub,
      clock: { now: () => NOW },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const auth = new Auth(db.database.db, loadConfig({}));
    const spend = new SpendService({ store, clock: { now: () => NOW } });
    app = createApp({
      auth,
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      spend,
      outbox: new OutboxRunner(db.database.db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, STRANGER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    cookies = {};
    for (const email of [ADMIN, DEV, STRANGER])
      cookies[email] = `${SESSION_COOKIE}=${await auth.createSession({ email, name: email })}`;
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'b',
        repo: null,
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    await spend.record({
      boardId,
      globId: null,
      source: 'review',
      model: 'openai.gpt-oss-120b-1:0',
      inputTokens: 1_000_000,
      outputTokens: 0,
      ref: '1',
    });
    await spend.record({
      boardId,
      globId: null,
      source: 'review',
      model: 'unpriced',
      inputTokens: 5,
      outputTokens: 5,
      ref: null,
    });
  });

  afterAll(() => db.drop());

  const call = (who: string, method: string, path: string, body?: object) =>
    app.request(path, {
      method,
      headers: { cookie: cookies[who] ?? '', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const board = async () =>
    (await (await call(ADMIN, 'GET', `/api/boards/${boardId}`)).json()) as Board;

  it('an admin changes some review settings and the rest stay; a bad value is refused', async () => {
    const before = await board();
    expect(before.review).toEqual({
      enabled: true,
      model: null,
      minSeverity: 'medium',
      ignoredPaths: [],
      toolCap: null,
    });
    const saved = await call(ADMIN, 'PATCH', `/api/boards/${boardId}/settings`, {
      version: before.version,
      review: { enabled: false, model: 'm1' },
    });
    expect(saved.status).toBe(200);
    const after = await board();
    expect(after.review).toEqual({
      enabled: false,
      model: 'm1',
      minSeverity: 'medium',
      ignoredPaths: [],
      toolCap: null,
    });
    const bad = await call(ADMIN, 'PATCH', `/api/boards/${boardId}/settings`, {
      version: after.version,
      review: { toolCap: 0 },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const unknown = await call(ADMIN, 'PATCH', `/api/boards/${boardId}/settings`, {
      version: after.version,
      review: { minSeverity: 'urgent' },
    });
    expect(unknown.status).toBe(422);
    expect((await board()).review.toolCap).toBeNull();
  });

  it('a non-admin cannot change them', async () => {
    const current = await board();
    const refused = await call(DEV, 'PATCH', `/api/boards/${boardId}/settings`, {
      version: current.version,
      review: { enabled: true },
    });
    expect(refused.status).toBe(403);
    expect((await board()).review.enabled).toBe(false);
  });

  it("shows a member this month's spend with its unpriced calls, and refuses a stranger", async () => {
    const response = await call(DEV, 'GET', `/api/boards/${boardId}/spend`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      month: '2026-10',
      usd: 0.15,
      unpricedCalls: 1,
      bySource: { review: 0.15 },
      unpricedBySource: { review: 1 },
    });
    expect((await call(STRANGER, 'GET', `/api/boards/${boardId}/spend`)).status).toBe(403);
  });
});
