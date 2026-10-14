import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { IntakeLearningService } from '../src/app/intake-learning-service.js';
import { RiskAreaService } from '../src/app/risk-area-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent, DomainEventType, JsonValue } from '../src/domain/events.js';
import {
  CLEAN_TO_REMOVE,
  CORRECTION_WEIGHT,
  DEFAULT_RISK_AREAS,
  applyOutcome,
  defaultAreas,
  isNarrowPattern,
  matchRiskAreas,
  pathsMatchArea,
  splitEvidence,
  subSafe,
} from '../src/domain/risk-area.js';
import type { RiskArea, RiskOutcome } from '../src/domain/risk-area.js';
import type { ChangeSource } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const DAY = 24 * 60 * 60 * 1000;
const MERGED = '2026-09-01T12:00:00.000Z';
const NOW = '2026-10-11T12:00:00.000Z';
const FILES = ['apps/billing/src/payments/charge.ts', 'apps/billing/src/payments/refund.ts'];

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected a value');
  return value;
};

const LEARNED = 'Learned: apps/billing/src/payments';

const outcome = (kind: RiskOutcome['kind'], paths: readonly string[] = FILES, globId = 's1t1'): RiskOutcome => ({ kind, globId, paths, at: NOW });

type Applied = ReturnType<typeof applyOutcome>;
const history = (...applied: Applied[]) => applied.flatMap((a) => a.changes);

