import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Hotspot } from '../src/domain/hotspots.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';

const hot = (path: string, globs: string[], conflicts = globs.length): Hotspot => ({
  path,
  conflicts,
  globs,
  real: 1,
  lastConflictAt: '2026-10-12T00:00:00.000Z',
  merges: null,
  lines: null,
});

describe('get_context hotspots', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  const clock = { now: () => '2026-10-13T12:00:00.000Z' };
  const view = { windowDays: 7, hotspots: [hot('a.ts', ['s1t8', 's1t9', 's1t10']), hot('b.ts', ['s1t8']), hot('c.ts', ['s1t8'])] };
  const create = async (plan: string): Promise<Glob> =>
    unwrap(await globs.create(DEV, { boardId, title: 'G', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan }));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
  });

  it('is absent when hotspots are not configured', async () => {
    const glob = await create('Change a.ts');
    const artifacts = new ArtifactService({ store, clock, notifier: new RecordingNotifier() });
    expect('hotspots' in unwrap(await artifacts.context(DEV, glob.id))).toBe(false);
  });

  it('lists the hotspots whose path the plan names or that the glob conflicted on, with counts', async () => {
    const glob = await create('Change a.ts and nothing else');
    const asked: [number, string][] = [];
    const artifacts = new ArtifactService({
      store,
      clock,
      notifier: new RecordingNotifier(),
      hotspots: (board, now) => (asked.push([board, now]), Promise.resolve({ ...view, hotspots: [...view.hotspots, hot('d.ts', [glob.id])] })),
    });
    const context = unwrap(await artifacts.context(DEV, glob.id));
    expect(context.hotspots?.map((h) => h.path)).toEqual(['a.ts', 'd.ts']);
    expect(context.hotspots?.[0]).toMatchObject({ conflicts: 3, globs: 3, real: 1, windowDays: 7 });
    expect(asked).toEqual([[boardId, '2026-10-13T12:00:00.000Z']]);
  });

  it('matches whole paths only: data.ts does not name a.ts', async () => {
    const glob = await create('Change data.ts, src/a.tsx and lib/a.ts.');
    const artifacts = new ArtifactService({
      store,
      clock,
      notifier: new RecordingNotifier(),
      hotspots: () => Promise.resolve({ windowDays: 7, hotspots: [hot('a.ts', ['s1t8']), hot('src/a.tsx', ['s1t8']), hot('lib/a.ts', ['s1t8'])] }),
    });
    expect(unwrap(await artifacts.context(DEV, glob.id)).hotspots?.map((h) => h.path)).toEqual(['src/a.tsx', 'lib/a.ts']);
  });

  it('is empty when none of the glob\'s files is hot', async () => {
    const glob = await create('Change z.ts');
    const artifacts = new ArtifactService({ store, clock, notifier: new RecordingNotifier(), hotspots: () => Promise.resolve(view) });
    expect(unwrap(await artifacts.context(DEV, glob.id)).hotspots).toEqual([]);
  });
});
