import { GlobService, ReportService, TIME_EVENT_DATA_KEYS, TIME_EVENT_TYPES } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database } from '../src/db/store.js';
import { PgStore } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountReports } from '../src/http/reports.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const HEADER = 'developer,period,RnD hours,maintenance hours,% RnD\r\n';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const overviewOf = z.object({ timeZone: z.string(), canDownload: z.boolean() });
const errorOf = z.object({ code: z.string() });

/** A board's time reports on real Postgres: computed from the seeded event log when downloaded, and only its admins may. */
describe('time reports', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let reports: ReportService;
  let boardId: number;
  const path = (rest: string) => `/api/boards/${String(boardId)}/reports${rest}`;
  let now = '2026-09-07T08:00:00.000Z';

  const as = (email: string, path: string, method = 'GET') =>
    app.request(path, { method, headers: { 'x-test-email': email } });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('reports'));
    store = new PgStore(database.db);
    const clock = { now: () => now };
    const globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    reports = new ReportService({ store, clock, timeZone: 'Europe/London' });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? ADMIN);
      await next();
    });
    mountReports(app, { reports });

    boardId = await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, STRANGER]) await tx.upsertUser({ email, name: email, active: true });
      const board = await tx.insertBoard({ name: 'reports', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    const input = { boardId, summary: '', type: 'same' as const, group: null, environment: null, autoTrigger: false, idempotencyKey: null };
    // Monday 7 September (BST, UTC+1): Dev starts a feature at 10:00 local and starts it again (back to Planning) at
    // 12:00; then picks up a task at 14:00 and starts that again at 16:00. 2 h each.
    const feature = unwrap(await globs.create(DEV, { ...input, title: 'Feature', category: 'feature' }));
    const task = unwrap(await globs.create(DEV, { ...input, title: 'Task', category: 'task' }));
    now = '2026-09-07T09:00:00.000Z';
    const started = unwrap(await globs.start(DEV, feature.id, feature.version));
    now = '2026-09-07T11:00:00.000Z';
    unwrap(await globs.startAgain(DEV, started.id, started.version));
    now = '2026-09-07T13:00:00.000Z';
    const picked = unwrap(await globs.pickUp(DEV, task.id, task.version, false));
    now = '2026-09-07T15:00:00.000Z';
    unwrap(await globs.startAgain(DEV, picked.id, picked.version));
    now = '2026-10-09T12:00:00.000Z';
  });

  afterAll(() => drop());

  const callReport = async (email: string, period: string) => {
    const server = buildServer({ reports } as unknown as McpDeps, email, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name: 'get_report', arguments: { board: boardId, period } });
    await client.close();
    const text = z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? 'null';
    return { isError: result.isError === true, body: JSON.parse(text) as unknown };
  };

  it('reads every board’s events of the given types before a time, in log order, with only the data keys asked for', async () => {
    const events = await store.transaction((tx) => tx.listEventsUntil('2026-09-07T13:00:00.000Z', TIME_EVENT_TYPES, TIME_EVENT_DATA_KEYS));
    expect(events.every((e) => TIME_EVENT_TYPES.some((t) => t === e.type) && e.at < '2026-09-07T13:00:00.000Z')).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['GlobCreated', 'GlobCreated', 'StatusChanged', 'StatusChanged']);
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
    expect(events[0]?.data).toEqual({ status: 'planning', category: 'feature', type: 'same' });
    expect(events[2]?.data).toEqual({ to: expect.any(String) as unknown });
    const keysOnly = await store.transaction((tx) => tx.listEventsUntil('2026-09-07T13:00:00.000Z', ['GlobCreated'], []));
    expect(keysOnly.map((e) => e.data)).toEqual([{}, {}]);
    expect(await store.transaction((tx) => tx.listEventsUntil('2030-01-01T00:00:00.000Z', [], TIME_EVENT_DATA_KEYS))).toEqual([]);
  });

  it('downloads the CSV computed from the event log', async () => {
    const csv = await as(ADMIN, path('/2026-09/csv'));
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe(`attachment; filename="slop-report-${String(boardId)}-2026-09.csv"`);
    expect(await csv.text()).toBe(`${HEADER}dev@example.com,2026-09,2.00,2.00,50.0\r\n`);

    const year = await as(ADMIN, path('/2026'));
    expect(year.status).toBe(200);
    expect(await year.json()).toEqual({ boardId, period: '2026', kind: 'year', timeZone: 'Europe/London', computedAt: now, csv: `${HEADER}dev@example.com,2026,2.00,2.00,50.0\r\n` });

    expect(await (await as(ADMIN, path('/2026-10/csv'))).text()).toBe(HEADER);
    expect(overviewOf.parse(await (await as(ADMIN, path(''))).json())).toEqual({ timeZone: 'Europe/London', canDownload: true });
  });

  it('shows members the time zone only, and refuses non-members, non-admins and bad or future periods', async () => {
    expect(overviewOf.parse(await (await as(DEV, path(''))).json())).toEqual({ timeZone: 'Europe/London', canDownload: false });
    expect((await as(STRANGER, path(''))).status).toBe(403);
    expect((await as(DEV, path('/2026-09/csv'))).status).toBe(403);
    expect((await as(DEV, path('/2026-09'))).status).toBe(403);
    expect((await as(STRANGER, path('/2026-09/csv'))).status).toBe(403);
    // Access is checked before the period, so a caller who can't download learns nothing from a bad one.
    expect((await as(STRANGER, path('/2026-1/csv'))).status).toBe(403);
    expect((await as(DEV, path('/2026-11/csv'))).status).toBe(403);
    expect((await as(ADMIN, path('/2026-1/csv'))).status).toBe(422);
    expect((await as(ADMIN, path('/2026-11/csv'))).status).toBe(422);
    expect((await as(ADMIN, '/api/boards/x/reports/2026-09/csv')).status).toBe(422);
    // A board the admin isn't on: refused like a stranger.
    expect((await as(ADMIN, `/api/boards/${String(boardId + 1000)}/reports/2026-09/csv`)).status).toBe(403);
  });

  it('reads glob facts for any number of IDs in one parameter, leaving missing ones out', async () => {
    const real = (await store.transaction((tx) => tx.listEventsUntil('2030-01-01T00:00:00.000Z', ['GlobCreated'], []))).map((e) => e.globId);
    // Past Postgres's 65,535 bind parameters, as a long event log would name.
    const ids = [...real, ...Array.from({ length: 70_000 }, (_, i) => `s999t${String(i)}`)];
    const facts = await store.transaction((tx) => tx.globFacts(ids));
    expect(facts.map((f) => f.id).sort()).toEqual([...real].sort());
    expect(facts.find((f) => f.category === 'feature')).toMatchObject({ boardId, planner: DEV, type: 'same' });
    expect(facts.map((f) => f.category).sort()).toEqual(['feature', 'task']);
    expect(await store.transaction((tx) => tx.globFacts([]))).toEqual([]);
  });

  it('serves the same report over MCP as get_report, with the same refusals', async () => {
    expect(await callReport(ADMIN, '2026-09')).toEqual({
      isError: false,
      body: { boardId, period: '2026-09', kind: 'month', timeZone: 'Europe/London', computedAt: now, csv: `${HEADER}dev@example.com,2026-09,2.00,2.00,50.0\r\n` },
    });
    const forbidden = await callReport(DEV, '2026-09');
    expect(forbidden.isError).toBe(true);
    expect(errorOf.parse(forbidden.body).code).toBe('forbidden');
    const bad = await callReport(ADMIN, '2026-1');
    expect(bad.isError).toBe(true);
    expect(errorOf.parse(bad.body).code).toBe('invalid_input');
  });
});
