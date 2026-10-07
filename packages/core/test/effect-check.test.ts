import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { EffectCheckService } from '../src/app/effect-check-service.js';
import { KnowledgeService, newKbItemId } from '../src/app/knowledge-service.js';
import { EFFECT_CHECK_INTERVAL_MS, LearningJobService } from '../src/app/learning-jobs.js';
import { MINED_BY, MiningService } from '../src/app/mining-service.js';
import { EFFECT_LOOKBACK_DAYS } from '../src/app/effect-check-service.js';
import { isImproved, isMarkedlyWorse } from '../src/domain/effect-check.js';
import type { EffectCheck, EffectFigures } from '../src/domain/effect-check.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import { UNPROCESSED } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { KbSignal } from '../src/domain/signals.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** When the change was approved. */
const DECIDED = '2026-10-07T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(DECIDED) + ms).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () =>
    Promise.resolve({
      hash: 'h1',
      files: [{ path: 'agents/orchestrator.md', content: 'Run the glob.\n' }],
    }),
};

const CI: KbSignal = {
  key: 'ci_after_local',
  kind: 'ci_after_local',
  agent: 'orchestrator',
  label: 'CI failing after local checks passed',
  window: { from: at(-28 * DAY), to: DECIDED },
  figures: { affected: 4, eligible: 19, rate: 0.211, count: 4 },
  globIds: [],
  examples: [],
  measuredAt: DECIDED,
};

const figures = (affected: number, eligible: number): EffectFigures => ({
  affected,
  eligible,
  rate: eligible === 0 ? 0 : affected / eligible,
  globIds: [],
  affectedGlobIds: [],
});

describe('Effect check verdict thresholds', () => {
  it('is improved at 70% of the rate before or less, compared exactly', () => {
    expect(isImproved(figures(10, 10), figures(7, 10))).toBe(true);
    expect(isImproved(figures(10, 10), figures(8, 10))).toBe(false);
    // 3/10 against 3/7 is exactly 70%.
    expect(isImproved(figures(3, 7), figures(3, 10))).toBe(true);
    expect(isImproved(figures(3, 7), figures(4, 10))).toBe(false);
    // Down to none from some is improved; staying at none is not worse.
    expect(isImproved(figures(1, 10), figures(0, 10))).toBe(true);
    expect(isImproved(figures(0, 10), figures(1, 10))).toBe(false);
  });

  it('is markedly worse at twice the rate and 20 points more, with at least 3 eligible globs a side', () => {
    expect(isMarkedlyWorse(figures(1, 10), figures(3, 10))).toBe(true);
    // Twice the rate but only 10 points more.
    expect(isMarkedlyWorse(figures(1, 10), figures(2, 10))).toBe(false);
    // 20 points more but under twice the rate.
    expect(isMarkedlyWorse(figures(3, 10), figures(5, 10))).toBe(false);
    expect(isMarkedlyWorse(figures(0, 3), figures(1, 3))).toBe(true);
    expect(isMarkedlyWorse(figures(0, 2), figures(2, 2))).toBe(false);
    expect(isMarkedlyWorse(figures(0, 3), figures(2, 2))).toBe(false);
  });

  it('counts 0% before and 0% after as improved (s15f8)', () => {
    expect(isImproved(figures(0, 10), figures(0, 10))).toBe(true);
  });

  it('is markedly worse at exactly twice the rate and exactly 20 points more, not just under either (s15f8)', () => {
    // Exactly 2x and exactly +0.2.
    expect(isMarkedlyWorse(figures(20, 100), figures(40, 100))).toBe(true);
    expect(isMarkedlyWorse(figures(1, 5), figures(2, 5))).toBe(true);
    // Exactly 2x, 19 points more.
    expect(isMarkedlyWorse(figures(19, 100), figures(38, 100))).toBe(false);
    // Exactly 20 points more, just under 2x.
    expect(isMarkedlyWorse(figures(21, 100), figures(41, 100))).toBe(false);
    // Exactly 3 eligible globs on the after side with 4 before.
    expect(isMarkedlyWorse(figures(0, 4), figures(1, 3))).toBe(true);
    expect(isMarkedlyWorse(figures(0, 4), figures(1, 2))).toBe(false);
  });
});