describe('risk areas (pure)', () => {
  const defaults = defaultAreas(1, NOW);
  /** The learned payments area, once two separate globs reverted. */
  const learnedArea = (): RiskArea[] => {
    const first = applyOutcome(1, defaults, outcome('reverted'));
    return [...applyOutcome(1, defaults, outcome('reverted', FILES, 's1t0'), history(first)).put];
  };

  it('ships generic defaults for the five risk areas, matched against paths', () => {
    expect(DEFAULT_RISK_AREAS.map((a) => a.name)).toEqual([
      'Auth and security',
      'Migrations that rewrite existing data',
      'Agent instructions',
      'Infrastructure and production',
      'Public API or cross-board contracts',
    ]);
    const byName = (name: string) => must(defaults.find((a) => a.name === name));
    expect(pathsMatchArea(byName('Migrations that rewrite existing data'), ['apps/server/drizzle/0038_rewrite_x.sql'])).toBe(true);
    // An additive migration is not a risk area.
    expect(pathsMatchArea(byName('Migrations that rewrite existing data'), ['apps/server/drizzle/0038_add_column.sql'])).toBe(false);
    expect(pathsMatchArea(byName('Agent instructions'), ['.claude/agents/implementer.md'])).toBe(true);
    expect(pathsMatchArea(byName('Auth and security'), ['apps/web/src/pages/board.tsx'])).toBe(false);
  });

  it('waits for a second glob before adding a learned area, then strengthens it the next time', () => {
    const first = applyOutcome(1, defaults, outcome('reverted'));
    expect(first.put).toEqual([]);
    expect(first.changes).toEqual([expect.objectContaining({ kind: 'candidate', areaName: LEARNED, cause: 'reverted', globId: 's1t1' })]);
    const second = applyOutcome(1, defaults, outcome('bug', FILES, 's1t2'), history(first));
    expect(second.put).toEqual([expect.objectContaining({ name: LEARNED, pathPatterns: ['apps/billing/src/payments/**'], source: 'learned', strength: 2 })]);
    expect(second.changes).toEqual([expect.objectContaining({ kind: 'added', cause: 'bug', globId: 's1t2' })]);
    // The same glob again (another cause) is not a second glob.
    expect(applyOutcome(1, defaults, outcome('deploy_failed'), history(first)).put).toEqual([]);
    const third = applyOutcome(1, [...defaults, ...second.put], outcome('reverted', FILES, 's1t3'), history(first, second));
    expect(third.put).toEqual([expect.objectContaining({ name: LEARNED, strength: 3, cleanCount: 0 })]);
    expect(third.changes).toEqual([expect.objectContaining({ kind: 'strengthened', cause: 'reverted' })]);
  });

  it('never learns a package or app root from files that are spread over it', () => {
    const a = outcome('reverted', ['apps/web/src/a.tsx'], 's1t1');
    const b = outcome('reverted', ['apps/web/src/lib/b.ts'], 's1t2');
    const first = applyOutcome(1, defaults, a);
    const second = applyOutcome(1, defaults, b, history(first));
    const third = applyOutcome(1, defaults, { ...a, globId: 's1t3' }, history(first, second));
    // Each file is its own narrow candidate; the common parent (`apps/web/src`) is never an area.
    const names = [...first.changes, ...second.changes, ...third.changes].map((c) => c.areaName);
    expect(names).not.toContain('Learned: apps/web/src');
    expect(names).toEqual(['Learned: apps/web/src/a.tsx', 'Learned: apps/web/src/lib', 'Learned: apps/web/src/a.tsx']);
    // a.tsx has two separate globs now: a file area.
    expect(third.put).toEqual([expect.objectContaining({ name: 'Learned: apps/web/src/a.tsx', pathPatterns: ['apps/web/src/a.tsx'], source: 'learned' })]);
    // Deep files in one module share the module directory.
    const deep = applyOutcome(1, defaults, outcome('reverted', ['packages/core/src/domain/x.ts', 'packages/core/src/domain/y.ts'], 's1t4'));
    expect(deep.changes).toEqual([expect.objectContaining({ areaName: 'Learned: packages/core/src/domain', kind: 'candidate' })]);
  });

  it('tells narrow patterns from wide ones', () => {
    expect(isNarrowPattern('packages/core/src/domain/**')).toBe(true);
    expect(isNarrowPattern('packages/core/src/domain/merge-policy.ts')).toBe(true);
    expect(isNarrowPattern('apps/web/src/**')).toBe(false);
    expect(isNarrowPattern('packages/core/src/**')).toBe(false);
    expect(isNarrowPattern('apps/*/src/domain/**')).toBe(false);
    expect(isNarrowPattern('**/*.ts')).toBe(false);
  });

  it('strengthens a default area a failed deploy touched, without adding another', () => {
    const applied = applyOutcome(1, defaults, outcome('deploy_failed', ['infra/stack.yaml']));
    expect(applied.put).toEqual([expect.objectContaining({ name: 'Infrastructure and production', source: 'default', strength: 1 })]);
  });

  it('removes a learned area after repeated clean outcomes, and only marks a default sub-safe', () => {
    let areas: RiskArea[] = [...defaults, ...learnedArea()];
    for (let i = 0; i < CLEAN_TO_REMOVE - 1; i++) {
      const applied = applyOutcome(1, areas, outcome('clean', FILES, `s1t${i + 2}`));
      areas = areas.map((a) => applied.put.find((p) => p.name === a.name) ?? a);
    }
    expect(areas.find((a) => a.source === 'learned')?.cleanCount).toBe(CLEAN_TO_REMOVE - 1);
    const last = applyOutcome(1, areas, outcome('clean', FILES, 's1t9'));
    expect(last.removed).toEqual(['Learned: apps/billing/src/payments']);
    expect(last.changes).toEqual([expect.objectContaining({ kind: 'removed', cause: 'clean' })]);

    let migrations = defaults;
    for (let i = 0; i < CLEAN_TO_REMOVE; i++) {
      const applied = applyOutcome(1, migrations, outcome('clean', ['apps/server/drizzle/0038_rewrite_x.sql'], `s1t${i + 2}`));
      expect(applied.removed).toEqual([]);
      migrations = migrations.map((a) => applied.put.find((p) => p.name === a.name) ?? a);
    }
    expect(subSafe(must(migrations.find((a) => a.name === 'Migrations that rewrite existing data')))).toBe(true);
    // A bad outcome in the area undoes it.
    const bad = applyOutcome(1, migrations, outcome('reverted', ['apps/server/drizzle/0039_rewrite_y.sql'], 's1t20'));
    expect(subSafe(must(bad.put[0]))).toBe(false);
  });

  it('weights a person\'s change of type heavily, in both directions', () => {
    const first = applyOutcome(1, defaults, outcome('type_to_same'));
    expect(first.put).toEqual([]);
    const toSame = applyOutcome(1, defaults, outcome('type_to_same', FILES, 's1t5'), history(first));
    expect(toSame.put[0]).toMatchObject({ source: 'learned', strength: CORRECTION_WEIGHT + 1 });
    expect(toSame.changes[0]).toMatchObject({ kind: 'correction', cause: 'type_to_same' });
    // One correction to sub is enough to wear a learned area away.
    const toSub = applyOutcome(1, [...defaults, ...toSame.put], outcome('type_to_sub', FILES, 's1t2'));
    expect(toSub.removed).toEqual(['Learned: apps/billing/src/payments']);
    expect(toSub.changes[0]).toMatchObject({ kind: 'removed', cause: 'type_to_sub' });
  });

  it('records a correction with no known paths, against no area', () => {
    const applied = applyOutcome(1, defaults, outcome('type_to_same', []));
    expect(applied.put).toEqual([]);
    expect(applied.changes).toEqual([expect.objectContaining({ kind: 'correction', areaName: null })]);
  });
});

