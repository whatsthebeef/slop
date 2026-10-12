import { BoardService, ContextTuningService, LearningJobService, MiningService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const NOW = '2026-10-12T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** The weekly context-tuning job and its service on real Postgres: every fact read runs against the real queries. */
describe('context tuning in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let tuning: ContextTuningService;
  let jobs: LearningJobService;
  let boardId: number;
  const clock = { now: () => NOW };
  const notifier = { publish: () => undefined };

  beforeAll(async () => {
    const created = await createTestDatabase('context_tuning');
    drop = created.drop;
    store = new PgStore(created.database.db);
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    tuning = new ContextTuningService({ store, clock, notifier });
    jobs = new LearningJobService({ store, clock, notifier, mining: new MiningService({ store, notifier }), contextTuning: tuning, manifests: null });
  });
  afterAll(async () => {
    await drop();
  });

  it('runs as a board job and holds every setting without evidence', async () => {
    const finished = await unwrap(await jobs.runNow(ADMIN, boardId, 'context_tuning')).finished;
    expect(finished.lastResult).toEqual({ kind: 'context_tuning', moves: [], held: 6 });
    const listed = unwrap(await jobs.jobs(ADMIN, boardId));
    expect(listed.map((j) => j.job)).toContain('context_tuning');
  });

  it('is not available without the service', async () => {
    const bare = new LearningJobService({ store, clock, notifier, mining: new MiningService({ store, notifier }), manifests: null });
    const run = await bare.runNow(ADMIN, boardId, 'context_tuning');
    expect(run.ok).toBe(false);
  });

  it('resets a stored setting and lists it in the history', async () => {
    await store.transaction((tx) => tx.setContextSetting(boardId, 'inbox_candidates', 10, NOW));
    const view = unwrap(await tuning.reset(ADMIN, boardId, 'inbox_candidates'));
    expect(view.settings.find((s) => s.key === 'inbox_candidates')?.value).toBe(8);
    expect(view.history).toMatchObject([{ key: 'inbox_candidates', before: 10, after: 8, outcome: 'reset' }]);
  });
});