describe('Effect checks', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let now: string;
  let mining: MiningService;
  let checks: EffectCheckService;
  let knowledge: KnowledgeService;
  let boards: BoardService;
  let boardId: number;
  let n: number;

  interface Merge {
    /** When it merged. */
    readonly mergedAt: string;
    /** Its CI failed on a routine push: affected by `ci_after_local`. */
    readonly failed?: boolean;
    /** No builds: not eligible for `ci_after_local`. */
    readonly noBuild?: boolean;
    /** Its commits' `Slop-Agent-Set` trailer; absent: unknown. */
    readonly version?: number;
    /** When its first run was triggered (its first recorded work); default an hour before the merge. */
    readonly workAt?: string;
    /** Its run ended: superseded by a start again (`run_superseded`), or completed. */
    readonly superseded?: boolean;
    /** Merged again then (Merge and continue). */
    readonly mergedAgainAt?: string;
  }

  /** A merged glob with a routine run, a push, a build and the merge. */
  const merge = async (m: Merge): Promise<string> => {
    const id = `s${String(boardId)}t${String(++n)}`;
    const sha = `${n.toString(16).padStart(7, '0')}abcdef0`;
    const runId = `run-${String(n)}`;
    const work = m.workAt ?? new Date(Date.parse(m.mergedAt) - HOUR).toISOString();
    const minute = (k: number) => new Date(Date.parse(work) + k * 60_000).toISOString();
    const events: DomainEvent[] = [
      { type: 'RunTriggered', globId: id, actor: null, at: work, data: { runId } },
      {
        type: 'CommitPushed',
        globId: id,
        actor: null,
        at: minute(1),
        data: { sha, runId, ...(m.version === undefined ? {} : { agentSetVersion: m.version }) },
      },
      ...(m.noBuild === true
        ? []
        : [
            {
              type: 'BuildCompleted' as const,
              globId: id,
              actor: null,
              at: minute(2),
              data: { sha, passed: m.failed !== true },
            },
          ]),
      ...(m.superseded === undefined
        ? []
        : [
            {
              type: 'RunEnded' as const,
              globId: id,
              actor: null,
              at: minute(3),
              data: {
                runId,
                outcome: m.superseded ? 'superseded' : 'completed',
                ...(m.superseded && { cause: 'start_again' }),
              },
            },
          ]),
      { type: 'Merged', globId: id, actor: null, at: m.mergedAt, data: { sha } },
      ...(m.mergedAgainAt === undefined
        ? []
        : [
            {
              type: 'Merged' as const,
              globId: id,
              actor: null,
              at: m.mergedAgainAt,
              data: { sha },
            },
          ]),
    ];
    await store.transaction(async (tx) => {
      // Created when its work started, last changed when it merged (what the activity's lookback reads).
      await tx.insertGlob(
        glob({ id, boardId, createdAt: work, updatedAt: m.mergedAgainAt ?? m.mergedAt }),
        null,
      );
      await tx.appendEvents(events);
    });
    return id;
  };

  /** `count` globs merged a day apart from `from`, the first `failed` of them failing CI. */
  const series = async (
    count: number,
    failed: number,
    from: number,
    patch: Omit<Merge, 'mergedAt' | 'failed'> = {},
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++)
      ids.push(await merge({ ...patch, mergedAt: at(from + i * DAY), failed: i < failed }));
    return ids;
  };

  /** An approved item watching `ci_after_local`; by default a document change (time basis). */
  const approved = async (patch: Partial<KbItem> = {}): Promise<KbItem> =>
    store.transaction(async (tx) => {
      const item: KbItem = {
        id: await newKbItemId(tx, boardId),
        boardId,
        status: 'approved',
        type: 'gotcha',
        statement:
          'Run the full checks, not only the fast ones, before pushing a commit that a routine marks ready',
        evidence: 'Mined',
        suggestedTarget: 'build_test_lint',
        sourceGlobIds: [],
        source: 'mined',
        signal: CI,
        agentSetVersion: 4,
        submittedBy: MINED_BY,
        createdAt: at(-DAY),
        decidedBy: ADMIN,
        decidedAt: DECIDED,
        decisionReason: null,
        document: null,
        outcome: { kind: 'applied', target: 'doc', name: 'build_test_lint', version: 3 },
        ...UNPROCESSED,
        processing: 'drafted',
        version: 1,
        ...patch,
      };
      await tx.insertKbItem(item);
      return item;
    });

  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  const check = async (id: string): Promise<EffectCheck> => {
    const found = (await item(id)).effectCheck;
    if (found === null) throw new Error(`${id} has no effect check`);
    return found;
  };
  const setGlobs = async (effectCheckGlobs: number) => {
    const board = unwrap(await boards.get(ADMIN, boardId)).board;
    unwrap(await boards.updateSettings(ADMIN, boardId, board.version, { effectCheckGlobs }));
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = at(60 * DAY);
    const clock = { now: () => now };
    mining = new MiningService({ store, notifier });
    checks = new EffectCheckService({ store, notifier, mining });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier, signals: mining });
    boards = new BoardService({ store, notifier });
    n = 0;
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'b',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    await setGlobs(3);
  });

  it('accepts 3 to 50 globs a side in board settings, whole numbers only', async () => {
    const board = unwrap(await boards.get(ADMIN, boardId)).board;
    expect(board.effectCheckGlobs).toBe(3);
    for (const bad of [2, 51, 4.5]) {
      const refused = await boards.updateSettings(ADMIN, boardId, board.version, {
        effectCheckGlobs: bad,
      });
      expect(refused.ok).toBe(false);
    }
    expect(
      unwrap(await boards.updateSettings(ADMIN, boardId, board.version, { effectCheckGlobs: 50 }))
        .effectCheckGlobs,
    ).toBe(50);
  });

  it('by time: compares the last N eligible globs before the approval with globs whose work started after it, partial meanwhile', async () => {
    const older = await series(2, 0, -30 * DAY);
    // Not eligible (no builds), so skipped rather than counted.
    await merge({ mergedAt: at(-5 * DAY), noBuild: true });
    const before = await series(3, 2, -4 * DAY);
    // Merged after the approval, but its work started before it: it didn't run with the change.
    await merge({ mergedAt: at(DAY), workAt: at(-HOUR), failed: true });
    const after = await series(2, 0, 2 * DAY);
    const watched = await approved();

    const result = await checks.check(boardId, now);
    expect(result).toEqual({ kind: 'effect_check', watching: 1, decided: [], raised: [] });
    expect(await check(watched.id)).toEqual({
      state: 'watching',
      key: 'ci_after_local',
      label: 'CI failing after local checks passed',
      basis: { kind: 'time', since: DECIDED },
      n: 3,
      before: {
        affected: 2,
        eligible: 3,
        rate: 0.667,
        globIds: before,
        affectedGlobIds: before.slice(0, 2),
      },
      after: { affected: 0, eligible: 2, rate: 0, globIds: after, affectedGlobIds: [] },
      worse: [],
      raisedItemId: null,
      checkedAt: now,
    });
    expect(older.some((id) => before.includes(id))).toBe(false);
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });

    // The third glob after makes it final: 0 of 3 against 2 of 3 is improved.
    const third = await merge({ mergedAt: at(10 * DAY) });
    expect(await checks.check(boardId, now)).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [{ id: watched.id, state: 'improved' }],
      raised: [],
    });
    expect(await check(watched.id)).toMatchObject({
      state: 'improved',
      after: { eligible: 3, globIds: [...after, third] },
      raisedItemId: null,
    });
  });

  it('by agent-set version: counts globs at the approved version or later, leaving out older and unknown versions', async () => {
    await series(3, 3, -10 * DAY, { version: 4 });
    const older = await merge({ mergedAt: at(DAY), version: 4, failed: true });
    const unknown = await merge({ mergedAt: at(2 * DAY), failed: true });
    const after = [
      ...(await series(2, 0, 3 * DAY, { version: 5 })),
      await merge({ mergedAt: at(6 * DAY), version: 6, failed: true }),
    ];
    const watched = await approved({
      outcome: {
        kind: 'applied',
        target: 'agent',
        name: 'agents/orchestrator.md',
        version: 2,
        agentSetVersion: 5,
      },
    });

    await checks.check(boardId, now);
    const result = await check(watched.id);
    expect(result.basis).toEqual({ kind: 'agent_set', fromVersion: 5 });
    expect(result.after?.globIds).toEqual(after);
    expect(result.after?.globIds).not.toContain(older);
    expect(result.after?.globIds).not.toContain(unknown);
    // 1 of 3 against 3 of 3.
    expect(result.state).toBe('improved');
  });

  it('follows the board setting while watching: the before side is the last N, the after side the first N', async () => {
    const before = await series(6, 0, -10 * DAY);
    const after = await series(6, 0, DAY);
    const watched = await approved();
    await setGlobs(5);
    await checks.check(boardId, now);
    expect(await check(watched.id)).toMatchObject({
      n: 5,
      before: { globIds: before.slice(1) },
      after: { globIds: after.slice(0, 5) },
    });
  });

  it('is unmeasurable, and final, with no eligible glob before the approval', async () => {
    await merge({ mergedAt: at(-DAY), noBuild: true });
    await series(3, 3, DAY);
    const watched = await approved();
    expect(await checks.check(boardId, now)).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [{ id: watched.id, state: 'unmeasurable' }],
      raised: [],
    });
    expect(await check(watched.id)).toMatchObject({
      state: 'unmeasurable',
      before: { eligible: 0 },
      raisedItemId: null,
    });
    expect(await checks.check(boardId, now)).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [],
      raised: [],
    });
  });

  it("raises a revise-or-revert item when the rate didn't drop, with the figures, and is final after that", async () => {
    const before = await series(3, 1, -5 * DAY);
    const after = await series(3, 1, DAY);
    const watched = await approved();
    const result = await checks.check(boardId, now);
    const [raisedId] = result.raised;
    expect(result).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [{ id: watched.id, state: 'not_improved' }],
      raised: [raisedId],
    });
    expect(await check(watched.id)).toMatchObject({
      state: 'not_improved',
      raisedItemId: raisedId,
    });

    const raised = await item(raisedId ?? '');
    expect(raised).toMatchObject({
      status: 'open',
      type: 'gotcha',
      source: 'mined',
      submittedBy: MINED_BY,
      suggestedTarget: 'build_test_lint',
      sourceGlobIds: [after[0]],
      processing: 'pending',
      target: null,
      draft: null,
      signal: {
        key: `effect:${watched.id}`,
        kind: 'ci_after_local',
        agent: 'orchestrator',
        label: 'CI failing after local checks passed',
        window: { from: DECIDED, to: now },
        figures: { affected: 1, eligible: 3, rate: 0.333, count: 1 },
        globIds: [after[0]],
        measuredAt: now,
      },
    });
    expect(raised.statement).toBe(
      `Revise or revert ${watched.id} (Run the full checks, not only the fast ones, before pushing a commit that a rou…): after 3 globs with work started after 2026-10-07 the rate of CI failing after local checks passed is 33% (1/3), against 33% (1/3) before.`,
    );
    expect(raised.evidence.split('\n')).toEqual([
      `Effect check by slop of ${watched.id} (approved 2026-10-07): CI failing after local checks passed (ci_after_local), 3 globs a side, with work started after 2026-10-07.`,
      `Before: 1 of 3 globs (33%); globs ${before.join(', ')}; affected ${before[0] ?? ''}`,
      `After: 1 of 3 globs (33%); globs ${after.join(', ')}; affected ${after[0] ?? ''}`,
    ]);

    // Final: later globs and runs change nothing, and nothing more is raised.
    const settled = await item(watched.id);
    await series(3, 3, 20 * DAY);
    expect(await checks.check(boardId, now)).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [],
      raised: [],
    });
    expect(await item(watched.id)).toEqual(settled);
    expect(
      (await store.transaction((tx) => tx.listKbItems(boardId))).filter(
        (i) => i.source === 'mined' && i.status === 'open',
      ),
    ).toHaveLength(1);
  });

  it('marks an improvement that made another signal markedly worse as worse elsewhere, and raises an item about that signal', async () => {
    // CI: 3 of 3 before, 0 of 3 after (improved). Superseded runs: 0 of 3 before, 2 of 3 after.
    await merge({ mergedAt: at(-3 * DAY), failed: true, superseded: false });
    await merge({ mergedAt: at(-2 * DAY), failed: true, superseded: false });
    await merge({ mergedAt: at(-DAY), failed: true, superseded: false });
    const after = [
      await merge({ mergedAt: at(DAY), superseded: true }),
      await merge({ mergedAt: at(2 * DAY), superseded: true }),
      await merge({ mergedAt: at(3 * DAY), superseded: false }),
    ];
    const watched = await approved();
    const result = await checks.check(boardId, now);
    expect(result.decided).toEqual([{ id: watched.id, state: 'worse_elsewhere' }]);
    const final = await check(watched.id);
    expect(final.worse).toEqual([
      {
        key: 'run_superseded',
        label: 'routine runs ending in a take-over or start again',
        before: {
          affected: 0,
          eligible: 3,
          rate: 0,
          globIds: expect.any(Array) as unknown,
          affectedGlobIds: [],
        },
        after: {
          affected: 2,
          eligible: 3,
          rate: 0.667,
          globIds: after,
          affectedGlobIds: after.slice(0, 2),
        },
      },
    ]);
    const raised = await item(result.raised[0] ?? '');
    // Leads with the gain to keep, then the side effect over that signal's own globs.
    expect(raised.statement).toBe(
      `Revise ${watched.id} (Run the full checks, not only the fast ones, before pushing a commit that a rou…): after 3 globs with work started after 2026-10-07 the rate of CI failing after local checks passed fell from 100% (3/3) to 0% (0/3), but the rate of routine runs ending in a take-over or start again rose from 0% (0/3) to 67% (2/3).`,
    );
    expect(raised.evidence).toContain(
      'Worse elsewhere: routine runs ending in a take-over or start again (run_superseded) 0% (0/3) before, 67% (2/3) after.',
    );
  });

  it("doesn't call a rise worse elsewhere under 3 eligible globs a side", async () => {
    await series(3, 3, -5 * DAY);
    await merge({ mergedAt: at(DAY), superseded: true });
    await merge({ mergedAt: at(2 * DAY), superseded: true });
    await merge({ mergedAt: at(3 * DAY) });
    const watched = await approved();
    expect((await checks.check(boardId, now)).decided).toEqual([
      { id: watched.id, state: 'improved' },
    ]);
  });

  it('starts a check for an item approved before effect checks, from its outcome', async () => {
    await series(3, 1, -5 * DAY);
    const watched = await approved({ effectCheck: null });
    await checks.check(boardId, now);
    expect(await check(watched.id)).toMatchObject({
      state: 'watching',
      basis: { kind: 'time', since: DECIDED },
      after: { eligible: 0 },
    });
  });

  it("doesn't raise twice when two runs check at once", async () => {
    await series(3, 1, -5 * DAY);
    await series(3, 1, DAY);
    const watched = await approved();
    const [a, b] = await Promise.all([checks.check(boardId, now), checks.check(boardId, now)]);
    const items = await store.transaction((tx) => tx.listKbItems(boardId));
    const raised = items.filter((i) => i.signal?.key === `effect:${watched.id}`);
    expect(raised).toHaveLength(1);
    expect((await check(watched.id)).raisedItemId).toBe(raised[0]?.id);
    expect([...a.raised, ...b.raised]).toContain(raised[0]?.id);
  });

  it('falls back to the time basis for an agent-file change approved without an agent-set version (s15f8)', async () => {
    await series(3, 3, -5 * DAY);
    // Unknown versions: left out on the agent-set basis, but counted by time.
    const after = await series(3, 0, DAY);
    const watched = await approved({
      outcome: { kind: 'applied', target: 'agent', name: 'agents/orchestrator.md', version: 2 },
    });
    await checks.check(boardId, now);
    expect(await check(watched.id)).toMatchObject({
      state: 'improved',
      basis: { kind: 'time', since: DECIDED },
      after: { globIds: after },
    });
  });

  it('decides on fewer than N eligible globs before the approval (s15f8)', async () => {
    const before = await series(2, 2, -5 * DAY);
    await series(3, 0, DAY);
    const watched = await approved();
    expect((await checks.check(boardId, now)).decided).toEqual([
      { id: watched.id, state: 'improved' },
    ]);
    expect(await check(watched.id)).toMatchObject({
      n: 3,
      before: { affected: 2, eligible: 2, rate: 1, globIds: before },
      after: { affected: 0, eligible: 3 },
    });
  });

  it('a stored watching check follows the current board setting, not the N it was started with (s15f8)', async () => {
    await series(6, 0, -10 * DAY);
    const after = await series(4, 0, DAY);
    const watched = await approved({
      effectCheck: {
        state: 'watching',
        key: CI.key,
        label: CI.label,
        basis: { kind: 'time', since: DECIDED },
        n: 3,
        before: null,
        after: null,
        worse: [],
        raisedItemId: null,
        checkedAt: null,
      },
    });
    await setGlobs(5);
    expect((await checks.check(boardId, now)).watching).toBe(1);
    expect(await check(watched.id)).toMatchObject({
      state: 'watching',
      n: 5,
      before: { eligible: 5 },
      after: { eligible: 4, globIds: after },
    });
  });

  it('keeps the N a final check was decided on when the board setting changes (s15f8)', async () => {
    await series(3, 3, -5 * DAY);
    await series(5, 0, DAY);
    const watched = await approved();
    await checks.check(boardId, now);
    const settled = await item(watched.id);
    expect(settled.effectCheck).toMatchObject({ state: 'improved', n: 3 });
    await setGlobs(5);
    await checks.check(boardId, now);
    expect(await item(watched.id)).toEqual(settled);
  });

  it('is not improved, not worse elsewhere, when the watched signal stayed and another rose, and names both (s15f8)', async () => {
    // CI: 1 of 3 before and after. Superseded runs: 0 of 3 before, 2 of 3 after.
    await merge({ mergedAt: at(-3 * DAY), failed: true, superseded: false });
    await merge({ mergedAt: at(-2 * DAY), superseded: false });
    await merge({ mergedAt: at(-DAY), superseded: false });
    await merge({ mergedAt: at(DAY), failed: true, superseded: true });
    await merge({ mergedAt: at(2 * DAY), superseded: true });
    await merge({ mergedAt: at(3 * DAY), superseded: false });
    const watched = await approved();
    const result = await checks.check(boardId, now);
    expect(result.decided).toEqual([{ id: watched.id, state: 'not_improved' }]);
    const final = await check(watched.id);
    expect(final.worse.map((w) => w.key)).toEqual(['run_superseded']);
    const raised = await item(result.raised[0] ?? '');
    expect(raised.statement).toContain(
      'the rate of CI failing after local checks passed is 33% (1/3), against 33% (1/3) before. The rate of routine runs ending in a take-over or start again also rose from 0% (0/3) to 67% (2/3).',
    );
  });

  it('keeps a glob first merged before the approval on the before side when it merges again after it (s15f8)', async () => {
    const before = await series(2, 0, -5 * DAY);
    const again = await merge({ mergedAt: at(-DAY), mergedAgainAt: at(DAY / 2), failed: true });
    const after = await series(3, 0, DAY);
    const watched = await approved();
    await checks.check(boardId, now);
    expect(await check(watched.id)).toMatchObject({
      state: 'improved',
      before: { affected: 1, eligible: 3, globIds: [...before, again] },
      after: { affected: 0, eligible: 3, globIds: after },
    });
  });

  it("counts a before glob's activity only up to the approval, so work it does after it with the change doesn't count (s15f8)", async () => {
    const before = await series(2, 0, -5 * DAY);
    const continued = await merge({ mergedAt: at(-DAY) });
    // Merge and continue: after the approval it pushes again, fails CI and merges again.
    const sha = 'f00dfeedabcdef0';
    await store.transaction((tx) =>
      tx.appendEvents([
        { type: 'RunTriggered', globId: continued, actor: null, at: at(HOUR), data: { runId: 'run-later' } },
        { type: 'CommitPushed', globId: continued, actor: null, at: at(2 * HOUR), data: { sha, runId: 'run-later' } },
        { type: 'BuildCompleted', globId: continued, actor: null, at: at(3 * HOUR), data: { sha, passed: false } },
        { type: 'Merged', globId: continued, actor: null, at: at(4 * HOUR), data: { sha } },
      ]),
    );
    await series(3, 0, DAY);
    const watched = await approved();
    await checks.check(boardId, now);
    expect(await check(watched.id)).toMatchObject({
      before: { affected: 0, eligible: 3, globIds: [...before, continued], affectedGlobIds: [] },
    });
  });

  it('takes the after side by first merge, so a glob that merges again later keeps its place (s15f8)', async () => {
    await series(3, 1, -5 * DAY);
    const first = await merge({ mergedAt: at(DAY), mergedAgainAt: at(10 * DAY) });
    const later = await series(3, 0, 2 * DAY);
    const watched = await approved();
    await checks.check(boardId, now);
    expect((await check(watched.id)).after).toMatchObject({
      eligible: 3,
      globIds: [first, ...later.slice(0, 2)],
    });
  });

  it('reads a year before the approval on every run, the before side full or not (s15f8)', async () => {
    await series(2, 0, -30 * DAY);
    const before = await series(3, 1, -5 * DAY);
    await series(1, 0, DAY);
    const watched = await approved();
    const froms: string[] = [];
    const activity = mining.activity.bind(mining);
    mining.activity = (tx, board, to, manifests, from) => {
      froms.push(from ?? '');
      return activity(tx, board, to, manifests, from);
    };
    await checks.check(boardId, now);
    const first = await check(watched.id);
    expect(first.before?.globIds).toEqual(before);
    await checks.check(boardId, now);
    const yearBefore = new Date(Date.parse(DECIDED) - EFFECT_LOOKBACK_DAYS * DAY).toISOString();
    expect(froms).toEqual([yearBefore, yearBefore]);
    expect(await check(watched.id)).toEqual({ ...first });
  });

  it('keeps the before side on every run past a glob first merged long ago that merged again before the approval (s15f8)', async () => {
    // Merge and continue: created 100 days before, first merged 90 days before, then a failing routine run and a
    // second merge 2 days before the approval. Its first merge ranks it behind the three before globs.
    const id = `s${String(boardId)}t${String(++n)}`;
    const sha = 'f00dfeedabcdef0';
    await store.transaction(async (tx) => {
      await tx.insertGlob(
        glob({ id, boardId, createdAt: at(-100 * DAY), updatedAt: at(-2 * DAY) }),
        null,
      );
      await tx.appendEvents([
        {
          type: 'RunTriggered',
          globId: id,
          actor: null,
          at: at(-100 * DAY),
          data: { runId: 'old' },
        },
        {
          type: 'Merged',
          globId: id,
          actor: null,
          at: at(-90 * DAY),
          data: { sha: 'old0000abcdef0' },
        },
        {
          type: 'RunTriggered',
          globId: id,
          actor: null,
          at: at(-3 * DAY),
          data: { runId: 'again' },
        },
        {
          type: 'CommitPushed',
          globId: id,
          actor: null,
          at: at(-3 * DAY + 60_000),
          data: { sha, runId: 'again' },
        },
        {
          type: 'BuildCompleted',
          globId: id,
          actor: null,
          at: at(-3 * DAY + 120_000),
          data: { sha, passed: false },
        },
        { type: 'Merged', globId: id, actor: null, at: at(-2 * DAY), data: { sha } },
      ]);
    });
    const before = await series(3, 0, -10 * DAY);
    await series(1, 0, DAY);
    const watched = await approved();
    await checks.check(boardId, now);
    const first = await check(watched.id);
    expect(first.before).toMatchObject({ affected: 0, globIds: before });
    await checks.check(boardId, now);
    expect((await check(watched.id)).before).toEqual(first.before);
  });

  it('keeps a glob whose work started long before the approval off the after side on every run (s15f8)', async () => {
    const before = await series(3, 0, -5 * DAY);
    // Work started 30 days before the approval, a second routine run after it, merged a day after it.
    const id = `s${String(boardId)}t${String(++n)}`;
    const sha = 'f00dfeedabcdef1';
    await store.transaction(async (tx) => {
      await tx.insertGlob(
        glob({ id, boardId, createdAt: at(-30 * DAY), updatedAt: at(DAY) }),
        null,
      );
      await tx.appendEvents([
        {
          type: 'RunTriggered',
          globId: id,
          actor: null,
          at: at(-30 * DAY),
          data: { runId: 'early' },
        },
        { type: 'RunTriggered', globId: id, actor: null, at: at(DAY / 2), data: { runId: 'late' } },
        {
          type: 'CommitPushed',
          globId: id,
          actor: null,
          at: at(DAY / 2 + 60_000),
          data: { sha, runId: 'late' },
        },
        {
          type: 'BuildCompleted',
          globId: id,
          actor: null,
          at: at(DAY / 2 + 120_000),
          data: { sha, passed: true },
        },
        { type: 'Merged', globId: id, actor: null, at: at(DAY), data: { sha } },
      ]);
    });
    const watched = await approved();
    await checks.check(boardId, now);
    const first = await check(watched.id);
    expect(first).toMatchObject({ before: { globIds: before }, after: { eligible: 0 } });
    await checks.check(boardId, now);
    expect(await check(watched.id)).toEqual(first);
  });

  it('checks only the items it is given when given some, leaving the others for the daily run (s15f8)', async () => {
    await series(3, 1, -5 * DAY);
    const mine = await approved();
    const other = await approved();
    const untouched = await item(other.id);
    expect(await checks.check(boardId, now, [mine.id])).toMatchObject({ watching: 1 });
    expect(await check(mine.id)).toMatchObject({ state: 'watching', before: { eligible: 3 } });
    expect(await item(other.id)).toEqual(untouched);
  });

  it("doesn't check a dependency signal: no check starts and the daily run leaves it alone (s15f8)", async () => {
    await series(3, 1, -5 * DAY);
    const dependency: KbSignal = {
      ...CI,
      key: 'dependency:zustand',
      kind: 'dependency',
      agent: null,
      label: 'zustand',
    };
    const old = await approved({ signal: dependency, effectCheck: null });
    expect(await checks.check(boardId, now)).toEqual({
      kind: 'effect_check',
      watching: 0,
      decided: [],
      raised: [],
    });
    expect((await item(old.id)).effectCheck).toBeNull();
    const open = await approved({
      status: 'open',
      signal: dependency,
      decidedBy: null,
      decidedAt: null,
      outcome: null,
    });
    const decided = unwrap(
      await knowledge.approve(ADMIN, open.id, open.version, { as: 'learning' }),
    );
    expect(decided).toMatchObject({ status: 'approved', signal: dependency, effectCheck: null });
  });

  describe('on approval', () => {
    /** A submitted learning from a glob. */
    const submitted = async (): Promise<string> => {
      const source = await merge({ mergedAt: at(-40 * DAY) });
      return unwrap(
        await knowledge.submitLearning(DEV, boardId, {
          sourceGlobId: source,
          type: 'gotcha',
          statement: 'Run the full checks first',
          evidence: 'CI failed',
        }),
      ).id;
    };

    it('lists the measured signals for admins, and watches the one an admin picks for a submitted item', async () => {
      now = at(-HOUR);
      await series(4, 2, -10 * DAY);
      const id = await submitted();
      const listed = unwrap(await knowledge.watchableSignals(ADMIN, boardId));
      expect(listed.map((s) => s.key)).toContain('ci_after_local');
      expect((await knowledge.watchableSignals(DEV, boardId)).ok).toBe(false);

      const before = await item(id);
      const unknown = await knowledge.approve(ADMIN, id, before.version, {
        as: 'learning',
        watchSignal: 'failure:nope',
      });
      expect(unknown.ok).toBe(false);
      expect(await item(id)).toEqual(before);

      const decided = unwrap(
        await knowledge.approve(ADMIN, id, before.version, {
          as: 'learning',
          watchSignal: 'ci_after_local',
        }),
      );
      expect(decided.signal).toMatchObject({
        key: 'ci_after_local',
        figures: { affected: 2, eligible: 4 },
      });
      expect(decided.effectCheck).toEqual({
        state: 'watching',
        key: 'ci_after_local',
        label: 'CI failing after local checks passed',
        basis: { kind: 'time', since: now },
        n: 3,
        before: null,
        after: null,
        worse: [],
        raisedItemId: null,
        checkedAt: null,
      });
      // The effect check owns the signal now: mining doesn't raise it while it is approved.
      const row = (await store.transaction((tx) => tx.listKbSignals(boardId))).find(
        (r) => r.key === 'ci_after_local',
      );
      expect(row?.itemId).toBe(id);
      const mined = await mining.mine(boardId, now);
      expect(mined.raised).toEqual([]);
    });

    it('refuses a watch signal for an item that has one', async () => {
      await series(4, 2, -10 * DAY);
      const id = await submitted();
      const current = await item(id);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...current, signal: CI, version: current.version + 1 }, current.version),
      );
      const refused = await knowledge.approve(ADMIN, id, current.version + 1, {
        as: 'learning',
        watchSignal: 'ci_after_local',
      });
      expect(refused.ok).toBe(false);
    });

    it('refuses a watch signal for a document proposal (s15f8)', async () => {
      // Measured now, so only the document rule refuses it.
      now = at(-HOUR);
      await series(4, 2, -10 * DAY);
      expect(unwrap(await knowledge.watchableSignals(ADMIN, boardId)).map((s) => s.key)).toContain(
        'ci_after_local',
      );
      const proposal = await approved({
        status: 'open',
        signal: null,
        decidedBy: null,
        decidedAt: null,
        outcome: null,
        document: {
          name: 'testing',
          area: 'testing',
          audience: [],
          description: 'How tests run',
          content: '# Testing\n',
        },
      });
      for (const as of ['document', 'draft'] as const) {
        const refused = await knowledge.approve(ADMIN, proposal.id, proposal.version, {
          as,
          watchSignal: 'ci_after_local',
        });
        expect(refused.ok ? null : refused.error).toMatchObject({
          code: 'invalid_input',
          message: expect.stringContaining("a document proposal doesn't watch a signal") as unknown,
        });
      }
      expect(await item(proposal.id)).toEqual(proposal);
    });

    it("doesn't offer or watch a dependency signal (s15f8)", async () => {
      const dependency: KbSignal = {
        ...CI,
        key: 'dependency:zustand',
        kind: 'dependency',
        agent: null,
        label: 'zustand',
      };
      const measured = new KnowledgeService({
        store,
        clock: { now: () => now },
        catalog,
        notifier,
        signals: { measure: () => Promise.resolve([dependency, CI]) },
      });
      expect(unwrap(await measured.watchableSignals(ADMIN, boardId)).map((s) => s.key)).toEqual([
        'ci_after_local',
      ]);
      const id = await submitted();
      const before = await item(id);
      const refused = await measured.approve(ADMIN, id, before.version, {
        as: 'learning',
        watchSignal: dependency.key,
      });
      expect(refused.ok).toBe(false);
      expect(await item(id)).toEqual(before);
    });

    it('watches an agent-file change that changed nothing by time, as no version has it (s15f8)', async () => {
      const edit = {
        as: 'edit',
        target: { kind: 'agent', name: 'agents/orchestrator.md' },
        content: '## Checks\n\nRun the full checks first.\n',
      } as const;
      const withSignal = async () => {
        const id = await submitted();
        const current = await item(id);
        await store.transaction((tx) =>
          tx.updateKbItem(
            { ...current, signal: CI, version: current.version + 1 },
            current.version,
          ),
        );
        return { id, version: current.version + 1 };
      };
      const first = await withSignal();
      unwrap(await knowledge.approve(ADMIN, first.id, first.version, edit));
      const version = unwrap(await boards.get(ADMIN, boardId)).board.agentSetVersion;
      const second = await withSignal();
      const decided = unwrap(await knowledge.approve(ADMIN, second.id, second.version, edit));
      expect(unwrap(await boards.get(ADMIN, boardId)).board.agentSetVersion).toBe(version);
      expect(decided.outcome).toEqual({
        kind: 'applied',
        target: 'agent',
        name: 'agents/orchestrator.md',
        version: expect.any(Number) as number,
      });
      expect(decided.effectCheck?.basis).toEqual({ kind: 'time', since: decided.decidedAt });
    });

    it('checks the approved item on its own when a run is already going, so its before figures come now (s15f8)', async () => {
      now = at(-HOUR);
      await series(4, 2, -10 * DAY);
      const jobs = new LearningJobService({
        store,
        clock: { now: () => now },
        notifier,
        mining,
        effectChecks: checks,
        manifests: null,
      });
      const id = await submitted();
      const decided = unwrap(
        await knowledge.approve(ADMIN, id, 1, { as: 'learning', watchSignal: 'ci_after_local' }),
      );
      expect(decided.effectCheck).toMatchObject({ state: 'watching', before: null });
      await store.transaction((tx) => tx.claimBoardJob(boardId, 'effect_check', now, HOUR));
      // Another watched item is the running run's to check, not this approval's.
      const other = await item((await approved()).id);
      expect((await jobs.runNow(ADMIN, boardId, 'effect_check')).ok).toBe(false);
      const checked = unwrap(await jobs.checkApproval(ADMIN, boardId, id));
      expect(checked).toEqual({ kind: 'effect_check', watching: 1, decided: [], raised: [] });
      expect(await check(id)).toMatchObject({ state: 'watching', before: { eligible: 3 } });
      expect(await item(other.id)).toEqual(other);
      expect((await jobs.checkApproval(DEV, boardId, id)).ok).toBe(false);
    });

    it("checks only the approved item on approval, leaving the board's job schedule alone (s15f8)", async () => {
      now = at(-HOUR);
      await series(4, 2, -10 * DAY);
      const jobs = new LearningJobService({
        store,
        clock: { now: () => now },
        notifier,
        mining,
        effectChecks: checks,
        manifests: null,
      });
      const other = await item((await approved()).id);
      const id = await submitted();
      unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'learning', watchSignal: 'ci_after_local' }));
      expect(unwrap(await jobs.checkApproval(ADMIN, boardId, id))).toEqual({
        kind: 'effect_check',
        watching: 1,
        decided: [],
        raised: [],
      });
      expect(await check(id)).toMatchObject({ state: 'watching', before: { eligible: 3 } });
      expect(await item(other.id)).toEqual(other);
      // Not recorded as a run, so the daily run is still due.
      expect(await store.transaction((tx) => tx.getBoardJob(boardId, 'effect_check'))).toBeNull();
      expect((await jobs.runDue()).filter((r) => r.job === 'effect_check')).toHaveLength(1);
    });

    it('starts no check for an approval without a signal', async () => {
      const id = await submitted();
      const decided = unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'learning' }));
      expect(decided.effectCheck).toBeNull();
    });

    it("watches an agent-file change from the board's new agent-set version", async () => {
      const id = await submitted();
      const current = await item(id);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...current, signal: CI, version: current.version + 1 }, current.version),
      );
      const versionBefore = unwrap(await boards.get(ADMIN, boardId)).board.agentSetVersion;
      const decided = unwrap(
        await knowledge.approve(ADMIN, id, current.version + 1, {
          as: 'edit',
          target: { kind: 'agent', name: 'agents/orchestrator.md' },
          content: '## Checks\n\nRun the full checks first.\n',
        }),
      );
      expect(decided.outcome).toMatchObject({
        kind: 'applied',
        agentSetVersion: versionBefore + 1,
      });
      expect(decided.effectCheck?.basis).toEqual({
        kind: 'agent_set',
        fromVersion: versionBefore + 1,
      });
    });

    it('watches the original signal when a revise-or-revert item is approved', async () => {
      await series(3, 1, -5 * DAY);
      await series(3, 1, DAY);
      const watched = await approved();
      const [raisedId] = (await checks.check(boardId, now)).raised;
      const raised = await item(raisedId ?? '');
      const decided = unwrap(
        await knowledge.approve(ADMIN, raised.id, raised.version, { as: 'learning' }),
      );
      expect(decided.signal?.key).toBe(`effect:${watched.id}`);
      expect(decided.effectCheck).toMatchObject({
        state: 'watching',
        key: 'ci_after_local',
        label: 'CI failing after local checks passed',
      });
    });
  });

  it('runs daily as a board job, with Run now for admins', async () => {
    await series(3, 1, -5 * DAY);
    await approved();
    const jobs = new LearningJobService({
      store,
      clock: { now: () => now },
      notifier,
      mining,
      effectChecks: checks,
      manifests: null,
    });
    const first = await jobs.runDue();
    expect(first.filter((r) => r.job === 'effect_check')).toEqual([
      {
        boardId,
        job: 'effect_check',
        result: { kind: 'effect_check', watching: 1, decided: [], raised: [] },
      },
    ]);
    expect((await jobs.runDue()).filter((r) => r.job === 'effect_check')).toEqual([]);
    now = new Date(Date.parse(now) + EFFECT_CHECK_INTERVAL_MS).toISOString();
    expect((await jobs.runDue()).filter((r) => r.job === 'effect_check')).toHaveLength(1);
    const started = unwrap(await jobs.runNow(ADMIN, boardId, 'effect_check'));
    expect((await started.finished).lastResult).toMatchObject({ kind: 'effect_check' });
    expect((await jobs.runNow(DEV, boardId, 'effect_check')).ok).toBe(false);
  });
});