describe('RiskAreaService', () => {
  let store: MemoryStore;
  let boardId: number;
  let now: string;
  let service: RiskAreaService;
  const changes: ChangeSource = { mergedDiff: () => Promise.resolve({ changedLines: 10, files: FILES }) };

  const event = (type: DomainEventType, globId: string, at: string, data: { readonly [key: string]: JsonValue } = {}): DomainEvent => ({ type, globId, actor: null, at, data });
  const addGlobs = (...globs: ReturnType<typeof glob>[]) => {
    for (const g of globs) store.state.globs.set(g.id, { glob: g, creationKey: null });
  };
  const addEvents = (...events: DomainEvent[]) => {
    store.state.events.push(...events);
  };
  const areas = () => store.transaction((tx) => tx.listRiskAreas(boardId));
  const history = () => store.transaction((tx) => tx.listRiskAreaChanges(boardId));
  const sub = (id: string) => glob({ id, boardId, type: 'sub', status: 'reviewing', createdAt: new Date(Date.parse(MERGED) - DAY).toISOString() });

  beforeEach(async () => {
    store = new MemoryStore();
    now = NOW;
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: ADMIN, active: true });
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
    });
    boardId = unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    await store.transaction((tx) => tx.upsertMember({ boardId, email: DEV, role: 'dev' }));
    service = new RiskAreaService({ store, clock: { now: () => now }, changes });
  });

  it('seeds the defaults on first read, and a reset restores them and drops the learned ones', async () => {
    const view = unwrap(await service.view(DEV, boardId));
    expect(view.areas.map((a) => a.name)).toEqual(DEFAULT_RISK_AREAS.map((a) => a.name));
    expect(view.areas.every((a) => a.source === 'default' && !a.subSafe)).toBe(true);
    await service.record(boardId, outcome('reverted'));
    await service.record(boardId, outcome('reverted', FILES, 's1t2'));
    expect((await areas()).some((a) => a.source === 'learned')).toBe(true);
    // Only admins reset.
    expect((await service.reset(DEV, boardId)).ok).toBe(false);
    const reset = unwrap(await service.reset(ADMIN, boardId));
    expect(reset.areas.every((a) => a.source === 'default' && a.strength === 0)).toBe(true);
    expect(reset.history[0]).toMatchObject({ kind: 'reset', cause: 'reset', globId: null });
    expect(reset.history.some((c) => c.kind === 'added')).toBe(true);
  });

  it('applies an outcome once per glob and kind', async () => {
    expect(await service.record(boardId, outcome('reverted'))).toBe(true);
    expect(await service.record(boardId, outcome('reverted'))).toBe(false);
    // One glob is a candidate only; a second one adds the area.
    expect((await areas()).some((a) => a.source === 'learned')).toBe(false);
    expect(await service.record(boardId, outcome('bug', FILES, 's1t2'))).toBe(true);
    expect((await areas()).find((a) => a.source === 'learned')?.strength).toBe(2);
  });

  it('learns from a revert: the reverted sub\'s merge files get a learned area', async () => {
    addGlobs(sub('s1t1'), sub('s1t2'));
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }), event('MergeReverted', 's1t1', MERGED, { sha: 'm1' }));
    expect(await service.learn(boardId, NOW)).toBe(1);
    // One revert alone produces no area.
    expect((await areas()).some((a) => a.source === 'learned')).toBe(false);
    addEvents(event('Merged', 's1t2', MERGED, { sha: 'm2' }), event('MergeReverted', 's1t2', MERGED, { sha: 'm2' }));
    expect(await service.learn(boardId, NOW)).toBe(1);
    expect((await areas()).find((a) => a.source === 'learned')).toMatchObject({ name: 'Learned: apps/billing/src/payments', strength: 2 });
    // Newest first.
    expect(await history()).toEqual([
      expect.objectContaining({ cause: 'reverted', kind: 'added', globId: 's1t2' }),
      expect.objectContaining({ cause: 'reverted', kind: 'candidate', globId: 's1t1' }),
    ]);
    // Run again: nothing more.
    expect(await service.learn(boardId, NOW)).toBe(0);
  });

  it('counts a failed deploy after the merge, but not a failed branch deploy before it', async () => {
    addGlobs(sub('s1t1'), sub('s1t2'));
    addEvents(
      event('DeployFailed', 's1t2', '2026-08-31T00:00:00.000Z'),
      event('Merged', 's1t2', MERGED, { sha: 'm2' }),
      event('Merged', 's1t1', MERGED, { sha: 'm1' }),
      event('DeployFailed', 's1t1', '2026-09-01T13:00:00.000Z'),
    );
    await service.learn(boardId, NOW);
    expect((await history()).map((c) => [c.globId, c.cause])).toEqual([['s1t1', 'deploy_failed']]);
  });

  it('wears a learned area away with repeated clean subs, once their window has passed', async () => {
    await service.record(boardId, outcome('reverted', FILES, 's1t8'));
    await service.record(boardId, outcome('reverted', FILES, 's1t9'));
    const ids = ['s1t1', 's1t2', 's1t3'];
    addGlobs(...ids.map(sub));
    addEvents(...ids.map((id) => event('Merged', id, MERGED, { sha: `m-${id}` })));
    // Still inside the window: nothing is clean yet.
    expect(await service.learn(boardId, new Date(Date.parse(MERGED) + 2 * DAY).toISOString())).toBe(0);
    expect(await service.learn(boardId, NOW)).toBe(3);
    expect((await areas()).some((a) => a.source === 'learned')).toBe(false);
    expect((await history()).some((c) => c.kind === 'removed' && c.cause === 'clean')).toBe(true);
  });

  describe('cleanup of learned areas', () => {
    const learnedArea = (name: string, pattern: string): RiskArea => ({
      boardId,
      name,
      pathPatterns: [pattern],
      why: 'A sub that changed it was reverted',
      source: 'learned',
      strength: 2,
      cleanCount: 0,
      updatedAt: NOW,
    });
    const put = async (...list: RiskArea[]) => {
      await store.transaction(async (tx) => {
        for (const a of defaultAreas(boardId, NOW)) await tx.putRiskArea(a);
        for (const a of list) await tx.putRiskArea(a);
      });
    };
    const evidence = (name: string, ...globIds: string[]) =>
      store.transaction(async (tx) => {
        for (const globId of globIds) await tx.insertRiskAreaChange({ boardId, at: NOW, areaName: name, kind: 'added', globId, cause: 'reverted' });
      });
    const escalated = (id: string, reason: string, status: 'planning' | 'implementing' = 'planning') =>
      glob({ id, boardId, type: 'same', status, pr: null, escalation: { reason, criterion: 'risk_area', by: ADMIN, at: NOW } });

    it('drops the package and app roots, keeps a narrow well-evidenced area, and records why', async () => {
      await put(
        learnedArea('Learned: apps/web/src', 'apps/web/src/**'),
        learnedArea('Learned: packages/core/src', 'packages/core/src/**'),
        learnedArea('Learned: packages/core/src/domain', 'packages/core/src/domain/**'),
        learnedArea('Learned: apps/server/src/db', 'apps/server/src/db/**'),
      );
      await evidence('Learned: apps/web/src', 's1t1', 's1t2');
      await evidence('Learned: packages/core/src', 's1t1', 's1t2');
      await evidence('Learned: packages/core/src/domain', 's1t1', 's1t2');
      // Narrow, but one glob is not enough evidence.
      await evidence('Learned: apps/server/src/db', 's1t3');
      expect(await service.cleanup(boardId)).toEqual(['Learned: apps/web/src', 'Learned: packages/core/src', 'Learned: apps/server/src/db']);
      expect((await areas()).filter((a) => a.source === 'learned').map((a) => a.name)).toEqual(['Learned: packages/core/src/domain']);
      const removed = (await history()).filter((c) => c.kind === 'removed');
      expect(removed.map((c) => [c.areaName, c.cause, c.globId])).toEqual([
        ['Learned: apps/server/src/db', 'cleanup', null],
        ['Learned: packages/core/src', 'cleanup', null],
        ['Learned: apps/web/src', 'cleanup', null],
      ]);
      // The evidence stays in the history for the System page, and a second pass changes nothing.
      expect(await service.cleanup(boardId)).toEqual([]);
    });

    it('de-escalates unstarted globs escalated only for dropped areas', async () => {
      const globs = new GlobService({ store, notifier: new RecordingNotifier(), clock: { now: () => now }, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
      const lifting = new RiskAreaService({ store, clock: { now: () => now }, changes, lift: (b, names) => globs.liftRiskAreaEscalations(b, names) });
      await put(learnedArea('Learned: apps/web/src', 'apps/web/src/**'), learnedArea('Learned: packages/core/src', 'packages/core/src/**'), learnedArea('Learned: packages/core/src/domain', 'packages/core/src/domain/**'));
      await evidence('Learned: packages/core/src/domain', 's1t1', 's1t2');
      addGlobs(
        escalated('s1t10', "Touches the board's risk areas: Learned: apps/web/src, Learned: packages/core/src"),
        // Also escalated for an area that stays.
        escalated('s1t11', "Touches the board's risk areas: Learned: apps/web/src, Learned: packages/core/src/domain"),
        // Already started.
        escalated('s1t12', "Touches the board's risk areas: Learned: apps/web/src", 'implementing'),
        // Escalated for another reason.
        glob({ id: 's1t13', boardId, type: 'same', status: 'planning', escalation: { reason: 'Needs a design decision', criterion: 'design_decision', by: ADMIN, at: NOW } }),
      );
      await lifting.cleanup(boardId);
      const after = (id: string) => store.transaction((tx) => tx.getGlob(id));
      expect(await after('s1t10')).toMatchObject({ type: 'sub', escalation: null, status: 'implementing' });
      for (const id of ['s1t11', 's1t12', 's1t13']) expect(await after(id)).toMatchObject({ type: 'same' });
      const events = store.state.events.filter((e) => e.globId === 's1t10');
      expect(events.map((e) => e.type)).not.toContain('Deescalated');
      expect(events.find((e) => e.type === 'FieldsChanged')?.data).toMatchObject({ type: { from: 'same', to: 'sub' }, note: expect.stringContaining('dropped') as unknown });
    });

    it('lets an admin remove a learned area, but not a default', async () => {
      await put(learnedArea('Learned: packages/core/src/domain', 'packages/core/src/domain/**'));
      expect((await service.remove(DEV, boardId, 'Learned: packages/core/src/domain')).ok).toBe(false);
      expect((await service.remove(ADMIN, boardId, 'Auth and security')).ok).toBe(false);
      const view = unwrap(await service.remove(ADMIN, boardId, 'Learned: packages/core/src/domain'));
      expect(view.areas.some((a) => a.source === 'learned')).toBe(false);
      expect(view.history[0]).toMatchObject({ kind: 'removed', areaName: 'Learned: packages/core/src/domain' });
    });

    it('shows the evidence globs of a learned area', async () => {
      await put(learnedArea('Learned: packages/core/src/domain', 'packages/core/src/domain/**'));
      await evidence('Learned: packages/core/src/domain', 's1t1', 's1t2');
      const view = unwrap(await service.view(DEV, boardId));
      expect([...(view.areas.find((a) => a.source === 'learned')?.evidence ?? [])].sort()).toEqual(['s1t1', 's1t2']);
    });
  });

  it('marks an outcome that changes no area as done, so learn() does not read the diff again', async () => {
    let calls = 0;
    const counting = new RiskAreaService({ store, clock: { now: () => now }, changes: { mergedDiff: () => { calls++; return Promise.resolve({ changedLines: 1, files: ['docs/readme.md'] }); } } });
    addGlobs(sub('s1t1'));
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }));
    await counting.learn(boardId, NOW);
    expect(calls).toBe(1);
    expect(await history()).toEqual([expect.objectContaining({ areaName: null, cause: 'clean', globId: 's1t1' })]);
    await counting.learn(boardId, NOW);
    expect(calls).toBe(1);
  });

  it('derives a small-fix or bug signal again from a recorded needed-fix outcome', async () => {
    addGlobs(sub('s1t1'), sub('s1t2'));
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }), event('Merged', 's1t2', MERGED, { sha: 'm2' }));
    const row = (globId: string, evidence: string) => store.transaction((tx) => tx.insertSubLimitChange({ boardId, at: NOW, fromLines: 2000, toLines: 2000, outcome: 'needed_fixes', globId, changedLines: 5, evidence, step: 500 }));
    await row('s1t1', 'QA review asked for changes. Too small');
    await row('s1t2', 's1b9: "it was introduced by s1t2"');
    await service.learn(boardId, NOW);
    expect((await history()).map((c) => [c.globId, c.cause]).sort()).toEqual([['s1t1', 'small_fix'], ['s1t2', 'bug']]);
  });

  it('does not count a sub a bug blamed, or one that needed fixes, as clean', async () => {
    addGlobs(
      sub('s1t1'),
      sub('s1t2'),
      glob({ id: 's1b3', boardId, category: 'bug', type: 'same', title: 'Broken by s1t1', createdAt: new Date(Date.parse(MERGED) + DAY).toISOString() }),
    );
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }), event('Merged', 's1t2', MERGED, { sha: 'm2' }));
    await store.transaction((tx) =>
      tx.insertSubLimitChange({ boardId, at: NOW, fromLines: 2000, toLines: 2000, outcome: 'needed_fixes', globId: 's1t2', changedLines: 5, evidence: 'x', step: 500 }),
    );
    await service.record(boardId, outcome('reverted', FILES, 's1t8'));
    await service.record(boardId, outcome('reverted', FILES, 's1t9'));
    await service.learn(boardId, NOW);
    expect((await areas()).find((a) => a.source === 'learned')?.cleanCount).toBe(0);
  });

  it('records and applies a person\'s change of type from the outcome job', async () => {
    const notifier = new RecordingNotifier();
    const clock = { now: () => now };
    const globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const created = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Change charge',
        plan: 'Change apps/billing/src/payments/charge.ts.\n\nDone when: it works.',
        type: 'sub',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    // An earlier revert of another sub in the same module is the first piece of evidence.
    await service.record(boardId, outcome('reverted', FILES, 's1t9'));
    unwrap(await globs.update(DEV, created.id, created.version, { type: 'same' }));
    await store.transaction((tx) => tx.appendEvents([event('Merged', created.id, now, { sha: 'abc' })]));
    const learning = new IntakeLearningService({ store, clock, riskAreas: service });
    await learning.run(boardId, now);
    const learned = (await areas()).find((a) => a.source === 'learned');
    expect(learned).toMatchObject({ name: 'Learned: apps/billing/src/payments', strength: CORRECTION_WEIGHT + 1 });
    expect((await history()).filter((c) => c.globId === created.id)).toEqual([expect.objectContaining({ kind: 'correction', cause: 'type_to_same' })]);
    // Refreshing the outcome doesn't count it again.
    await learning.run(boardId, now);
    expect((await areas()).find((a) => a.source === 'learned')?.strength).toBe(CORRECTION_WEIGHT + 1);
  });
});

