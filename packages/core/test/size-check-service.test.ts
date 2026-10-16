import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { cleanTitle, parseParts, SizeCheckService } from '../src/app/size-check-service.js';
import type { Result } from '../src/domain/errors.js';
import type { GlobOutcome } from '../src/domain/intake-learning.js';
import * as machine from '../src/domain/machine.js';
import { DEFAULT_SIZE_THRESHOLD } from '../src/domain/size-check.js';
import type { JsonValue } from '../src/domain/events.js';
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
  let requests: LlmRequest[];
  let service: SizeCheckService;
  let clockNow: string;
  /** What the judge answers; the default says five parts, three of them buildable at the same time. */
  let judged: string;
  /** What the proposer answers: the workstreams, with the model's needs. */
  let proposed: { name: string; goal: string; files: string[]; plan: string; needs: number[] }[];

  const llm: Llm = {
    complete: (request: LlmRequest) => {
      calls.push(request.system.startsWith('You judge') ? 'judge' : 'propose');
      spends.push(request.spend);
      requests.push(request);
      if (llmMode === 'unavailable') return Promise.reject(new LlmUnavailable('down', 'wait'));
      if (llmMode === 'junk') return Promise.resolve('no json here');
      return Promise.resolve(
        request.system.startsWith('You judge')
          ? judged
          : JSON.stringify({ workstreams: proposed }),
      );
    },
  };

  const create = async (type: 'sub' | 'same', plan: string, autoTrigger = false): Promise<Glob> =>
    unwrap(
      await globs.create(ADMIN, {
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
      { name: 'Data and server', goal: 'the table and its endpoint', files: ['apps/server/drizzle'], plan: '## Tasks\n1. migration in apps/server/drizzle\n2. endpoint in apps/server/drizzle', needs: [] },
      { name: 'Web', goal: 'the card', files: [], plan: '## Tasks\n3. web card', needs: [0] },
      { name: 'CLI', goal: 'the command', files: [], plan: '## Tasks\n4. CLI command in apps/server/drizzle', needs: [0] },
    ];
    calls = [];
    spends = [];
    requests = [];
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
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
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
    // The model's workstreams; the untasked "Chat content" section is context, copied into each.
    expect(check?.proposal?.workstreams.map((w) => w.name)).toEqual(['Data and server', 'Web', 'CLI']);
    expect(check?.proposal?.workstreams.map((w) => w.goal)).toEqual(['the table and its endpoint', 'the card', 'the command']);
    expect(check?.proposal?.workstreams[0]?.files).toEqual(['apps/server/drizzle']);
    for (const w of check?.proposal?.workstreams ?? []) expect(w.plan).toContain('This section has prose and no task of its own');
    expect(check?.proposal?.workstreams.map((w) => w.needs)).toEqual([[], [0], [0]]);
    // The first workstream is the shared contract: two that need only it, and the proposal shows the shape.
    expect(check?.proposal).toMatchObject({ criticalPath: 2, maxParallel: 2 });
    // The judge and the split proposal both go to the board's ledger as the size check.
    expect(calls).toEqual(['judge', 'propose']);
    expect(spends).toEqual([{ boardId, source: 'size_check' }, { boardId, source: 'size_check' }]);
  });

  it('gives the proposer the original title and asks for workstreams, not parts', async () => {
    unwrap(
      await globs.create(ADMIN, { boardId, title: 'Board chat feedback', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: BIG }),
    );
    const request = requests.find((r) => !r.system.startsWith('You judge'));
    expect(request?.prompt).toContain('Original title: Board chat feedback');
    expect(request?.system).toContain('workstreams');
    expect(request?.system).toContain('"needs"');
    expect(request?.system).not.toContain('Part 0');
  });

  it('keeps a proposed workstream name to one trimmed line of at most 100 characters', () => {
    expect(cleanTitle('  Board chat:\n answers   get buttons ')).toBe('Board chat: answers get buttons');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    const long = cleanTitle(`Board chat: ${'x'.repeat(200)}`);
    expect(long?.length).toBe(100);
    expect(long?.endsWith('…')).toBe(true);
    expect(parseParts(JSON.stringify({ workstreams: [{ name: ' A:  b ', plan: 'p', files: ['x.ts', 3], needs: [0] }, { name: ' ', plan: 'p' }] }))).toEqual([
      { name: 'A: b', goal: null, files: ['x.ts'], plan: 'p', needs: [0] },
    ]);
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

  it('does not hold or escalate a flagged sub: it stays a sub, and starts at once', async () => {
    const sub = await create('sub', BIG);
    // Size is advice for the run (workstreams): it never changes the type the glob was created with.
    expect(sub.type).toBe('sub');
    expect(sub.escalation ?? null).toBeNull();
    expect(store.state.events.filter((e) => e.globId === sub.id).map((e) => e.type)).not.toContain('Escalated');
    // Nothing holds it: it is implementing, with its run queued, and the flag stays as information.
    expect(sub.status).toBe('implementing');
    expect(sub.waiting ?? null).toBeNull();
    expect(sub.runs.map((r) => [r.purpose, r.state])).toEqual([[undefined, 'queued']]);
    const check = await store.transaction((tx) => tx.getSizeCheck(sub.id));
    expect(check).toMatchObject({ flagged: true, decision: null });
    expect(check?.proposal?.workstreams).toHaveLength(3);
  });

  it('a flagged sub that waits for another glob is held only for that, and starts when it merges', async () => {
    const first = await create('same', SMALL);
    const sub = unwrap(
      await globs.create(ADMIN, { boardId, title: 'T', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: BIG, after: [first.id] }),
    );
    expect([sub.type, sub.status]).toEqual(['sub', 'planning']);
    expect(sub.waiting).not.toBeNull();
    const view = unwrap(await globs.get(DEV, sub.id));
    expect(view.waitingFor.map((w) => w.id)).toEqual([first.id]);
    unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
    expect(await globs.releaseDependents(first.id, boardId)).toContain(sub.id);
    expect((await get(sub.id)).status).toBe('implementing');
  });

  it('a sub that is not flagged stays a sub, and a flagged same or super is not escalated', async () => {
    const small = await create('sub', SMALL);
    expect([small.type, small.escalation ?? null]).toEqual(['sub', null]);
    const same = await create('same', BIG);
    expect([same.type, same.escalation ?? null]).toEqual(['same', null]);
  });

  it('a waiting sub whose plan grows past the size threshold stays a sub, with no escalation', async () => {
    const first = await create('same', SMALL);
    const sub = unwrap(
      await globs.create(ADMIN, { boardId, title: 'T', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: SMALL, after: [first.id] }),
    );
    expect([sub.type, sub.status]).toEqual(['sub', 'planning']);
    unwrap(await artifacts.putPlan(DEV, sub.id, BIG));
    await service.refresh(sub.id);
    await globs.reconcileSizeCheck(sub.id);
    const flagged = await get(sub.id);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.flagged).toBe(true);
    expect(flagged.type).toBe('sub');
    expect(flagged.escalation ?? null).toBeNull();
    // Reconciling again changes nothing.
    await globs.reconcileSizeCheck(sub.id);
    expect((await get(sub.id)).version).toBe(flagged.version);
  });

  it('auto-triggers a flagged same as usual, and leaves one without auto-trigger alone', async () => {
    const auto = await create('same', BIG, true);
    expect(auto.status).toBe('implementing');
    expect(auto.waiting ?? null).toBeNull();
    expect(auto.runs.map((r) => r.purpose)).toEqual([undefined]);
    const plain = await create('same', BIG);
    expect(plain.status).toBe('planning');
    expect(plain.waiting ?? null).toBeNull();
    // A small auto-triggered same starts too.
    expect((await create('same', SMALL, true)).status).toBe('implementing');
  });

  it('investigates a flagged glob once by itself, unless the board turns it off', async () => {
    const flagged = await create('same', BIG);
    expect(flagged.runs).toHaveLength(1);
    expect(flagged.runs[0]).toMatchObject({ purpose: 'investigate', state: 'queued', triggeredBy: ADMIN });
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

  it('does not flag a plan when the model gives no usable workstreams, and records why', async () => {
    // A model that judges the plan big but gives no usable division: size alone never flags.
    proposed = [];
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    expect(check).toMatchObject({ flagged: false, reasons: [], proposal: null });
    const sub = await create('sub', BIG);
    expect(sub.type).toBe('sub');
    expect(check?.evidence).toContain('No workstreams were proposed: the model gave fewer than 2 usable workstreams');
  });

  it('splitting a flagged glob records the decision', async () => {
    const glob = await create('same', BIG);
    const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
    const parts = (check?.proposal?.workstreams ?? []).map((w) => ({ title: w.name, plan: w.plan }));
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
    if (check === null) throw new Error('no check');
    await store.transaction((tx) => tx.upsertSizeCheck({ ...check, decision: 'split', decidedBy: DEV, decidedAt: NOW }));
    await service.refresh(glob.id);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.decision).toBe('split');
  });

  it('a summary-only sub is not held by the model\'s parts estimate', async () => {
    const sub = unwrap(
      await globs.create(ADMIN, { boardId, title: 'T', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    expect(calls).toEqual([]);
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.flagged).toBe(false);
    expect(sub.status).toBe('implementing');
  });

  it('saving a smaller plan re-judges the check and lifts the flag, and the glob is untouched', async () => {
    const glob = await create('same', BIG);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.flagged).toBe(true);
    unwrap(await artifacts.putPlan(DEV, glob.id, SMALL));
    await service.refresh(glob.id);
    expect((await store.transaction((tx) => tx.getSizeCheck(glob.id)))?.flagged).toBe(false);
    expect((await get(glob.id)).status).toBe('planning');
  });

  it('reports oversized only while the glob is in Planning, and skips the model for an unchanged plan', async () => {
    const glob = await create('same', BIG);
    expect([...(await globs.oversizedOf(boardId))]).toEqual([glob.id]);
    const before = calls.length;
    await service.refresh(glob.id);
    expect(calls.length).toBe(before);
    // The big glob is already being investigated: Start waits for that run, which then starts the glob.
    const started = unwrap(await globs.start(DEV, glob.id, (await get(glob.id)).version));
    expect(started.status).toBe('planning');
    const investigation = machine.liveInvestigation(started);
    expect(investigation).not.toBeNull();
    unwrap(await globs.applyEvent(glob.id, (g, c) => machine.investigationPushed(g, investigation?.id ?? '', c)));
    expect((await get(glob.id)).status).toBe('implementing');
    expect([...(await globs.oversizedOf(boardId))]).toEqual([]);
  });

  describe('serial plans, shared contracts and parallel workstreams', () => {
    const contractParts = [
      { name: 'Contract', goal: 'the shared schema', files: [], plan: '## Tasks\n1. migration in apps/server/drizzle/0001.sql', needs: [] },
      { name: 'Server', goal: 's', files: [], plan: '## Tasks\n2. endpoint in apps/server/src/shared.ts\n3. route in apps/server/src/http/app.ts', needs: [0] },
      { name: 'Web', goal: 'w', files: [], plan: '## Tasks\n4. web card\n5. web page\n6. web test', needs: [0] },
      { name: 'CLI', goal: 'c', files: [], plan: '## Tasks\n7. cli command in apps/server/src/shared.ts', needs: [0] },
    ];
    const needsOf = (id: string | undefined): string[] => [...store.state.relations.values()].filter((r) => r.from === id && r.gate === 'start').map((r) => r.to);
    /** A scope cut along the proposal's workstreams, as a person or agent would make it: each part independent unless it names needs. */
    const cutAlongProposal = async (glob: Glob, withNeeds = false): Promise<Glob[]> => {
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      const parts = (check?.proposal?.workstreams ?? []).map((w, index) => ({
        title: w.name,
        plan: w.plan,
        ...(withNeeds && index > 0 && w.needs.length > 0 ? { after: [...w.needs] } : {}),
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

    it('drops a proposal whose workstreams wait on each other in one line, and does not flag the glob', async () => {
      proposed = [
        { name: 'A', goal: 'a', files: [], plan: '## Tasks\n1. a', needs: [] },
        { name: 'B', goal: 'b', files: [], plan: '## Tasks\n2. b', needs: [0] },
        { name: 'C', goal: 'c', files: [], plan: '## Tasks\n3. c', needs: [1] },
      ];
      const glob = await create('sub', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check).toMatchObject({ flagged: false, proposal: null });
      expect(check?.evidence.join('\n')).toContain('would be a chain of 3');
      expect((await get(glob.id)).status).toBe('implementing');
    });

    it('proposes a shared schema and three consumers as the first workstream plus three that need only it; shared files make no need', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      expect(check?.proposal?.workstreams.map((w) => w.needs)).toEqual([[], [0], [0], [0]]);
      expect(check?.proposal?.workstreams.every((w) => !('type' in w) && !('overlaps' in w))).toBe(true);
    });

    it('a split is a scope cut: independent globs, no gate between them and no sign-off from the original', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const created = await cutAlongProposal(glob);
      expect(created).toHaveLength(4);
      expect(created.map((g) => g.type)).toEqual(['same', 'same', 'same', 'same']);
      for (const part of created) {
        expect(needsOf(part.id)).toEqual([]);
        expect(part).not.toHaveProperty('autoStart');
        expect(part.waiting ?? null).toBeNull();
        expect(part.status).toBe('planning');
      }
      expect([...store.state.relations.values()]).toEqual([]);
      // The original signs off on its own.
      expect((await get(created[0]?.id ?? '')).status).toBe('planning');
    });

    it('a part that names needs has them as ordinary person relations, and nothing starts it by itself', async () => {
      proposed = contractParts;
      const glob = await create('same', BIG);
      const [first, server, web] = await cutAlongProposal(glob, true);
      if (first === undefined || server === undefined || web === undefined) throw new Error('no parts');
      expect(needsOf(server.id)).toEqual([first.id]);
      expect([...store.state.relations.values()].map((r) => [r.gate, r.source])).toEqual([['start', 'person'], ['start', 'person'], ['start', 'person']]);
      expect(web.waiting ?? null).toBeNull();
      unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
      await globs.releaseDependents(first.id, boardId);
      expect((await get(web.id)).status).toBe('planning');
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
    const merge = async (globId: string, patch: Parameters<typeof outcomeOf>[1] = {}, extra: { type: 'RunFailed' | 'GlobSplit' | 'RunTriggered' | 'WorkstreamsRecorded'; at: string; data?: { [key: string]: JsonValue } }[] = []) => {
      await store.transaction(async (tx) => {
        await tx.upsertGlobOutcome(outcomeOf(globId, patch));
        await tx.appendEvents([
          { type: 'PROpened', globId, actor: null, at: '2026-08-31T20:00:00.000Z', data: {} },
          { type: 'Merged', globId, actor: null, at: '2026-09-01T00:00:00.000Z', data: {} },
          ...extra.map((e) => ({ type: e.type, globId, actor: null, at: e.at, data: e.data ?? {} })),
        ]);
      });
    };
    const threshold = () => store.transaction((tx) => tx.getSizeThreshold(boardId));

    it('raises when a flagged glob merged cleanly, once', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id);
      const first = await service.learn(boardId);
      expect(first.changes).toMatchObject([{ globId: glob.id, outcome: 'kept_whole_clean', from: { maxTasks: 5, maxParts: 3, minParallel: 2 }, to: { maxTasks: 6, maxParts: 4, minParallel: 2 } }]);
      expect(await threshold()).toEqual({ maxTasks: 6, maxParts: 4, minParallel: 2 });
      expect((await service.learn(boardId)).changes).toEqual([]);
      const view = unwrap(await service.view(DEV, boardId));
      expect(view.history).toHaveLength(1);
      expect(view.history[0]?.evidence).toContain('merged cleanly');
    });

    it('lowers when an unflagged glob hit max review rounds; a split after it started no longer counts', async () => {
      const a = await create('same', SMALL);
      const b = await create('same', SMALL);
      await merge(a.id, { rounds: 3 });
      await merge(b.id, {}, [
        { type: 'RunTriggered', at: '2026-08-31T10:00:00.000Z' },
        { type: 'GlobSplit', at: '2026-08-31T12:00:00.000Z' },
      ]);
      const result = await service.learn(boardId);
      expect(result.changes.map((c) => [c.globId, c.outcome])).toEqual([[a.id, 'unflagged_struggled']]);
      expect(await threshold()).toEqual({ maxTasks: 4, maxParts: 2, minParallel: 2 });
    });

    it('leaves the threshold when a flagged glob merged and was not clean', async () => {
      const messy = await create('same', BIG);
      await merge(messy.id, { fixGlobs: ['s1b9'] });
      const result = await service.learn(boardId);
      expect(result.changes.map((c) => c.outcome)).toEqual(['flag_confirmed']);
      expect(await threshold()).toEqual(DEFAULT_SIZE_THRESHOLD);
    });

    const recorded = (patch: { state?: string; attempts?: number; conflicts?: string[] } = {}) => ({
      type: 'WorkstreamsRecorded' as const,
      at: '2026-08-31T22:00:00.000Z',
      data: {
        fannedOut: true,
        maxParallel: 2,
        workstreams: ['a', 'b'].map((name, i) => ({
          name,
          goal: 'g',
          predictedFiles: [],
          actualFiles: [],
          needs: [],
          state: i === 1 ? (patch.state ?? 'done') : 'done',
          attempts: i === 1 ? (patch.attempts ?? 1) : 1,
          conflicts: i === 1 ? (patch.conflicts ?? []) : [],
          durationMinutes: 5,
        })),
        version: 2,
        commitSha: null,
        runId: null,
      },
    });

    it('lowers the fan-out floor when a glob fanned out and merged cleanly, with evidence, once', async () => {
      await store.transaction((tx) => tx.setSizeThreshold(boardId, DEFAULT_SIZE_THRESHOLD, { ...DEFAULT_SIZE_THRESHOLD, minParallel: 3 }));
      const glob = await create('same', BIG);
      await merge(glob.id, {}, [recorded()]);
      const result = await service.learn(boardId);
      expect(result.changes).toMatchObject([{ globId: glob.id, outcome: 'fanout_helped', from: { minParallel: 3 }, to: { minParallel: 2, maxTasks: 5, maxParts: 3 } }]);
      expect(await threshold()).toEqual(DEFAULT_SIZE_THRESHOLD);
      expect((await service.learn(boardId)).changes).toEqual([]);
      expect(unwrap(await service.view(DEV, boardId)).history[0]?.evidence).toContain('2 workstreams, up to 2 at the same time');
    });

    it('raises the fan-out floor when a workstream conflicted, failed or was retried', async () => {
      const a = await create('same', BIG);
      await merge(a.id, {}, [recorded({ conflicts: ['x.ts'] })]);
      const result = await service.learn(boardId);
      expect(result.changes.map((c) => c.outcome)).toEqual(['fanout_stalled']);
      expect(await threshold()).toEqual({ ...DEFAULT_SIZE_THRESHOLD, minParallel: 3 });
      expect(unwrap(await service.view(DEV, boardId)).history[0]?.evidence).toContain('conflicted on integration (b)');
      const b = await create('same', BIG);
      await merge(b.id, {}, [recorded({ state: 'failed' })]);
      expect((await service.learn(boardId)).changes.map((c) => c.outcome)).toEqual(['fanout_stalled']);
      expect((await threshold()).minParallel).toBe(4);
    });

    it('reads the latest workstreams block of the glob', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id, {}, [recorded({ state: 'failed' }), { ...recorded(), at: '2026-08-31T23:00:00.000Z' }]);
      expect((await service.learn(boardId)).changes.map((c) => c.outcome)).toEqual(['fanout_helped']);
    });

    it('records no split outcome any more: a split original is judged like any flagged glob, and old split outcomes stay readable', async () => {
      const glob = await create('same', BIG);
      const check = await store.transaction((tx) => tx.getSizeCheck(glob.id));
      const parts = (check?.proposal?.workstreams ?? []).map((w) => ({ title: w.name, plan: w.plan }));
      unwrap(await globs.split(DEV, glob.id, glob.version, { parts, idempotencyKey: null }));
      // Only the original has merged; its parts are not waited for.
      await merge(glob.id, {}, [{ type: 'GlobSplit', at: '2026-08-30T00:00:00.000Z' }]);
      expect((await service.learn(boardId)).changes.map((c) => c.outcome)).toEqual(['kept_whole_clean']);
      await store.transaction((tx) =>
        tx.insertSizeThresholdChange({ boardId, at: NOW, from: DEFAULT_SIZE_THRESHOLD, to: { maxTasks: 6, maxParts: 4, minParallel: 2 }, outcome: 'split_stalled', globId: 's1f99', evidence: 'Split into 3 parts' }),
      );
      expect(unwrap(await service.view(DEV, boardId)).history.map((h) => h.outcome)).toEqual(expect.arrayContaining(['split_stalled', 'kept_whole_clean']));
    });

    it('shows the learned threshold beside the default, and an admin resets it', async () => {
      const glob = await create('same', BIG);
      await merge(glob.id);
      await service.learn(boardId);
      const view = unwrap(await service.view(DEV, boardId));
      expect(view).toMatchObject({ current: { maxTasks: 6, maxParts: 4, minParallel: 2 }, defaults: DEFAULT_SIZE_THRESHOLD });
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
