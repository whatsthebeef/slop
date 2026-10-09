import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { LearningJobService, SUB_LIMIT_INTERVAL_MS } from '../src/app/learning-jobs.js';
import { MiningService } from '../src/app/mining-service.js';
import { SubLimitService } from '../src/app/sub-limit-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent, DomainEventType, JsonValue } from '../src/domain/events.js';
import {
  SUB_LIMIT_MAX,
  SUB_LIMIT_MIN,
  SUB_LIMIT_STEP,
  gateVerdictOf,
  loweredLimit,
  nextLimit,
  namesGlob,
  raisedLimit,
  subLimitCandidates,
} from '../src/domain/sub-limit.js';
import type { Glob } from '../src/domain/types.js';
import type { SubDiffSource } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const OUTSIDER = 'outsider@example.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** When the sub merged. */
const MERGED = '2026-10-07T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(MERGED) + ms).toISOString();
const NOW = at(2 * HOUR);

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const event = (
  globId: string,
  type: DomainEventType,
  when: string,
  data: { readonly [key: string]: JsonValue },
): DomainEvent => ({
  type,
  globId,
  actor: null,
  at: when,
  data,
});

/** A fake findings model: answers in turn, or throws `LlmUnavailable` while `down`. */
class FakeLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  down = false;
  constructor(private readonly answers: string[] = []) {}
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    if (this.down)
      return Promise.reject(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    return Promise.resolve(this.answers.shift() ?? '{"caused": false, "quote": ""}');
  }
}

/** A size at least half of the 2000-line limit: a sub this large that needed fixes lowers it. */
const NEAR = 1500;

class FakeDiffs implements SubDiffSource {
  readonly asked: string[] = [];
  constructor(private readonly lines: number | null) {}
  mergedChangedLines(_board: unknown, sha: string): Promise<number | null> {
    this.asked.push(sha);
    return Promise.resolve(this.lines);
  }
}

describe('the sub-limit rule', () => {
  it('raises by a fixed step of 250, to exactly 5000 at most', () => {
    expect(SUB_LIMIT_STEP).toBe(250);
    expect(raisedLimit(2000)).toBe(2250);
    expect(raisedLimit(4750)).toBe(SUB_LIMIT_MAX);
    // Capped at the bound rather than stepping past it.
    expect(raisedLimit(4900)).toBe(SUB_LIMIT_MAX);
    expect(raisedLimit(SUB_LIMIT_MAX)).toBe(SUB_LIMIT_MAX);
    // Never lowers one set above the bounds before the limit was learned.
    expect(raisedLimit(8000)).toBe(8000);
  });

  it('lowers by a fixed step of 250, to exactly 200 at least', () => {
    expect(loweredLimit(2000)).toBe(1750);
    expect(loweredLimit(450)).toBe(SUB_LIMIT_MIN);
    // Floored at the bound rather than stepping past it.
    expect(loweredLimit(300)).toBe(SUB_LIMIT_MIN);
    expect(loweredLimit(SUB_LIMIT_MIN)).toBe(SUB_LIMIT_MIN);
    // Never raises one set below the bounds.
    expect(loweredLimit(150)).toBe(150);
  });

  it('moves by the step whatever the sub changed', () => {
    expect(nextLimit('merged_unchanged', 2000, 10)).toBe(2250);
    expect(nextLimit('needed_fixes', 2000, 1000)).toBe(1750);
  });

  it('lowers only for a sub that changed at least half the limit', () => {
    expect(nextLimit('needed_fixes', 2000, 999)).toBe(2000);
    expect(nextLimit('needed_fixes', 2000, 1000)).toBe(1750);
    expect(nextLimit('needed_fixes', 2000, null)).toBe(2000);
    expect(nextLimit('merged_unchanged', 2000, null)).toBe(2250);
  });

  it('reads gate verdicts recorded before line counts from their reason', () => {
    expect(
      gateVerdictOf(
        event('s1t1', 'SubReviewCompleted', MERGED, {
          sha: 'a',
          passed: false,
          reason: 'Changes 2898 lines (limit 2000)',
        }),
      ),
    ).toMatchObject({
      cause: 'size',
      changedLines: 2898,
      limit: 2000,
    });
    expect(
      gateVerdictOf(
        event('s1t1', 'SubReviewCompleted', MERGED, {
          sha: 'a',
          passed: false,
          reason: 'Touches sensitive paths: infra/x.ts',
        }),
      ),
    ).toMatchObject({
      cause: 'sensitive',
      changedLines: null,
    });
    expect(
      gateVerdictOf(
        event('s1t1', 'SubReviewCompleted', MERGED, { sha: 'a', passed: true, reason: null }),
      ),
    ).toMatchObject({
      cause: null,
      changedLines: null,
    });
    expect(
      gateVerdictOf(
        event('s1t1', 'SubReviewCompleted', MERGED, {
          sha: 'a',
          passed: true,
          reason: null,
          cause: null,
          changedLines: 12,
          limit: 2000,
        }),
      ),
    ).toMatchObject({
      changedLines: 12,
      limit: 2000,
    });
  });

  it('matches whole glob IDs only', () => {
    expect(namesGlob('Introduced by s15t1.', 's15t1')).toBe(true);
    expect(namesGlob('S15T1 broke it', 's15t1')).toBe(true);
    expect(namesGlob('Introduced by s15t10', 's15t1')).toBe(false);
    expect(namesGlob('as15t1', 's15t1')).toBe(false);
  });
});

