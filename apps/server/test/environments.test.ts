import { EnvironmentService, GlobService } from '@slop/core';
import type { Board, Effect, Glob, Hint } from '@slop/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitGraph, Repo } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { environmentExecutors } from '../src/environment-executors.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'reviewing',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'merged', headSha: `${id}-head` },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  signedOffAt: null,
  doingSince: null,
});

/** Ancestry from a table of deployed commit → the merge commits it contains. */
class FakeGraph implements CommitGraph {
  readonly asked: string[] = [];
  history: Record<string, readonly string[]> = {};
  failOn: string | null = null;
  contains(_repo: Repo, descendant: string, ancestor: string): Promise<boolean | null> {
    this.asked.push(`${ancestor}...${descendant}`);
    if (ancestor === this.failOn) return Promise.reject(new Error('GitHub is down'));
    const known = this.history[descendant];
    if (known === undefined || ancestor === 'unknown') return Promise.resolve(null);
    return Promise.resolve(known.includes(ancestor));
  }
}

describe('release deploys on contained globs', () => {
  let drop: () => Promise<void>;
  let database: Database;
  let store: PgStore;
  let environments: EnvironmentService;
  let globs: GlobService;
  let board: Board;
  const graph = new FakeGraph();
  const hints: Hint[] = [];
  const logged: string[] = [];
  let now = '2026-10-05T12:00:00.000Z';
  let event = 0;

  /** Runs the environment's pending checks as the outbox would; returns their outcomes. */
  const drain = async () => {
    const executors = environmentExecutors(environments, graph, () => true, (id) => store.transaction((tx) => tx.getBoard(id)), (_t, m) => logged.push(m));
    const rows = await database.db.select().from(schema.outbox).where(eq(schema.outbox.state, 'pending')).orderBy(asc(schema.outbox.id));
    const outcomes: string[] = [];
    for (const row of rows) {
      const effect: Effect = row.effect;
      const outcome = await executors.check_environment?.(effect, null, { globs });
      outcomes.push(outcome ?? 'none');
      await database.db.update(schema.outbox).set({ state: outcome ?? 'dropped' }).where(eq(schema.outbox.id, row.id));
    }
    return outcomes;
  };

  const deploy = (sha: string, environment = 'prod') =>
    environments.recordDeploy({
      repo: 'acme/app',
      environment,
      sha,
      ref: null,
      succeeded: true,
      url: null,
      at: null,
      eventId: `aws:${String(++event)}`,
    });

  const presence = () =>
    store.transaction((tx) => tx.listGlobPresence(board.id, { environment: 'prod' })).then((rows) => rows.map((p) => [p.globId, p.contained, p.checkedSha]));

  beforeAll(async () => {
    const test = await createTestDatabase('environments');
    drop = test.drop;
    database = test.database;
    store = new PgStore(database.db);
    environments = new EnvironmentService({ store, notifier: { publish: (h) => hints.push(h) }, clock: { now: () => now } });
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => now },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(false) },
    });
    board = await store.transaction(async (tx) => {
      const inserted = await tx.insertBoard({
        name: 'app',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [
          { name: 'staging', allowBranchDeploy: false, role: 'integration' },
          { name: 'prod', allowBranchDeploy: false, role: 'release', production: true },
        ],
        sensitivePaths: [],
      });
      for (const id of ['s1t1', 's1t2', 's1t3']) await tx.insertGlob(glob(id, inserted.id), null);
      await tx.appendEvents([
        { type: 'Merged', globId: 's1t1', actor: null, at: '2026-10-01T00:00:00.000Z', data: { sha: 'm1' } },
        { type: 'Merged', globId: 's1t2', actor: null, at: '2026-10-02T00:00:00.000Z', data: { sha: 'm2' } },
        { type: 'Merged', globId: 's1t3', actor: null, at: '2026-10-03T00:00:00.000Z', data: { sha: 'unknown' } },
      ]);
      return inserted;
    });
    graph.history = { d1: ['m1'], d2: ['m1', 'm2'], d0: [] };
  });

  afterAll(async () => {
    await drop();
  });

  it('marks the globs a release deploy contains, and only those', async () => {
    await deploy('d1');
    expect(await drain()).toEqual(['done']);
    expect(await presence()).toEqual([
      ['s1t1', true, 'd1'],
      ['s1t2', false, 'd1'],
      ['s1t3', false, 'd1'],
    ]);
    expect(logged.some((m) => m.includes("doesn't know unknown"))).toBe(true);
    expect(hints).toEqual([{ kind: 'glob.deploys', boardId: board.id, globId: 's1t1' }]);
    const state = await environments.boardState(board.id, ['s1t1', 's1t2']);
    expect(state.get('s1t1')?.map((i) => [i.environment, i.warning])).toEqual([['prod', 'before_sign_off']]);
  });

  it('adds globs as later deploys contain them', async () => {
    await deploy('d2');
    expect(await drain()).toEqual(['done']);
    expect(await presence()).toEqual([
      ['s1t1', true, 'd2'],
      ['s1t2', true, 'd2'],
      ['s1t3', false, 'd2'],
    ]);
  });

  it('takes globs out again on a rollback, logging it on each', async () => {
    await deploy('d0');
    expect(await drain()).toEqual(['done']);
    expect((await presence()).filter(([, contained]) => contained)).toEqual([]);
    const events = await store.transaction((tx) => tx.listBoardEvents(board.id, '2026-01-01T00:00:00.000Z', ['Deployed', 'DeployRolledBack']));
    expect(events.map((e) => [e.type, e.globId])).toEqual([
      ['Deployed', 's1t1'],
      ['Deployed', 's1t2'],
      ['DeployRolledBack', 's1t1'],
      ['DeployRolledBack', 's1t2'],
    ]);
  });

  it("drops a check overtaken by a newer deploy, and retries one whose compare failed", async () => {
    await deploy('d1');
    now = '2026-10-05T12:00:01.000Z';
    await deploy('d2');
    graph.failOn = 'm1';
    await expect(drain()).rejects.toThrow('GitHub is down');
    graph.failOn = null;
    // The first check (d1) was dropped as stale before the second failed; the retry runs the second.
    expect(await drain()).toEqual(['done']);
    expect(await presence()).toEqual([
      ['s1t1', true, 'd2'],
      ['s1t2', true, 'd2'],
      ['s1t3', false, 'd2'],
    ]);
  });

  it("doesn't check an environment without a role", async () => {
    expect(await deploy('d2', 'nowhere')).toEqual([]);
    expect(await drain()).toEqual([]);
  });

  it("deletes a glob's presence with the glob", async () => {
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect((await presence()).map(([id]) => id)).toEqual(['s1t2', 's1t3']);
  });
});
