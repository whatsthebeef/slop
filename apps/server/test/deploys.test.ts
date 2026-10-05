import { DeployService } from '@slop/core';
import type { Board, Glob, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';

const glob = (id: string, boardId: number, environment = 'dev1'): Glob => ({
  id,
  boardId,
  title: id,
  summary: '',
  type: 'super',
  category: 'feature',
  group: null,
  environment,
  status: 'in_progress',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'draft', headSha: `${id}-head` },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  signedOffAt: null,
  doingSince: '2026-10-05T12:00:00.000Z',
});

describe('deploys in Postgres', () => {
  let drop: () => Promise<void>;
  let database: Database;
  let store: PgStore;
  let service: DeployService;
  let board: Board;
  let n = 0;
  let clock = Date.parse('2026-10-05T12:00:00.000Z');

  beforeAll(async () => {
    const test = await createTestDatabase('deploys');
    drop = test.drop;
    database = test.database;
    store = new PgStore(test.database.db);
    service = new DeployService({
      store,
      notifier: { publish: () => undefined },
      // Each call a second later, so requests order by time as they do in production.
      clock: { now: () => new Date((clock += 1000)).toISOString() },
      newDeployId: () => `dep-${++n}`,
    });
    board = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const inserted = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [
          { name: 'dev1', allowBranchDeploy: true },
          { name: 'dev2', allowBranchDeploy: true },
        ],
        sensitivePaths: [],
      });
      expect(inserted.deploy).toBeNull();
      const withDeploy: Board = {
        ...inserted,
        deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: 'sandbox-deploy', projects: {} },
        version: inserted.version + 1,
      };
      expect(await tx.updateBoard(withDeploy, inserted.version)).toBe(true);
      await tx.upsertMember({ boardId: inserted.id, email: DEV, role: 'dev' });
      for (const id of ['s9f1', 's9f2', 's9f3']) await tx.insertGlob(glob(id, inserted.id), null);
      for (const id of ['s9f4', 's9f5', 's9f6']) await tx.insertGlob(glob(id, inserted.id, 'dev2'), null);
      return withDeploy;
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('stores the board integration', async () => {
    const stored = await store.transaction((tx) => tx.getBoard(board.id));
    expect(stored?.deploy).toEqual(board.deploy);
  });

  it('queues per environment, finds deploys by provider handle and shows the board state', async () => {
    const first = unwrap(await service.requestFromPush('s9f1', 'a1'));
    unwrap(await service.requestFromPush('s9f2', 'b1'));
    unwrap(await service.requestFromPush('s9f3', 'c1'));
    expect(first?.state).toBe('running');

    const all = await store.transaction((tx) => tx.listDeploys(board.id, {}));
    expect(all.map((d) => [d.globId, d.state])).toEqual([
      ['s9f3', 'waiting'],
      ['s9f2', 'replaced'],
      ['s9f1', 'running'],
    ]);
    const active = await store.transaction((tx) =>
      tx.listDeploys(board.id, { environment: 'dev1', states: ['waiting', 'running'] }),
    );
    expect(active).toHaveLength(2);
    expect(await store.transaction((tx) => tx.listDeploys(board.id, { globIds: [] }))).toEqual([]);

    unwrap(await service.started('dep-1', { providerRef: 'arn:build/1', url: 'https://example.com/1' }));
    expect((await store.transaction((tx) => tx.findDeployByProviderRef('arn:build/1')))?.id).toBe('dep-1');
    unwrap(await service.finishedByProviderRef('arn:build/1', { succeeded: true, error: null }));

    const third = await store.transaction((tx) => tx.getDeploy('dep-3'));
    expect(third?.state).toBe('running');
    const { indicators, running } = await service.boardState(board.id, ['s9f1', 's9f2', 's9f3']);
    expect(indicators.get('s9f1')).toEqual({ state: 'live', environment: 'dev1', sha: 'a1' });
    expect(indicators.get('s9f3')).toEqual({ state: 'deploying', environment: 'dev1', waiting: false });
    expect([...running]).toEqual(['dev1']);

    unwrap(await service.finished('dep-3', { succeeded: false, error: 'exit 2' }));
    const history = unwrap(await service.history(DEV, 's9f3'));
    expect(history[0]).toMatchObject({ state: 'failed', error: 'exit 2' });
  });

  it('keeps one running and one waiting deploy per environment under concurrent requests and results', async () => {
    const dev2 = () => store.transaction((tx) => tx.listDeploys(board.id, { environment: 'dev2' }));
    const results = await Promise.all([
      service.requestFromPush('s9f4', 'd1'),
      service.requestFromPush('s9f5', 'e1'),
      service.requestFromPush('s9f6', 'f1'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const states = (await dev2()).map((d) => d.state).sort();
    expect(states).toEqual(['replaced', 'running', 'waiting']);

    // A result and a new request at the same time: the waiting deploy (or the new one) must run.
    const running = (await dev2()).find((d) => d.state === 'running');
    if (running === undefined) throw new Error('expected a running deploy');
    await Promise.all([
      service.finished(running.id, { succeeded: true, error: null }),
      service.requestFromPush('s9f4', 'd2'),
    ]);
    const after = await dev2();
    expect(after.filter((d) => d.state === 'running')).toHaveLength(1);
    expect(after.filter((d) => d.state === 'waiting').length).toBeLessThanOrEqual(1);
  });

  it("reads each glob's latest deploy", async () => {
    const latest = await store.transaction((tx) => tx.latestDeploys(board.id, ['s9f1', 's9f4', 'nope']));
    expect(new Map(latest.map((d) => [d.globId, d.sha]))).toEqual(new Map([['s9f1', 'a1'], ['s9f4', 'd2']]));
  });

  it("migration 0011 resolves duplicate active deploys from before the lock, keeping the newest", async () => {
    // Recreate the pre-lock state: no unique indexes and two running and two waiting deploys in one environment.
    await database.db.execute(sql.raw('drop index deploys_one_running_idx; drop index deploys_one_waiting_idx'));
    const row = (id: string, state: string, at: string) =>
      `('${id}', ${String(board.id)}, 'dup', 's9f1', 'x', '${state}', 'push', '${at}')`;
    await database.db.execute(
      sql.raw(
        `insert into deploys (id, board_id, environment, glob_id, sha, state, trigger, requested_at) values ` +
          [
            row('old-run', 'running', '2026-10-01T00:00:00Z'),
            row('new-run', 'running', '2026-10-02T00:00:00Z'),
            row('old-wait', 'waiting', '2026-10-01T00:00:00Z'),
            row('new-wait', 'waiting', '2026-10-02T00:00:00Z'),
          ].join(', '),
      ),
    );
    const migration = readFileSync(new URL('../drizzle/0011_deploy_queue.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint')
      .filter((statement) => !statement.includes('ADD COLUMN'));
    for (const statement of migration) await database.db.execute(sql.raw(statement));
    const states = await store.transaction((tx) => tx.listDeploys(board.id, { environment: 'dup' }));
    expect(new Map(states.map((d) => [d.id, d.state]))).toEqual(
      new Map([
        ['new-run', 'running'],
        ['old-run', 'failed'],
        ['new-wait', 'waiting'],
        ['old-wait', 'replaced'],
      ]),
    );
  });
});
