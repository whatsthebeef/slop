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
const FILES = ['apps/billing/src/charge.ts', 'apps/billing/src/refund.ts'];

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected a value');
  return value;
};

const outcome = (kind: RiskOutcome['kind'], paths: readonly string[] = FILES, globId = 's1t1'): RiskOutcome => ({ kind, globId, paths, at: NOW });

describe('risk areas (pure)', () => {
  const defaults = defaultAreas(1, NOW);

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

  it('adds a learned area for a reverted sub\'s paths, and strengthens it the next time', () => {
    const first = applyOutcome(1, defaults, outcome('reverted'));
    expect(first.put).toEqual([expect.objectContaining({ name: 'Learned: apps/billing/src', pathPatterns: ['apps/billing/src/**'], source: 'learned', strength: 1 })]);
    expect(first.changes).toEqual([expect.objectContaining({ kind: 'added', cause: 'reverted', globId: 's1t1' })]);
    const areas = [...defaults, ...first.put];
    const second = applyOutcome(1, areas, outcome('bug', FILES, 's1t2'));
    expect(second.put).toEqual([expect.objectContaining({ name: 'Learned: apps/billing/src', strength: 2, cleanCount: 0 })]);
    expect(second.changes).toEqual([expect.objectContaining({ kind: 'strengthened', cause: 'bug' })]);
  });

  it('strengthens a default area a failed deploy touched, without adding another', () => {
    const applied = applyOutcome(1, defaults, outcome('deploy_failed', ['infra/stack.yaml']));
    expect(applied.put).toEqual([expect.objectContaining({ name: 'Infrastructure and production', source: 'default', strength: 1 })]);
  });

  it('removes a learned area after repeated clean outcomes, and only marks a default sub-safe', () => {
    let areas: RiskArea[] = [...defaults, ...applyOutcome(1, defaults, outcome('reverted')).put];
    for (let i = 0; i < CLEAN_TO_REMOVE - 1; i++) {
      const applied = applyOutcome(1, areas, outcome('clean', FILES, `s1t${i + 2}`));
      areas = areas.map((a) => applied.put.find((p) => p.name === a.name) ?? a);
    }
    expect(areas.find((a) => a.source === 'learned')?.cleanCount).toBe(CLEAN_TO_REMOVE - 1);
    const last = applyOutcome(1, areas, outcome('clean', FILES, 's1t9'));
    expect(last.removed).toEqual(['Learned: apps/billing/src']);
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
    const toSame = applyOutcome(1, defaults, outcome('type_to_same'));
    expect(toSame.put[0]).toMatchObject({ source: 'learned', strength: CORRECTION_WEIGHT });
    expect(toSame.changes[0]).toMatchObject({ kind: 'correction', cause: 'type_to_same' });
    // One correction to sub is enough to wear a learned area away.
    const toSub = applyOutcome(1, [...defaults, ...toSame.put], outcome('type_to_sub', FILES, 's1t2'));
    expect(toSub.removed).toEqual(['Learned: apps/billing/src']);
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
    expect((await areas()).find((a) => a.source === 'learned')?.strength).toBe(1);
  });

  it('learns from a revert: the reverted sub\'s merge files get a learned area', async () => {
    addGlobs(sub('s1t1'));
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }), event('MergeReverted', 's1t1', MERGED, { sha: 'm1' }));
    expect(await service.learn(boardId, NOW)).toBe(1);
    expect((await areas()).find((a) => a.source === 'learned')).toMatchObject({ name: 'Learned: apps/billing/src', strength: 1 });
    expect(await history()).toEqual([expect.objectContaining({ cause: 'reverted', kind: 'added', globId: 's1t1' })]);
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
    await service.record(boardId, outcome('reverted', FILES, 's1t9'));
    const ids = ['s1t1', 's1t2', 's1t3'];
    addGlobs(...ids.map(sub));
    addEvents(...ids.map((id) => event('Merged', id, MERGED, { sha: `m-${id}` })));
    // Still inside the window: nothing is clean yet.
    expect(await service.learn(boardId, new Date(Date.parse(MERGED) + 2 * DAY).toISOString())).toBe(0);
    expect(await service.learn(boardId, NOW)).toBe(3);
    expect((await areas()).some((a) => a.source === 'learned')).toBe(false);
    expect((await history())[0]).toMatchObject({ kind: 'removed', cause: 'clean' });
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
      glob({ id: 's1b3', boardId, category: 'bug', type: 'same', title: 'Broken by s1t1', summary: '', createdAt: new Date(Date.parse(MERGED) + DAY).toISOString() }),
    );
    addEvents(event('Merged', 's1t1', MERGED, { sha: 'm1' }), event('Merged', 's1t2', MERGED, { sha: 'm2' }));
    await store.transaction((tx) =>
      tx.insertSubLimitChange({ boardId, at: NOW, fromLines: 2000, toLines: 2000, outcome: 'needed_fixes', globId: 's1t2', changedLines: 5, evidence: 'x', step: 500 }),
    );
    await service.record(boardId, outcome('reverted', FILES, 's1t9'));
    await service.learn(boardId, NOW);
    expect((await areas()).find((a) => a.source === 'learned')?.cleanCount).toBe(0);
  });

  it('records and applies a person\'s change of type from the outcome job', async () => {
    const notifier = new RecordingNotifier();
    const clock = { now: () => now };
    const globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const created = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Change charge',
        summary: 'Change charge',
        plan: 'Change apps/billing/src/charge.ts.\n\nDone when: it works.',
        type: 'sub',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    unwrap(await globs.update(DEV, created.id, created.version, { type: 'same' }));
    await store.transaction((tx) => tx.appendEvents([event('Merged', created.id, now, { sha: 'abc' })]));
    const learning = new IntakeLearningService({ store, clock, riskAreas: service });
    await learning.run(boardId, now);
    const learned = (await areas()).find((a) => a.source === 'learned');
    expect(learned).toMatchObject({ name: 'Learned: apps/billing/src', strength: CORRECTION_WEIGHT });
    expect(await history()).toEqual([expect.objectContaining({ kind: 'correction', cause: 'type_to_same', globId: created.id })]);
    // Refreshing the outcome doesn't count it again.
    await learning.run(boardId, now);
    expect((await areas()).find((a) => a.source === 'learned')?.strength).toBe(CORRECTION_WEIGHT);
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
