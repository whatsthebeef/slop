import { BoardService, GlobService, LearningJobService, MiningService, SizeCheckService } from '@slop/core';
import { DEFAULT_SIZE_CALIBRATION } from '@slop/core';
import type { GlobOutcome, Llm, Result, SizeForecast } from '@slop/core';
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

const FORECAST: SizeForecast = {
  source: 'code',
  files: { count: 3, paths: ['apps/server/a.ts', 'apps/web/b.tsx', 'packages/core/c.ts'] },
  modules: ['apps/server', 'apps/web', 'packages/core'],
  lines: { min: 120, max: 300 },
  parts: [
    { name: 'apps/server', files: ['apps/server/a.ts'], needs: [] },
    { name: 'apps/web', files: ['apps/web/b.tsx'], needs: ['apps/server'] },
  ],
  riskTier: 'low',
  riskAreas: [],
  areas: ['server', 'web'],
  migration: false,
  publicApi: false,
  fanIn: 2,
  confidence: 'medium',
  reference: null,
  signals: { code: { files: 3, lines: 200 }, reference: null, text: { files: 2, lines: 100 } },
  weights: { code: 0.6, reference: 0.3, text: 0.1 },
  calibrated: { scale: 1, areaFactors: { server: 1, web: 1 } },
  evidence: ['predicted from the code'],
};

const BIG = `# Big

## Tasks
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
          ? '{"independentParts": 4, "parallelParts": 3, "reason": "four pieces"}'
          : '{"parts":[{"title":"Data","summary":"a","plan":"## Tasks\\n1. migration","after":[]},{"title":"Web","summary":"b","plan":"## Tasks\\n3. card","after":[0]},{"title":"CLI","summary":"c","plan":"## Tasks\\n4. cli","after":[0]}]}',
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
    expect(check?.proposal?.parts.map((p) => p.title)).toEqual(['Data', 'Web', 'CLI']);
    expect(check?.proposal).toMatchObject({ criticalPath: 2, maxParallel: 2 });
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
      // Text alone cannot tell that parts run in parallel, so it never flags.
      expect(check).toMatchObject({ flagged: false, proposal: null, estimate: { partsSource: 'text' } });
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

  it('keeps the forecast in the estimate and stores the calibration, its history and the three-point record', async () => {
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    if (check === null) throw new Error('no size check');
    await store.transaction((tx) => tx.updateSizeAssessment({ ...check, estimate: { ...check.estimate, forecast: FORECAST } }));
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.estimate.forecast).toEqual(FORECAST);

    expect(await store.transaction((tx) => tx.getSizeCalibration(boardId))).toEqual(DEFAULT_SIZE_CALIBRATION);
    const moved = { weights: { code: 0.55, reference: 0.35, text: 0.1 }, areaFactors: { server: 1.4 }, samples: 1 };
    await store.transaction((tx) => tx.setSizeCalibration(boardId, moved));
    expect(await store.transaction((tx) => tx.getSizeCalibration(boardId))).toEqual(moved);

    const change = {
      boardId,
      at: NOW,
      globId: glob.id,
      kind: 'area_factor' as const,
      area: 'server' as const,
      from: { factor: 1 },
      to: { factor: 1.4 },
      cause: 'server lines ran 40% over',
    };
    expect(await store.transaction((tx) => tx.insertSizeCalibrationChange(change))).toBe(true);
    expect(await store.transaction((tx) => tx.insertSizeCalibrationChange(change))).toBe(false);
    expect(await store.transaction((tx) => tx.listSizeCalibrationChanges(boardId))).toMatchObject([{ globId: glob.id, area: 'server', cause: change.cause, to: { factor: 1.4 } }]);
    expect(unwrap(await size.calibrationView(DEV, boardId))).toMatchObject({ current: moved, defaults: DEFAULT_SIZE_CALIBRATION });

    const record = {
      globId: glob.id,
      boardId,
      recordedAt: NOW,
      estimate: FORECAST,
      investigation: null,
      actual: { files: 4, lines: 420, rounds: 2, reworkRuns: 0, escalated: false, followUpBugs: 0, hoursOpen: 6 },
    };
    expect(await store.transaction((tx) => tx.getSizeRecord(glob.id))).toBeNull();
    await store.transaction((tx) => tx.upsertSizeRecord(record));
    await store.transaction((tx) => tx.upsertSizeRecord({ ...record, actual: { ...record.actual, lines: 450 } }));
    expect(await store.transaction((tx) => tx.getSizeRecord(glob.id))).toMatchObject({ globId: glob.id, estimate: FORECAST, investigation: null, actual: { lines: 450 } });
    expect(await store.transaction((tx) => tx.listSizeRecords(boardId))).toHaveLength(1);
  });
});
