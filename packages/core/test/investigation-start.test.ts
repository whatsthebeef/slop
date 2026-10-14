import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';

describe('Start and Pick up during an investigation', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  const clock = { now: () => '2026-10-14T12:00:00.000Z' };
  let n = 0;

  const investigated = async (): Promise<Glob> => {
    const glob = unwrap(await globs.create(DEV, { boardId, title: 'G', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    return unwrap(await globs.investigate(DEV, glob.id, glob.version));
  };
  const get = async (id: string): Promise<Glob> => unwrap(await globs.get(DEV, id)).glob;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${String(++n)}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService({ store, clock, notifier: new RecordingNotifier() });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  it('Start queues behind the investigation, a second Start changes nothing, and the end of the run starts the glob', async () => {
    const glob = await investigated();
    const investigation = machine.liveInvestigation(glob);
    expect(investigation).not.toBeNull();
    const queued = unwrap(await globs.start(DEV, glob.id, glob.version));
    expect(queued.status).toBe('planning');
    expect(queued.runs).toHaveLength(1);
    const again = unwrap(await globs.start(DEV, glob.id, queued.version));
    expect(again.version).toBe(queued.version);
    unwrap(await globs.applyEvent(glob.id, (g, c) => machine.investigationPushed(g, investigation?.id ?? '', c)));
    const started = await get(glob.id);
    expect(started.status).toBe('implementing');
    expect(started.runs.map((r) => [r.state, r.purpose])).toEqual([['ended', 'investigate'], ['queued', undefined]]);
  });

  it('a failed investigation also starts the queued glob', async () => {
    const glob = await investigated();
    const queued = unwrap(await globs.start(DEV, glob.id, glob.version));
    unwrap(await globs.reportFailure(DEV, glob.id, 'no routine', machine.liveInvestigation(queued)?.id ?? null, null));
    const started = await get(glob.id);
    expect(started.status).toBe('implementing');
    expect(started.runs.map((r) => r.outcome)).toEqual(['failed', null]);
  });

  it('Pick up warns that an investigation is running, leaves it running, and the context carries it until it ends', async () => {
    const glob = await investigated();
    const picked = unwrap(await globs.pickUpWithWarning(DEV, glob.id, glob.version, false));
    expect(picked.warning).toMatch(/investigation has been running since 2026-10-14T12:00:00\.000Z/);
    expect(picked.glob.status).toBe('in_progress');
    const running = machine.investigationRunning(picked.glob);
    expect(unwrap(await artifacts.context(DEV, glob.id)).investigationRunning).toEqual(running);
    unwrap(await globs.applyEvent(glob.id, (g, c) => machine.investigationPushed(g, running?.runId ?? '', c)));
    expect('investigationRunning' in unwrap(await artifacts.context(DEV, glob.id))).toBe(false);
  });
});
