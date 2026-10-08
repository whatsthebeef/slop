import { readFile } from 'node:fs/promises';
import {
  ArtifactService,
  BoardService,
  EffectCheckService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MiningService,
  newKbItemId,
  UNPROCESSED,
} from '@slop/core';
import type { BoardJob, DomainEvent, KbItem, KbSignal, Result, Store } from '@slop/core';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** When changes are approved (the services' clock). */
const NOW = '2026-10-07T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

/** This strand's migration: a renumber (when another migration lands first) changes only this. */
const MIGRATION = '0019_kb_effect_check';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by the knowledge routes'));
const host = fakeCodeHost({ configured: false });
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

const CI: KbSignal = {
  key: 'ci_after_local',
  kind: 'ci_after_local',
  agent: 'orchestrator',
  label: 'CI failing after local checks passed',
  window: { from: at(-28 * DAY), to: NOW },
  figures: { affected: 4, eligible: 19, rate: 0.211, count: 4 },
  globIds: [],
  examples: [],
  measuredAt: NOW,
};

describe('Effect checks in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let appWith: (
    jobs: LearningJobService,
    logError: (task: string, message: string) => void,
  ) => Hono<Env>;
  let boards: BoardService;
  let globs: GlobService;
  let mining: MiningService;
  let checks: EffectCheckService;
  let knowledge: KnowledgeService;
  let jobs: LearningJobService;
  let boardId: number;
  const clock = { now: () => NOW };
  const notifier = { publish: () => undefined };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('effect_check'));
    const { db } = database;
    store = new PgStore(db);
    const hub = new HintHub();
    const deps = { store, notifier, clock };
    globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boards = new BoardService(deps);
    mining = new MiningService(deps);
    checks = new EffectCheckService({ store, notifier, mining });
    knowledge = new KnowledgeService({ ...deps, catalog, signals: mining });
    jobs = new LearningJobService({ ...deps, mining, effectChecks: checks, manifests: null });
    // The real app (dev sign-in: `Bearer dev:<email>`), with the knowledge routes.
    appWith = (routeJobs, logError) => {
      const built = createApp({
        auth: new Auth(db, loadConfig({})),
        links: new SignedLinks('test'),
        boards,
        globs,
        hub,
        outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
        onBoardCreated: () => Promise.resolve(),
      });
      mountKnowledge(built, {
        knowledge,
        artifacts: new ArtifactService(deps),
        findings: new FindingsService(deps),
        catalog,
        intake: new IntakeService({ store, llm: { complete: unused } }),
        boards,
        host,
        jobs: routeJobs,
        logError,
      });
      return built;
    };
    app = appWith(jobs, () => undefined);
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'b',
        repo: null,
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

  const request = (method: string, path: string, body: unknown, email = ADMIN, via = app) =>
    via.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${email}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let n = 0;
  /** A merged glob whose routine push built, failing CI when `failed`. */
  const merge = async (mergedAt: string, failed: boolean): Promise<string> => {
    const id = unwrap(
      await globs.create(DEV, {
        boardId,
        title: `Glob ${String(++n)}`,
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    const sha = `${n.toString(16).padStart(7, '0')}abcdef0`;
    const work = new Date(Date.parse(mergedAt) - HOUR).toISOString();
    const event = (
      type: DomainEvent['type'],
      when: string,
      data: DomainEvent['data'],
    ): DomainEvent => ({ type, globId: id, actor: null, at: when, data });
    await store.transaction((tx) =>
      tx.appendEvents([
        event('RunTriggered', work, { runId: `run-${String(n)}` }),
        event('CommitPushed', work, { sha, runId: `run-${String(n)}` }),
        event('BuildCompleted', work, { sha, passed: !failed }),
        event('Merged', mergedAt, { sha }),
      ]),
    );
    // Created when its work started, last changed when it merged (what the activity's lookback reads).
    await database.db.execute(
      sql`update globs set data = data || jsonb_build_object('createdAt', ${work}::text, 'updatedAt', ${mergedAt}::text), updated_at = ${mergedAt} where id = ${id}`,
    );
    return id;
  };

  /** An open mined item watching `ci_after_local`, kept as a learning when approved (time basis). */
  const mined = async (): Promise<KbItem> =>
    store.transaction(async (tx) => {
      const item: KbItem = {
        id: await newKbItemId(tx, boardId),
        boardId,
        status: 'open',
        type: 'gotcha',
        statement: 'Run the full checks before a routine pushes',
        evidence: 'Mined',
        suggestedTarget: 'build_test_lint',
        sourceGlobIds: [],
        source: 'mined',
        signal: CI,
        agentSetVersion: 0,
        submittedBy: 'slop',
        createdAt: at(-DAY),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        document: null,
        outcome: null,
        ...UNPROCESSED,
        processing: 'drafted',
        version: 1,
      };
      await tx.insertKbItem(item);
      return item;
    });
  const get = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  it('the effect-check migration adds its columns with their defaults, and re-running it is harmless', async () => {
    const migration = await readFile(
      new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint'))
      await database.db.execute(sql.raw(statement));
    const columns = await database.db.execute(sql`
      select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where (table_name = 'boards' and column_name = 'effect_check_globs') or (table_name = 'kb_proposals' and column_name = 'effect_check')
      order by table_name`);
    expect([...columns]).toEqual([
      {
        table_name: 'boards',
        column_name: 'effect_check_globs',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: '10',
      },
      {
        table_name: 'kb_proposals',
        column_name: 'effect_check',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    // A row from before the migration has no check.
    const id = `s${String(boardId)}k9999`;
    await database.db.execute(sql`
      insert into kb_proposals (id, board_id, status, type, statement, evidence, source_glob_ids, source, submitted_by, created_at, version)
      values (${id}, ${boardId}, 'rejected', 'gotcha', 'Old', 'Old', '[]'::jsonb, 'submitted', ${DEV}, now(), 1)`);
    expect((await get(id)).effectCheck).toBeNull();
    await database.db.execute(sql`delete from kb_proposals where id = ${id}`);
    const journal = JSON.parse(
      await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as {
      entries: { tag: string; when: number }[];
    };
    // Found by its tag, so later migrations can follow it.
    const index = journal.entries.findIndex((e) => e.tag === MIGRATION);
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Infinity,
    );
  });

  it('round-trips the board setting through the settings route, validated to 3–50 globs, for admins', async () => {
    const board = async () =>
      (await (await request('GET', `/api/boards/${String(boardId)}`, undefined)).json()) as {
        version: number;
        effectCheckGlobs: number;
      };
    expect((await board()).effectCheckGlobs).toBe(10);
    for (const bad of [2, 51, 4.5]) {
      const refused = await request('PATCH', `/api/boards/${String(boardId)}/settings`, {
        version: (await board()).version,
        effectCheckGlobs: bad,
      });
      expect(refused.status).toBe(422);
    }
    const byDev = await request(
      'PATCH',
      `/api/boards/${String(boardId)}/settings`,
      { version: (await board()).version, effectCheckGlobs: 20 },
      DEV,
    );
    expect(byDev.status).toBe(403);
    const saved = await request('PATCH', `/api/boards/${String(boardId)}/settings`, {
      version: (await board()).version,
      effectCheckGlobs: 3,
    });
    expect(saved.status).toBe(200);
    expect((await board()).effectCheckGlobs).toBe(3);
  });

  it('gives the effect-check job lease to one claimer at a time', async () => {
    const lease = 30 * 60 * 1000;
    const claims = await Promise.all([
      store.transaction((tx) => tx.claimBoardJob(boardId, 'effect_check', NOW, lease)),
      store.transaction((tx) => tx.claimBoardJob(boardId, 'effect_check', NOW, lease)),
    ]);
    const won = claims.filter((c): c is BoardJob => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ job: 'effect_check', runningUntil: at(lease) });
    const [claimed] = won;
    if (claimed === undefined) throw new Error('not claimed');
    expect(
      await store.transaction((tx) =>
        tx.finishBoardJob({ ...claimed, runningUntil: null }, claimed.runningUntil ?? ''),
      ),
    ).toBe(true);
  });

  it('starts the check on approval through the route, with the before figures at once, and Run now is for admins', async () => {
    const before = [
      await merge(at(-3 * DAY), true),
      await merge(at(-2 * DAY), false),
      await merge(at(-DAY), true),
    ];
    const item = await mined();
    const approved = await request('POST', `/api/kb/${item.id}/approve`, {
      as: 'learning',
      version: item.version,
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as KbItem).effectCheck).toMatchObject({
      state: 'watching',
      basis: { kind: 'time', since: NOW },
      n: 3,
    });
    // The approval started a check in the background.
    await vi.waitFor(async () => expect((await get(item.id)).effectCheck?.before).not.toBeNull(), {
      timeout: 5_000,
      interval: 20,
    });
    expect((await get(item.id)).effectCheck).toMatchObject({
      state: 'watching',
      before: { affected: 2, eligible: 3, globIds: before },
      after: { affected: 0, eligible: 0 },
    });
    await vi.waitFor(async () =>
      expect(
        (await store.transaction((tx) => tx.getBoardJob(boardId, 'effect_check')))?.runningUntil,
      ).toBeNull(),
    );

    const byDev = await request(
      'POST',
      `/api/boards/${String(boardId)}/kb/jobs/effect_check/run`,
      undefined,
      DEV,
    );
    expect(byDev.status).toBe(403);
    const byAdmin = await request(
      'POST',
      `/api/boards/${String(boardId)}/kb/jobs/effect_check/run`,
      undefined,
    );
    expect(byAdmin.status).toBe(202);
    expect(await byAdmin.json()).toMatchObject({ job: 'effect_check' });
    await vi.waitFor(async () =>
      expect(
        await store.transaction((tx) => tx.getBoardJob(boardId, 'effect_check')),
      ).toMatchObject({ runningUntil: null, lastResult: { kind: 'effect_check' } }),
    );
  });

  it('lists the measured signals for the Watch signal choice, for admins only', async () => {
    const listed = await request('GET', `/api/boards/${String(boardId)}/kb/signals`, undefined);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as KbSignal[]).map((s) => s.key)).toContain('ci_after_local');
    expect(
      (await request('GET', `/api/boards/${String(boardId)}/kb/signals`, undefined, DEV)).status,
    ).toBe(403);
  });

  it('raises one revise-or-revert item when two runs check at once, and stores the check', async () => {
    const watching = (await store.transaction((tx) => tx.listKbItems(boardId))).filter(
      (i) => i.effectCheck?.state === 'watching',
    );
    expect(watching).toHaveLength(1);
    const [watched] = watching;
    if (watched === undefined) throw new Error('nothing watched');
    // After the approval: 2 of 3 failing again, against 2 of 3 before.
    await merge(at(DAY), true);
    await merge(at(2 * DAY), true);
    await merge(at(3 * DAY), false);
    const later = at(10 * DAY);
    const runs = await Promise.all([checks.check(boardId, later), checks.check(boardId, later)]);
    const raised = runs.flatMap((r) => r.raised);
    expect(raised).toHaveLength(1);
    const check = (await get(watched.id)).effectCheck;
    expect(check).toMatchObject({
      state: 'not_improved',
      raisedItemId: raised[0],
      after: { affected: 2, eligible: 3 },
    });
    const items = await store.transaction((tx) => tx.listKbItems(boardId));
    expect(items.filter((i) => i.signal?.key === `effect:${watched.id}`).map((i) => i.id)).toEqual(
      raised,
    );
    expect(await get(raised[0] ?? '')).toMatchObject({
      status: 'open',
      source: 'mined',
      processing: 'pending',
      suggestedTarget: 'build_test_lint',
    });
  });
  it('refuses a watch signal on a document approval at the route (s15f8)', async () => {
    const item = await mined();
    const refused = await request('POST', `/api/kb/${item.id}/approve`, {
      as: 'document',
      version: item.version,
      watchSignal: 'ci_after_local',
    });
    expect(refused.status).toBe(422);
    // The route refuses it, rather than dropping it and leaving core to refuse something else.
    expect(((await refused.json()) as { message: string }).message).toContain(
      "A document proposal doesn't watch a signal",
    );
    expect(await get(item.id)).toEqual(item);
  });

  it('answers the approval when the check started on it fails, and logs the failure (s15f8)', async () => {
    const failing = new LearningJobService({
      store,
      clock,
      notifier,
      mining,
      effectChecks: checks,
      manifests: null,
    });
    failing.checkApproval = () => Promise.reject(new Error('the database went away'));
    const logged: string[] = [];
    const via = appWith(failing, (task, message) => logged.push(`${task}: ${message}`));
    const item = await mined();
    const approved = await request(
      'POST',
      `/api/kb/${item.id}/approve`,
      { as: 'learning', version: item.version },
      ADMIN,
      via,
    );
    expect(approved.status).toBe(200);
    expect((await get(item.id)).status).toBe('approved');
    await vi.waitFor(() =>
      expect(logged).toEqual([expect.stringContaining('the database went away')]),
    );
    expect(logged[0]).toMatch(
      new RegExp(`^effect_check: board ${String(boardId)}: checking ${item.id} on approval: `),
    );
  });

  it('logs a check started on approval whose run failed, and still answers the approval (s15f8)', async () => {
    const failing = new LearningJobService({
      store,
      clock,
      notifier,
      mining,
      effectChecks: checks,
      manifests: null,
    });
    failing.checkApproval = () =>
      Promise.resolve({
        ok: true,
        value: { kind: 'failed', error: 'the lease was lost' },
      } as const);
    const logged: string[] = [];
    const via = appWith(failing, (task, message) => logged.push(`${task}: ${message}`));
    const item = await mined();
    const approved = await request(
      'POST',
      `/api/kb/${item.id}/approve`,
      { as: 'learning', version: item.version },
      ADMIN,
      via,
    );
    expect(approved.status).toBe(200);
    await vi.waitFor(() =>
      expect(logged).toEqual([
        `effect_check: board ${String(boardId)}: checking ${item.id} on approval: the lease was lost`,
      ]),
    );
  });

  it('answers the approval when starting the check throws at once, and logs it (s15f8)', async () => {
    const failing = new LearningJobService({
      store,
      clock,
      notifier,
      mining,
      effectChecks: checks,
      manifests: null,
    });
    failing.checkApproval = () => {
      throw new Error('not wired');
    };
    const logged: string[] = [];
    const via = appWith(failing, (task, message) => logged.push(`${task}: ${message}`));
    const item = await mined();
    const approved = await request(
      'POST',
      `/api/kb/${item.id}/approve`,
      { as: 'learning', version: item.version },
      ADMIN,
      via,
    );
    expect(approved.status).toBe(200);
    expect((await get(item.id)).status).toBe('approved');
    await vi.waitFor(() => expect(logged).toEqual([expect.stringContaining('not wired')]));
  });

  it("claims a watched signal under mining's lock, so a mining run meanwhile neither overwrites the claim nor raises it (s15f8)", async () => {
    const source = await merge(at(-4 * DAY), true);
    const id = unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: source,
        type: 'gotcha',
        statement: 'Run the full checks before a routine pushes, not only the fast ones',
        evidence: 'CI failed',
      }),
    ).id;
    // The approval waits after its lock until the mining run is seen waiting for that lock in pg_locks (with the
    // lock), or has finished (without it: it reads kb_signals before the claim commits and writes its stale row back).
    // Neither branch depends on timing; the cap only stops a broken run from hanging the test.
    let miningDone: () => void = () => undefined;
    const miningFinished = new Promise<void>((resolve) => (miningDone = resolve));
    const miningWaitsForLock = async (): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        const waiting = await database.db.execute(
          sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
        );
        if (waiting.length > 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    };
    let claiming: () => void = () => undefined;
    const approvalClaims = new Promise<void>((resolve) => (claiming = resolve));
    const base = new PgStore(database.db);
    const pausing: Store = {
      transaction: (work) =>
        base.transaction((tx) =>
          work({
            ...tx,
            listKbSignals: async (b) => {
              claiming();
              await Promise.race([miningWaitsForLock(), miningFinished]);
              return tx.listKbSignals(b);
            },
          }),
        ),
    };
    const approving = new KnowledgeService({
      store: pausing,
      clock,
      notifier,
      catalog,
      signals: mining,
    }).approve(ADMIN, id, 1, { as: 'learning', watchSignal: 'ci_after_local' });
    await approvalClaims;
    const mined = mining.mine(boardId, NOW).finally(() => miningDone());
    const [decided, run] = await Promise.all([approving, mined]);
    expect(unwrap(decided)).toMatchObject({
      status: 'approved',
      signal: { key: 'ci_after_local' },
    });
    const row = (await store.transaction((tx) => tx.listKbSignals(boardId))).find(
      (r) => r.key === 'ci_after_local',
    );
    expect(row?.itemId).toBe(id);
    const raised = await Promise.all(run.raised.map(get));
    expect(raised.filter((i) => i.signal?.key === 'ci_after_local')).toEqual([]);
  });
});
