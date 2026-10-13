import { BoardService, GlobService, ROLLOUT_NOT_WRITTEN_TITLE } from '@slop/core';
import type { Board, ChangeSource, Effect, Glob, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { rolloutExecutors } from '../src/rollout-executors.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('check_rollout_paths: a merge touching rollout paths without a Rollout section is flagged', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let boardId = 0;
  let files: readonly string[] | null | Error = [];
  let customPaths: readonly string[] | undefined;
  const logged: string[] = [];

  const changes: ChangeSource = {
    mergedDiff: () => (files instanceof Error ? Promise.reject(files) : Promise.resolve(files === null ? null : { changedLines: 10, files })),
  };
  const boardOf = (id: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(id));
  const executors = () => rolloutExecutors(changes, boardOf, () => Promise.resolve(customPaths), (task, message) => logged.push(`${task}: ${message}`));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('rollout_paths'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(DEV, { name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(() => drop());

  /** A merged glob in Reviewing, as after the Merged webhook. */
  const mergedGlob = async (): Promise<Glob> => {
    const created = unwrap(await globs.create(DEV, { boardId, title: 'Infra', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    const next: Glob = { ...created, status: 'reviewing', labels: { CR: 'required' }, pr: { number: 7, state: 'merged', headSha: 'a1' } };
    await database.db.update(schema.globs).set({ data: next }).where(eq(schema.globs.id, created.id));
    return next;
  };
  const effectOf = (glob: Glob): Effect => ({ kind: 'check_rollout_paths', globId: glob.id, generation: glob.generation, sha: 'm1' });
  const run = (glob: Glob | null, effect: Effect) => {
    const executor = executors().check_rollout_paths;
    if (executor === undefined) throw new Error('No executor');
    return executor(effect, glob, { globs });
  };
  const flagged = async (id: string) =>
    (await store.transaction((tx) => tx.listHumanSteps(boardId, [id]))).filter((s) => s.origin === 'rollout-paths');

  it('adds the step once when a default rollout path changed', async () => {
    files = ['apps/web/src/a.ts', 'infra/lib/host-stack.ts'];
    const glob = await mergedGlob();
    expect(await run(glob, effectOf(glob))).toBe('done');
    expect(await run(glob, effectOf(glob))).toBe('done');
    const steps = await flagged(glob.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'rollout', title: ROLLOUT_NOT_WRITTEN_TITLE, due: 'after_merge', blocks: ['sign_off', 'dependants'], who: 'anyone', state: 'open' });
  });

  it('adds nothing when no changed file matches', async () => {
    files = ['apps/web/src/a.ts', 'README.md'];
    const glob = await mergedGlob();
    expect(await run(glob, effectOf(glob))).toBe('done');
    expect(await flagged(glob.id)).toEqual([]);
  });

  it('adds nothing when the implementation record has a Rollout section', async () => {
    files = ['apps/server/src/config.ts'];
    const glob = await mergedGlob();
    await database.db.insert(schema.artifacts).values({
      globId: glob.id,
      kind: 'implementation_plan',
      label: '',
      version: 1,
      content: '# Record\n\n## Rollout\n- setting: Add the env var\n',
      provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: null },
      createdAt: new Date(),
    });
    expect(await run(glob, effectOf(glob))).toBe('done');
    expect(await flagged(glob.id)).toEqual([]);
  });

  it("uses the board's own rollout paths instead of the defaults", async () => {
    customPaths = ['ops/**'];
    try {
      files = ['infra/lib/host-stack.ts'];
      const plain = await mergedGlob();
      await run(plain, effectOf(plain));
      expect(await flagged(plain.id)).toEqual([]);
      files = ['ops/deploy.sh'];
      const custom = await mergedGlob();
      await run(custom, effectOf(custom));
      expect(await flagged(custom.id)).toHaveLength(1);
    } finally {
      customPaths = undefined;
    }
  });

  it('flags nothing and does not throw when the diff cannot be read', async () => {
    const glob = await mergedGlob();
    files = new Error('GitHub is down');
    expect(await run(glob, effectOf(glob))).toBe('done');
    files = null;
    expect(await run(glob, effectOf(glob))).toBe('done');
    expect(await flagged(glob.id)).toEqual([]);
    expect(logged.some((l) => l.includes('GitHub is down'))).toBe(true);
  });

  it('drops the effect for a glob that is gone or not merged', async () => {
    files = ['infra/x.ts'];
    const glob = await mergedGlob();
    expect(await run(null, effectOf(glob))).toBe('dropped');
    const open: Glob = { ...glob, status: 'in_progress' };
    expect(await run(open, effectOf(open))).toBe('dropped');
    expect(await flagged(glob.id)).toEqual([]);
  });
});
