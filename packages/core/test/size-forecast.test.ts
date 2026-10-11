import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService, FORECAST_NOTE } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import type { CodeView } from '../src/app/code-view.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SizeCheckService } from '../src/app/size-check-service.js';
import type { CodeTouchedModule } from '../src/domain/code-view.js';
import type { Result } from '../src/domain/errors.js';
import type { GlobOutcome } from '../src/domain/intake-learning.js';
import { DEFAULT_SIZE_THRESHOLD, estimateFromText, oversizedReasons } from '../src/domain/size-check.js';
import {
  DEFAULT_SIZE_CALIBRATION,
  FOOTPRINT_MAX_CALLS,
  footprintOf,
  forecastFrom,
  forecastReasons,
  forecastShape,
  parseFilesLine,
  proposalFromForecast,
} from '../src/domain/size-forecast.js';
import type { SizeForecast } from '../src/domain/size-forecast.js';
import type { Glob } from '../src/domain/types.js';
import type { Embedder } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-09T12:00:00.000Z';

const checklist = (n: number): string =>
  `# Tidy the size card\n\nA long enough description of work that stays inside one module of the server, so the plan is worth a forecast.\n\n## Tasks\n${Array.from({ length: n }, (_, i) => `- [ ] Step ${String(i + 1)}: change the server behaviour`).join('\n')}\n`;
const THREE = `# Add a badge everywhere

A short plan that touches a few places: the server answers it, the web card shows it, and the pipeline needs a variable. Written to be long enough for a forecast.

## Tasks
- [ ] Server: answer the new field in apps/server/src/http/app.ts
- [ ] Web: show it in apps/web/src/card.tsx
- [ ] Infra: add the variable in infra/stack.ts
`;

type Step = { action: 'tree'; path: string } | { action: 'grep'; pattern: string } | { action: 'done'; files: string[] };

