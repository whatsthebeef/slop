import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SizeCheckService } from '../src/app/size-check-service.js';
import type { Result } from '../src/domain/errors.js';
import type { GlobOutcome } from '../src/domain/intake-learning.js';
import { DEFAULT_SIZE_THRESHOLD } from '../src/domain/size-check.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-09T12:00:00.000Z';

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
const SMALL = '## Do\n1. Fix the label on the card.\n';

describe('learned size check', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let llmMode: 'ok' | 'unavailable' | 'junk';
  let calls: string[];
  let service: SizeCheckService;
  let clockNow: string;

  const llm: Llm = {
    complete: (request: LlmRequest) => {
      calls.push(request.system.startsWith('You judge') ? 'judge' : 'propose');
      if (llmMode === 'unavailable') return Promise.reject(new LlmUnavailable('down', 'wait'));
      if (llmMode === 'junk') return Promise.resolve('no json here');
      return Promise.resolve(
        request.system.startsWith('You judge')
          ? '{"independentParts": 5, "reason": "five pieces"}'
          : JSON.stringify({
              parts: [
                { title: 'Data and server', summary: 'a', plan: '## Build\n1. migration in apps/server/drizzle\n2. endpoint in apps/server/drizzle', after: [] },
                { title: 'Web', summary: 'b', plan: '## Build\n3. web card', after: [0] },
              ],
            }),
      );
    },
  };

  const create = async (type: 'sub' | 'same', plan: string, autoTrigger = false): Promise<Glob> =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'T',
        summary: 's',
        type,
        category: type === 'sub' ? 'task' : 'feature',
        group: null,
        environment: null,
        autoTrigger,
        idempotencyKey: null,
        plan,
      }),
    );
  const get = async (id: string): Promise<Glob> => {
    const g = await globs.peek(id);
    if (g === null) throw new Error('missing');
    return g;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    llmMode = 'ok';
    calls = [];
    clockNow = NOW;
    const notifier = new RecordingNotifier();
    const clock = { now: () => clockNow };
    service = new SizeCheckService({ store, clock, notifier, llm });
    let runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) }, sizeCheck: service });
    artifacts = new ArtifactService({ store, clock, notifier, sizeCheck: service });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('stores the estimate with its evidence and a proposal for a flagged glob', async () => {
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(check).toMatchObject({ flagged: true, decision: null, threshold: DEFAULT_SIZE_THRESHOLD });
    expect(check?.estimate).toMatchObject({ tasks: 6, independentParts: 5, partsSource: 'model' });
    expect(check?.evidence.join('\n')).toContain('Model: 5 independent parts');
    expect(check?.reasons.length).toBe(2);
    // The model's two parts, and the untasked "Chat content" section as a third.
    expect(check?.proposal?.parts.map((p) => p.title)).toEqual(['Data and server', 'Web', 'Chat content']);
    expect(check?.proposal?.parts[1]?.after).toEqual([0]);
  });

  it('does not flag a small plan, and makes no model call for a trivial one', async () => {
    const glob = await create('sub', SMALL);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.flagged).toBe(false);
    expect(calls).toEqual([]);
    expect((await get(glob.id)).status).toBe('implementing');
  });

  it('degrades to the text estimate when the model is unavailable or answers badly', async () => {
    for (const mode of ['unavailable', 'junk'] as const) {
      llmMode = mode;
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check?.estimate.partsSource).toBe('text');
      expect(check?.flagged).toBe(true);
      expect(check?.proposal).toBeNull();
    }
  });

  it('holds a flagged sub in Planning, not queuing a run, until it is kept whole', async () => {
    const sub = await create('sub', BIG);
    expect(sub.status).toBe('planning');
    expect(sub.runs).toHaveLength(0);
    expect(sub.waiting).not.toBeNull();
    // Nothing waited for merging starts it.
    expect((unwrap(await globs.release(sub.id))).status).toBe('planning');
    unwrap(await service.keepWhole(DEV, sub.id));
    const released = unwrap(await globs.release(sub.id));
    expect(released.status).toBe('implementing');
    expect(released.runs).toHaveLength(1);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.decision).toBe('kept_whole');
  });

  it('does not auto-trigger a flagged same, and leaves one without auto-trigger alone', async () => {
    const auto = await create('same', BIG, true);
    expect(auto.status).toBe('planning');
    expect(auto.runs).toHaveLength(0);
    const plain = await create('same', BIG);
    expect(plain.status).toBe('planning');
    expect(plain.waiting ?? null).toBeNull();
    // A small auto-triggered same still starts.
    expect((await create('same', SMALL, true)).status).toBe('implementing');
  });

  it('keep whole is refused for a glob that is not flagged', async () => {
    const small = await create('same', SMALL);
    const result = await service.keepWhole(DEV, small.id);
    expect(result.ok).toBe(false);
  });

  it('splitting a flagged glob records the decision', async () => {
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    const parts = (check?.proposal?.parts ?? []).map((p) => ({ title: p.title, summary: p.summary, plan: p.plan, after: p.after }));
    unwrap(await globs.split(DEV, glob.id, glob.version, { parts, idempotencyKey: null }));
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.decision).toBe('split');
    const view = unwrap(await globs.get(DEV, glob.id));
    expect(view.sizeCheck?.flagged).toBe(true);
  });

  it('re-judges when plan.md is saved in Planning, keeping a decision', async () => {
    const glob = await create('same', SMALL);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.flagged).toBe(false);
    unwrap(await artifacts.putPlan(DEV, glob.id, BIG));
    await service.refresh(glob.id);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(check?.flagged).toBe(true);
    unwrap(await service.keepWhole(DEV, glob.id));
    await service.refresh(glob.id);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.decision).toBe('kept_whole');
  });

  it('reports oversized only while the glob is in Planning, and skips the model for an unchanged plan', async () => {
    const glob = await create('same', BIG);
    expect([...(await globs.oversizedOf(boardId))]).toEqual([glob.id]);
    const before = calls.length;
    await service.refresh(glob.id);
    expect(calls.length).toBe(before);
    unwrap(await globs.start(DEV, glob.id, glob.version));
    expect((await get(glob.id)).status).toBe('implementing');
    expect([...(await globs.oversizedOf(boardId))]).toEqual([]);
  });

  describe('the learning job', () => {
    const outcomeOf = (globId: string, patch: { rounds?: number; fixGlobs?: string[] } = {}): GlobOutcome => ({
      globId,
      snapshotVersion: 1,
      boardId,
      mergedAt: '2026-09-01T00:00:00.000Z',
      recordedAt: '2026-09-20T00:00:00.000Z',
      final: true,
      corrections: { category: null, type: null, subConverted: null, split: false },
      size: { changedLines: null },
      review: { rounds: patch.rounds ?? 1, maxRounds: 3, testFailRounds: 0, findingsBySeverity: {}, findingsByClass: {} },
      tests: { ciFailures: 0 },
      effort: { calendarHours: 5 },
      postMerge: { fixGlobs: patch.fixGlobs ?? [] },
    });
    const merge = async (globId: string, patch: Parameters<typeof outcomeOf>[1] = {}, extra: { type: 'RunFailed' | 'GlobSplit' | 'RunTriggered'; at: string }[] = []) => {
      await store.transaction(async (tx) => {
        await tx.upsertGlobOutcome(outcomeOf(globId, patch));
        await tx.appendEvents([
          { type: 'PROpened', globId, actor: null, at: '2026-08-31T20:00:00.000Z', data: {} },
          { type: 'Merged', globId, actor: null, at: '2026-09-01T00:00:00.000Z', data: {} },
          ...extra.map((e) => ({ type: e.type, globId, actor: null, at: e.at, data: {} })),
        ]);
      });
    };
    const threshold = () => store.transaction((tx) => tx.getSizeThreshold(boardId));

    it('raises when a flagged glob kept whole merged cleanly, once', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id);
      const first = await service.learn(boardId);
      expect(first.changes).toMatchObject([{ globId: glob.id, outcome: 'kept_whole_clean', from: { maxTasks: 5, maxParts: 3 }, to: { maxTasks: 6, maxParts: 4 } }]);
      expect(await threshold()).toEqual({ maxTasks: 6, maxParts: 4 });
      expect((await service.learn(boardId)).changes).toEqual([]);
      const view = unwrap(await service.view(DEV, boardId));
      expect(view.history).toHaveLength(1);
      expect(view.history[0]?.evidence).toContain('kept whole');
    });

    it('lowers when an unflagged glob hit max review rounds, or was split after it started', async () => {
      const a = await create('same', SMALL);
      const b = await create('same', SMALL);
      await merge(a.id, { rounds: 3 });
      await merge(b.id, {}, [
        { type: 'RunTriggered', at: '2026-08-31T10:00:00.000Z' },
        { type: 'GlobSplit', at: '2026-08-31T12:00:00.000Z' },
      ]);
      const result = await service.learn(boardId);
      expect(result.changes.map((c) => c.outcome)).toEqual(['unflagged_struggled', 'unflagged_struggled']);
      expect(await threshold()).toEqual({ maxTasks: 3, maxParts: 2 });
    });

    it('leaves the threshold when a flagged glob was split, or kept whole and not clean', async () => {
      const split = await create('same', BIG);
      const messy = await create('same', BIG);
      await merge(split.id, {}, [{ type: 'GlobSplit', at: '2026-08-30T00:00:00.000Z' }]);
      await merge(messy.id, { fixGlobs: ['s1b9'] });
      const result = await service.learn(boardId);
      expect(result.changes.map((c) => c.outcome)).toEqual(['flag_confirmed', 'flag_confirmed']);
      expect(await threshold()).toEqual(DEFAULT_SIZE_THRESHOLD);
    });

    it('waits for the outcome to be final, and ignores globs with no size check', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id);
      await store.transaction((tx) => tx.upsertGlobOutcome({ ...outcomeOf(glob.id), final: false }));
      await store.transaction((tx) => tx.upsertGlobOutcome(outcomeOf('s9f9', { rounds: 3 })));
      expect((await service.learn(boardId)).changes).toEqual([]);
    });
  });
});