describe('matchRiskAreas and splitEvidence', () => {
  const areas = defaultAreas(1, NOW);

  it('matches the areas the plan files fall under and lists only those files', () => {
    const plan = 'Change `apps/server/src/auth/token.ts` and `infra/iam.tf`, then `docs/readme.md`.';
    const match = matchRiskAreas(areas, plan);
    expect(match.areas.map((a) => a.name)).toEqual(['Auth and security', 'Infrastructure and production']);
    expect(match.paths).toEqual(['apps/server/src/auth/token.ts', 'infra/iam.tf']);
  });

  it('matches nothing when the plan names no files or only unrelated ones', () => {
    expect(matchRiskAreas(areas, 'Tidy the wording.')).toEqual({ areas: [], paths: [] });
    expect(matchRiskAreas(areas, 'Edit `docs/guide/intro.md`.')).toEqual({ areas: [], paths: [] });
  });

  it('formats the evidence with the source glob, files and areas, capping the files', () => {
    const match = { areas: [{ name: 'Auth and security' }], paths: ['a/auth/1.ts', 'a/auth/2.ts'] };
    expect(splitEvidence('s1t1', match)).toBe('From the split of s1t1: files a/auth/1.ts, a/auth/2.ts, areas Auth and security');
    const many = { areas: [{ name: 'X' }, { name: 'Y' }], paths: ['a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts', 'a/5.ts', 'a/6.ts', 'a/7.ts'] };
    expect(splitEvidence('s1t1', many)).toBe('From the split of s1t1: files a/1.ts, a/2.ts, a/3.ts, a/4.ts, a/5.ts (+2 more), areas X, Y');
  });
});
