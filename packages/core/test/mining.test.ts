import { beforeEach, describe, expect, it } from 'vitest';
import type { Llm } from '../src/app/intake-service.js';
import { KbPipeline } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import { FAILED_RETRY_MAX_MS, isJobDue, LearningJobService, MINING_INTERVAL_MS } from '../src/app/learning-jobs.js';
import { MINED_BY, MiningService } from '../src/app/mining-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import type { KbItem } from '../src/domain/kb.js';
import type { BoardJob, BoardJobResult, ManifestChange, MergedCommit } from '../src/domain/signals.js';
import type { Board } from '../src/domain/types.js';
import type { Catalog, ManifestSource, Store } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const START = '2026-10-07T12:00:00.000Z';
const later = (ms: number, from = START) => new Date(Date.parse(from) + ms).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const BUILD_DOC =
  '---\narea: build\naudience: [implementer, tester]\ndescription: Build and test commands\n---\n# Build\n\n## Test\n\nRun vitest.\n';

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'h1', files: [] }),
};

/** A fake LLM answering from a queue of canned answers, recording each request (as in the KB pipeline tests). */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(private readonly answers: string[] = []) {}
  answer(...answers: string[]): void {
    this.answers.push(...answers);
  }
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt });
    const next = this.answers.shift();
    return next === undefined ? Promise.reject(new Error('No canned answer')) : Promise.resolve(next);
  }
}

