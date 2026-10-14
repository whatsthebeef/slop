import { describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { DEFAULT_SIZE_THRESHOLD, estimateFromText } from '../src/domain/size-check.js';
import type { Embedder } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly open: (value: T) => void;
}
const gate = <T>(): Gate<T> => {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** Lets every already-queued continuation run (the in-memory store settles in microtasks, so a macrotask turn drains them). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('GlobService.create model-bound reads', () => {
  it('starts the embedding, the size check and the dependency inference before any of them finishes', async () => {
    const started: string[] = [];
    const embedGate = gate<number[][]>();
    const sizeGate = gate<null>();
    const inferGate = gate<never[]>();
    const embedder: Embedder = {
      model: 'fake',
      dimensions: 1024,
      embed: () => {
        started.push('embed');
        return embedGate.promise;
      },
    };
    const sizeCheck = {
      assess: async (_boardId: number, plan: string) => {
        started.push('size');
        await sizeGate.promise;
        const estimate = estimateFromText(plan);
        return { planHash: 'h', estimate, evidence: [], threshold: DEFAULT_SIZE_THRESHOLD, flagged: false, reasons: [], proposal: null };
      },
      refresh: () => Promise.resolve(),
    };
    const inference = {
      infer: () => {
        started.push('infer');
        return inferGate.promise;
      },
    };
    const store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-14T12:00:00.000Z' };
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
      embedder,
      sizeCheck,
      inference,
    });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    const boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;

    let finished = false;
    const created = globs
      .create(ADMIN, { boardId, title: 'Slow', plan: '## Tasks\n1. Do it', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null })
      .then((result) => {
        finished = true;
        return result;
      });

    await settle();
    // All three are in flight together, and create is still waiting on them.
    expect([...started].sort()).toEqual(['embed', 'infer', 'size']);
    expect(finished).toBe(false);

    // Finish them in the opposite order to the one they started in: the result does not depend on who is last.
    inferGate.open([]);
    sizeGate.open(null);
    await settle();
    expect(finished).toBe(false);
    embedGate.open([new Array<number>(1024).fill(0)]);

    const glob = unwrap(await created);
    expect(glob.title).toBe('Slow');
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(check).toMatchObject({ globId: glob.id, flagged: false });
  });
});
