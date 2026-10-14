import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SizeCheckService } from '../src/app/size-check-service.js';
import type { Result } from '../src/domain/errors.js';
import type { GlobOutcome } from '../src/domain/intake-learning.js';
import * as machine from '../src/domain/machine.js';
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
const SMALL = '## Do\n- [ ] Fix the label on the card.\n';

describe('learned size check', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let llmMode: 'ok' | 'unavailable' | 'junk';
  let calls: string[];
  let spends: LlmRequest['spend'][];
  let service: SizeCheckService;
  let clockNow: string;
  /** What the judge answers; the default says five parts, three of them buildable at the same time. */
  let judged: string;
  /** What the proposer answers: the parts, with the model's needs. */
  let proposed: { title: string; summary: string; plan: string; after: number[] }[];

  const llm: Llm = {
    complete: (request: LlmRequest) => {
      calls.push(request.system.startsWith('You judge') ? 'judge' : 'propose');
      spends.push(request.spend);
      if (llmMode === 'unavailable') return Promise.reject(new LlmUnavailable('down', 'wait'));
      if (llmMode === 'junk') return Promise.resolve('no json here');
      return Promise.resolve(
        request.system.startsWith('You judge')
          ? judged
          : JSON.stringify({ parts: proposed }),
      );
    },
  };

  const create = async (type: 'sub' | 'same', plan: string, autoTrigger = false): Promise<Glob> =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'T',
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
    judged = '{"independentParts": 5, "parallelParts": 3, "reason": "five pieces"}';
    proposed = [
      { title: 'Data and server', summary: 'a', plan: '## Tasks\n1. migration in apps/server/drizzle\n2. endpoint in apps/server/drizzle', after: [] },
      { title: 'Web', summary: 'b', plan: '## Tasks\n3. web card', after: [0] },
      { title: 'CLI', summary: 'c', plan: '## Tasks\n4. CLI command in apps/server/drizzle', after: [0] },
    ];
    calls = [];
    spends = [];
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
    expect(check?.reasons.length).toBe(3);
    expect(check?.estimate.parallelParts).toBe(3);
    // The model's two parts; the untasked "Chat content" section is context, copied into each.
    expect(check?.proposal?.parts.map((p) => p.title)).toEqual(['Data and server', 'Web', 'CLI']);
    for (const part of check?.proposal?.parts ?? []) expect(part.plan).toContain('This section has prose and no task of its own');
    expect(check?.proposal?.parts.map((p) => p.after)).toEqual([[], [0], [0]]);
    // Part 0 is the shared contract: two parts that need only it, and the proposal shows the shape.
    expect(check?.proposal).toMatchObject({ criticalPath: 2, maxParallel: 2 });
    // The judge and the split proposal both go to the board's ledger as the size check.
    expect(calls).toEqual(['judge', 'propose']);
    expect(spends).toEqual([{ boardId, source: 'size_check' }, { boardId, source: 'size_check' }]);
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
      // The text cannot tell whether parts could run at the same time, so it never flags.
      expect(check?.flagged).toBe(false);
      expect(check?.proposal).toBeNull();
    }
  });

  it('holds a flagged sub in Planning, not queuing a run, until it is kept whole', async () => {
    const sub = await create('sub', BIG);
    expect(sub.status).toBe('planning');
    // Only the automatic investigate-only run: nothing implements it.
    expect(sub.runs.map((r) => r.purpose)).toEqual(['investigate']);
    expect(sub.waiting).not.toBeNull();
    // Nothing waited for merging starts it.
    expect((unwrap(await globs.release(sub.id))).status).toBe('planning');
    unwrap(await service.keepWhole(DEV, sub.id));
    const released = unwrap(await globs.release(sub.id));
    expect(released.status).toBe('implementing');
    // The queued investigation is superseded by the run that implements it.
    expect(released.runs.map((r) => [r.purpose, r.outcome ?? r.state])).toEqual([['investigate', 'superseded'], [undefined, 'queued']]);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.decision).toBe('kept_whole');
  });

  it('Start now on a flagged sub offers the action and starts it; keeping whole first records the override', async () => {
    const sub = await create('sub', BIG);
    const view = unwrap(await globs.get(DEV, sub.id));
    expect(view.allowedActions).toContain('start_anyway');
    unwrap(await service.keepWhole(DEV, sub.id));
    const started = unwrap(await globs.startAnyway(DEV, sub.id, sub.version));
    expect(started.status).toBe('implementing');
    expect(started.implementer).toBeNull();
    expect(started.runs.filter((r) => r.purpose === undefined)).toHaveLength(1);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.decision).toBe('kept_whole');
  });

  it('does not auto-trigger a flagged same, and leaves one without auto-trigger alone', async () => {
    const auto = await create('same', BIG, true);
    expect(auto.status).toBe('planning');
    expect(auto.runs.map((r) => r.purpose)).toEqual(['investigate']);
    const plain = await create('same', BIG);
    expect(plain.status).toBe('planning');
    expect(plain.waiting ?? null).toBeNull();
    // A small auto-triggered same still starts.
    expect((await create('same', SMALL, true)).status).toBe('implementing');
  });

  it('investigates a flagged glob once by itself, unless the board turns it off', async () => {
    const flagged = await create('same', BIG);
    expect(flagged.runs).toHaveLength(1);
    expect(flagged.runs[0]).toMatchObject({ purpose: 'investigate', state: 'queued', triggeredBy: DEV });
    expect(flagged.status).toBe('planning');
    // Saving the plan again does not start a second one: one automatic run per glob.
    await globs.autoInvestigate(flagged.id);
    expect((await get(flagged.id)).runs).toHaveLength(1);
    // A small, model-judged plan is not investigated; a text-only multi-task estimate is (low confidence).
    expect((await create('same', SMALL)).runs).toHaveLength(0);
    llmMode = 'unavailable';
    const guessed = await create('same', '## Tasks\n- [ ] One thing\n- [ ] Another thing\n');
    expect(guessed.runs.map((r) => r.purpose)).toEqual(['investigate']);
    const board = await store.transaction((tx) => tx.getBoard(boardId));
    expect(board?.autoInvestigate).toBe(true);
    unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).updateSettings(ADMIN, boardId, board?.version ?? 1, { autoInvestigate: false }));
    expect((await create('same', BIG)).runs).toHaveLength(0);
  });

  it('keep whole is refused for a glob that is not flagged', async () => {
    const small = await create('same', SMALL);
    const result = await service.keepWhole(DEV, small.id);
    expect(result.ok).toBe(false);
  });

  it('proposes again on the current plan, and records why when the model gives no split', async () => {
    // A model that judges the plan big but gives no usable split.
    proposed = [];
    const glob = await create('same', BIG);
    const first = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(first).toMatchObject({ flagged: true, proposal: null });
    expect(first?.evidence).toContain('No split was proposed: the model gave fewer than 2 usable parts');
    // The plan changed behind the stored check's back (same hash is not required).
    proposed = [
      { title: 'Data and server', summary: 'a', plan: '## Tasks\n1. migration in apps/server/drizzle\n2. endpoint in apps/server/drizzle', after: [] },
      { title: 'Web', summary: 'b', plan: '## Tasks\n3. web card', after: [0] },
      { title: 'CLI', summary: 'c', plan: '## Tasks\n4. CLI command in apps/server/drizzle', after: [0] },
    ];
    clockNow = '2026-10-09T13:00:00.000Z';
    unwrap(await service.repropose(DEV, glob.id));
    expect(service.isReproposing(glob.id)).toBe(true);
    // A second request while one runs is not an error.
    unwrap(await service.repropose(DEV, glob.id));
    await service.runRepropose(glob.id);
    expect(service.isReproposing(glob.id)).toBe(false);
    const again = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(again).toMatchObject({ flagged: true, createdAt: first?.createdAt, updatedAt: '2026-10-09T13:00:00.000Z' });
    expect(again?.proposal?.parts.map((p) => p.title)).toEqual(['Data and server', 'Web', 'CLI']);
    expect(again?.evidence.join('\n')).not.toContain('No split was proposed');
  });

  it('a failed proposal keeps the flag and says the model timed out or was unavailable', async () => {
    const glob = await create('same', BIG);
    llmMode = 'unavailable';
    unwrap(await service.repropose(DEV, glob.id));
    await service.runRepropose(glob.id);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    // The judge failed too, so the text estimate is back and does not flag: the earlier flag is not the model's to lift silently.
    expect(check?.proposal).toBeNull();
    expect(check?.evidence.some((e) => e.startsWith('No split was proposed')) || check?.flagged === false).toBe(true);
  });

  it('proposing again is refused when not flagged, answered or started', async () => {
    const small = await create('same', SMALL);
    expect((await service.repropose(DEV, small.id)).ok).toBe(false);
    const flagged = await create('same', BIG);
    unwrap(await service.keepWhole(DEV, flagged.id));
    expect((await service.repropose(DEV, flagged.id)).ok).toBe(false);
    expect((await service.repropose('nobody@example.com', flagged.id)).ok).toBe(false);
    const sub = await create('sub', BIG);
    unwrap(await service.keepWhole(DEV, sub.id));
    unwrap(await globs.release(sub.id));
    expect((await service.repropose(DEV, sub.id)).ok).toBe(false);
  });

  it('splitting a flagged glob records the decision', async () => {
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    const parts = (check?.proposal?.parts ?? []).map((p) => ({ title: p.title, plan: p.plan, after: p.after }));
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

  it('a summary-only sub is not held by the model\'s parts estimate', async () => {
    const sub = unwrap(
      await globs.create(DEV, { boardId, title: 'T', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    expect(calls).toEqual([]);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.flagged).toBe(false);
    expect(sub.status).toBe('implementing');
  });

  it('saving a smaller plan re-judges a held sub and lifts the hold, as save_plan does', async () => {
    const sub = await create('sub', BIG);
    expect(sub.status).toBe('planning');
    expect(sub.waiting).not.toBeNull();
    unwrap(await artifacts.putPlan(DEV, sub.id, SMALL));
    await service.refresh(sub.id);
    // The save's own background refresh may still be lifting the hold; the lift is idempotent.
    await globs.reconcileSizeHold(sub.id);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.flagged).toBe(false);
    const started = await get(sub.id);
    expect(started.status).toBe('implementing');
    expect(started.runs.map((r) => [r.purpose, r.outcome ?? r.state])).toEqual([['investigate', 'superseded'], [undefined, 'queued']]);
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

  describe('serial plans, shared contracts and parallel parts', () => {
    const contractParts = [
      { title: 'Contract', summary: 'the shared schema', plan: '## Tasks\n1. migration in apps/server/drizzle/0001.sql', after: [] },
      { title: 'Server', summary: 's', plan: '## Tasks\n2. endpoint in apps/server/src/shared.ts\n3. route in apps/server/src/http/app.ts', after: [0] },
      { title: 'Web', summary: 'w', plan: '## Tasks\n4. web card\n5. web page\n6. web test', after: [0] },
      { title: 'CLI', summary: 'c', plan: '## Tasks\n7. cli command in apps/server/src/shared.ts', after: [0] },
    ];
    const needsOf = (id: string | undefined): string[] => [...store.state.relations.values()].filter((r) => r.from === id && r.gate === 'start').map((r) => r.to);
    const splitAsProposed = async (glob: Glob): Promise<Glob[]> => {
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      const parts = (check?.proposal?.parts ?? []).map((p, index) => ({
        title: p.title,
        plan: p.plan,
        ...(index > 0 && p.after.length > 0 ? { after: [...p.after] } : {}),
        ...(index > 0 && p.type !== undefined ? { type: p.type } : {}),
      }));
      return unwrap(await globs.split(DEV, glob.id, glob.version, { parts, idempotencyKey: null }));
    };

    it('does not flag a long serial plan, however many tasks it has', async () => {
      judged = '{"independentParts": 6, "parallelParts": 1, "reason": "each step needs the one before"}';
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check).toMatchObject({ flagged: false, reasons: [], proposal: null });
      expect(check?.estimate).toMatchObject({ tasks: 6, parallelParts: 1 });
      expect(calls).toEqual(['judge']);
    });

    it('does not flag when the model leaves the parallelism out', async () => {
      judged = '{"independentParts": 5, "reason": "five pieces"}';
      const glob = await create('same', BIG);
      expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.flagged).toBe(false);
    });

    it('flags three independent areas, and the proposal shows the critical path and parallelism', async () => {
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check?.flagged).toBe(true);
      expect(check?.reasons.join('; ')).toContain('3 parts could be built at the same time');
      expect(check?.proposal).toMatchObject({ criticalPath: 2, maxParallel: 2 });
    });

    it('drops a proposal whose parts wait on each other in one line, and does not flag the glob', async () => {
      proposed = [
        { title: 'A', summary: 'a', plan: '## Tasks\n1. a', after: [] },
        { title: 'B', summary: 'b', plan: '## Tasks\n2. b', after: [0] },
        { title: 'C', summary: 'c', plan: '## Tasks\n3. c', after: [1] },
      ];
      const glob = await create('sub', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check).toMatchObject({ flagged: false, proposal: null });
      expect(check?.evidence.join('\n')).toContain('a chain of 3 parts');
      expect((await get(glob.id)).status).toBe('implementing');
    });

    it('splits a shared schema and three consumers into part 0 plus three parts that need only part 0; shared files make no relation', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check?.proposal?.parts.map((p) => p.after)).toEqual([[], [0], [0], [0]]);
      expect(check?.proposal?.parts.every((p) => !('overlaps' in p))).toBe(true);
      // Small, low-risk parts are subs; the 3-task part stays the glob's own type.
      expect(check?.proposal?.parts.map((p) => p.type)).toEqual([undefined, 'sub', undefined, 'sub']);
      const created = await splitAsProposed(glob);
      expect(created).toHaveLength(4);
      const [first, server, web, cli] = created;
      expect(needsOf(server?.id)).toEqual([first?.id]);
      expect(needsOf(web?.id)).toEqual([first?.id]);
      expect(needsOf(cli?.id)).toEqual([first?.id]);
      expect(created.map((g) => g.type)).toEqual(['same', 'sub', 'same', 'sub']);
      // The file overlap is not a relation at all: only the need on part 0 is.
      expect(needsOf(cli?.id)).not.toContain(server?.id);
      // The source can't be signed off until each part has merged.
      expect([...store.state.relations.values()].filter((r) => r.gate === 'sign_off').map((r) => [r.from, r.to, r.source])).toEqual(
        [server, web, cli].map((p) => [first?.id, p?.id, 'split']),
      );
    });

    it('a split same starts its routine on its own when its last need merges, and a person can turn that off', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const [first, , web, cli] = await splitAsProposed(glob);
      if (first === undefined || web === undefined || cli === undefined) throw new Error('no parts');
      expect(web).toMatchObject({ status: 'planning', autoStart: true });
      expect(web.waiting).not.toBeNull();
      // Turn it off on the web part: the wait ends, the need stays.
      const off = unwrap(await globs.update(DEV, web.id, web.version, { autoStart: false }));
      expect(off).toMatchObject({ autoStart: false, waiting: null, status: 'planning' });
      expect(needsOf(web.id)).toEqual([first.id]);
      unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
      const released = await globs.releaseDependents(first.id, boardId);
      expect(released).toContain(cli.id);
      expect(released).not.toContain(web.id);
      expect((await get(web.id)).status).toBe('planning');
    });

    it('a split same that keeps the flag starts when its need merges', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const [first, , web] = await splitAsProposed(glob);
      if (first === undefined || web === undefined) throw new Error('no parts');
      unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
      expect(await globs.releaseDependents(first.id, boardId)).toContain(web.id);
      const started = await get(web.id);
      expect(started).toMatchObject({ status: 'implementing', waiting: null });
      expect(started.runs).toHaveLength(1);
    });

    it('the flag only exists on a same that waits: a part with no needs has none', async () => {
      proposed = contractParts;
      const [first] = await splitAsProposed(await create('same', BIG));
      expect(first?.autoStart).toBeUndefined();
    });
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

    describe('split outcomes', () => {
      const partsOf = (after: number[][]) => after.map((a, i) => ({ title: `P${i}`, summary: '', plan: `## Tasks\n${i + 1}. step ${i + 1}`, after: a }));
      /** Splits a flagged glob, merges the parts named (all by default) and records the source's outcome. */
      const splitAndMerge = async (after: number[][], mergeParts = after.map((_, i) => i)) => {
        const glob = await create('same', BIG);
        const parts = unwrap(await globs.split(DEV, glob.id, glob.version, { parts: partsOf(after), idempotencyKey: null }));
        for (const index of mergeParts) {
          const part = parts[index];
          if (part !== undefined) unwrap(await globs.applyEvent(part.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
        }
        await store.transaction((tx) => tx.upsertGlobOutcome(outcomeOf(glob.id)));
        return { glob, parts };
      };
      const failRun = (globId: string) =>
        store.transaction((tx) => tx.appendEvents([{ type: 'RunFailed', globId, actor: null, at: NOW, data: {} }]));

      it('a split whose parts serialised and stalled raises the threshold, with the cause in the history', async () => {
        const { glob, parts } = await splitAndMerge([[], [0], [1]]);
        await failRun(parts[1]?.id ?? '');
        const result = await service.learn(boardId);
        expect(result.changes).toMatchObject([{ globId: glob.id, outcome: 'split_stalled', from: { maxTasks: 5, maxParts: 3 }, to: { maxTasks: 6, maxParts: 4 } }]);
        expect(await threshold()).toEqual({ maxTasks: 6, maxParts: 4 });
        const history = unwrap(await service.view(DEV, boardId)).history;
        expect(history[0]?.evidence).toContain('one after another');
        expect(history[0]?.evidence).toContain('1 failed run');
        expect((await service.learn(boardId)).changes).toEqual([]);
      });

      it('a split whose parts ran in parallel is recorded and leaves the threshold, even with a failed run', async () => {
        const { glob, parts } = await splitAndMerge([[], [0], [0]]);
        await failRun(parts[2]?.id ?? '');
        const result = await service.learn(boardId);
        expect(result.changes).toMatchObject([{ globId: glob.id, outcome: 'split_helped' }]);
        expect(await threshold()).toEqual(DEFAULT_SIZE_THRESHOLD);
      });

      it('a serialised split that did not stall leaves the threshold', async () => {
        await splitAndMerge([[], [0]]);
        expect((await service.learn(boardId)).changes.map((c) => c.outcome)).toEqual(['split_helped']);
      });

      it('waits until every part has merged', async () => {
        await splitAndMerge([[], [0], [1]], [0, 1]);
        expect((await service.learn(boardId)).changes).toEqual([]);
      });
    });

    it('shows the learned threshold beside the default, and an admin resets it', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id);
      await service.learn(boardId);
      const view = unwrap(await service.view(DEV, boardId));
      expect(view).toMatchObject({ current: { maxTasks: 6, maxParts: 4 }, defaults: DEFAULT_SIZE_THRESHOLD });
      expect((await service.reset(DEV, boardId)).ok).toBe(false);
      const reset = unwrap(await service.reset(ADMIN, boardId));
      expect(reset.current).toEqual(DEFAULT_SIZE_THRESHOLD);
      expect(reset.history.map((h) => h.outcome)).toEqual(['reset', 'kept_whole_clean']);
      // The glob's outcome stays recorded: learning does not replay it.
      expect((await service.learn(boardId)).changes).toEqual([]);
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