describe('Mining: mined KB items and the re-raise rules', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let mining: MiningService;
  let board: Board;
  let n: number;

  /** `count` globs whose runs ended: the first `superseded` of them by a start again. */
  const runs = async (count: number, superseded: number, at: string) => {
    const events: DomainEvent[] = [];
    for (let i = 0; i < count; i++) {
      const id = `s${String(board.id)}t${String(++n)}`;
      await store.transaction((tx) => tx.insertGlob(glob({ id, boardId: board.id }), null));
      events.push({
        type: 'RunEnded',
        globId: id,
        actor: null,
        at,
        data: { runId: `r${String(n)}`, outcome: i < superseded ? 'superseded' : 'completed', cause: 'start_again' },
      });
    }
    await store.transaction((tx) => tx.appendEvents(events));
  };

  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  const decide = async (id: string, patch: Partial<KbItem>) => {
    const current = await item(id);
    await store.transaction((tx) => tx.updateKbItem({ ...current, ...patch, version: current.version + 1 }, current.version));
  };
  const signalRow = async (key: string) => (await store.transaction((tx) => tx.listKbSignals(board.id))).find((r) => r.key === key);
  const items = () => store.transaction((tx) => tx.listKbItems(board.id));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    mining = new MiningService({ store, notifier });
    n = 0;
    board = await store.transaction(async (tx) => {
      const created = await tx.insertBoard({ name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      const versioned = { ...created, agentSetVersion: 7, version: 2 };
      await tx.updateBoard(versioned, created.version);
      return versioned;
    });
  });

  it('raises a crossed signal as an open, unprocessed mined item with its signal and figures as evidence', async () => {
    await runs(10, 3, later(-2 * DAY));
    const result = await mining.mine(board.id, START);
    expect(result).toEqual({ kind: 'mining', measured: 1, crossed: 1, raised: [`s${String(board.id)}k1`], refreshed: [] });
    const mined = await item(result.raised[0] ?? '');
    expect(mined).toMatchObject({
      status: 'open',
      type: 'agent-behaviour',
      source: 'mined',
      submittedBy: MINED_BY,
      agentSetVersion: 7,
      suggestedTarget: 'agents/orchestrator.md',
      sourceGlobIds: ['s1t1', 's1t2', 's1t3'],
      processing: 'pending',
      target: null,
      draft: null,
      signal: {
        key: 'run_superseded',
        kind: 'run_superseded',
        agent: 'orchestrator',
        window: { from: later(-28 * DAY), to: START },
        figures: { affected: 3, eligible: 10, rate: 0.3, count: 3 },
        globIds: ['s1t1', 's1t2', 's1t3'],
        measuredAt: START,
      },
    });
    expect(mined.statement).toBe('Routine runs keep ending with someone taking over or starting again: 3 of 10 ended routine runs in the last 4 weeks.');
    // The occurrences repeat the 3 runs, so they aren't given again.
    expect(mined.evidence).toContain('Figures: 3 of 10 (30%).');
    expect(mined.evidence).toContain('Threshold: at least 3 runs and 20% of ended routine runs.');
    expect(mined.evidence).toContain('- s1t1: start again on 2026-10-05');
    expect(await signalRow('run_superseded')).toEqual({
      boardId: board.id,
      key: 'run_superseded',
      itemId: mined.id,
      lastFigures: { affected: 3, eligible: 10, rate: 0.3, count: 3 },
      lastMeasuredAt: START,
      raisedAt: START,
      belowThresholdRuns: 0,
    });
    expect(notifier.hints).toEqual([{ kind: 'board.kb', boardId: board.id }]);
  });

  it('raises nothing below the threshold, and keeps nothing for a signal it never raised', async () => {
    await runs(10, 1, later(-2 * DAY));
    expect(await mining.mine(board.id, START)).toEqual({ kind: 'mining', measured: 1, crossed: 0, raised: [], refreshed: [] });
    expect(await items()).toEqual([]);
    expect(await signalRow('run_superseded')).toBeUndefined();
    expect(notifier.hints).toEqual([]);
  });

  it('is routed, deduplicated and drafted by the KB pipeline like a submitted item', async () => {
    const knowledge = new KnowledgeService({ store, clock: { now: () => START }, catalog, notifier });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
    });
    unwrap(await knowledge.importDocuments(ADMIN, board.id, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'upload'));
    const route = new FakeLlm();
    const draft = new FakeLlm();
    const pipeline = new KbPipeline({ store, clock: { now: () => START }, catalog, notifier, route, draft });
    await runs(10, 3, later(-2 * DAY));
    const [id] = (await mining.mine(board.id, START)).raised;

    route.answer(
      JSON.stringify({ target: { kind: 'document', name: 'build_test_lint', section: '## Test', newDocument: null }, catalogCandidate: false, catalogReason: null }),
      JSON.stringify({ suppressedBy: null, duplicateOf: null, coveredBy: null, contradicts: [] }),
    );
    expect(await pipeline.processNext()).toBe(id);
    expect(route.calls[0]?.prompt).toContain('Routine runs keep ending with someone taking over or starting again');
    expect(await item(id ?? '')).toMatchObject({ processing: 'routed', target: { kind: 'doc', name: 'build_test_lint', section: 'Test' } });

    draft.answer(JSON.stringify({ section: 'Test', content: '## Test\n\nRun vitest. Starting again needs a reason.\n', rationale: 'Adds the rule' }));
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id ?? '')).toMatchObject({ status: 'open', processing: 'drafted', source: 'mined', draft: { section: 'Test' } });
  });

  it('refreshes an open item weekly (figures and a line of evidence) without raising or drafting again', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [id] = (await mining.mine(board.id, START)).raised;
    await decide(id ?? '', { processing: 'drafted', draft: { section: null, content: 'x' }, draftedAgainstVersion: 1 });
    const before = await item(id ?? '');
    await runs(2, 2, later(-DAY));

    const nextWeek = later(WEEK);
    expect(await mining.mine(board.id, nextWeek)).toMatchObject({ raised: [], refreshed: [id] });
    const refreshed = await item(id ?? '');
    expect(refreshed).toMatchObject({
      processing: 'drafted',
      draft: { section: null, content: 'x' },
      signal: { figures: { affected: 5, eligible: 12, rate: 0.417, count: 5 }, measuredAt: nextWeek },
      version: before.version + 1,
    });
    expect(refreshed.evidence).toBe(`${before.evidence}\nWeek of ${nextWeek.slice(0, 10)}: 5/12 (42%)`);
    expect(refreshed.sourceGlobIds).toEqual(['s1t1', 's1t2', 's1t3', 's1t11', 's1t12']);
    expect((await items()).length).toBe(1);
    // Run now again the same day: the same figures add nothing.
    expect(await mining.mine(board.id, nextWeek)).toMatchObject({ raised: [], refreshed: [] });
    expect((await item(id ?? '')).version).toBe(refreshed.version);
  });

  it("clears a stale flag when a refresh adds the week's evidence (s15f8)", async () => {
    await runs(10, 3, later(-2 * DAY));
    const [id] = (await mining.mine(board.id, START)).raised;
    await decide(id ?? '', {
      processing: 'drafted',
      draft: { section: null, content: 'x' },
      draftedAgainstVersion: 1,
      staleSince: START,
      staleReason: 'signal_below_threshold',
    });
    await runs(2, 2, later(-DAY));
    expect(await mining.mine(board.id, later(WEEK))).toMatchObject({ refreshed: [id] });
    expect(await item(id ?? '')).toMatchObject({ status: 'open', staleSince: null, staleReason: null });
  });

  it('never raises an approved or covered signal again, however long it has been', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [approved] = (await mining.mine(board.id, START)).raised;
    await decide(approved ?? '', { status: 'approved', decidedBy: ADMIN, decidedAt: START });
    const muchLater = later(20 * WEEK);
    await runs(10, 8, later(-DAY, muchLater));
    expect(await mining.mine(board.id, muchLater)).toMatchObject({ crossed: 1, raised: [], refreshed: [] });
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: approved, lastMeasuredAt: muchLater, belowThresholdRuns: 0 });

    await decide(approved ?? '', { status: 'covered', coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build_test_lint', section: null } });
    expect(await mining.mine(board.id, later(DAY, muchLater))).toMatchObject({ raised: [] });
  });

  it('follows a merged item to the item it was merged into: refreshed while that is open, never again once approved', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    const survivor: KbItem = { ...(await item(mined ?? '')), id: 's1k99', signal: null, evidence: 'Submitted', version: 1 };
    await store.transaction((tx) => tx.insertKbItem(survivor));
    await decide(mined ?? '', { status: 'merged', duplicateOf: survivor.id });

    expect(await mining.mine(board.id, later(WEEK))).toMatchObject({ raised: [], refreshed: [survivor.id] });
    expect(await item(survivor.id)).toMatchObject({ signal: { key: 'run_superseded' }, evidence: `Submitted\nWeek of ${later(WEEK).slice(0, 10)}: 3/10 (30%)` });

    await decide(survivor.id, { status: 'approved', decidedAt: later(WEEK) });
    expect(await mining.mine(board.id, later(30 * WEEK))).toMatchObject({ raised: [], refreshed: [] });
  });

  it('keeps a rejected signal quiet for 12 weeks, then raises it again only at 1.5× its rate at rejection', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [rejected] = (await mining.mine(board.id, START)).raised;
    await decide(rejected ?? '', { status: 'rejected', decidedBy: ADMIN, decidedAt: START, decisionReason: 'Starting again is fine' });

    // Within 12 weeks: quiet, even at a much higher rate.
    const eleventhWeek = later(11 * WEEK);
    await runs(4, 4, later(-DAY, eleventhWeek));
    expect(await mining.mine(board.id, eleventhWeek)).toMatchObject({ crossed: 1, raised: [] });

    // After 12 weeks (the week-11 runs out of the window), 40% isn't 1.5× 30%: still quiet.
    const afterQuiet = later(17 * WEEK);
    await runs(10, 4, later(-DAY, afterQuiet));
    const quiet = await mining.mine(board.id, afterQuiet);
    expect(quiet).toMatchObject({ crossed: 1, raised: [] });
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: rejected, lastFigures: { affected: 4, eligible: 10 } });

    // 45% is 1.5× 30%: raised again as a new item.
    const reRaisedAt = later(23 * WEEK);
    await runs(20, 9, later(-DAY, reRaisedAt));
    const again = await mining.mine(board.id, reRaisedAt);
    expect(again.raised).toHaveLength(1);
    expect(again.raised[0]).not.toBe(rejected);
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: again.raised[0], raisedAt: reRaisedAt });
  });

  it("compares with the signal's own rate at rejection, not that of a survivor raised for another signal (s15f8)", async () => {
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    const base = await item(mined ?? '');
    const survivor: KbItem = {
      ...base,
      id: 's1k70',
      status: 'rejected',
      decidedAt: START,
      signal: base.signal === null ? null : { ...base.signal, key: 'failure:timeout', kind: 'failure', figures: { affected: 9, eligible: 10, rate: 0.9, count: 9 } },
      version: 1,
    };
    await store.transaction((tx) => tx.insertKbItem(survivor));
    await decide(mined ?? '', { status: 'merged', duplicateOf: survivor.id });
    // 45% is 1.5× run_superseded's 30%, though far below the survivor's 90%.
    const reRaisedAt = later(13 * WEEK);
    await runs(20, 9, later(-DAY, reRaisedAt));
    expect((await mining.mine(board.id, reRaisedAt)).raised).toHaveLength(1);
  });

  it('raises a signal again when the chain of merged items runs past 10 links (s15f8)', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    const base = await item(mined ?? '');
    // A loop: the mined item and a submitted one merged into each other.
    const other: KbItem = { ...base, id: 's1k80', status: 'merged', duplicateOf: base.id, signal: null, version: 1 };
    await store.transaction((tx) => tx.insertKbItem(other));
    await decide(base.id, { status: 'merged', duplicateOf: other.id });
    const again = await mining.mine(board.id, later(WEEK));
    expect(again.raised).toHaveLength(1);
    expect(again.raised[0]).not.toBe(base.id);
  });

  it('treats a suppressed item like a rejected one, quiet from when it was raised', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [suppressed] = (await mining.mine(board.id, START)).raised;
    await decide(suppressed ?? '', { status: 'suppressed', suppressedBy: 's1k50' });
    await runs(1, 1, later(-DAY, later(WEEK)));
    expect(await mining.mine(board.id, later(WEEK))).toMatchObject({ raised: [] });
    const quarterLater = later(12 * WEEK);
    await runs(4, 4, later(-DAY, quarterLater));
    expect((await mining.mine(board.id, quarterLater)).raised).toHaveLength(1);
  });

  it('counts the runs a raised signal has been below its threshold or unmeasured, and resets on crossing', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [id] = (await mining.mine(board.id, START)).raised;
    // Next week: still in the window, diluted below 20%.
    await runs(10, 0, later(-DAY, later(WEEK)));
    expect(await mining.mine(board.id, later(WEEK))).toMatchObject({ crossed: 0, refreshed: [] });
    expect(await signalRow('run_superseded')).toMatchObject({ belowThresholdRuns: 1, lastFigures: { affected: 3, eligible: 20 } });
    // Five weeks on, nothing is in the window: not measured at all, still counted.
    expect(await mining.mine(board.id, later(5 * WEEK))).toMatchObject({ measured: 0 });
    // Not measured: when it was last measured, and its figures then, stand.
    expect(await signalRow('run_superseded')).toMatchObject({ belowThresholdRuns: 2, itemId: id, lastMeasuredAt: later(WEEK), lastFigures: { affected: 3, eligible: 20 } });
    await runs(5, 5, later(-DAY, later(6 * WEEK)));
    expect(await mining.mine(board.id, later(6 * WEEK))).toMatchObject({ refreshed: [id] });
    expect(await signalRow('run_superseded')).toMatchObject({ belowThresholdRuns: 0 });
  });

  it('is merged by the KB pipeline into an open submitted duplicate, which the next run then refreshes (s15f8)', async () => {
    const knowledge = new KnowledgeService({ store, clock: { now: () => START }, catalog, notifier });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
    });
    unwrap(await knowledge.importDocuments(ADMIN, board.id, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'upload'));
    const route = new FakeLlm();
    const pipeline = new KbPipeline({ store, clock: { now: () => START }, catalog, notifier, route, draft: new FakeLlm() });
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    const submitted: KbItem = {
      ...(await item(mined ?? '')),
      id: 's1k50',
      source: 'submitted',
      submittedBy: DEV,
      signal: null,
      statement: 'Say why when starting again',
      evidence: 'From s1t1',
      processing: 'drafted',
      version: 1,
    };
    await store.transaction((tx) => tx.insertKbItem(submitted));

    route.answer(
      JSON.stringify({ target: { kind: 'document', name: 'build_test_lint', section: '## Test', newDocument: null }, catalogCandidate: false, catalogReason: null }),
      JSON.stringify({ checked: [{ ref: submitted.id, relation: 'same fact' }], suppressedBy: null, duplicateOf: { id: submitted.id, quote: 'Say why when starting again', newQuote: 'someone taking over or starting again' }, coveredBy: null, contradicts: [] }),
    );
    expect(await pipeline.processNext()).toBe(mined);
    expect(await item(mined ?? '')).toMatchObject({ status: 'merged', duplicateOf: submitted.id });

    const nextWeek = later(WEEK);
    expect(await mining.mine(board.id, nextWeek)).toMatchObject({ raised: [], refreshed: [submitted.id] });
    // Slop's line on the submitter's item says it is slop's.
    expect((await item(submitted.id)).evidence).toBe(`From s1t1\nMined by slop, week of ${nextWeek.slice(0, 10)}: 3/10 (30%)`);
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: mined });
  });

  it('raises a new item when the item it was merged into no longer exists (s15f8)', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    await decide(mined ?? '', { status: 'merged', duplicateOf: 's1k404' });
    const again = await mining.mine(board.id, later(WEEK));
    expect(again.raised).toHaveLength(1);
    expect(again.raised[0]).not.toBe(mined);
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: again.raised[0] });
  });

  it('never raises again a signal covered by an approved item (s15f8)', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [mined] = (await mining.mine(board.id, START)).raised;
    const approved: KbItem = { ...(await item(mined ?? '')), id: 's1k60', status: 'approved', signal: null, decidedAt: START, version: 1 };
    await store.transaction((tx) => tx.insertKbItem(approved));
    await decide(mined ?? '', { status: 'covered', coveredBy: { kind: 'item', id: approved.id } });
    await runs(4, 4, later(-DAY, later(30 * WEEK)));
    expect(await mining.mine(board.id, later(30 * WEEK))).toMatchObject({ crossed: 1, raised: [], refreshed: [] });
  });

  it('re-raises a rejected signal at exactly 12 weeks, not a minute before (s15f8)', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [rejected] = (await mining.mine(board.id, START)).raised;
    await decide(rejected ?? '', { status: 'rejected', decidedBy: ADMIN, decidedAt: START });
    const twelveWeeks = later(12 * WEEK);
    await runs(4, 4, later(-DAY, twelveWeeks));
    expect(await mining.mine(board.id, later(-60_000, twelveWeeks))).toMatchObject({ crossed: 1, raised: [] });
    expect((await mining.mine(board.id, twelveWeeks)).raised).toHaveLength(1);
  });

  it('skips the refresh, and raises nothing, when the item changed between reading and writing it (s15f8)', async () => {
    await runs(10, 3, later(-2 * DAY));
    const [id] = (await mining.mine(board.id, START)).raised;
    const before = await item(id ?? '');
    // A store whose reads of the item are one version behind: the pipeline wrote it meanwhile.
    const racing: Store = {
      transaction: (work) =>
        store.transaction((tx) =>
          work({
            ...tx,
            getKbItem: async (itemId) => {
              const found = await tx.getKbItem(itemId);
              return found === null || itemId !== id ? found : { ...found, version: found.version - 1 };
            },
          }),
        ),
    };
    const racingMining = new MiningService({ store: racing, notifier });
    expect(await racingMining.mine(board.id, later(WEEK))).toMatchObject({ crossed: 1, raised: [], refreshed: [] });
    expect(await item(id ?? '')).toEqual(before);
    expect((await items()).length).toBe(1);
    expect(await signalRow('run_superseded')).toMatchObject({ itemId: id, lastMeasuredAt: later(WEEK), belowThresholdRuns: 0 });
  });

  it('counts findings by when their review was written: an old review split today is outside the window (s15f8)', async () => {
    /** A local review written `at` on a new glob, split today into one classified IN-SCOPE edge-case finding. */
    const reviewed = async (at: string) => {
      const id = `s${String(board.id)}t${String(++n)}`;
      await store.transaction(async (tx) => {
        await tx.insertGlob(glob({ id, boardId: board.id }), null);
        const source = await tx.insertReviewSource({
          boardId: board.id,
          globId: id,
          kind: 'local_review',
          artifactId: null,
          externalId: null,
          commitSha: null,
          agentSetVersion: null,
          content: 'review',
          path: null,
          line: null,
          createdAt: at,
        });
        if (source === null) throw new Error('No source');
        const finding = { boardId: board.id, globId: id, sourceId: source.id, source: 'local_review' as const, commitSha: null, agentSetVersion: null };
        await tx.insertFindings([{ ...finding, severity: 'in_scope', round: 1, path: null, line: null, text: 'Misses the empty case', fingerprint: 'empty' }], START);
        const [split] = await tx.listFindings(id);
        if (split === undefined) throw new Error('No finding');
        await tx.updateFinding({ ...split, state: 'classified', class: 'edge-case', classifiedAt: START, version: split.version + 1 }, split.version);
      });
    };
    for (let i = 0; i < 3; i++) await reviewed(later(-40 * DAY));
    expect((await mining.mine(board.id, START)).measured).toBe(0);
    for (let i = 0; i < 3; i++) await reviewed(later(-3 * DAY));
    const result = await mining.mine(board.id, START);
    expect(result.raised).toHaveLength(1);
    expect((await item(result.raised[0] ?? '')).signal).toMatchObject({ key: 'finding:edge-case', figures: { affected: 3, eligible: 3 } });
  });

  it('raises the new dependencies of a run as one item, and each name only once', async () => {
    const change = (globId: string, dependencies: string[]): ManifestChange => ({ globId, sha: 'm', path: 'package.json', dependencies });
    const first = await mining.mine(board.id, START, { manifestChanges: [change('s1t1', ['zustand']), change('s1t2', ['msw', 'zustand'])] });
    expect(first.raised).toHaveLength(1);
    const raised = await item(first.raised[0] ?? '');
    expect(raised).toMatchObject({
      type: 'gotcha',
      statement: 'New dependencies have no conventions yet: msw, zustand. Document how the project uses them.',
      sourceGlobIds: ['s1t1', 's1t2'],
      signal: { key: 'dependency:msw,zustand', kind: 'dependency', agent: null, figures: { affected: 2, eligible: 2, count: 2 } },
    });
    expect(await signalRow('dependency:msw')).toMatchObject({ itemId: raised.id });
    await decide(raised.id, { status: 'rejected', decidedAt: START });

    const second = await mining.mine(board.id, later(20 * WEEK), { manifestChanges: [change('s1t3', ['msw', 'vitest'])] });
    expect(second.raised).toHaveLength(1);
    expect((await item(second.raised[0] ?? '')).signal?.key).toBe('dependency:vitest');
  });
});