describe('SubLimitService', () => {
  let store: MemoryStore;
  let boardId: number;

  const sub = (id: string, patch: Partial<Glob> = {}): Glob =>
    glob({
      id,
      boardId,
      type: 'sub',
      status: 'reviewing',
      title: `Change ${id}`,
      createdAt: at(-DAY),
      ...patch,
    });
  const bug = (id: string, created: string, summary: string, patch: Partial<Glob> = {}): Glob =>
    glob({
      id,
      boardId,
      type: 'same',
      category: 'bug',
      status: 'planning',
      title: `Bug ${id}`,
      summary,
      createdAt: created,
      ...patch,
    });

  const addGlobs = (...globs: Glob[]) => {
    for (const g of globs) store.state.globs.set(g.id, { glob: g, creationKey: null });
  };
  const addEvents = (...events: DomainEvent[]) => {
    store.state.events.push(...events);
  };
  /** A sub converted for its size at sha `c1`, merged as `m1` 4 hours later. */
  const converted = (id: string, lines = 2898) => [
    event(id, 'CommitPushed', at(-5 * HOUR), { sha: 'c1', runId: 'r1', fromSupersededRun: false }),
    event(id, 'SubReviewCompleted', at(-4 * HOUR), {
      sha: 'c1',
      passed: false,
      reason: `Changes ${lines} lines (limit 2000)`,
    }),
    event(id, 'Merged', MERGED, { sha: 'm1' }),
  ];
  /** A sub that passed the gate and merged, with or without a line count. */
  const passed = (id: string, lines: number | null) => [
    event(id, 'SubReviewCompleted', at(-1000), {
      sha: 'c1',
      passed: true,
      reason: null,
      ...(lines === null ? {} : { cause: null, changedLines: lines, limit: 2000 }),
    }),
    event(id, 'Merged', MERGED, { sha: `m-${id}` }),
  ];
  const limit = async () =>
    (await store.transaction((tx) => tx.getBoard(boardId)))?.subMaxChangedLines;
  const history = () => store.transaction((tx) => tx.listSubLimitChanges(boardId));
  const setLimit = async (lines: number) => {
    await store.transaction((tx) => tx.setSubLimit(boardId, 2000, lines));
  };
  const service = (llm?: Llm, diffs: SubDiffSource | null = new FakeDiffs(null)) =>
    new SubLimitService({
      store,
      notifier: new RecordingNotifier(),
      ...(llm === undefined ? {} : { llm }),
      diffs,
    });

  beforeEach(async () => {
    store = new MemoryStore();
    const board = unwrap(
      await store.transaction(async (tx) => {
        await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
        await tx.upsertUser({ email: OUTSIDER, name: 'Outsider', active: true });
        const b = await tx.insertBoard({
          name: 'demo',
          repo: 'acme/app',
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: ADMIN,
          environments: [],
          sensitivePaths: [],
        });
        await tx.upsertMember({ boardId: b.id, email: ADMIN, role: 'admin' });
        return { ok: true as const, value: b };
      }),
    );
    boardId = board.id;
  });

  describe('merged unchanged (raises)', () => {
    it('raises the limit once a converted sub merged with no further commits and is signed off, once', async () => {
      addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
      addEvents(...converted('s1t1'));
      const result = await service().learn(boardId, NOW, null);
      expect(result).toEqual({
        kind: 'sub_limit',
        limit: 2250,
        changes: [{ globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 }],
        asked: 0,
        waiting: 0,
      });
      expect(await limit()).toBe(2250);
      const [row] = await history();
      expect(row).toMatchObject({
        globId: 's1t1',
        outcome: 'merged_unchanged',
        fromLines: 2000,
        toLines: 2250,
        changedLines: 2898,
      });
      expect(row?.evidence).toMatch(/Converted at c1 for changing 2898 lines \(limit 2000\)/);
      // Idempotent: the outcome is recorded once, and the limit doesn't move again.
      expect((await service().learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([]);
      expect(await limit()).toBe(2250);
      expect(await history()).toHaveLength(1);
    });

    it('ignores a converted sub with a commit after the conversion, but not one from a superseded run', async () => {
      addGlobs(
        sub('s1t1', { type: 'same', status: 'signed_off' }),
        sub('s1t2', { type: 'same', status: 'signed_off' }),
      );
      addEvents(
        ...converted('s1t1'),
        event('s1t1', 'CommitPushed', at(-2 * HOUR), {
          sha: 'c2',
          runId: 'r1',
          fromSupersededRun: false,
        }),
        ...converted('s1t2', 2100),
        event('s1t2', 'CommitPushed', at(-2 * HOUR), {
          sha: 'c2',
          runId: 'r0',
          fromSupersededRun: true,
        }),
      );
      const result = await service().learn(boardId, NOW, null);
      expect(result.changes).toEqual([
        { globId: 's1t2', outcome: 'merged_unchanged', from: 2000, to: 2250 },
      ]);
    });

    it('ignores one whose review asked for changes, and one converted for a sensitive path', async () => {
      addGlobs(
        sub('s1t1', { type: 'same', status: 'signed_off' }),
        sub('s1t2', { type: 'same', status: 'signed_off' }),
      );
      addEvents(
        ...converted('s1t1'),
        event('s1t1', 'LabelChanged', at(HOUR), {
          label: 'CR',
          from: 'required',
          to: 'added',
          items: ['Split this'],
        }),
        event('s1t2', 'SubReviewCompleted', at(-HOUR), {
          sha: 'c1',
          passed: false,
          reason: 'Touches sensitive paths: infra/x.ts',
        }),
        event('s1t2', 'Merged', MERGED, { sha: 'm2' }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([]);
      expect(await limit()).toBe(2000);
    });

    it('waits for the sign-off, or raises on the first hourly run after the window has passed without one', async () => {
      addGlobs(sub('s1t1', { type: 'same', status: 'reviewing' }));
      addEvents(...converted('s1t1'));
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([]);
      // Hourly, each run an hour after the one before: nothing before the window ends.
      const before = at(14 * DAY - 30 * 60 * 1000);
      expect(
        (await service().learn(boardId, before, at(14 * DAY - 90 * 60 * 1000))).changes,
      ).toEqual([]);
      // The run after the window ends still reads the merge, and nobody asked for changes: it counts.
      expect(
        (await service().learn(boardId, at(14 * DAY + 30 * 60 * 1000), before)).changes,
      ).toEqual([{ globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 }]);
      expect(await history()).toHaveLength(1);
    });
  });

  describe('needed fixes (lowers)', () => {
    it('lowers the limit when a sign-off label asks for changes within 14 days of the merge', async () => {
      addGlobs(sub('s1t1'));
      addEvents(
        ...passed('s1t1', NEAR),
        event('s1t1', 'LabelChanged', at(HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: ['The cards overflow again'],
        }),
      );
      const result = await service().learn(boardId, NOW, null);
      expect(result.changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect((await history())[0]?.evidence).toBe(
        'QA review asked for changes: "The cards overflow again"',
      );
    });

    it('reads a line count missing from the verdict from the merge commit, and records the outcome without one', async () => {
      addGlobs(sub('s1t1'));
      addEvents(
        ...passed('s1t1', null),
        event('s1t1', 'LabelChanged', at(HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      const diffs = new FakeDiffs(NEAR);
      expect((await service(undefined, diffs).learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect(diffs.asked).toEqual(['m-s1t1']);
      expect((await history())[0]).toMatchObject({
        changedLines: NEAR,
        evidence: 'QA review asked for changes',
      });
      // Without a code host the count is unknown: the outcome is recorded, and says nothing about the limit.
      addGlobs(sub('s1t2'));
      addEvents(
        ...passed('s1t2', null),
        event('s1t2', 'LabelChanged', at(HOUR), {
          label: 'CR',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      expect(await service(undefined, null).learn(boardId, NOW, null)).toMatchObject({
        changes: [{ globId: 's1t2', outcome: 'needed_fixes', from: 1750, to: 1750 }],
        waiting: 0,
      });
      expect((await history())[0]).toMatchObject({ globId: 's1t2', changedLines: null });
    });

    it('records a small sub that needed fixes without moving the limit, and a sub at half the limit lowers it', async () => {
      addGlobs(sub('s1t1'), sub('s1t2'));
      const asked = (id: string, lines: number, ...rest: [number]) => [
        ...passed(id, lines),
        event(id, 'LabelChanged', at(HOUR + rest[0]), { label: 'QA', from: 'required', to: 'added', items: ['Broken'] }),
      ];
      addEvents(...asked('s1t1', 2, 0), ...asked('s1t2', 1000, 1));
      const result = await service().learn(boardId, NOW, null);
      expect(result.changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 2000 },
        { globId: 's1t2', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect(await limit()).toBe(1750);
      const rows = await history();
      expect(rows.find((r) => r.globId === 's1t1')).toMatchObject({ fromLines: 2000, toLines: 2000, changedLines: 2 });
      expect(rows.find((r) => r.globId === 's1t1')?.evidence).toContain('Too small to say anything about the limit');
      // Recorded once: a later run neither repeats it nor lowers the limit for the small sub.
      expect((await service().learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([]);
    });

    it("doesn't read the merge commit for a bug reference already answered, or one the model doesn't blame", async () => {
      const llm = new FakeLlm(['{"caused": false, "quote": ""}']);
      const diffs = new FakeDiffs(2);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'Related to s1t1.'));
      addEvents(...passed('s1t1', null));
      await service(llm, diffs).learn(boardId, NOW, null);
      await service(llm, diffs).learn(boardId, at(3 * HOUR), NOW);
      expect(llm.requests).toHaveLength(1);
      expect(diffs.asked).toEqual([]);
    });

    it('ignores labels after the window, and subs merged before it', async () => {
      addGlobs(sub('s1t1'));
      addEvents(
        ...passed('s1t1', NEAR),
        event('s1t1', 'LabelChanged', at(15 * DAY), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      expect((await service().learn(boardId, at(15 * DAY + HOUR), at(15 * DAY))).changes).toEqual(
        [],
      );
    });

    it('lowers on a bug that blames the sub, with the verified quote as evidence', async () => {
      const llm = new FakeLlm([
        '{"caused": true, "quote": "The defect was introduced by s1t1, which reverted the fix"}',
      ]);
      addGlobs(
        sub('s1t1'),
        bug(
          's1b2',
          at(HOUR),
          'Cards overflow. The defect was introduced by s1t1, which reverted the fix.',
        ),
      );
      addEvents(...passed('s1t1', NEAR));
      const result = await service(llm).learn(boardId, NOW, null);
      expect(result).toMatchObject({
        changes: [{ globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 }],
        asked: 1,
      });
      expect((await history())[0]?.evidence).toBe(
        's1b2: "The defect was introduced by s1t1, which reverted the fix"',
      );
      expect(llm.requests[0]?.prompt).toMatch(
        /Does this bug report say the defect was introduced by s1t1 \(Change s1t1\)\?/,
      );
      expect(llm.requests[0]?.prompt).toContain('Cards overflow.');
    });

    it("doesn't lower on 'caused: false', and doesn't ask about that bug again", async () => {
      const llm = new FakeLlm(['{"caused": false, "quote": ""}']);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'Related to s1t1, which touched the same file.'));
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).changes).toEqual([]);
      expect((await service(llm).learn(boardId, at(3 * HOUR), NOW)).asked).toBe(0);
      expect(llm.requests).toHaveLength(1);
      expect(await limit()).toBe(2000);
    });

    it('asks again about a bug whose report was edited', async () => {
      const llm = new FakeLlm();
      const first = bug('s1b2', at(HOUR), 'Related to s1t1.');
      addGlobs(sub('s1t1'), first);
      addEvents(...passed('s1t1', NEAR));
      await service(llm).learn(boardId, NOW, null);
      addGlobs({ ...first, summary: 'Related to s1t1. It was introduced by s1t1 after all.' });
      await service(llm).learn(boardId, at(3 * HOUR), NOW);
      expect(llm.requests).toHaveLength(2);
    });

    it("ignores an answer whose quote isn't in the bug report, or is too short", async () => {
      const llm = new FakeLlm([
        '{"caused": true, "quote": "s1t1 introduced a regression in the board"}',
        '{"caused": true, "quote": "s1t1"}',
      ]);
      addGlobs(
        sub('s1t1'),
        bug('s1b2', at(HOUR), 'Board looks wrong after s1t1.'),
        bug('s1b3', at(2 * HOUR), 'Broken by s1t1.'),
      );
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, at(3 * HOUR), null)).changes).toEqual([]);
      expect(llm.requests).toHaveLength(2);
      expect(await limit()).toBe(2000);
    });

    it('only asks about bug globs created after the merge that name the sub as a whole ID', async () => {
      const llm = new FakeLlm();
      addGlobs(
        sub('s1t1'),
        glob({
          id: 's1t9',
          boardId,
          category: 'task',
          title: 'Follow up',
          summary: 'The defect was introduced by s1t1',
          createdAt: at(HOUR),
        }),
        bug('s1b2', at(-HOUR), 'The defect was introduced by s1t1'),
        bug('s1b3', at(HOUR), 'The defect was introduced by s1t10'),
        bug('s1b4', at(15 * DAY), 'The defect was introduced by s1t1'),
      );
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).asked).toBe(0);
      expect(llm.requests).toEqual([]);
    });

    it('a label outcome wins over bug references: the model is not asked', async () => {
      const llm = new FakeLlm();
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(
        ...passed('s1t1', NEAR),
        event('s1t1', 'LabelChanged', at(2 * HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: ['Overflow'],
        }),
      );
      expect((await service(llm).learn(boardId, at(3 * HOUR), null)).changes).toHaveLength(1);
      expect(llm.requests).toEqual([]);
    });

    it('waits while the model is unavailable, without remembering the bug, and learns once it is back', async () => {
      const llm = new FakeLlm(['{"caused": true, "quote": "The defect was introduced by s1t1"}']);
      llm.down = true;
      addGlobs(
        sub('s1t1'),
        sub('s1t2'),
        bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'),
        bug('s1b3', at(HOUR), 'The defect was introduced by s1t2'),
      );
      addEvents(...passed('s1t1', NEAR), ...passed('s1t2', NEAR));
      const down = await service(llm).learn(boardId, NOW, null);
      // The first call finds it down; the second reference isn't asked.
      expect(down).toMatchObject({ changes: [], asked: 1, waiting: 2 });
      expect(llm.requests).toHaveLength(1);
      llm.down = false;
      const back = await service(llm).learn(boardId, at(3 * HOUR), NOW);
      expect(back.changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
    });

    it('a bug reference that waited while the model was down across the end of its window is still decided', async () => {
      const llm = new FakeLlm(['{"caused": true, "quote": "The defect was introduced by s1t1"}']);
      llm.down = true;
      addGlobs(sub('s1t1'), bug('s1b2', at(13 * DAY), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      // Hourly runs from day 13 to two days after the window ended, all with the model down.
      let last: string | null = null;
      for (let t = 13 * DAY + HOUR; t <= 16 * DAY; t += HOUR) {
        expect(await service(llm).learn(boardId, at(t), last)).toMatchObject({
          changes: [],
          waiting: 1,
        });
        last = at(t);
      }
      llm.down = false;
      expect((await service(llm).learn(boardId, at(16 * DAY + HOUR), last)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
    });

    it("doesn't call the model while it is known to be down: bug references wait, label outcomes are recorded", async () => {
      const llm = new FakeLlm();
      let down = true;
      const known = new SubLimitService({
        store,
        notifier: new RecordingNotifier(),
        llm,
        findingsDown: () => down,
        diffs: null,
      });
      addGlobs(
        sub('s1t1'),
        sub('s1t2'),
        bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'),
      );
      addEvents(
        ...passed('s1t1', NEAR),
        ...passed('s1t2', NEAR),
        event('s1t2', 'LabelChanged', at(HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      expect(await known.learn(boardId, NOW, null)).toMatchObject({
        changes: [{ globId: 's1t2', outcome: 'needed_fixes' }],
        asked: 0,
        waiting: 1,
      });
      expect(llm.requests).toEqual([]);
      down = false;
      expect((await known.learn(boardId, at(3 * HOUR), NOW)).asked).toBe(1);
    });

    it('skips a bug reference after 3 asks without a usable answer, and notes it', async () => {
      const llm = new FakeLlm(['not json', '{"caused": "maybe"}', 'still not json']);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect(await service(llm).learn(boardId, NOW, null)).toMatchObject({ asked: 1, waiting: 1 });
      expect(await service(llm).learn(boardId, at(3 * HOUR), NOW)).toMatchObject({
        asked: 1,
        waiting: 1,
      });
      const third = await service(llm).learn(boardId, at(4 * HOUR), at(3 * HOUR));
      expect(third).toMatchObject({ changes: [], asked: 1, waiting: 0, gaveUp: 1 });
      // Remembered: not asked again, and its attempts are no longer kept.
      expect((await service(llm).learn(boardId, at(5 * HOUR), at(4 * HOUR))).asked).toBe(0);
      expect(llm.requests).toHaveLength(3);
      expect(
        await store.transaction((tx) => tx.getBoardJobState(boardId, 'sub_limit')),
      ).toMatchObject({
        attempts: {},
      });
    });

    it("drops a reference's failed asks once its sub's bug outcome is recorded", async () => {
      const llm = new FakeLlm([
        'not json',
        '{"caused": true, "quote": "The defect was introduced by s1t1"}',
      ]);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect(await service(llm).learn(boardId, NOW, null)).toMatchObject({ asked: 1, waiting: 1 });
      const state = () => store.transaction((tx) => tx.getBoardJobState(boardId, 'sub_limit'));
      const before = (await state()) as { attempts: Record<string, number> };
      expect(Object.entries(before.attempts)).toEqual([[expect.stringMatching(/^s1t1:s1b2:/), 1]]);
      expect((await service(llm).learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect(await state()).toMatchObject({ attempts: {} });
    });

    it('counts timeouts towards the skip, but not asks made while the model is unavailable', async () => {
      // Answers only by failing once the deadline aborts the call.
      const slow: Llm = {
        complete: (request) =>
          new Promise<string>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      };
      const timing = new SubLimitService({
        store,
        notifier: new RecordingNotifier(),
        llm: slow,
        diffs: null,
        llmTimeoutMs: 5,
      });
      const down = new FakeLlm();
      down.down = true;
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      await service(down).learn(boardId, NOW, null);
      await service(down).learn(boardId, NOW, null);
      expect(await timing.learn(boardId, NOW, null)).toMatchObject({ waiting: 1 });
      expect(await timing.learn(boardId, NOW, null)).toMatchObject({ waiting: 1 });
      expect(await timing.learn(boardId, NOW, null)).toMatchObject({ waiting: 0, gaveUp: 1 });
    });

    it('records an outcome that leaves the limit as it is, at the lower bound, so it is not checked again', async () => {
      await setLimit(SUB_LIMIT_MIN);
      addGlobs(sub('s1t1'));
      addEvents(
        ...passed('s1t1', 0),
        event('s1t1', 'LabelChanged', at(HOUR), {
          label: 'FR',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 200, to: 200 },
      ]);
      expect(await history()).toHaveLength(1);
      expect((await service().learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([]);
    });

    it('applies outcomes in order, each to the limit the one before left', async () => {
      addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }), sub('s1t2'));
      addEvents(
        ...converted('s1t1'),
        ...passed('s1t2', NEAR),
        event('s1t2', 'LabelChanged', at(HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: [],
        }),
      );
      const result = await service().learn(boardId, NOW, null);
      expect(result.changes).toEqual([
        { globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
        { globId: 's1t2', outcome: 'needed_fixes', from: 2250, to: 2000 },
      ]);
      expect(result.limit).toBe(2000);
      // Newest first.
      expect((await history()).map((c) => c.globId)).toEqual(['s1t2', 's1t1']);
    });
  });

  it('finds the merge after the last gate verdict before it (a failed merge goes through the gate again)', () => {
    const candidates = subLimitCandidates({
      events: [
        event('s1t1', 'SubReviewCompleted', at(-2 * HOUR), {
          sha: 'c0',
          passed: false,
          reason: 'Changes 2500 lines (limit 2000)',
        }),
        event('s1t1', 'SubReviewCompleted', at(-HOUR), {
          sha: 'c1',
          passed: true,
          reason: null,
          changedLines: 30,
        }),
        event('s1t1', 'Merged', MERGED, { sha: 'm1' }),
        event('s1t1', 'LabelChanged', at(HOUR), { label: 'QA', from: 'required', to: 'added' }),
      ],
      globs: [],
      recorded: new Set(),
      mergedSince: at(-DAY),
      now: NOW,
    });
    expect(candidates).toEqual([
      expect.objectContaining({ kind: 'needed_fixes', changedLines: 30, mergeSha: 'm1' }),
    ]);
  });

  it('shows members the limit, its bounds and its history; others are refused', async () => {
    addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
    addEvents(...converted('s1t1'));
    await service().learn(boardId, NOW, null);
    const view = unwrap(await service().view(ADMIN, boardId));
    expect(view).toMatchObject({ current: 2250, bounds: { min: 200, max: 5000, step: 250 } });
    expect(view.history).toHaveLength(1);
    const refused = await service().view(OUTSIDER, boardId);
    expect(refused.ok ? null : refused.error.code).toBe('forbidden');
  });

  it("isn't an admin setting: a settings save neither sets it nor undoes a learned move", async () => {
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
    addEvents(...converted('s1t1'));
    const before = unwrap(await boards.get(ADMIN, boardId)).board;
    await service().learn(boardId, NOW, null);
    // The admin's form was loaded before the move; its save carries the old board.
    const settings = { name: 'renamed', subMaxChangedLines: 100 };
    unwrap(await boards.updateSettings(ADMIN, boardId, before.version, settings));
    expect(await limit()).toBe(2250);
  });

  it('runs hourly as a board job, and admins can run it now', async () => {
    const mining = new MiningService({ store, notifier: new RecordingNotifier() });
    let now = NOW;
    const jobs = new LearningJobService({
      store,
      clock: { now: () => now },
      notifier: new RecordingNotifier(),
      mining,
      subLimit: service(),
      manifests: null,
    });
    addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
    addEvents(...converted('s1t1'));
    const ran = await jobs.runDue();
    expect(ran.find((r) => r.job === 'sub_limit')?.result).toMatchObject({
      kind: 'sub_limit',
      limit: 2250,
    });
    now = new Date(Date.parse(NOW) + SUB_LIMIT_INTERVAL_MS - 1000).toISOString();
    expect((await jobs.runDue()).some((r) => r.job === 'sub_limit')).toBe(false);
    now = new Date(Date.parse(NOW) + SUB_LIMIT_INTERVAL_MS).toISOString();
    expect((await jobs.runDue()).some((r) => r.job === 'sub_limit')).toBe(true);
    const started = unwrap(await jobs.runNow(ADMIN, boardId, 'sub_limit'));
    expect((await started.finished).lastResult).toMatchObject({ kind: 'sub_limit', changes: [] });
  });

  it("a failed run doesn't move the point the next run reads merges from", async () => {
    const calls: (string | null)[] = [];
    let failing = false;
    class Flaky extends SubLimitService {
      override learn(id: number, now: string, lastRunAt: string | null) {
        calls.push(lastRunAt);
        return failing
          ? Promise.reject(new Error('database unavailable'))
          : super.learn(id, now, lastRunAt);
      }
    }
    let now = NOW;
    const jobs = new LearningJobService({
      store,
      clock: { now: () => now },
      notifier: new RecordingNotifier(),
      mining: new MiningService({ store, notifier: new RecordingNotifier() }),
      subLimit: new Flaky({ store, notifier: new RecordingNotifier(), diffs: null }),
      manifests: null,
    });
    await jobs.runDue();
    failing = true;
    now = at(2 * HOUR + SUB_LIMIT_INTERVAL_MS);
    expect((await jobs.runDue()).find((r) => r.job === 'sub_limit')?.result.kind).toBe('failed');
    failing = false;
    now = at(2 * HOUR + 3 * DAY);
    await jobs.runDue();
    expect(calls).toEqual([null, NOW, NOW]);
  });

  describe('edge cases (tester, s15f8 strand 5)', () => {
    const qaAdded = (globId: string, when: string) =>
      event(globId, 'LabelChanged', when, {
        label: 'QA',
        from: 'required',
        to: 'added',
        items: ['Fix it'],
      });

    it('counts a label moved to added up to exactly 14 days after the merge, and not a moment later', async () => {
      addGlobs(sub('s1t1'), sub('s1t2'));
      addEvents(
        ...passed('s1t1', NEAR),
        qaAdded('s1t1', at(14 * DAY)),
        ...passed('s1t2', NEAR),
        qaAdded('s1t2', at(14 * DAY + 1)),
      );
      // The job last ran just before the merges, so both subs are in reach although the window has passed.
      const result = await service().learn(boardId, at(15 * DAY), at(-HOUR));
      expect(result.changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
    });

    it('counts a label or a bug that arrives in the last hour of the window, on the hourly run after it ends', async () => {
      const llm = new FakeLlm(['{"caused": true, "quote": "The defect was introduced by s1t2"}']);
      addGlobs(sub('s1t1'), sub('s1t2'));
      addEvents(...passed('s1t1', NEAR), ...passed('s1t2', NEAR));
      const before = at(14 * DAY - 30 * 60 * 1000);
      expect(
        (await service(llm).learn(boardId, before, at(14 * DAY - 90 * 60 * 1000))).changes,
      ).toEqual([]);
      // Both arrive after that run, 10 minutes before the window ends; the next run, after it, finds both.
      addGlobs(bug('s1b3', at(14 * DAY - 10 * 60 * 1000), 'The defect was introduced by s1t2'));
      addEvents(qaAdded('s1t1', at(14 * DAY - 10 * 60 * 1000)));
      expect(
        (await service(llm).learn(boardId, at(14 * DAY + 30 * 60 * 1000), before)).changes,
      ).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
        { globId: 's1t2', outcome: 'needed_fixes', from: 1750, to: 1500 },
      ]);
    });

    it('ignores a label moved to added before the merge', async () => {
      addGlobs(sub('s1t1'));
      addEvents(
        event('s1t1', 'SubReviewCompleted', at(-2 * HOUR), {
          sha: 'c1',
          passed: true,
          reason: null,
          cause: null,
          changedLines: 400,
          limit: 2000,
        }),
        qaAdded('s1t1', at(-HOUR)),
        event('s1t1', 'Merged', MERGED, { sha: 'm1' }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([]);
    });

    it('still counts a label that moved to added and was later cleared: fixes were asked for', async () => {
      addGlobs(sub('s1t1', { status: 'signed_off' }));
      addEvents(
        ...passed('s1t1', NEAR),
        event('s1t1', 'LabelChanged', at(HOUR), {
          label: 'CR',
          from: 'required',
          to: 'added',
          items: ['Rename it'],
        }),
        event('s1t1', 'LabelChanged', at(90 * 60 * 1000), {
          label: 'CR',
          from: 'added',
          to: 'approved',
        }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect((await history())[0]?.evidence).toBe('CR review asked for changes: "Rename it"');
    });

    it('a converted sub raises with the window passed and no sign-off, but not once a label was added and cleared', async () => {
      addGlobs(
        sub('s1t1', { type: 'same', status: 'reviewing' }),
        sub('s1t2', { type: 'same', status: 'signed_off' }),
      );
      addEvents(
        ...converted('s1t1', 2100),
        ...converted('s1t2', 2100),
        event('s1t2', 'LabelChanged', at(HOUR), {
          label: 'FR',
          from: 'required',
          to: 'added',
          items: ['More'],
        }),
        event('s1t2', 'LabelChanged', at(90 * 60 * 1000), {
          label: 'FR',
          from: 'added',
          to: 'approved',
        }),
      );
      expect((await service().learn(boardId, at(14 * DAY + 1), at(-HOUR))).changes).toEqual([
        { globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
      ]);
    });

    it('earlier commits, a commit pushed after the merge, or the converted sha pushed again, do not disqualify a raise', async () => {
      addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
      addEvents(
        event('s1t1', 'CommitPushed', at(-6 * HOUR), {
          sha: 'c0',
          runId: 'r1',
          fromSupersededRun: false,
        }),
        ...converted('s1t1', 2100),
        event('s1t1', 'CommitPushed', at(-2 * HOUR), {
          sha: 'c1',
          runId: 'r1',
          fromSupersededRun: false,
        }),
        event('s1t1', 'CommitPushed', at(HOUR), {
          sha: 'c9',
          runId: 'r2',
          fromSupersededRun: false,
        }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
      ]);
    });

    it('raises from a verdict recorded with cause and line count fields, and ignores a sensitive one with a line count', async () => {
      addGlobs(
        sub('s1t1', { type: 'same', status: 'signed_off' }),
        sub('s1t2', { type: 'same', status: 'signed_off' }),
      );
      addEvents(
        event('s1t1', 'SubReviewCompleted', at(-HOUR), {
          sha: 'c1',
          passed: false,
          reason: 'Changes 2100 lines (limit 2000)',
          cause: 'size',
          changedLines: 2100,
          limit: 2000,
        }),
        event('s1t1', 'Merged', MERGED, { sha: 'm1' }),
        event('s1t2', 'SubReviewCompleted', at(-HOUR), {
          sha: 'c1',
          passed: false,
          reason: 'Touches sensitive paths: infra/x.ts',
          cause: 'sensitive',
          changedLines: 2500,
          limit: 2000,
        }),
        event('s1t2', 'Merged', MERGED, { sha: 'm2' }),
      );
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
      ]);
    });

    it('a bug created up to 14 days after the merge counts, a bug created later does not', async () => {
      const llm = new FakeLlm([
        '{"caused": true, "quote": "The defect was introduced by s1t1"}',
        '{"caused": true, "quote": "The defect was introduced by s1t2"}',
      ]);
      addGlobs(
        sub('s1t1'),
        sub('s1t2'),
        bug('s1b1', at(14 * DAY), 'The defect was introduced by s1t1'),
        bug('s1b2', at(14 * DAY + 1), 'The defect was introduced by s1t2'),
      );
      addEvents(...passed('s1t1', NEAR), ...passed('s1t2', NEAR));
      const result = await service(llm).learn(boardId, at(15 * DAY), at(-HOUR));
      expect(result.changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
      expect(llm.requests).toHaveLength(1);
    });

    it('a bug glob created at the same moment as the merge does not count', async () => {
      const llm = new FakeLlm();
      addGlobs(sub('s1t1'), bug('s1b2', MERGED, 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).asked).toBe(0);
    });

    it('a bug naming the sub only in its title counts', async () => {
      const llm = new FakeLlm(['{"caused": true, "quote": "Regression introduced by s1t1"}']);
      addGlobs(
        sub('s1t1'),
        bug('s1b2', at(HOUR), 'Cards overflow.', { title: 'Regression introduced by s1t1' }),
      );
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
    });

    it("'caused: false' does not count even with a verified quote", async () => {
      const llm = new FakeLlm(['{"caused": false, "quote": "The defect was introduced by s1t1"}']);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).changes).toEqual([]);
      expect(await limit()).toBe(2000);
    });

    it('a verified quote that is too short does not count, and the answer is remembered', async () => {
      const llm = new FakeLlm(['{"caused": true, "quote": "s1t1"}']);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect((await service(llm).learn(boardId, NOW, null)).changes).toEqual([]);
      expect((await service(llm).learn(boardId, at(3 * HOUR), NOW)).asked).toBe(0);
      expect(llm.requests).toHaveLength(1);
    });

    it('an unusable answer is not remembered: the bug is asked about again on the next run', async () => {
      const llm = new FakeLlm([
        'not json',
        '{"caused": true, "quote": "The defect was introduced by s1t1"}',
      ]);
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect(await service(llm).learn(boardId, NOW, null)).toMatchObject({
        changes: [],
        asked: 1,
        waiting: 1,
      });
      expect((await service(llm).learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([
        { globId: 's1t1', outcome: 'needed_fixes', from: 2000, to: 1750 },
      ]);
    });

    it('without a model, bug references wait and nothing is remembered', async () => {
      addGlobs(sub('s1t1'), bug('s1b2', at(HOUR), 'The defect was introduced by s1t1'));
      addEvents(...passed('s1t1', NEAR));
      expect(await service().learn(boardId, NOW, null)).toMatchObject({
        changes: [],
        asked: 0,
        waiting: 1,
      });
      expect(await store.transaction((tx) => tx.getBoardJobState(boardId, 'sub_limit'))).toBeNull();
    });

    it('a raise that leaves the limit as it is, at the upper bound, is still recorded, and not checked again', async () => {
      await setLimit(SUB_LIMIT_MAX);
      addGlobs(sub('s1t1', { type: 'same', status: 'signed_off' }));
      addEvents(...converted('s1t1', 6000));
      expect((await service().learn(boardId, NOW, null)).changes).toEqual([
        { globId: 's1t1', outcome: 'merged_unchanged', from: 5000, to: 5000 },
      ]);
      expect(await history()).toHaveLength(1);
      expect((await service().learn(boardId, at(3 * HOUR), NOW)).changes).toEqual([]);
    });
  });
});

describe('the sub-limit rule at the edges (tester, s15f8 strand 5)', () => {
  it('keeps both bounds', () => {
    expect(raisedLimit(4999)).toBe(SUB_LIMIT_MAX);
    expect(loweredLimit(201)).toBe(SUB_LIMIT_MIN);
  });

  it('a passed verdict is never a size conversion, whatever its reason says', () => {
    expect(
      gateVerdictOf(
        event('s1t1', 'SubReviewCompleted', MERGED, {
          sha: 'a',
          passed: true,
          reason: 'Changes 2898 lines (limit 2000)',
        }),
      ),
    ).toMatchObject({ passed: true, cause: null });
  });
});
