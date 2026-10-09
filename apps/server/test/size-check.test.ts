import { BoardService, GlobService, LearningJobService, MiningService, SizeCheckService } from '@slop/core';
import type { GlobOutcome, Llm, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const NOW = '2026-10-09T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const BIG = `# Big

## Build
1. Add the migration for the new table in apps/server/drizzle
2. Add the server endpoint in apps/server/src/http/app.ts
3. Add the web card in apps/web/src/components/card.tsx
4. Add a CLI command
5. Change the LLM prompt
6. Change the infra pipeline
Done when: all of it works.

## Chat content
The chat panel shows more content. This section has prose and no task of its own.
`;

describe('The learned size check in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let size: SizeCheckService;
  let jobs: LearningJobService;
  let boardId: number;
  let down = false;
  const clock = { now: () => NOW };
  const notifier = { publish: () => undefined };
  const llm: Llm = {
    complete: ({ system }) => {
      if (down) return Promise.reject(new Error('model failed'));
      return Promise.resolve(
        system.startsWith('You judge')
          ? '{"independentParts": 4, "reason": "four pieces"}'
          : '{"parts":[{"title":"Data","summary":"a","plan":"## Build\\n1. migration","after":[]},{"title":"Web","summary":"b","plan":"## Build\\n3. card","after":[0]}]}',
      );
    },
  };
  const create = async (type: 'sub' | 'same', plan: string) =>
    unwrap(await globs.create(DEV, { boardId, title: 'T', summary: 's', plan, type, category: type === 'sub' ? 'task' : 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
  const outcome = (globId: string): GlobOutcome => ({
    globId,
    snapshotVersion: 1,
    boardId,
    mergedAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-20T00:00:00.000Z',
    final: true,
    corrections: { category: null, type: null, subConverted: null, split: false },
    size: { changedLines: null },
    review: { rounds: 1, maxRounds: 3, testFailRounds: 0, findingsBySeverity: {}, findingsByClass: {} },
    tests: { ciFailures: 0 },
    effort: { calendarHours: 5 },
    postMerge: { fixGlobs: [] },
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('size_check'));
    store = new PgStore(database.db);
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    size = new SizeCheckService({ store, clock, notifier, llm });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) }, sizeCheck: size });
    jobs = new LearningJobService({ store, clock, notifier, mining: new MiningService({ store, notifier }), sizeCheck: size, manifests: null });
  });

  afterAll(async () => {
    await drop();
  });

  it('stores the estimate, evidence and proposed split with the glob, and holds a flagged sub', async () => {
    const sub = await create('sub', BIG);
    expect(sub.status).toBe('planning');
    const check = await store.transaction((tx) => tx.getSizeCheck(sub.id));
    expect(check).toMatchObject({ flagged: true, decision: null, threshold: { maxTasks: 5, maxParts: 3 } });
    expect(check?.estimate).toMatchObject({ tasks: 6, independentParts: 4, partsSource: 'model' });
    expect(check?.proposal?.parts.map((p) => p.title)).toEqual(['Data', 'Web', 'Chat content']);
    expect(unwrap(await globs.get(DEV, sub.id)).sizeCheck?.flagged).toBe(true);
    expect([...(await globs.oversizedOf(boardId))]).toContain(sub.id);
    unwrap(await size.keepWhole(DEV, sub.id));
    expect(unwrap(await globs.release(sub.id)).status).toBe('implementing');
    expect([...(await globs.oversizedOf(boardId))]).not.toContain(sub.id);
  });

  it('keeps the text estimate when the model fails', async () => {
    down = true;
    try {
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check).toMatchObject({ flagged: true, proposal: null, estimate: { partsSource: 'text' } });
    } finally {
      down = false;
    }
  });

  it('moves the threshold with a compare-and-set, and records each outcome once', async () => {
    const start = { maxTasks: 5, maxParts: 3 };
    expect(await store.transaction((tx) => tx.setSizeThreshold(boardId, { maxTasks: 9, maxParts: 9 }, start))).toBe(false);
    const glob = await create('same', BIG);
    await store.transaction((tx) => tx.upsertGlobOutcome(outcome(glob.id)));
    const first = await jobs.runNow(DEV, boardId, 'size_threshold');
    // Not an admin of nothing: the creator of the board is its admin, so the run starts.
    const run = unwrap(first);
    const finished = await run.finished;
    expect(finished.lastResult).toMatchObject({ kind: 'size_threshold', threshold: { maxTasks: 6, maxParts: 4 } });
    expect(await store.transaction((tx) => tx.getSizeThreshold(boardId))).toEqual({ maxTasks: 6, maxParts: 4 });
    const again = await (unwrap(await jobs.runNow(DEV, boardId, 'size_threshold'))).finished;
    expect(again.lastResult).toMatchObject({ kind: 'size_threshold', changes: [] });
    const view = unwrap(await size.view(DEV, boardId));
    expect(view.history).toMatchObject([{ globId: glob.id, outcome: 'kept_whole_clean', from: start, to: { maxTasks: 6, maxParts: 4 } }]);
    // A stale write is refused.
    expect(await store.transaction((tx) => tx.setSizeThreshold(boardId, start, { maxTasks: 4, maxParts: 2 }))).toBe(false);
  });
});