describe('Learning jobs: weekly mining with a lease, and Run now', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let now: string;
  let jobs: LearningJobService;
  let boardId: number;
  let asked: MergedCommit[][];
  let failNext: boolean;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    asked = [];
    failNext = false;
    const manifests: ManifestSource = {
      manifestChanges: (_board, commits) => {
        asked.push([...commits]);
        if (failNext) return Promise.reject(new Error('GitHub is down'));
        return Promise.resolve([]);
      },
    };
    jobs = new LearningJobService({ store, clock: { now: () => now }, notifier, mining: new MiningService({ store, notifier }), manifests });
    boardId = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({ name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      for (const [email, role] of [[ADMIN, 'admin'], [DEV, 'dev']] as const) {
        await tx.upsertUser({ email, name: email, active: true });
        await tx.upsertMember({ boardId: board.id, email, role });
      }
      await tx.insertGlob(glob({ id: 's1t1', boardId: board.id }), null);
      await tx.appendEvents([{ type: 'Merged', globId: 's1t1', actor: null, at: later(-DAY), data: { sha: 'abc1234' } }]);
      return board.id;
    });
  });

  it('runs mining on a board that never ran it, then not again until a week has passed', async () => {
    expect(await jobs.runDue()).toEqual([{ boardId, job: 'mining', result: { kind: 'mining', measured: 0, crossed: 0, raised: [], refreshed: [] } }]);
    expect(asked).toEqual([[{ globId: 's1t1', sha: 'abc1234' }]]);
    expect(await store.transaction((tx) => tx.getBoardJob(boardId, 'mining'))).toMatchObject({ lastRunAt: START, runningUntil: null });
    now = later(WEEK - 60_000);
    expect(await jobs.runDue()).toEqual([]);
    now = later(MINING_INTERVAL_MS);
    expect(await jobs.runDue()).toHaveLength(1);
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
  });

  it("doesn't run a job another server holds the lease of", async () => {
    await store.transaction((tx) => tx.claimBoardJob(boardId, 'mining', START, 30 * 60 * 1000));
    expect(await jobs.runDue()).toEqual([]);
    const held = await jobs.runNow(ADMIN, boardId, 'mining');
    expect(held.ok ? null : held.error.code).toBe('run_active');
  });

  it("doesn't record a run that outlived its lease over the next holder's (s15f8)", async () => {
    // The manifest read outlasts the lease, and another server claims the job meanwhile.
    let next: Promise<unknown> = Promise.resolve();
    const slow: ManifestSource = {
      manifestChanges: () => {
        now = later(31 * 60 * 1000);
        next = store.transaction((tx) => tx.claimBoardJob(boardId, 'mining', now, 30 * 60 * 1000));
        return next.then(() => []);
      },
    };
    const logged: [string, string][] = [];
    const slowJobs = new LearningJobService({
      store,
      clock: { now: () => now },
      notifier,
      mining: new MiningService({ store, notifier }),
      manifests: slow,
      log: (task, message) => logged.push([task, message]),
    });
    expect(await slowJobs.runDue()).toHaveLength(1);
    await next;
    // The other server's lease and (empty) last run stand.
    expect(await store.transaction((tx) => tx.getBoardJob(boardId, 'mining'))).toMatchObject({ lastRunAt: null, lastResult: null, runningUntil: later(61 * 60 * 1000) });
    // The dropped result is logged, so operators can see the lease is too short.
    expect(logged).toEqual([['mining', `board ${String(boardId)}: the run started at ${START} outlived its lease (until ${later(30 * 60 * 1000)}), so its result wasn't recorded`]]);
  });

  it("reports a job whose lease has expired as not running, by the server's clock (s15f8)", async () => {
    // A server died mid-run: its lease stays in the row until it expires.
    await store.transaction((tx) => tx.claimBoardJob(boardId, 'mining', START, 30 * 60 * 1000));
    expect(unwrap(await jobs.jobs(DEV, boardId))).toMatchObject([{ running: true, runningUntil: later(30 * 60 * 1000) }]);
    now = later(30 * 60 * 1000);
    expect(unwrap(await jobs.jobs(DEV, boardId))).toMatchObject([{ running: false, runningUntil: later(30 * 60 * 1000) }]);
  });

  it('records a failed run without moving the last run, so the check an hour later tries again', async () => {
    failNext = true;
    expect(await jobs.runDue()).toEqual([{ boardId, job: 'mining', result: { kind: 'failed', error: 'GitHub is down', at: START, failures: 1 } }]);
    expect(await store.transaction((tx) => tx.getBoardJob(boardId, 'mining'))).toMatchObject({ lastRunAt: null, runningUntil: null });
    failNext = false;
    now = later(60 * 60 * 1000);
    expect((await jobs.runDue())[0]?.result.kind).toBe('mining');
  });

  it('backs off a failing mining run, and counts failures from one again after a success (s15f8)', async () => {
    const HOUR = 60 * 60 * 1000;
    const mining = () => store.transaction((tx) => tx.getBoardJob(boardId, 'mining'));
    failNext = true;
    expect((await jobs.runDue())[0]?.result).toEqual({ kind: 'failed', error: 'GitHub is down', at: START, failures: 1 });
    now = later(HOUR - 60_000);
    expect(await jobs.runDue()).toEqual([]);
    now = later(HOUR);
    expect((await jobs.runDue())[0]?.result).toEqual({ kind: 'failed', error: 'GitHub is down', at: now, failures: 2 });
    // The second failure in a row waits 2 hours.
    now = later(3 * HOUR - 60_000);
    expect(await jobs.runDue()).toEqual([]);
    now = later(3 * HOUR);
    failNext = false;
    expect((await jobs.runDue())[0]?.result.kind).toBe('mining');
    const succeeded = now;
    expect(await mining()).toMatchObject({ lastRunAt: succeeded });
    // The next weekly run fails: the count starts again, so it is retried an hour later, not 4.
    now = later(MINING_INTERVAL_MS, succeeded);
    failNext = true;
    expect((await jobs.runDue())[0]?.result).toEqual({ kind: 'failed', error: 'GitHub is down', at: now, failures: 1 });
    expect(await mining()).toMatchObject({ lastRunAt: succeeded });
    const failedAt = now;
    now = later(HOUR - 60_000, failedAt);
    expect(await jobs.runDue()).toEqual([]);
    now = later(HOUR, failedAt);
    failNext = false;
    expect((await jobs.runDue())[0]?.result.kind).toBe('mining');
  });

  it('isJobDue: never run, skipped, failed with its backoff capped at a day, and failures recorded before the backoff (s15f8)', () => {
    const HOUR = 60 * 60 * 1000;
    const jobWith = (lastRunAt: string | null, lastResult: BoardJobResult | null): BoardJob => ({
      boardId,
      job: 'mining',
      lastRunAt,
      lastResult,
      runningUntil: null,
    });
    expect(isJobDue(null, WEEK, START)).toBe(true);
    expect(isJobDue(jobWith(null, null), WEEK, START)).toBe(true);
    // Skipped: due at once, whenever the last run was.
    expect(isJobDue(jobWith(START, { kind: 'skipped', reason: 'AI unavailable' }), WEEK, START)).toBe(true);
    // Many failures in a row: capped at a day, whatever the last run was.
    const tenth: BoardJobResult = { kind: 'failed', error: 'x', at: START, failures: 10 };
    expect(FAILED_RETRY_MAX_MS).toBe(DAY);
    expect(isJobDue(jobWith(null, tenth), WEEK, later(DAY - 1))).toBe(false);
    expect(isJobDue(jobWith(null, tenth), WEEK, later(DAY))).toBe(true);
    expect(isJobDue(jobWith(later(-WEEK - DAY), tenth), WEEK, later(DAY - 1))).toBe(false);
    // A failure without its count waits as a first one.
    const uncounted: BoardJobResult = { kind: 'failed', error: 'x', at: START };
    expect(isJobDue(jobWith(null, uncounted), WEEK, later(HOUR - 1))).toBe(false);
    expect(isJobDue(jobWith(null, uncounted), WEEK, later(HOUR))).toBe(true);
    // A failure recorded before the backoff (no time): by the interval since the last run.
    const legacy: BoardJobResult = { kind: 'failed', error: 'x' };
    expect(isJobDue(jobWith(null, legacy), WEEK, START)).toBe(true);
    expect(isJobDue(jobWith(START, legacy), WEEK, later(WEEK - 1))).toBe(false);
    expect(isJobDue(jobWith(START, legacy), WEEK, later(WEEK))).toBe(true);
  });

  it('lets admins run a job now, members read the last run, and refuses others', async () => {
    const started = unwrap(await jobs.runNow(ADMIN, boardId, 'mining'));
    // Run now answers once the lease is taken: the job shows as running until it finishes.
    expect(started.job).toMatchObject({ boardId, job: 'mining', lastRunAt: null, runningUntil: later(30 * 60 * 1000) });
    expect(notifier.hints).toEqual([{ kind: 'board.kb', boardId }]);
    const again = await jobs.runNow(ADMIN, boardId, 'mining');
    expect(again.ok ? null : again.error.code).toBe('run_active');
    const ran = await started.finished;
    expect(ran).toMatchObject({ boardId, job: 'mining', lastRunAt: START, runningUntil: null, lastResult: { kind: 'mining' } });
    const refused = await jobs.runNow(DEV, boardId, 'mining');
    expect(refused.ok ? null : refused.error.code).toBe('forbidden');
    const unknown = await jobs.runNow(ADMIN, boardId, 'nonsense');
    expect(unknown.ok ? null : unknown.error.code).toBe('not_found');
    const later_ = await jobs.runNow(ADMIN, boardId, 'effect_check');
    expect(later_.ok ? null : later_.error.code).toBe('invalid_input');
    expect(unwrap(await jobs.jobs(DEV, boardId))).toEqual([{ ...ran, running: false }]);
    const outsider = await jobs.jobs('outsider@example.com', boardId);
    expect(outsider.ok ? null : outsider.error.code).toBe('forbidden');
  });
});
