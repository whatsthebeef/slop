import { readFile } from 'node:fs/promises';
import {
  ArtifactService,
  BoardService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MiningService,
  TypeLearningService,
} from '@slop/core';
import type { Glob, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
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
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const NOW = '2026-10-11T12:00:00.000Z';
const MIGRATION = '0045_type_corrections';
const PLAN =
  '## Open questions\n- Which store holds it?\n\nTouches apps/server/src/auth/session.ts.';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by these tests'));
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

describe('Type corrections in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let globs: GlobService;
  let boardId: number;
  let at = NOW;
  const notifier = { publish: () => undefined };
  const clock = { now: () => at };
  const path = (suffix: string) => `/api/boards/${String(boardId)}/type-learning${suffix}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('type_corrections'));
    store = new PgStore(database.db);
    const deps = { store, notifier, clock };
    globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boards = new BoardService(deps);
    const mining = new MiningService(deps);
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: new HintHub(),
      outbox: new OutboxRunner(database.db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    mountKnowledge(app, {
      knowledge: new KnowledgeService({ ...deps, catalog, signals: mining }),
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards,
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining, manifests: null }),
      typeLearning: new TypeLearningService({ store, clock }),
      logError: () => undefined,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  afterAll(async () => {
    await drop();
  });

  const request = (method: string, url: string, body: unknown, email = ADMIN) =>
    app.request(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${email}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const create = async (type: Glob['type']): Promise<Glob> =>
    unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'x',
        type,
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: PLAN,
      }),
    );

  it('the migration creates the table, re-running it is harmless, and the journal orders it after the previous one', async () => {
    const migration = await readFile(
      new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url),
      'utf8',
    );
    for (let run = 0; run < 2; run++)
      for (const statement of migration.split('--> statement-breakpoint'))
        await database.db.execute(sql.raw(statement));
    const columns = await database.db.execute(sql`
      select column_name, is_nullable from information_schema.columns where table_name = 'type_corrections' order by ordinal_position`);
    expect([...columns].map((c) => c.column_name)).toEqual([
      'id',
      'board_id',
      'glob_id',
      'from_type',
      'to_type',
      'actor',
      'at',
      'signals',
      'reset_at',
    ]);
    expect([...columns].find((c) => c.column_name === 'reset_at')?.is_nullable).toBe('YES');
    const journal = JSON.parse(
      await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const index = journal.entries.findIndex((e) => e.tag === MIGRATION);
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Infinity,
    );
  });

  it("inserts, lists the board's latest not reset (newest first, limited), and a reset stamps them but keeps the rows", async () => {
    const signals = {
      openQuestions: 1,
      decisionWording: false,
      riskAreaFiles: ['apps/server/src/auth/session.ts'],
      sizeTasks: null,
    };
    const row = (globId: string, when: string) =>
      ({
        boardId,
        globId,
        fromType: 'sub',
        toType: 'same',
        actor: DEV,
        at: when,
        signals,
      }) as const;
    await store.transaction(async (tx) => {
      await tx.insertTypeCorrection(row('g1', '2026-10-01T00:00:00.000Z'));
      await tx.insertTypeCorrection(row('g2', '2026-10-02T00:00:00.000Z'));
      await tx.insertTypeCorrection(row('g3', '2026-10-03T00:00:00.000Z'));
    });
    const live = await store.transaction((tx) => tx.listTypeCorrections(boardId));
    expect(live.map((c) => c.globId)).toEqual(['g3', 'g2', 'g1']);
    expect(live[0]).toMatchObject({
      boardId,
      fromType: 'sub',
      toType: 'same',
      actor: DEV,
      signals,
      resetAt: null,
      at: '2026-10-03T00:00:00.000Z',
    });
    expect(
      (await store.transaction((tx) => tx.listTypeCorrections(boardId, { limit: 2 }))).map(
        (c) => c.globId,
      ),
    ).toEqual(['g3', 'g2']);

    expect(
      await store.transaction((tx) => tx.resetTypeCorrections(boardId, '2026-10-04T00:00:00.000Z')),
    ).toBe(3);
    expect(await store.transaction((tx) => tx.listTypeCorrections(boardId))).toEqual([]);
    const all = await store.transaction((tx) => tx.listTypeCorrections(boardId, { all: true }));
    expect(all).toHaveLength(3);
    expect(all.every((c) => c.resetAt === '2026-10-04T00:00:00.000Z')).toBe(true);
    // A second reset has nothing live to stamp, and another board is untouched.
    expect(
      await store.transaction((tx) => tx.resetTypeCorrections(boardId, '2026-10-05T00:00:00.000Z')),
    ).toBe(0);
    expect(
      await store.transaction((tx) => tx.listTypeCorrections(boardId + 1, { all: true })),
    ).toEqual([]);
  });

  it('a person retype through the glob service is recorded with the plan signals, and the routes show it', async () => {
    at = '2026-10-11T12:00:00.000Z';
    const same = await create('same');
    unwrap(await globs.update(ADMIN, same.id, same.version, { type: 'super' }));

    const view = await request('GET', path(''), undefined, DEV);
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      learned: boolean;
      defaults: unknown[];
      corrections: { globId: string; fromType: string; toType: string; signals: unknown }[];
    };
    expect(body.learned).toBe(true);
    expect(body.defaults).toHaveLength(3);
    expect(body.corrections).toEqual([
      expect.objectContaining({
        globId: same.id,
        fromType: 'same',
        toType: 'super',
        signals: {
          openQuestions: 1,
          decisionWording: false,
          riskAreaFiles: ['apps/server/src/auth/session.ts'],
          sizeTasks: null,
        },
      }),
    ]);
    expect((await request('GET', path(''), undefined, OUTSIDER)).status).toBe(403);
  });

  it('reset is for board admins only, and leaves the history', async () => {
    expect((await request('POST', path('/reset'), {}, DEV)).status).toBe(403);
    expect((await request('POST', path('/reset'), {}, OUTSIDER)).status).toBe(403);
    expect(
      ((await (await request('GET', path(''), undefined, DEV)).json()) as { learned: boolean })
        .learned,
    ).toBe(true);

    at = '2026-10-12T00:00:00.000Z';
    const reset = await request('POST', path('/reset'), {}, ADMIN);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ learned: false, corrections: [] });
    const all = await store.transaction((tx) => tx.listTypeCorrections(boardId, { all: true }));
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((c) => c.resetAt !== null)).toBe(true);
  });

  it('needs_pairing: the failure is recorded, Make it a super is a REST action and records a correction', async () => {
    at = '2026-10-13T00:00:00.000Z';
    const sub = await create('sub');
    const runId = sub.runs.at(-1)?.id ?? null;
    const failed = unwrap(
      await globs.reportFailure(ADMIN, sub.id, 'The storage design is open', runId, null, {
        kind: 'needs_pairing',
        decision: 'Which store?',
      }),
    );
    expect(failed.failure).toMatchObject({ kind: 'needs_pairing', decision: 'Which store?' });

    const read = (await (await request('GET', `/api/globs/${sub.id}`, undefined, ADMIN)).json()) as {
      allowedActions?: string[];
    };
    expect(read.allowedActions).toContain('make_super');

    expect(
      (
        await request(
          'POST',
          `/api/globs/${sub.id}/actions/make-super`,
          { version: failed.version },
          OUTSIDER,
        )
      ).status,
    ).toBe(403);
    const made = await request(
      'POST',
      `/api/globs/${sub.id}/actions/make-super`,
      { version: failed.version },
      ADMIN,
    );
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({
      type: 'super',
      status: 'in_progress',
      implementer: ADMIN,
      failure: null,
    });

    const live = await store.transaction((tx) => tx.listTypeCorrections(boardId));
    expect(live).toEqual([
      expect.objectContaining({ globId: sub.id, fromType: 'sub', toType: 'super', actor: ADMIN }),
    ]);
  });
});