describe('size forecast', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let base: SizeCheckService;
  let forecaster: SizeCheckService;
  let viewCalls: string[];
  let script: Step[];
  let turns: number;
  let llmDown: boolean;
  let viewDown: boolean;
  let touched: CodeTouchedModule[];
  /** What the text judge answers; by default one part. */
  let judged: string;
  const MANY = '{"independentParts": 5, "parallelParts": 2, "reason": "many"}';

  const llm: Llm = {
    complete: (request: LlmRequest) => {
      if (llmDown) return Promise.reject(new LlmUnavailable('down', 'wait'));
      if (request.system.startsWith('You predict')) {
        const step = script[Math.min(turns++, script.length - 1)];
        return Promise.resolve(JSON.stringify(step));
      }
      return Promise.resolve(request.system.startsWith('You judge') ? judged : 'no json');
    },
  };
  const unsupported = (): never => {
    throw new Error('not used');
  };
  const codeView: CodeView = {
    tree: (_b, ref, path) => {
      viewCalls.push(`tree:${String(ref)}:${path}`);
      return viewDown ? Promise.reject(new Error('git failed')) : Promise.resolve([{ name: 'src', path: 'src', type: 'dir', size: null }]);
    },
    read: unsupported,
    grep: (_b, ref, pattern) => {
      viewCalls.push(`grep:${String(ref)}:${pattern}`);
      return Promise.resolve({ hits: [{ path: 'apps/server/src/a.ts', line: 3, text: 'x' }], truncated: false });
    },
    history: unsupported,
    imports: unsupported,
    importedBy: unsupported,
    touchedModules: () => {
      viewCalls.push('touchedModules');
      return viewDown ? Promise.reject(new Error('git failed')) : Promise.resolve(touched);
    },
  };
  const embedder: Embedder = { model: 'fake', dimensions: 1024, embed: (texts) => Promise.resolve(texts.map(() => [1, 0])) };

  const create = async (plan: string): Promise<Glob> =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'T',
        summary: 's',
        type: 'same',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan,
      }),
    );
  const check = (id: string) => store.transaction((tx) => tx.getSizeCheck(id));
  /** The model looks in each file's directory first (a path the looks cannot place does not count), then answers. */
  const done = (...files: string[]): Step[] => [
    ...[...new Set(files.map((f) => f.slice(0, Math.max(0, f.lastIndexOf('/')))))].slice(0, 4).map((path): Step => ({ action: 'tree', path })),
    { action: 'done', files },
  ];

  const seedChange = async (globId: string, files: string, title = `Change ${globId}`): Promise<void> => {
    await store.transaction(async (tx) => {
      await tx.replaceItem(
        {
          boardId,
          sourceType: 'change_summary',
          externalRef: `change:${globId}`,
          title,
          occurredAt: '2026-09-01T00:00:00.000Z',
          authority: 'merged_code',
          status: 'active',
          supersededBy: null,
          globIds: [globId],
          globGroup: null,
          externalUrl: null,
          contentHash: globId,
          state: 'ready',
        },
        [{ position: 0, header: `[${title}]`, text: `${files}\n\nSummary of the change.` }],
      );
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: [1, 0] })));
    });
  };

  const outcomeOf = (globId: string, lines: number | null, patch: { rounds?: number; fixGlobs?: string[] } = {}): GlobOutcome => ({
    globId,
    snapshotVersion: 1,
    boardId,
    mergedAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-20T00:00:00.000Z',
    final: true,
    corrections: { category: null, type: null, subConverted: null, split: false },
    size: { changedLines: lines },
    review: { rounds: patch.rounds ?? 1, maxRounds: 3, testFailRounds: 0, findingsBySeverity: {}, findingsByClass: {} },
    tests: { ciFailures: 0 },
    effort: { calendarHours: 5 },
    postMerge: { fixGlobs: patch.fixGlobs ?? [] },
  });
  const merge = (globId: string, lines: number | null, patch: { rounds?: number; fixGlobs?: string[] } = {}, extra: 'RunFailed'[] = []) =>
    store.transaction(async (tx) => {
      await tx.upsertGlobOutcome(outcomeOf(globId, lines, patch));
      await tx.appendEvents([
        { type: 'PROpened', globId, actor: null, at: '2026-08-31T20:00:00.000Z', data: {} },
        { type: 'Merged', globId, actor: null, at: '2026-09-01T00:00:00.000Z', data: {} },
        ...extra.map((type) => ({ type, globId, actor: null, at: '2026-08-31T22:00:00.000Z', data: {} })),
      ]);
    });
  const withForecast = async (globId: string, forecast: SizeForecast): Promise<void> => {
    const current = await check(globId);
    if (current === null) throw new Error('no check');
    await store.transaction((tx) => tx.upsertSizeCheck({ ...current, estimate: { ...current.estimate, forecast } }));
  };
  const investigationOf = (files: string[]): string =>
    `Findings.\n\n\`\`\`investigation\n${JSON.stringify({
      files: files.map((path) => ({ path, change: 'modify' })),
      modules: ['apps/web'],
      expectedLines: { min: 10, max: 40 },
      parts: [],
      riskTier: 'low',
      riskAreas: [],
      needsHuman: { needed: false, reason: null },
      confidence: 'medium',
      planHash: 'h',
      baseCommit: 'c',
    })}\n\`\`\`\n`;
  const addInvestigation = (globId: string, files: string[]) =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind: 'investigation',
        label: '',
        content: investigationOf(files),
        link: null,
        commitSha: null,
        provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: NOW,
      }),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    viewCalls = [];
    script = done('apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/c.ts', 'apps/server/src/d.ts');
    turns = 0;
    llmDown = false;
    viewDown = false;
    touched = [];
    judged = '{"independentParts": 1, "reason": "one"}';
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    // Glob creation uses a service with no code view, so the background refresh never races the explicit forecast.
    base = new SizeCheckService({ store, clock, notifier, llm });
    forecaster = new SizeCheckService({ store, clock, notifier, llm, codeView, embedder });
    let runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) }, sizeCheck: base });
    artifacts = new ArtifactService({ store, clock, notifier, sizeCheck: base });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  describe('code footprint', () => {
    it('predicts files that overlap what a past merged glob changed', async () => {
      const actual = ['apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/c.ts', 'apps/server/src/e.ts'];
      await seedChange('s1f1', `Files: ${actual.join(', ')}`);
      script = [{ action: 'tree', path: '' }, { action: 'grep', pattern: 'badge' }, ...done(...actual.slice(0, 3), 'apps/server/src/d.ts')];
      const footprint = await forecaster.footprint(boardId, THREE);
      const changed = await store.transaction((tx) => tx.changeCandidates({ boardId, query: '', mode: 'all_time', globId: 's1f1' }, 3));
      const real = parseFilesLine(changed[0]?.text ?? '')?.paths ?? [];
      const hit = (footprint?.files ?? []).filter((f) => real.includes(f)).length;
      expect(hit / real.length).toBeGreaterThanOrEqual(0.75);
      expect(footprint?.modules).toEqual(['apps/server']);
      // The model's looks go through the base branch (ref null).
      expect(viewCalls.slice(0, 2)).toEqual(['tree:null:', 'grep:null:badge']);
    });

    it('stays within the call cap, however long the model keeps looking', async () => {
      script = [{ action: 'tree', path: '' }];
      expect(await forecaster.footprint(boardId, THREE)).toBeNull();
      expect(viewCalls.length).toBeLessThanOrEqual(FOOTPRINT_MAX_CALLS);
      viewCalls = [];
      turns = 0;
      script = [{ action: 'tree', path: '' }, { action: 'tree', path: 'a' }, { action: 'tree', path: 'b' }, { action: 'tree', path: 'c' }, { action: 'tree', path: 'apps/web/src' }, ...done('apps/web/src/x.ts').slice(1)];
      const footprint = await forecaster.footprint(boardId, THREE);
      expect(viewCalls.length).toBeLessThanOrEqual(FOOTPRINT_MAX_CALLS);
      expect(footprint?.files).toEqual(['apps/web/src/x.ts']);
    });

    it('drops predicted paths the looks cannot place, and gives no footprint when none can be', async () => {
      // The tree of apps/web/src was listed: its new file stands; the invented one in a directory never looked at does not.
      script = [{ action: 'tree', path: 'apps/web/src' }, { action: 'done', files: ['apps/web/src/new.tsx', 'apps/ghost/x.ts'] }];
      expect((await forecaster.footprint(boardId, THREE))?.files).toEqual(['apps/web/src/new.tsx']);
      turns = 0;
      script = [{ action: 'done', files: ['apps/ghost/x.ts', 'apps/ghost/y.ts'] }];
      expect(await forecaster.footprint(boardId, THREE)).toBeNull();
    });

    it('reports migrations, public API paths, risk areas, fan-in and the parts that need others', async () => {
      await store.transaction((tx) =>
        tx.putRiskArea({ boardId, name: 'Public API', pathPatterns: ['apps/server/src/http/**'], why: 'w', source: 'default', strength: 0, cleanCount: 0, updatedAt: NOW }),
      );
      touched = [
        { module: 'apps/server', paths: ['apps/server/drizzle/0042.sql'], importers: [{ path: 'apps/web/src/other.ts', module: 'apps/web' }], fanIn: 3 },
      ];
      script = done('apps/server/drizzle/0042.sql', 'apps/server/src/http/app.ts', 'apps/web/src/card.tsx');
      const footprint = await forecaster.footprint(boardId, THREE);
      expect(footprint).toMatchObject({ touchesMigration: true, touchesPublicApi: true, fanIn: 3, riskAreas: ['Public API'] });
      const forecast = forecastFrom(footprint ?? footprintOf([]), null, estimateFromText(THREE), DEFAULT_SIZE_CALIBRATION);
      expect(forecast.parts.find((p) => p.name === 'apps/web')?.needs).toEqual(['apps/server']);
      expect(forecast.riskTier).toBe('high');
    });
  });

  describe('reference class', () => {
    it('shows the real sizes and outcomes of similar merged globs', async () => {
      // The three merged globs (s1f1 to s1f3) exist on the board, so their events are readable.
      for (let i = 0; i < 3; i++) await create(checklist(1));
      for (const [id, files, lines] of [['s1f1', 'Files: a.ts, b.ts', 80], ['s1f2', 'Files: a.ts, b.ts, c.ts, +3 more', 300], ['s1f3', 'Files: c.ts', 20]] as const) {
        await seedChange(id, files);
        await merge(id, lines, id === 's1f2' ? { fixGlobs: ['s1b1'] } : {}, id === 's1f2' ? ['RunFailed'] : []);
      }
      const reference = await forecaster.referenceClass(boardId, THREE);
      expect(reference?.samples.map((s) => s.globId).sort()).toEqual(['s1f1', 's1f2', 's1f3']);
      expect(reference?.samples.find((s) => s.globId === 's1f2')).toMatchObject({ files: 6, lines: 300, reworkRuns: 1, followUpBugs: 1, cleanSub: false });
      // The store reads are bounded by glob ids, so the reference class never needs the board's whole history.
      expect((await store.transaction((tx) => tx.listGlobOutcomes(boardId, ['s1f1']))).map((o) => o.globId)).toEqual(['s1f1']);
      expect(new Set((await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', undefined, ['s1f2']))).map((e) => e.globId))).toEqual(new Set(['s1f2']));
      expect(await store.transaction((tx) => tx.listGlobOutcomes(boardId, []))).toEqual([]);
      expect(reference?.summary).toContain('3 similar merged globs');
      expect(reference?.summary).toContain('median 80 lines');
      // The forecast carries it as evidence.
      const glob = await create(THREE);
      await forecaster.forecast(glob.id);
      const stored = await check(glob.id);
      expect(stored?.estimate.forecast?.reference?.samples).toHaveLength(3);
      expect(stored?.evidence.join('\n')).toContain('History: 3 similar merged globs');
    });
  });

  describe('the combined estimate', () => {
    it('does not flag a ten-checkbox plan that touches one module', async () => {
      judged = MANY;
      const glob = await create(checklist(10));
      // By its text alone it looks oversized.
      expect((await check(glob.id))?.flagged).toBe(true);
      await forecaster.forecast(glob.id);
      const after = await check(glob.id);
      expect(after?.estimate.forecast).toMatchObject({ source: 'code', modules: ['apps/server'] });
      expect(after?.estimate.forecast?.parts).toHaveLength(1);
      expect(after).toMatchObject({ flagged: false, reasons: [], proposal: null });
    });

    it('flags a short plan touching three unrelated modules, with a fan-out proposal from the file sets', async () => {
      const glob = await create(THREE);
      expect((await check(glob.id))?.flagged).toBe(false);
      script = done('apps/server/src/http/app.ts', 'apps/web/src/card.tsx', 'infra/stack.ts');
      await forecaster.forecast(glob.id);
      const after = await check(glob.id);
      expect(after?.flagged).toBe(true);
      expect(after?.reasons.join(' ')).toContain('3 parts in separate modules');
      const parts = after?.proposal?.parts ?? [];
      expect(parts).toHaveLength(3);
      const byTitle = (name: string) => parts.find((p) => p.title.startsWith(name));
      expect(byTitle('apps/server')?.plan).toContain('apps/server/src/http/app.ts');
      expect(byTitle('apps/web')?.plan).toContain('- apps/web/src/card.tsx');
      expect(byTitle('infra')?.plan).toContain('infra/stack.ts');
      // The task lines go to the part whose files they name.
      expect(byTitle('infra')?.plan).toContain('Infra: add the variable');
      expect(parts.every((p, i) => p.after.every((n) => n < i))).toBe(true);
      // Held like any flagged glob, until it is split or kept whole.
      expect(unwrap(await forecaster.keepWhole(DEV, glob.id)).decision).toBe('kept_whole');
    });

    it('makes parts start after the parts they need, and lets two migrations overlap without blocking', () => {
      const forecast = forecastFrom(
        footprintOf(['apps/server/drizzle/1.sql', 'apps/web/a.ts', 'infra/x.ts', 'infra/drizzle/2.sql'], { importers: { 'apps/server': ['apps/web/b.ts'] } }),
        null,
        estimateFromText(THREE),
        DEFAULT_SIZE_CALIBRATION,
      );
      const proposal = proposalFromForecast(THREE, forecast);
      const parts = proposal?.parts ?? [];
      expect(parts.map((p) => p.title.split(' ')[0])).toEqual(['infra', 'apps/server', 'apps/web']);
      expect(parts[2]?.after).toEqual([1]);
      expect(parts[1]?.after).toEqual([]);
      expect(parts[1]?.overlaps).toEqual([0]);
      expect(proposal).toMatchObject({ criticalPath: 2, maxParallel: 2 });
    });

    it('does not flag a core -> server -> web chain, and offers no split for it', () => {
      const chain = forecastFrom(
        footprintOf(['packages/core/a.ts', 'apps/server/b.ts', 'apps/web/c.ts'], {
          importers: { 'packages/core': ['apps/server/x.ts'], 'apps/server': ['apps/web/y.ts'] },
        }),
        null,
        estimateFromText(THREE),
        DEFAULT_SIZE_CALIBRATION,
      );
      expect(forecastShape(chain)).toEqual({ criticalPath: 3, maxParallel: 1 });
      expect(forecastReasons(chain, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
      expect(oversizedReasons({ ...estimateFromText(THREE), forecast: chain }, { maxTasks: 2, maxParts: 2 })).toEqual([]);
      expect(proposalFromForecast(THREE, chain)).toBeNull();
    });

    it('flags three unrelated modules at the default, with a fan-out proposal from their file sets', () => {
      const unrelated = forecastFrom(footprintOf(['apps/server/a.ts', 'apps/web/b.ts', 'infra/c.ts']), null, estimateFromText(THREE), DEFAULT_SIZE_CALIBRATION);
      expect(forecastShape(unrelated)).toEqual({ criticalPath: 1, maxParallel: 3 });
      expect(forecastReasons(unrelated, DEFAULT_SIZE_THRESHOLD)).toEqual([
        expect.stringContaining('3 parts in separate modules'),
        '3 parts could be built at the same time',
      ]);
      expect(proposalFromForecast(THREE, unrelated)).toMatchObject({ criticalPath: 1, maxParallel: 3 });
    });

    it('flags two modules only when they are many for the board, never at the learned floor of 2', () => {
      const two = forecastFrom(footprintOf(['apps/server/a.ts', 'apps/web/b.ts']), null, estimateFromText(THREE), DEFAULT_SIZE_CALIBRATION);
      expect(forecastReasons(two, { maxTasks: 5, maxParts: 2 })).toEqual([]);
      expect(forecastReasons(two, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
    });

    it('uses the board threshold: a learned higher part limit stops the flag', () => {
      const forecast = forecastFrom(footprintOf(['apps/server/a.ts', 'apps/web/b.ts', 'infra/c.ts']), null, estimateFromText(THREE), DEFAULT_SIZE_CALIBRATION);
      const estimate = { ...estimateFromText(THREE), forecast };
      expect(oversizedReasons(estimate, DEFAULT_SIZE_THRESHOLD)).toHaveLength(2);
      expect(oversizedReasons(estimate, { maxTasks: 6, maxParts: 4 })).toEqual([]);
    });

    it('hands the forecast to the investigator through get_context', async () => {
      const glob = await create(THREE);
      expect(unwrap(await artifacts.context(DEV, glob.id)).size?.forecast).toBeUndefined();
      script = done('apps/server/src/http/app.ts', 'apps/web/src/card.tsx', 'infra/stack.ts');
      await forecaster.forecast(glob.id);
      const size = unwrap(await artifacts.context(DEV, glob.id)).size;
      expect(size?.forecast).toMatchObject({ note: FORECAST_NOTE, files: ['apps/server/src/http/app.ts', 'apps/web/src/card.tsx', 'infra/stack.ts'] });
      expect(size?.forecast?.parts.map((p) => p.name)).toEqual(expect.arrayContaining(['apps/server', 'apps/web', 'infra']));
      expect(size?.oversized).toBe(true);
    });

    it('is made by refresh for a glob whose forecast is missing, and again for a changed plan', async () => {
      const glob = await create(checklist(2));
      await forecaster.refresh(glob.id);
      expect((await check(glob.id))?.estimate.forecast).toBeDefined();
      const before = viewCalls.length;
      await forecaster.refresh(glob.id);
      expect(viewCalls.length).toBe(before);
      unwrap(await artifacts.putPlan(DEV, glob.id, THREE));
      script = done('apps/web/src/card.tsx');
      turns = 0;
      await forecaster.refresh(glob.id);
      expect((await check(glob.id))?.estimate.forecast?.files.paths).toEqual(['apps/web/src/card.tsx']);
    });
  });

  describe('the background forecast of a created glob and the hold', () => {
    const createSub = async (plan: string): Promise<Glob> =>
      unwrap(
        await globs.create(DEV, { boardId, title: 'T', summary: 's', type: 'sub', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan }),
      );
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('creating a glob neither waits for a slow size refresh nor fails when it rejects', async () => {
      const logged: string[] = [];
      let refreshes = 0;
      const sizeCheck = { assess: base.assess.bind(base), refresh: () => (++refreshes, new Promise<void>(() => undefined)) };
      const slow = new GlobService({ store, notifier: new RecordingNotifier(), clock: { now: () => NOW }, ids: { runId: () => 'run-x' }, routines: { hasRoutine: () => Promise.resolve(true) }, sizeCheck, log: (_t, m) => void logged.push(m) });
      const created = unwrap(
        await slow.create(DEV, { boardId, title: 'T', summary: 's', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: checklist(2) }),
      );
      expect(created.status).toBe('planning');
      expect(refreshes).toBe(1);

      const failing = new GlobService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => NOW },
        ids: { runId: () => 'run-y' },
        routines: { hasRoutine: () => Promise.resolve(true) },
        sizeCheck: { assess: base.assess.bind(base), refresh: () => Promise.reject(new Error('model exploded')) },
        log: (_t, m) => void logged.push(m),
      });
      const again = unwrap(
        await failing.create(DEV, { boardId, title: 'T2', summary: 's', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: checklist(2) }),
      );
      expect(again.status).toBe('planning');
      await settle();
      expect(logged).toEqual(['model exploded']);
      // A refresh that throws synchronously is contained too.
      const throwing = new GlobService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => NOW },
        ids: { runId: () => 'run-z' },
        routines: { hasRoutine: () => Promise.resolve(true) },
        sizeCheck: {
          assess: base.assess.bind(base),
          refresh: () => {
            throw new Error('sync boom');
          },
        },
        log: (_t, m) => void logged.push(m),
      });
      unwrap(await throwing.create(DEV, { boardId, title: 'T3', summary: 's', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: checklist(2) }));
      await settle();
      expect(logged).toEqual(['model exploded', 'sync boom']);
    });

    it('calls onRechecked once when the forecast changes the flag, and not when nothing was written', async () => {
      const rechecked: string[] = [];
      const hooked = new SizeCheckService({ store, clock: { now: () => NOW }, notifier: new RecordingNotifier(), llm, codeView, embedder, onRechecked: (id) => (rechecked.push(id), Promise.resolve()) });
      const glob = await create(THREE);
      expect((await check(glob.id))?.flagged).toBe(false);
      script = done('apps/server/src/http/app.ts', 'apps/web/src/card.tsx', 'infra/stack.ts');
      await hooked.forecast(glob.id);
      expect((await check(glob.id))?.flagged).toBe(true);
      expect(rechecked).toEqual([glob.id]);
      // The model failing writes nothing: no hook.
      llmDown = true;
      const other = await create(THREE);
      await hooked.forecast(other.id);
      llmDown = false;
      expect(rechecked).toEqual([glob.id]);
    });

    it('lifts the hold of a text-flagged sub once the forecast clears the flag', async () => {
      judged = MANY;
      const released = new SizeCheckService({ store, clock: { now: () => NOW }, notifier: new RecordingNotifier(), llm, codeView, embedder, onRechecked: (id) => globs.reconcileSizeHold(id) });
      const sub = await createSub(checklist(10));
      expect(sub.status).toBe('planning');
      expect(sub.waiting).not.toBeNull();
      expect((await check(sub.id))?.flagged).toBe(true);
      await released.forecast(sub.id);
      expect((await check(sub.id))?.flagged).toBe(false);
      expect(unwrap(await globs.get(DEV, sub.id)).glob.status).toBe('implementing');
    });

    it('runs one forecast per glob at a time, with one more pass for a call that arrived meanwhile', async () => {
      const glob = await create(THREE);
      const files = ['apps/server/src/http/app.ts', 'apps/web/src/card.tsx', 'infra/stack.ts'];
      script = [...done(...files), ...done(...files)];
      const first = forecaster.forecast(glob.id);
      const second = forecaster.forecast(glob.id);
      await Promise.all([first, second]);
      // Two passes in sequence (never two loops at once): each makes its tree looks and the module read.
      expect(viewCalls.filter((c) => c === 'touchedModules')).toHaveLength(2);
      expect((await check(glob.id))?.estimate.forecast).toBeDefined();
    });
  });

  describe('fallback to the text estimate', () => {
    it('leaves the text estimate when there is no code view, or the model or view fails', async () => {
      const glob = await create(checklist(10));
      const text = await check(glob.id);
      await base.forecast(glob.id);
      llmDown = true;
      await forecaster.forecast(glob.id);
      llmDown = false;
      viewDown = true;
      script = [{ action: 'tree', path: '' }, ...done()];
      await forecaster.forecast(glob.id);
      viewDown = false;
      script = [{ action: 'grep', pattern: '-bad' }];
      await forecaster.forecast(glob.id);
      expect(await check(glob.id)).toEqual(text);
      expect(text?.estimate.forecast).toBeUndefined();
    });

    it('never makes a forecast for a glob that has started, or for a missing one', async () => {
      const glob = await create(checklist(2));
      unwrap(await globs.start(DEV, glob.id, glob.version));
      await forecaster.forecast(glob.id);
      await forecaster.forecast('s9f9');
      expect((await check(glob.id))?.estimate.forecast).toBeUndefined();
    });
  });

  describe('three-point recording and calibration', () => {
    const webForecast = (calibration = DEFAULT_SIZE_CALIBRATION): SizeForecast =>
      forecastFrom(footprintOf(['apps/web/src/a.tsx', 'apps/web/src/b.tsx']), null, estimateFromText(checklist(2)), calibration);
    const mergeWith = async (forecast: SizeForecast, lines: number, extra: { files?: string[]; investigation?: string[] } = {}): Promise<Glob> => {
      const glob = await create(checklist(2));
      await withForecast(glob.id, forecast);
      if (extra.files !== undefined) await seedChange(glob.id, `Files: ${extra.files.join(', ')}`);
      if (extra.investigation !== undefined) await addInvestigation(glob.id, extra.investigation);
      await merge(glob.id, lines);
      return glob;
    };
    const calibration = () => store.transaction((tx) => tx.getSizeCalibration(boardId));

    it('records the three points once per merged glob', async () => {
      const glob = await mergeWith(webForecast(), 400, { files: ['apps/web/src/a.tsx', 'apps/web/src/z.tsx'], investigation: ['apps/web/src/a.tsx', 'apps/web/src/b.tsx', 'apps/web/src/c.tsx'] });
      await store.transaction((tx) => tx.appendEvents([{ type: 'Escalated', globId: glob.id, actor: null, at: '2026-08-31T21:00:00.000Z', data: {} }]));
      const first = await base.learn(boardId);
      expect(first.calibration?.records).toBe(1);
      const record = await store.transaction((tx) => tx.getSizeRecord(glob.id));
      expect(record?.estimate.files.paths).toHaveLength(2);
      expect(record?.investigation?.files).toHaveLength(3);
      expect(record?.actual).toMatchObject({ lines: 400, files: 2, rounds: 1, reworkRuns: 0, escalated: true, followUpBugs: 0, hoursOpen: 4 });
      expect((await base.learn(boardId)).calibration).toBeUndefined();
      expect(await store.transaction((tx) => tx.listSizeRecords(boardId))).toHaveLength(1);
    });

    it('raises the web correction after web work ran over, and the next web estimate reflects it', async () => {
      const before = webForecast();
      for (let i = 0; i < 3; i++) await mergeWith(webForecast(await calibration()), Math.round(before.lines.max * 3));
      const result = await base.learn(boardId);
      expect(result.calibration?.records).toBe(3);
      const after = await calibration();
      expect(after.areaFactors.web).toBeGreaterThan(1.3);
      expect(after.samples).toBe(3);
      const history = unwrap(await base.calibrationView(DEV, boardId)).history;
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]).toMatchObject({ kind: 'area_factor', area: 'web' });
      expect(history[0]?.cause).toContain('web');
      expect(history[0]?.cause).toContain('lines');
      const next = webForecast(after);
      expect(next.lines.max).toBeGreaterThan(before.lines.max);
      expect(next.calibrated.scale).toBe(after.areaFactors.web);
      expect(next.files.count).toBeGreaterThanOrEqual(before.files.count);
      // The glob the forecaster writes next uses it.
      const glob = await create(THREE);
      script = done('apps/web/src/a.tsx', 'apps/web/src/b.tsx');
      await forecaster.forecast(glob.id);
      expect((await check(glob.id))?.estimate.forecast?.calibrated.scale).toBe(after.areaFactors.web);
    });

    it('leaves other areas alone, and a correct estimate does not move a factor', async () => {
      const serverForecast = forecastFrom(footprintOf(['apps/server/src/a.ts']), null, estimateFromText(checklist(2)), DEFAULT_SIZE_CALIBRATION);
      const exact = Math.round((serverForecast.lines.min + serverForecast.lines.max) / 2);
      await mergeWith(serverForecast, exact);
      await base.learn(boardId);
      expect((await calibration()).areaFactors).toEqual({});
    });

    it('shifts the weights when the investigator keeps correcting the same signals', async () => {
      // The text signal over-counts files (10 tasks), the code signal is right.
      const textHeavy = (): SizeForecast =>
        forecastFrom(footprintOf(['apps/web/src/a.tsx', 'apps/web/src/b.tsx']), null, estimateFromText(checklist(10)), DEFAULT_SIZE_CALIBRATION);
      const exact = Math.round((textHeavy().lines.min + textHeavy().lines.max) / 2);
      for (let i = 0; i < 2; i++) await mergeWith(textHeavy(), exact, { investigation: ['apps/web/src/a.tsx', 'apps/web/src/b.tsx'] });
      expect((await base.learn(boardId)).calibration?.records).toBe(2);
      const weights = (await calibration()).weights;
      expect(weights.code).toBeGreaterThan(DEFAULT_SIZE_CALIBRATION.weights.code);
      expect(weights.text).toBeLessThan(DEFAULT_SIZE_CALIBRATION.weights.text);
      expect(weights.code + weights.reference + weights.text).toBeCloseTo(1, 5);
      const moves = unwrap(await base.calibrationView(DEV, boardId)).history.filter((c) => c.kind === 'weights');
      expect(moves.length).toBeGreaterThanOrEqual(1);
      expect(moves[0]?.cause).toContain('investigation');
      expect(moves[0]?.cause).toContain('weight moves from text to code');
      // Future forecasts blend with the new weights.
      const next = forecastFrom(footprintOf(['apps/web/src/a.tsx']), null, estimateFromText(checklist(10)), await calibration());
      expect(next.weights).toEqual(weights);
    });

    it('is idempotent per glob and cause, and leaves the threshold learning working', async () => {
      judged = MANY;
      const glob = await create(checklist(10));
      await withForecast(glob.id, webForecast());
      await merge(glob.id, 500);
      const first = await base.learn(boardId);
      expect(first.changes.map((c) => c.outcome)).toEqual(['kept_whole_clean']);
      expect(first.threshold).toEqual({ maxTasks: 6, maxParts: 4 });
      const history = await store.transaction((tx) => tx.listSizeCalibrationChanges(boardId));
      const [existing] = history;
      if (existing === undefined) throw new Error('expected a calibration change');
      expect(await store.transaction((tx) => tx.insertSizeCalibrationChange({ ...existing, at: NOW }))).toBe(false);
      const second = await base.learn(boardId);
      expect(second.changes).toEqual([]);
      expect(await store.transaction((tx) => tx.listSizeCalibrationChanges(boardId))).toHaveLength(history.length);
    });
  });
});
