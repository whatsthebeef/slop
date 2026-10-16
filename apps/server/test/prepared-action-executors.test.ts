import { BoardService, GlobService, actionState, machine } from '@slop/core';
import type { Board, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { GitHub } from '../src/github/client.js';
import { prepareInstructions } from '../src/routines.js';
import type { RoutineSource } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeHost extends FakeCodeHost {
  readonly merged: number[] = [];
  override provision = (_repo: unknown, glob: Glob) => Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: HEAD } });
  override markReady = () => Promise.resolve({ wasDraft: true, sha: HEAD });
  override squashMerge = (_repo: unknown, _glob: Glob, pr: number) => {
    this.merged.push(pr);
    return Promise.resolve({ outcome: 'merged' as const, sha: 'm1' });
  };
}

const routines: RoutineSource = {
  hasRoutine: () => Promise.resolve(true),
  secretFor: () => Promise.resolve({ url: 'https://routines.example/fire', token: 't' }),
};

describe('prepared actions through the code host executors (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  const fired: string[] = [];

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('prepared_actions'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: REPO, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: DEV, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
    host = new FakeHost();
    executors = codeHostExecutors(host, boardOf, routines, new BoardService({ store, notifier: { publish: () => undefined } }));
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => drop());

  const current = async (id: string) => unwrap(await globs.get(DEV, id)).glob;
  const pending = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((row) => row.kind === kind && row.state === 'pending');
  /** Runs every pending effect of `kind` as the outbox would. */
  const run = async (globId: string, kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await current(globId), { globs }));
      await database.db.update(schema.outbox).set({ state: 'done' }).where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };
  const stubFire = () => {
    fired.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { body: string }) => {
        fired.push((JSON.parse(init.body) as { text: string }).text);
        return Promise.resolve(new Response(JSON.stringify({ claude_code_session_id: 'sess' }), { status: 200 }));
      }),
    );
  };
  const make = async (title: string, record: 'branch' | 'artifact' | 'attachment') =>
    unwrap(await globs.create(DEV, { boardId: 1, title, type: null, category: 'action', group: null, environment: null, autoTrigger: false, idempotencyKey: null, prepare: true, record }));

  it('a branch record is provisioned, then its routine is told to prepare on the action branch; ready, Done and the merge close it', async () => {
    stubFire();
    const a = await make('Permission set', 'branch');
    // The routine waits for the branch: nothing fires until provisioning is ok.
    const row = (await pending(a.id, 'fire_routine'))[0];
    expect(await executors.fire_routine?.(row?.effect as Effect, await current(a.id), { globs })).toMatchObject({ state: 'pending', reason: 'Waiting for the branch' });
    expect(fired).toEqual([]);
    expect(await run(a.id, 'provision')).toEqual(['done']);
    expect(await current(a.id)).toMatchObject({ provisioning: 'ok', pr: { number: 7 } });
    expect(await run(a.id, 'fire_routine')).toEqual(['done']);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain('PREPARE run (round 1)');
    expect(fired[0]).toContain(`git checkout -B ${a.id} origin/${a.id}`);
    expect(fired[0]).toContain('Never run the script yourself');

    // mark_ready: the PR is marked ready, the action is ready to run, and no review or sub gate is queued.
    unwrap(await globs.requestReady(DEV, a.id, null));
    expect(await run(a.id, 'mark_pr_ready')).toEqual(['done']);
    // GitHub's ready_for_review webhook confirms it.
    await globs.applyEvent(a.id, (g, ctx) => machine.prReadyForReview(g, { number: 7, headSha: HEAD }, ctx));
    expect(actionState(await current(a.id))).toBe('ready');
    expect(await pending(a.id, 'review_change')).toEqual([]);
    expect(await pending(a.id, 'evaluate_sub_gate')).toEqual([]);

    // Done with checks passed: slop merges the record itself, and the merge closes the action.
    await globs.applyEvent(a.id, (g, ctx) => machine.checksCompleted(g, { sha: HEAD, passed: true }, ctx));
    unwrap(await globs.completeAction(DEV, a.id, (await current(a.id)).version, 'ran'));
    expect(await run(a.id, 'squash_merge')).toEqual(['done']);
    expect(host.merged).toEqual([7]);
    expect(await current(a.id)).toMatchObject({ status: 'signed_off', labels: {} });
  });

  it('an artifact record fires its routine at once: there is no branch to wait for, and the text keeps off git', async () => {
    stubFire();
    const a = await make('One-shot script', 'artifact');
    expect(await pending(a.id, 'provision')).toEqual([]);
    expect(await run(a.id, 'fire_routine')).toEqual(['done']);
    expect(fired[0]).toContain('PREPARE run (round 1)');
    expect(fired[0]).toContain('no branch and no PR');
    expect(fired[0]).toContain('put_artifact (kind rollout_script');
    expect(fired[0]).not.toContain('git checkout -B');
  });

  it('a later round tells the routine to read the failure report', () => {
    const text = prepareInstructions({ id: 's1a1', title: 'T' }, 'run-1', REPO, 'main', { record: 'branch', rounds: 2 });
    expect(text).toContain('round 2');
    expect(text).toContain('Action run failed (round 1)');
    expect(prepareInstructions({ id: 's1a1', title: 'T' }, 'run-1', null, null, { record: 'attachment', rounds: 1 })).not.toContain('Action run failed');
  });
});

describe('GitHub.syncLabels', () => {
  const labels = (glob: Partial<Glob>, current: string[]) => {
    const calls: { route: string; params: Record<string, unknown> }[] = [];
    const gh = Object.create(GitHub.prototype) as GitHub;
    Object.assign(gh, {
      octokit: () =>
        Promise.resolve({
          request: (route: string, params: Record<string, unknown>) => {
            calls.push({ route, params });
            return Promise.resolve({ data: route.startsWith('GET') ? current.map((name) => ({ name })) : [] });
          },
        }),
    });
    return { run: () => gh.syncLabels({ owner: 'acme', name: 'app', base: 'main' }, { id: 's1a1', ...glob } as Glob, 7), calls };
  };

  it('labels an action slop:action and nothing else, removing a stale type or environment label', async () => {
    const { run, calls } = labels({ category: 'action', type: null, environment: null }, ['slop:same', 'env:dev']);
    await run();
    expect(calls.filter((c) => c.route.startsWith('DELETE')).map((c) => c.params.name)).toEqual(['slop:same', 'env:dev']);
    expect(calls.find((c) => c.route.startsWith('POST'))?.params.labels).toEqual(['slop:action']);
  });

  it('keeps the type and environment labels for code work', async () => {
    const { run, calls } = labels({ category: 'task', type: 'same', environment: 'dev' }, []);
    await run();
    expect(calls.find((c) => c.route.startsWith('POST'))?.params.labels).toEqual(['slop:same', 'env:dev']);
  });
});
