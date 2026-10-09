import { createHash } from 'node:crypto';
import { IntegrationTokenService, InboxService, INBOX_TEXT_LIMIT } from '@slop/core';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/store.js';
import { PgStore } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountIntegrations } from '../src/http/integrations.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOTES = 'Weekly sync.\n\nWe agreed to move the sync jobs to a websocket.';

const secretOf = z.object({ token: z.string(), createdAt: z.string() });
const idOf = z.object({ id: z.number(), created: z.boolean() });

/** Integration ingest on real Postgres: token auth (valid, revoked, wrong board), dedupe on the source ref, size limits. */
describe('integration ingest', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let mine: number;
  let theirs: number;
  let counter = 0;

  const clock = { now: () => new Date().toISOString() };
  const asPerson = (email: string, path: string, method: string) =>
    app.request(`/api/boards/${String(mine)}/integration-token${path}`, {
      method,
      headers: { 'x-test-email': email },
    });
  const newToken = async (): Promise<string> =>
    secretOf.parse(await (await asPerson(ADMIN, '', 'POST')).json()).token;
  const deliver = (board: number, token: string | null, body: unknown) =>
    app.request(`/integrations/boards/${String(board)}/inbox`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  const meet = (ref: string, text = NOTES) => ({
    source: 'meet',
    sourceRef: ref,
    text,
    title: 'Weekly sync',
    occurredAt: '2026-10-06',
    sourceLabel: 'Google Meet',
  });
  const count = (board: number) =>
    database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.boardId, board))
      .then((r) => r[0]?.n ?? 0);

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('integrations'));
    const store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? ADMIN);
      await next();
    });
    mountIntegrations(app, {
      inbox: new InboxService({ store, clock, notifier }),
      tokens: new IntegrationTokenService({
        store,
        clock,
        newSecret: () => `slopit_test${String(++counter)}`,
        hashSecret: (s) => createHash('sha256').update(s).digest('hex'),
      }),
    });
    [mine, theirs] = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const insert = (name: string) =>
        tx.insertBoard({ name, repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      const a = await insert('mine');
      const b = await insert('theirs');
      await tx.upsertMember({ boardId: a.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: a.id, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: b.id, email: ADMIN, role: 'admin' });
      return [a.id, b.id];
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('refuses a delivery with no token, a wrong token and a token for another board', async () => {
    const token = await newToken();
    expect((await deliver(mine, null, meet('doc-a'))).status).toBe(401);
    expect((await deliver(mine, 'slopit_nope', meet('doc-a'))).status).toBe(401);
    // Another board's own token does not open this board.
    await app.request(`/api/boards/${String(theirs)}/integration-token`, { method: 'POST', headers: { 'x-test-email': ADMIN } });
    expect((await deliver(theirs, token, meet('doc-a'))).status).toBe(401);
    expect(await count(mine)).toBe(0);
    expect(await count(theirs)).toBe(0);
  });

  it('adds a delivered item to its own board, once per source ref', async () => {
    const token = await newToken();
    const first = await deliver(mine, token, meet('doc-1'));
    expect(first.status).toBe(201);
    const added = idOf.parse(await first.json());
    expect(added.created).toBe(true);
    const [row] = await database.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, added.id));
    expect(row).toMatchObject({
      boardId: mine,
      source: 'meet',
      sourceRef: 'doc-1',
      title: 'Weekly sync',
      sourceLabel: 'Google Meet',
      sourceType: 'meeting',
      status: 'new',
      createdBy: null,
    });
    expect(row?.occurredAt.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    // A re-run delivers the same doc: nothing new, even when the text was edited meanwhile.
    const again = await deliver(mine, token, meet('doc-1', `${NOTES}\n\nAn edit.`));
    expect(again.status).toBe(200);
    expect(idOf.parse(await again.json())).toEqual({ id: added.id, created: false });
    expect(await count(mine)).toBe(1);
    // A different doc is a different item.
    expect((await deliver(mine, token, meet('doc-2', 'Another meeting about billing.'))).status).toBe(201);
    expect(await count(mine)).toBe(2);
  });

  it('keeps a discarded item discarded when its doc is delivered again', async () => {
    const token = await newToken();
    const added = idOf.parse(await (await deliver(mine, token, meet('doc-3', 'Notes to throw away.'))).json());
    await database.db.update(schema.inboxItems).set({ status: 'discarded' }).where(eq(schema.inboxItems.id, added.id));
    const again = idOf.parse(await (await deliver(mine, token, meet('doc-3', 'Notes to throw away.'))).json());
    expect(again).toEqual({ id: added.id, created: false });
    const [row] = await database.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, added.id));
    expect(row?.status).toBe('discarded');
  });

  it('refuses a revoked token, and a new token replaces the old one', async () => {
    const old = await newToken();
    const replacement = await newToken();
    expect((await deliver(mine, old, meet('doc-4', 'Replaced token notes.'))).status).toBe(401);
    expect((await deliver(mine, replacement, meet('doc-4', 'Replaced token notes.'))).status).toBe(201);
    expect((await asPerson(ADMIN, '', 'DELETE')).status).toBe(200);
    expect((await deliver(mine, replacement, meet('doc-5', 'After revoke.'))).status).toBe(401);
    const status = z.object({ active: z.boolean() }).parse(await (await asPerson(ADMIN, '', 'GET')).json());
    expect(status.active).toBe(false);
  });

  it('stores only the hash of the token, and only admins manage it', async () => {
    expect((await asPerson(DEV, '', 'POST')).status).toBe(403);
    expect((await asPerson(DEV, '', 'DELETE')).status).toBe(403);
    expect((await asPerson(DEV, '', 'GET')).status).toBe(200);
    const token = await newToken();
    const rows = await database.db.select().from(schema.integrationTokens).where(eq(schema.integrationTokens.boardId, mine));
    expect(rows.some((r) => r.tokenHash === createHash('sha256').update(token).digest('hex'))).toBe(true);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
  });

  it('enforces the size limits and the shape', async () => {
    const token = await newToken();
    const tooLong = await deliver(mine, token, meet('doc-6', 'x'.repeat(INBOX_TEXT_LIMIT + 1)));
    expect(tooLong.status).toBe(422);
    const huge = await app.request(`/integrations/boards/${String(mine)}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'y'.repeat(INBOX_TEXT_LIMIT * 4 + 5_000),
    });
    expect(huge.status).toBe(413);
    expect((await deliver(mine, token, { ...meet('doc-7'), source: 'slack' })).status).toBe(422);
    expect((await deliver(mine, token, { ...meet(''), text: NOTES })).status).toBe(422);
    expect((await deliver(mine, token, { ...meet('doc-8'), occurredAt: 'yesterday' })).status).toBe(422);
  });
});
