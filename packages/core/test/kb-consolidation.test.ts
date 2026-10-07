import { beforeEach, describe, expect, it } from 'vitest';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import {
  consolidationMemoryOf,
  KbConsolidation,
  MAX_CONSOLIDATION_PAIRS,
  MAX_REMEMBERED_NOT_SAME,
  PAIRS_SYSTEM,
  VERIFY_SYSTEM,
} from '../src/app/kb-consolidation.js';
import { longEnoughQuote, MIN_MERGE_QUOTE_CHARS, MIN_MERGE_QUOTE_WORDS } from '../src/app/kb-dedupe.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import {
  BOARD_JOB_LEASE_MS,
  CONSOLIDATION_INTERVAL_MS,
  CONSOLIDATION_LEASE_MS,
  FAILED_RETRY_MAX_MS,
  failedRetryMs,
  LearningJobService,
} from '../src/app/learning-jobs.js';
import { MiningService } from '../src/app/mining-service.js';
import type { Result } from '../src/domain/errors.js';
import { STALE_AFTER_MS, STALE_KEEP_MS, UNPROCESSED } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { KbSignal } from '../src/domain/signals.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const DAY = 24 * 60 * 60 * 1000;
const START = '2026-10-07T12:00:00.000Z';
const at = (ms: number, from = START) => new Date(Date.parse(from) + ms).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const errorCode = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'h1', files: [] }),
};

type Answer = string | Error | (() => Promise<string>);

/** A fake LLM answering from a queue of canned answers, errors or functions (run during the call), recording each request. */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(private readonly answers: Answer[] = []) {}
  answer(...answers: Answer[]): void {
    this.answers.push(...answers);
  }
  complete(request: LlmRequest): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt });
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    if (next instanceof Error) return Promise.reject(next);
    return typeof next === 'string' ? Promise.resolve(next) : next();
  }
}

const json = (value: unknown) => JSON.stringify(value);
const pairs = (...ids: [string, string][]) => json({ pairs: ids.map(([a, b]) => ({ a, b })) });
const sameFact = (quoteA: string | null, quoteB: string | null) =>
  json({ fact: 'Generated files live in src/gen', relation: 'same fact', quoteA, quoteB });

const SIGNAL: KbSignal = {
  key: 'run_superseded',
  kind: 'run_superseded',
  agent: 'orchestrator',
  label: 'runs taken over or started again',
  window: { from: at(-28 * DAY), to: START },
  figures: { affected: 4, eligible: 16, rate: 0.25, count: 4 },
  globIds: ['s1t1'],
  examples: [],
  measuredAt: START,
};

describe('Weekly consolidation: merges on verified quotes, stale flags and the queue order', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let consolidation: KbConsolidation;
  let knowledge: KnowledgeService;
  let now: string;
  let boardId: number;
  let n: number;

  /** An open, drafted statement on the board (created `createdAt`), as the pipeline leaves it. */
  const add = async (patch: Partial<KbItem> = {}): Promise<KbItem> => {
    const id = `s${String(boardId)}k${String(++n)}`;
    const item: KbItem = {
      id,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: `Statement ${id}`,
      evidence: `Evidence for ${id}`,
      suggestedTarget: null,
      sourceGlobIds: [`s${String(boardId)}t${String(n)}`],
      source: 'submitted',
      signal: null,
      agentSetVersion: null,
      submittedBy: DEV,
      createdAt: now,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      processing: 'drafted',
      target: { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null },
      draft: { section: 'Test', content: `## Test\n\n- ${id}\n` },
      draftedAgainstVersion: 1,
      version: 3,
      ...patch,
    };
    await store.transaction((tx) => tx.insertKbItem(item));
    return item;
  };
  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  const update = async (id: string, patch: Partial<KbItem>) => {
    const current = await item(id);
    await store.transaction((tx) =>
      tx.updateKbItem({ ...current, ...patch, version: current.version + 1 }, current.version),
    );
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    llm = new FakeLlm();
    now = START;
    n = 0;
    const clock = { now: () => now };
    consolidation = new KbConsolidation({ store, clock, notifier, llm });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    boardId = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      for (const [email, role] of [
        [ADMIN, 'admin'],
        [DEV, 'dev'],
      ] as const) {
        await tx.upsertUser({ email, name: email, active: true });
        await tx.upsertMember({ boardId: board.id, email, role });
      }
      return board.id;
    });
  });

  it("merges a proposed pair verified as the same fact with both quotes, keeping both items' evidence on the survivor", async () => {
    const older = await add({
      statement: 'Generated files live in src/gen/ and are never edited by hand.',
      evidence: 'Review of s1t1',
    });
    now = at(DAY);
    const repeated = await add({
      statement: 'Never hand-edit src/gen/: the generated files there are rebuilt.',
      evidence: 'Review of s1t2',
      occurrenceCount: 2,
      extraEvidence: [
        {
          itemId: 's1k9',
          globIds: ['s1t9'],
          evidence: 'Earlier repeat',
          submittedBy: DEV,
          at: START,
        },
      ],
    });
    llm.answer(
      pairs([older.id, repeated.id]),
      sameFact('Generated files live in src/gen/', 'the generated files there are rebuilt'),
    );

    const result = await consolidation.consolidate(boardId);

    expect(result).toEqual({
      kind: 'consolidation',
      candidates: 2,
      proposed: 1,
      verified: 1,
      merged: [{ id: older.id, into: repeated.id }],
      skipped: 0,
      alreadyChecked: 0,
      unchanged: false,
      flaggedStale: 0,
      clearedStale: 0,
    });
    // The more repeated item survives, with its own draft, and every piece of evidence.
    const survivor = await item(repeated.id);
    expect(survivor).toMatchObject({
      status: 'open',
      processing: 'drafted',
      draft: repeated.draft,
      occurrenceCount: 3,
      sourceGlobIds: [...repeated.sourceGlobIds, ...older.sourceGlobIds],
      version: repeated.version + 1,
    });
    expect(survivor.evidence).toBe('Review of s1t2');
    expect(survivor.extraEvidence).toEqual([
      ...repeated.extraEvidence,
      {
        itemId: older.id,
        globIds: older.sourceGlobIds,
        evidence: 'Review of s1t1',
        submittedBy: DEV,
        at: older.createdAt,
      },
    ]);
    expect(await item(older.id)).toMatchObject({
      status: 'merged',
      duplicateOf: repeated.id,
      mergeNote: {
        by: 'consolidation',
        quote: 'Generated files live in src/gen/',
        survivorQuote: 'the generated files there are rebuilt',
        at: now,
      },
      version: older.version + 1,
    });
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    // The pair call sees every candidate; the verification call sees both statements.
    expect(llm.calls.map((c) => c.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM]);
    expect(llm.calls[0]?.prompt).toContain(
      json({
        id: older.id,
        type: 'gotcha',
        target: 'build_test_lint › Test',
        evidence: 1,
        statement: older.statement,
      }),
    );
    expect(llm.calls[1]?.prompt).toContain(older.statement);
    expect(llm.calls[1]?.prompt).toContain(repeated.statement);
  });

  it('keeps the older item when both are as repeated', async () => {
    const older = await add({ statement: 'Run vitest with --reporter=dot.' });
    now = at(DAY);
    const newer = await add({ statement: 'Use the dot reporter: run vitest with --reporter=dot.' });
    llm.answer(
      pairs([newer.id, older.id]),
      sameFact('run vitest with --reporter=dot', 'Run vitest with --reporter=dot'),
    );
    await consolidation.consolidate(boardId);
    expect(await item(older.id)).toMatchObject({ status: 'open', occurrenceCount: 2 });
    expect(await item(newer.id)).toMatchObject({
      status: 'merged',
      duplicateOf: older.id,
      mergeNote: { quote: 'run vitest with --reporter=dot' },
    });
  });

  it('keeps a drafted item over one the pipeline gave up on, even when the failed one is more repeated', async () => {
    const failed = await add({
      statement: 'Run vitest with --reporter=dot in CI.',
      processing: 'failed',
      draft: null,
      occurrenceCount: 3,
    });
    now = at(DAY);
    const drafted = await add({ statement: 'In CI, run vitest with --reporter=dot.' });
    const quote = 'run vitest with --reporter=dot';
    llm.answer(pairs([failed.id, drafted.id]), sameFact(quote, quote));
    await consolidation.consolidate(boardId);
    expect(await item(drafted.id)).toMatchObject({
      status: 'open',
      processing: 'drafted',
      draft: drafted.draft,
      occurrenceCount: 4,
    });
    expect(await item(failed.id)).toMatchObject({ status: 'merged', duplicateOf: drafted.id });
  });

  it('clears a stale flag on the item it closes', async () => {
    const stale = await add({
      statement: 'Run vitest with --reporter=dot in CI.',
      staleSince: START,
      staleReason: 'no_recent_evidence',
    });
    const fresh = await add({ statement: 'In CI, run vitest with --reporter=dot.', occurrenceCount: 2 });
    const quote = 'run vitest with --reporter=dot';
    llm.answer(pairs([stale.id, fresh.id]), sameFact(quote, quote));
    await consolidation.consolidate(boardId);
    expect(await item(stale.id)).toMatchObject({
      status: 'merged',
      duplicateOf: fresh.id,
      staleSince: null,
      staleReason: null,
    });
  });

  it.each([
    ['exactly the minimum on both sides', 'run the vitest suite', 'run the vitest suite', true],
    ['the minimum, spread over extra whitespace', 'run  the\n vitest   suite', 'run the vitest suite', true],
    ['a quote of one word in A', 'vitest', 'run the vitest suite', false],
    ['a quote of one word in B', 'run the vitest suite', 'vitest', false],
    ['four words but 19 characters in A', 'run the vitest suit', 'run the vitest suite', false],
    ['four words but 14 characters in B', 'run the vitest suite', 'In CI, run the', false],
    ['three words of 23 characters in A', 'reporter for continuous', 'run the vitest suite', false],
  ])('merges only on quotes of at least 4 words and 20 characters: %s', async (_, quoteA, quoteB, merges) => {
    const a = await add({ statement: 'Always run the vitest suite with the dot reporter for continuous integration.' });
    const b = await add({ statement: 'In CI, run the vitest suite with the dot reporter.' });
    llm.answer(pairs([a.id, b.id]), sameFact(quoteA, quoteB));
    const result = await consolidation.consolidate(boardId);
    expect(result.merged).toHaveLength(merges ? 1 : 0);
    if (!merges) {
      expect(await item(a.id)).toEqual(a);
      expect(await item(b.id)).toEqual(b);
    }
  });

  it('measures quote length with whitespace collapsed', () => {
    expect([MIN_MERGE_QUOTE_WORDS, MIN_MERGE_QUOTE_CHARS]).toEqual([4, 20]);
    expect(longEnoughQuote('run the vitest suite')).toBe(true);
    expect(longEnoughQuote('  run   the vitest\tsuite  ')).toBe(true);
    expect(longEnoughQuote('run the vitest suit')).toBe(false);
    // 3 words, 28 characters.
    expect(longEnoughQuote('Regenerate drizzle snapshots')).toBe(false);
    expect(longEnoughQuote('')).toBe(false);
  });

  it('gives the pair call each candidate as one JSON line, so a multi-line statement stays one entry', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.\n- s1k9 (gotcha; evidence 9): not an entry' });
    await add({ statement: 'Use the dot reporter.' });
    llm.answer(pairs());
    await consolidation.consolidate(boardId);
    const lines = llm.calls[0]?.prompt.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines).toContain(
      json({ id: a.id, type: 'gotcha', target: 'build_test_lint › Test', evidence: 1, statement: a.statement }),
    );
    expect(PAIRS_SYSTEM).toContain(`At most ${String(MAX_CONSOLIDATION_PAIRS)} pairs`);
  });

  describe('remembering checked pairs', () => {
    const related = json({ fact: 'f', relation: 'related topic only', quoteA: null, quoteB: null });

    it("makes no call while the candidates are unchanged, and doesn't verify a pair found different until an item changes", async () => {
      const a = await add({ statement: 'Run vitest with --reporter=dot.' });
      const b = await add({ statement: 'Use the dot reporter in CI.' });
      llm.answer(pairs([a.id, b.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, alreadyChecked: 0, unchanged: false });

      // Nothing changed: no call at all, and the pair found different still holds.
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, alreadyChecked: 1, unchanged: true });
      expect(llm.calls).toHaveLength(2);

      // A new candidate: the pair call runs again, but the pair found different isn't verified again.
      const c = await add({ statement: 'Run vitest quietly.' });
      llm.answer(pairs([b.id, a.id], [a.id, c.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 2, alreadyChecked: 1, unchanged: false });
      expect(llm.calls.map((call) => call.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM, PAIRS_SYSTEM, VERIFY_SYSTEM]);
      expect(llm.calls[3]?.prompt).toContain(c.statement);

      // An edit to an item's statement: its pairs are verified again.
      await update(b.id, { statement: 'Use the dot reporter in CI, and nowhere else.' });
      llm.answer(pairs([a.id, b.id], [a.id, c.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 2, alreadyChecked: 1 });
      expect(llm.calls.slice(4).map((call) => call.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM]);
      expect(llm.calls[5]?.prompt).toContain('nowhere else');
    });

    it('asks again next run when a pair was left unanswered (an unusable answer, or the same fact without checkable quotes)', async () => {
      const a = await add({ statement: 'Run vitest with --reporter=dot.' });
      const b = await add({ statement: 'Use the dot reporter in CI.' });
      llm.answer(pairs([a.id, b.id]), 'not JSON');
      await consolidation.consolidate(boardId);
      llm.answer(pairs([a.id, b.id]), sameFact('dot', 'dot'));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, unchanged: false });
      llm.answer(pairs([a.id, b.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, unchanged: false });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, unchanged: true });
      expect(llm.calls).toHaveLength(6);
    });

    it('sees the candidates as the run left them, so its own stale flags and merges count as unchanged next run', async () => {
      const old = await add({ statement: 'Run vitest with --reporter=dot.' });
      now = at(STALE_AFTER_MS);
      const b = await add({ statement: 'Use the dot reporter in CI.' });
      llm.answer(pairs([old.id, b.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 1 });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, unchanged: true });

      // A merge (the survivor written, the loser closed), then stale flags on the survivor and on b, in one run.
      now = at(2 * STALE_AFTER_MS);
      const c = await add({ statement: 'Generated files live in src/gen/ and are never edited by hand.' });
      const d = await add({ statement: 'Never hand-edit src/gen/: the generated files there are rebuilt.' });
      llm.answer(
        pairs([c.id, d.id]),
        sameFact('Generated files live in src/gen/', 'the generated files there are rebuilt'),
      );
      now = at(3 * STALE_AFTER_MS);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ merged: [{ id: d.id, into: c.id }], flaggedStale: 2 });
      expect((await item(c.id)).staleSince).toBe(now);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, unchanged: true });
    });

    it.each([
      ['a candidate is drafted', 'insert'],
      ["a candidate's statement is edited", 'edit'],
      ['a candidate is given another target', 'target'],
    ] as const)(
      "doesn't remember the candidates when %s by another writer during the run, so the next run compares again",
      async (_, write) => {
        const a = await add({ statement: 'Run vitest with --reporter=dot.' });
        const b = await add({ statement: 'Use the dot reporter in CI.' });
        const c = await add({ statement: 'Regenerate drizzle snapshots after a schema change.' });
        llm.answer(pairs([a.id, b.id]), async () => {
          if (write === 'insert') await add({ statement: 'Run the dot reporter locally too.' });
          else if (write === 'edit') await update(c.id, { statement: 'Regenerate drizzle snapshots after every schema change.' });
          else await update(c.id, { target: { kind: 'doc', name: 'database', section: null, newDocument: null } });
          return related;
        });
        expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, unchanged: false });

        // The pair found different is still remembered; the candidates aren't, so the pair call runs again.
        llm.answer(pairs([a.id, b.id]));
        expect(await consolidation.consolidate(boardId)).toMatchObject({
          proposed: 1,
          alreadyChecked: 1,
          unchanged: false,
        });
        expect(llm.calls.map((call) => call.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM, PAIRS_SYSTEM]);
        // That run saw every candidate, so the one after makes no call.
        expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, unchanged: true });
        expect(llm.calls).toHaveLength(3);
      },
    );

    it('keeps the memory through writes that change no statement, type or target: evidence, a stale flag, mining\'s refresh', async () => {
      const mined = await add({
        statement: 'Runs are often started again: check the run before starting again.',
        source: 'mined',
        signal: SIGNAL,
        submittedBy: 'slop',
      });
      const b = await add({ statement: 'Check CI before starting a run again.' });
      llm.answer(pairs([mined.id, b.id]), async () => {
        // Another writer adds evidence to b during the run.
        await update(b.id, { occurrenceCount: 2, evidence: 'More evidence' });
        return related;
      });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, unchanged: false });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, alreadyChecked: 1, unchanged: true });

      // Mining's weekly refresh: a line of evidence, new figures and globs, and any stale flag cleared.
      const refreshed = await item(mined.id);
      await update(mined.id, {
        evidence: `${refreshed.evidence}\nWeek of 2026-10-14: 5/16 (31%)`,
        signal: { ...SIGNAL, figures: { affected: 5, eligible: 16, rate: 0.3125, count: 5 } },
        sourceGlobIds: [...refreshed.sourceGlobIds, 's1t9'],
        staleSince: null,
        staleReason: null,
      });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, alreadyChecked: 1, unchanged: true });

      // A new candidate: the pair call runs, and the remembered pair isn't verified again.
      const c = await add({ statement: 'Regenerate drizzle snapshots after a schema change.' });
      llm.answer(pairs([mined.id, b.id], [b.id, c.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 2, alreadyChecked: 1 });
      expect(llm.calls.slice(2).map((call) => call.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM]);
      expect(llm.calls.at(-1)?.prompt).toContain(c.statement);
    });

    it.each<[string, Partial<KbItem>]>([
      ['type', { type: 'pattern' }],
      ['target', { target: { kind: 'doc', name: 'build_test_lint', section: 'Lint', newDocument: null } }],
      ['statement', { statement: 'Check CI before starting any run again.' }],
    ])('verifies a remembered pair again once an item\'s %s changes', async (_, patch) => {
      const a = await add({ statement: 'Check the run before starting again.' });
      const b = await add({ statement: 'Check CI before starting a run again.' });
      llm.answer(pairs([a.id, b.id]), related);
      await consolidation.consolidate(boardId);
      await update(b.id, patch);
      llm.answer(pairs([a.id, b.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 1, alreadyChecked: 0, unchanged: false });
      expect(llm.calls.map((call) => call.system)).toEqual([PAIRS_SYSTEM, VERIFY_SYSTEM, PAIRS_SYSTEM, VERIFY_SYSTEM]);
    });

    it(`keeps the newest ${String(MAX_REMEMBERED_NOT_SAME)} pairs found different`, async () => {
      const items: KbItem[] = [];
      for (let i = 0; i < 33; i++) items.push(await add({ statement: `Run vitest with the dot reporter, case ${String(i)}.` }));
      const all: [string, string][] = [];
      for (const [i, x] of items.entries()) for (const y of items.slice(i + 1)) all.push([x.id, y.id]);
      // The first pair is left unanswered every run (so the next run calls again); 19 others are found different.
      const [open, ...rest] = all;
      if (open === undefined) throw new Error('No pairs');
      const perRun = MAX_CONSOLIDATION_PAIRS - 1;
      const runs = Math.floor(rest.length / perRun);
      for (let run = 0; run < runs; run++) {
        const chunk = rest.slice(run * perRun, (run + 1) * perRun);
        llm.answer(pairs(open, ...chunk), 'not JSON', ...chunk.map(() => related));
        await consolidation.consolidate(boardId);
      }
      const recorded = runs * perRun;
      expect(recorded).toBeGreaterThan(MAX_REMEMBERED_NOT_SAME);
      const memory = consolidationMemoryOf(await store.transaction((tx) => tx.getBoardJobState(boardId, 'consolidation')));
      expect(memory.notSame).toHaveLength(MAX_REMEMBERED_NOT_SAME);
      const ids = (pair: readonly string[]) => pair.map((key) => key.split('#')[0]).sort().join(' ');
      expect(memory.notSame.map(ids)).toEqual(
        rest.slice(recorded - MAX_REMEMBERED_NOT_SAME, recorded).map((pair) => [...pair].sort().join(' ')),
      );
    });

    it('lists pairs found different as already checked, and keeps them out of the cap so new pairs get a slot', async () => {
      const items: KbItem[] = [];
      for (let i = 0; i <= MAX_CONSOLIDATION_PAIRS; i++)
        items.push(await add({ statement: `Run vitest with the dot reporter, case ${String(i)}.` }));
      const [first, ...rest] = items;
      if (first === undefined) throw new Error('No items');
      const known = rest.map((other): [string, string] => [first.id, other.id]);
      llm.answer(pairs(...known), ...known.map(() => related));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: MAX_CONSOLIDATION_PAIRS });

      // A new candidate: the model proposes the known pairs again and one new one, which still gets verified.
      const fresh = await add({ statement: 'Use the dot reporter in CI as well.' });
      llm.answer(pairs(...known, [first.id, fresh.id]), related);
      expect(await consolidation.consolidate(boardId)).toMatchObject({
        proposed: MAX_CONSOLIDATION_PAIRS + 1,
        alreadyChecked: MAX_CONSOLIDATION_PAIRS,
      });
      const lines = llm.calls.at(-2)?.prompt.split('\n') ?? [];
      const heading = lines.indexOf('Already checked, not the same fact (never propose these pairs):');
      expect(heading).toBeGreaterThan(0);
      // One {"a", "b"} line per known pair, in either order.
      const listed = lines.slice(heading + 1).map((line) => [...line.matchAll(/s\d+k\d+/g)].map((m) => m[0]).sort().join(' '));
      expect(listed.sort()).toEqual(known.map((pair) => [...pair].sort().join(' ')).sort());
      expect(llm.calls.at(-1)).toMatchObject({ system: VERIFY_SYSTEM });
      expect(llm.calls.at(-1)?.prompt).toContain(fresh.statement);
    });
  });

  it.each([
    ['a quote is missing', sameFact('Run vitest with --reporter=dot', null)],
    [
      'a quote is not in the statement',
      sameFact('Run vitest with --reporter=dot', 'Always run vitest quietly'),
    ],
    [
      'B is a related topic only',
      json({
        fact: 'f',
        relation: 'related topic only',
        quoteA: 'Run vitest with --reporter=dot',
        quoteB: 'Use the dot reporter',
      }),
    ],
    [
      'B contradicts A',
      json({
        fact: 'f',
        relation: 'contradicts',
        quoteA: 'Run vitest with --reporter=dot',
        quoteB: 'Use the dot reporter',
      }),
    ],
    [
      "quoteA is only in B's statement",
      sameFact('Use the dot reporter in CI', 'Use the dot reporter in CI'),
    ],
    ['the quotes are swapped', sameFact('Use the dot reporter', 'Run vitest with --reporter=dot')],
    [
      'a quote matches only without its punctuation',
      sameFact('Run vitest with reporter dot', 'Use the dot reporter'),
    ],
    [
      'the relation is not one of the four',
      json({
        fact: 'f',
        relation: 'same',
        quoteA: 'Run vitest with --reporter=dot',
        quoteB: 'Use the dot reporter',
      }),
    ],
  ])("doesn't merge when %s", async (_, verdict) => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Use the dot reporter in CI.' });
    llm.answer(pairs([a.id, b.id]), verdict);
    const result = await consolidation.consolidate(boardId);
    expect(result).toMatchObject({ proposed: 1, verified: 0, merged: [], skipped: 0 });
    expect(await item(a.id)).toEqual(a);
    expect(await item(b.id)).toEqual(b);
  });

  it('skips a pair whose verification is unusable or fails, leaving both open', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Use the dot reporter.' });
    const c = await add({ statement: 'Run vitest quietly with --reporter=dot.' });
    llm.answer(
      pairs([a.id, b.id], [a.id, c.id]),
      'I think they are the same.',
      new Error('Throttled'),
    );
    const result = await consolidation.consolidate(boardId);
    expect(result).toMatchObject({ proposed: 2, verified: 0, merged: [], skipped: 2 });
    for (const original of [a, b, c]) expect(await item(original.id)).toEqual(original);
  });

  it('drops a pair an admin kept apart, and pairs with an item still in the pipeline or a document proposal', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Use the dot reporter.', keptApartFrom: [a.id] });
    const routed = await add({
      statement: 'Run vitest with --reporter=dot!',
      processing: 'routed',
      draft: null,
    });
    const pending = await add({
      statement: 'Run vitest with --reporter=dot?',
      processing: 'pending',
      target: null,
      draft: null,
    });
    const document = await add({
      statement: 'Testing',
      document: {
        name: 'testing',
        area: 'testing',
        audience: [],
        description: 'How tests run',
        content: '# Testing\n',
      },
    });
    llm.answer(
      pairs(
        [b.id, a.id],
        [a.id, routed.id],
        [pending.id, a.id],
        [document.id, a.id],
        [a.id, 's1k99'],
        [a.id, a.id],
      ),
    );
    const result = await consolidation.consolidate(boardId);
    expect(result).toMatchObject({ candidates: 2, proposed: 0, verified: 0, merged: [] });
    // Only the pair call: nothing was verified.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.prompt).not.toContain(routed.id);
    expect(llm.calls[0]?.prompt).not.toContain(document.id);
  });

  it('makes no call with fewer than two candidates', async () => {
    await add();
    await add({ processing: 'routed' });
    expect(await consolidation.consolidate(boardId)).toMatchObject({ candidates: 1, proposed: 0 });
    expect(llm.calls).toEqual([]);
  });

  it('fails the run on a candidate-pair answer that is not JSON, writing nothing', async () => {
    const a = await add();
    await add();
    llm.answer('No pairs here.');
    await expect(consolidation.consolidate(boardId)).rejects.toThrow(
      'The candidate-pair answer was not usable JSON',
    );
    expect(await item(a.id)).toEqual(a);
  });

  it('skips the pair when an item changes during the verification call (the version race)', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Run vitest with --reporter=dot in CI.' });
    llm.answer(pairs([a.id, b.id]), async () => {
      // An admin edits b's target meanwhile (or the pipeline merges a new item into it).
      await update(b.id, { evidence: 'Changed' });
      return sameFact('Run vitest with --reporter=dot', 'Run vitest with --reporter=dot');
    });
    const result = await consolidation.consolidate(boardId);
    expect(result).toMatchObject({ proposed: 1, verified: 1, merged: [], skipped: 1 });
    expect(await item(a.id)).toEqual(a);
    expect(await item(b.id)).toMatchObject({
      status: 'open',
      evidence: 'Changed',
      occurrenceCount: 1,
    });
  });

  it('verifies a later pair whose item this run merged away against the survivor, in the same run (s15f8)', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot, quietly.' });
    const c = await add({ statement: 'In CI, run vitest with --reporter=dot.' });
    const quote = 'run vitest with --reporter=dot';
    const related = json({ fact: 'f', relation: 'related topic only', quoteA: null, quoteB: null });
    // Only (a, b) and (b, c) are proposed; b merges into a, so a is asked about against c.
    llm.answer(pairs([a.id, b.id], [b.id, c.id]), sameFact(quote, quote), related);
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      proposed: 2,
      verified: 1,
      merged: [{ id: b.id, into: a.id }],
      skipped: 0,
    });
    const verifications = llm.calls.filter((call) => call.system === VERIFY_SYSTEM);
    expect(verifications).toHaveLength(2);
    expect(verifications[1]?.prompt).toContain(`Learning A, ${a.id}`);
    expect(verifications[1]?.prompt).toContain(`Learning B, ${c.id}`);
    // Every pair was answered: the next run makes no call.
    expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, alreadyChecked: 1, unchanged: true });
    expect(llm.calls).toHaveLength(3);
  });

  it('counts a survivor kept apart from the third item as answered, without a call', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot, quietly.' });
    const c = await add({ statement: 'In CI, run vitest with --reporter=dot.', keptApartFrom: [a.id] });
    await update(a.id, { keptApartFrom: [c.id] });
    const quote = 'run vitest with --reporter=dot';
    llm.answer(pairs([a.id, b.id], [b.id, c.id]), sameFact(quote, quote));
    expect(await consolidation.consolidate(boardId)).toMatchObject({ merged: [{ id: b.id, into: a.id }], skipped: 1 });
    expect(llm.calls.filter((call) => call.system === VERIFY_SYSTEM)).toHaveLength(1);
    expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, unchanged: true });
  });

  it('skips a later pair whose item this run already merged away, and merges onto the survivor as written', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot, quietly.' });
    const c = await add({ statement: 'In CI, run vitest with --reporter=dot.' });
    const quote = 'run vitest with --reporter=dot';
    llm.answer(
      pairs([a.id, b.id], [b.id, c.id], [a.id, c.id]),
      sameFact(quote, quote),
      sameFact(quote, quote),
    );
    const result = await consolidation.consolidate(boardId);
    expect(result).toMatchObject({
      proposed: 3,
      verified: 2,
      merged: [
        { id: b.id, into: a.id },
        { id: c.id, into: a.id },
      ],
      skipped: 1,
    });
    expect(await item(a.id)).toMatchObject({
      status: 'open',
      occurrenceCount: 4,
      version: a.version + 2,
    });
  });

  it("moves the loser's signal to a survivor without one, and repoints its kb_signals row", async () => {
    const survivor = await add({
      statement: 'Superseded runs: check the run before starting again.',
      occurrenceCount: 2,
    });
    const mined = await add({
      statement: 'Runs are often started again: check the run before starting again.',
      source: 'mined',
      signal: SIGNAL,
      submittedBy: 'slop',
    });
    await store.transaction((tx) =>
      tx.upsertKbSignal({
        boardId,
        key: SIGNAL.key,
        itemId: mined.id,
        lastFigures: SIGNAL.figures,
        lastMeasuredAt: START,
        raisedAt: START,
        belowThresholdRuns: 0,
      }),
    );
    const quote = 'check the run before starting again';
    llm.answer(pairs([survivor.id, mined.id]), sameFact(quote, quote));
    await consolidation.consolidate(boardId);
    expect(await item(survivor.id)).toMatchObject({
      status: 'open',
      signal: SIGNAL,
      source: 'submitted',
    });
    expect(await item(mined.id)).toMatchObject({ status: 'merged', duplicateOf: survivor.id });
    expect((await store.transaction((tx) => tx.listKbSignals(boardId)))[0]).toMatchObject({
      key: SIGNAL.key,
      itemId: survivor.id,
    });
  });

  it("keeps the survivor's own signal when both have one", async () => {
    const own: KbSignal = { ...SIGNAL, key: 'ci_after_local', kind: 'ci_after_local' };
    const survivor = await add({
      statement: 'Check CI before starting again.',
      occurrenceCount: 2,
      signal: own,
      source: 'mined',
    });
    const other = await add({
      statement: 'Check CI before starting again!',
      signal: SIGNAL,
      source: 'mined',
    });
    llm.answer(
      pairs([survivor.id, other.id]),
      sameFact('Check CI before starting again', 'Check CI before starting again'),
    );
    await consolidation.consolidate(boardId);
    expect((await item(survivor.id)).signal).toEqual(own);
  });

  it('merges on a quote that differs only in case and spacing, and a relation written as Same_Fact, keeping the quotes as given', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'In CI, run   vitest\nwith --reporter=dot.' });
    llm.answer(
      pairs([a.id, b.id]),
      json({
        fact: 'f',
        relation: 'Same_Fact',
        quoteA: 'RUN vitest with --reporter=dot',
        quoteB: 'run vitest with --reporter=dot',
      }),
    );
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      merged: [{ id: b.id, into: a.id }],
    });
    expect((await item(b.id)).mergeNote).toMatchObject({
      quote: 'run vitest with --reporter=dot',
      survivorQuote: 'RUN vitest with --reporter=dot',
    });
  });

  it('verifies a pair proposed in both orders once', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot!' });
    const quote = 'Run vitest with --reporter=dot';
    llm.answer(pairs([a.id, b.id], [b.id, a.id]), sameFact(quote, quote));
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      proposed: 1,
      verified: 1,
      merged: [{ id: b.id, into: a.id }],
      skipped: 0,
    });
    expect(llm.calls.filter((c) => c.system === VERIFY_SYSTEM)).toHaveLength(1);
    expect(await item(a.id)).toMatchObject({ status: 'open', occurrenceCount: 3 });
  });

  it('never chains a merge into an item this run closed: every merged item points at an open survivor', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Run vitest with --reporter=dot!', occurrenceCount: 3 });
    const c = await add({ statement: 'Run vitest with --reporter=dot?' });
    const quote = 'Run vitest with --reporter=dot';
    // a~b closes a into b; a~c names the closed a (skipped, no call); c~b merges c into b.
    llm.answer(
      pairs([a.id, b.id], [a.id, c.id], [c.id, b.id]),
      sameFact(quote, quote),
      sameFact(quote, quote),
    );
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      proposed: 3,
      verified: 2,
      merged: [
        { id: a.id, into: b.id },
        { id: c.id, into: b.id },
      ],
      skipped: 1,
    });
    expect(llm.calls.filter((call) => call.system === VERIFY_SYSTEM)).toHaveLength(2);
    expect(await item(a.id)).toMatchObject({ status: 'merged', duplicateOf: b.id });
    expect(await item(c.id)).toMatchObject({ status: 'merged', duplicateOf: b.id });
    const survivor = await item(b.id);
    expect(survivor).toMatchObject({ status: 'open', occurrenceCount: 5, version: b.version + 2 });
    expect(survivor.extraEvidence.map((e) => e.itemId)).toEqual([a.id, c.id]);
  });

  it('merges an item the pipeline gave up on (failed) like a drafted one', async () => {
    const drafted = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const failed = await add({
      statement: 'Run vitest with --reporter=dot!',
      processing: 'failed',
      draft: null,
      processingError: 'Routing failed',
    });
    const quote = 'Run vitest with --reporter=dot';
    llm.answer(pairs([failed.id, drafted.id]), sameFact(quote, quote));
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      candidates: 2,
      merged: [{ id: failed.id, into: drafted.id }],
    });
  });

  it('never offers or merges approved, rejected or closed items, even when the model names them', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.' });
    const b = await add({ statement: 'Use the dot reporter.' });
    const decided = [
      await add({
        statement: 'Run vitest with --reporter=dot!',
        status: 'approved',
        decidedBy: ADMIN,
        decidedAt: START,
      }),
      await add({
        statement: 'Run vitest with --reporter=dot?',
        status: 'rejected',
        decidedBy: ADMIN,
        decidedAt: START,
      }),
      await add({
        statement: 'Run vitest with --reporter=dot;',
        status: 'merged',
        duplicateOf: b.id,
      }),
      await add({
        statement: 'Run vitest with --reporter=dot:',
        status: 'suppressed',
        suppressedBy: a.id,
      }),
    ];
    llm.answer(
      pairs(
        ...decided.map((d): [string, string] => [a.id, d.id]),
        ...decided.map((d): [string, string] => [d.id, b.id]),
      ),
    );
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      candidates: 2,
      proposed: 0,
      merged: [],
    });
    expect(llm.calls).toHaveLength(1);
    for (const d of decided) {
      expect(llm.calls[0]?.prompt).not.toContain(d.id);
      expect(await item(d.id)).toEqual(d);
    }
    expect(await item(a.id)).toEqual(a);
    expect(await item(b.id)).toEqual(b);
  });

  describe('stale flags', () => {
    it('flags an open item with no evidence newer than 60 days, not a millisecond before', async () => {
      const old = await add();
      // A second candidate makes the pair call; it proposes nothing.
      now = at(STALE_AFTER_MS - 1);
      const fresh = await add({ extraEvidence: [] });
      llm.answer(pairs(), pairs());
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 0 });
      now = at(STALE_AFTER_MS);
      expect(await consolidation.consolidate(boardId)).toMatchObject({
        flaggedStale: 1,
        clearedStale: 0,
      });
      expect(await item(old.id)).toMatchObject({
        status: 'open',
        staleSince: now,
        staleReason: 'no_recent_evidence',
      });
      expect(await item(fresh.id)).toMatchObject({ staleSince: null, staleReason: null });
    });

    it('counts evidence merged into an item and its signal measurement as evidence', async () => {
      const merged = await add({
        extraEvidence: [
          { itemId: 's1k50', globIds: [], evidence: 'Repeat', submittedBy: DEV, at: at(10 * DAY) },
        ],
      });
      const measured = await add({
        source: 'mined',
        signal: { ...SIGNAL, measuredAt: at(10 * DAY) },
      });
      now = at(STALE_AFTER_MS);
      llm.answer(pairs());
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 0 });
      now = at(STALE_AFTER_MS + 10 * DAY);
      llm.answer(pairs());
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 2 });
      expect((await item(merged.id)).staleReason).toBe('no_recent_evidence');
      expect((await item(measured.id)).staleReason).toBe('no_recent_evidence');
    });

    it('flags a mined item whose signal has been below its threshold for 4 runs, not 3', async () => {
      const mined = await add({ source: 'mined', signal: SIGNAL });
      const row = {
        boardId,
        key: SIGNAL.key,
        itemId: mined.id,
        lastFigures: SIGNAL.figures,
        lastMeasuredAt: START,
        raisedAt: START,
        belowThresholdRuns: 3,
      };
      await store.transaction((tx) => tx.upsertKbSignal(row));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 0 });
      await store.transaction((tx) => tx.upsertKbSignal({ ...row, belowThresholdRuns: 4 }));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 1 });
      expect(await item(mined.id)).toMatchObject({
        status: 'open',
        staleReason: 'signal_below_threshold',
        staleSince: START,
      });
      // The signal crosses again: the next run clears the flag.
      await store.transaction((tx) => tx.upsertKbSignal({ ...row, belowThresholdRuns: 0 }));
      expect(await consolidation.consolidate(boardId)).toMatchObject({
        flaggedStale: 0,
        clearedStale: 1,
      });
      expect(await item(mined.id)).toMatchObject({
        status: 'open',
        staleSince: null,
        staleReason: null,
      });
    });

    it('never flags an item still in the pipeline, and closes nothing', async () => {
      const routed = await add({ processing: 'routed' });
      now = at(STALE_AFTER_MS * 2);
      await consolidation.consolidate(boardId);
      expect(await item(routed.id)).toEqual(routed);
    });

    it('clears the flag when new evidence arrives (a near-duplicate merged into it)', async () => {
      const old = await add({ statement: 'Run vitest with --reporter=dot.' });
      now = at(STALE_AFTER_MS);
      await consolidation.consolidate(boardId);
      expect((await item(old.id)).staleSince).toBe(now);
      const repeat = await add({ statement: 'Run vitest with --reporter=dot!' });
      const quote = 'Run vitest with --reporter=dot';
      llm.answer(pairs([old.id, repeat.id]), sameFact(quote, quote));
      expect(await consolidation.consolidate(boardId)).toMatchObject({
        merged: [{ id: repeat.id, into: old.id }],
        flaggedStale: 0,
      });
      expect(await item(old.id)).toMatchObject({
        status: 'open',
        staleSince: null,
        staleReason: null,
        occurrenceCount: 2,
      });
    });

    it('lets an admin keep a stale item: the flag clears and stays off for 60 days', async () => {
      const old = await add();
      now = at(STALE_AFTER_MS);
      await consolidation.consolidate(boardId);
      const flagged = await item(old.id);
      expect(errorCode(await knowledge.keepStale(DEV, old.id, flagged.version))).toBe('forbidden');
      expect(errorCode(await knowledge.keepStale(ADMIN, old.id, flagged.version - 1))).toBe(
        'version_conflict',
      );
      const keptAt = now;
      const kept = unwrap(await knowledge.keepStale(ADMIN, old.id, flagged.version));
      expect(kept).toMatchObject({
        status: 'open',
        staleSince: null,
        staleReason: null,
        staleDismissedAt: keptAt,
        version: flagged.version + 1,
      });
      expect(errorCode(await knowledge.keepStale(ADMIN, old.id, kept.version))).toBe(
        'invalid_input',
      );
      now = at(STALE_KEEP_MS - 1, keptAt);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 0 });
      now = at(STALE_KEEP_MS, keptAt);
      expect(await consolidation.consolidate(boardId)).toMatchObject({ flaggedStale: 1 });
    });
  });

  it('orders the open queue by evidence count, then the freshest evidence', async () => {
    const plain = await add();
    now = at(DAY);
    const newer = await add();
    const repeated = await add({ createdAt: START, occurrenceCount: 3 });
    const manyGlobs = await add({
      createdAt: START,
      sourceGlobIds: ['s1t1', 's1t2', 's1t3', 's1t4'],
    });
    const freshRepeat = await add({
      createdAt: START,
      occurrenceCount: 3,
      extraEvidence: [
        { itemId: 's1k40', globIds: [], evidence: 'Repeat', submittedBy: DEV, at: at(2 * DAY) },
      ],
    });
    const listed = unwrap(await knowledge.proposals(DEV, boardId)).open;
    expect(listed.map((i) => i.id)).toEqual([
      manyGlobs.id,
      freshRepeat.id,
      repeated.id,
      newer.id,
      plain.id,
    ]);
    expect(listed.map((i) => i.evidenceCount)).toEqual([4, 3, 3, 1, 1]);
    expect(listed[1]?.lastEvidenceAt).toBe(at(2 * DAY));
  });

  it("reopening a merged item keeps the pair apart on both items, so consolidation doesn't merge them again", async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot!' });
    const quote = 'Run vitest with --reporter=dot';
    llm.answer(pairs([a.id, b.id]), sameFact(quote, quote));
    await consolidation.consolidate(boardId);
    const merged = await item(b.id);
    const reopened = unwrap(await knowledge.reopen(ADMIN, b.id, merged.version));
    expect(reopened).toMatchObject({
      status: 'open',
      duplicateOf: null,
      mergeNote: null,
      keptApartFrom: [a.id],
      processing: 'routed',
    });
    expect((await item(a.id)).keptApartFrom).toEqual([b.id]);
    // Drafted again, it is a candidate; the pair is dropped before any verification.
    await update(b.id, { processing: 'drafted' });
    llm.answer(pairs([a.id, b.id]));
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      candidates: 2,
      proposed: 0,
      merged: [],
    });
    expect(llm.calls.filter((c) => c.system === VERIFY_SYSTEM)).toHaveLength(1);
  });

  describe('keep-apart through a merge (s15f8)', () => {
    const quote = 'Run vitest with --reporter=dot';
    /** A (the likelier survivor), and B and C an admin split from each other; each states the same fact as A. */
    const split = async () => {
      const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 3 });
      const b = await add({ statement: 'Run vitest with --reporter=dot!' });
      const c = await add({ statement: 'Run vitest with --reporter=dot?', keptApartFrom: [b.id] });
      await update(b.id, { keptApartFrom: [c.id] });
      return { a, b: await item(b.id), c };
    };

    it('merges only one of two items an admin split, when both verify against a third in one run', async () => {
      const { a, b, c } = await split();
      llm.answer(pairs([a.id, b.id], [a.id, c.id]), sameFact(quote, quote), sameFact(quote, quote));
      expect(await consolidation.consolidate(boardId)).toMatchObject({
        proposed: 2,
        verified: 1,
        merged: [{ id: b.id, into: a.id }],
        skipped: 1,
      });
      // The second pair is refused before its verification call.
      expect(llm.calls.filter((call) => call.system === VERIFY_SYSTEM)).toHaveLength(1);
      expect(await item(c.id)).toMatchObject({ status: 'open', duplicateOf: null, version: c.version });
    });

    it("carries the loser's kept-apart items onto the survivor, which keeps the two apart in a later run", async () => {
      const { a, b, c } = await split();
      llm.answer(pairs([a.id, b.id]), sameFact(quote, quote));
      await consolidation.consolidate(boardId);
      const survivor = await item(a.id);
      expect(survivor.keptApartFrom).toEqual([c.id]);
      expect(survivor.extraEvidence.map((e) => e.itemId)).toEqual([b.id]);

      llm.answer(pairs([a.id, c.id], [c.id, a.id]));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ candidates: 2, proposed: 0, merged: [] });
      expect(llm.calls.filter((call) => call.system === VERIFY_SYSTEM)).toHaveLength(1);
      expect(await item(c.id)).toMatchObject({ status: 'open', duplicateOf: null });
    });

    it('keeps the two apart in a later run through the evidence the survivor holds, even without the carried set', async () => {
      const { a, b, c } = await split();
      llm.answer(pairs([a.id, b.id]), sameFact(quote, quote));
      await consolidation.consolidate(boardId);
      // A survivor merged before kept-apart sets were carried: only its evidence names B.
      await update(a.id, { keptApartFrom: [] });
      await update(c.id, { keptApartFrom: [b.id] });
      llm.answer(pairs([c.id, a.id]));
      expect(await consolidation.consolidate(boardId)).toMatchObject({ proposed: 0, merged: [] });
      expect(await item(c.id)).toMatchObject({ status: 'open' });
    });

    it('refuses the pair at the write when an item gained a kept-apart one between the read and the merge', async () => {
      const { a, c } = await split();
      const d = await add({ statement: 'Run vitest with --reporter=dot;' });
      llm.answer(pairs([a.id, d.id]), async () => {
        // An admin separates A from D while the pair is verified (and the version race is out of the way).
        const fresh = await item(d.id);
        await store.transaction((tx) => tx.updateKbItem({ ...fresh, keptApartFrom: [a.id] }, fresh.version));
        return sameFact(quote, quote);
      });
      expect(await consolidation.consolidate(boardId)).toMatchObject({ verified: 1, merged: [], skipped: 1 });
      expect(await item(a.id)).toMatchObject({ status: 'open', occurrenceCount: 3 });
      expect(await item(c.id)).toMatchObject({ status: 'open' });
    });
  });

  it('records nothing on the other item when a suppressed or covered item is reopened', async () => {
    const rejected = await add({ status: 'rejected' });
    const suppressed = await add({ status: 'suppressed', suppressedBy: rejected.id });
    const reopened = unwrap(await knowledge.reopen(ADMIN, suppressed.id, suppressed.version));
    expect(reopened.keptApartFrom).toEqual([]);
    expect(await item(rejected.id)).toEqual(rejected);
  });

  it('propagates an LLM outage from the pair call, writing nothing', async () => {
    const a = await add();
    await add();
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    await expect(consolidation.consolidate(boardId)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(await item(a.id)).toEqual(a);
  });

  it('propagates an LLM outage from a verification call, keeping merges already written', async () => {
    const a = await add({ statement: 'Run vitest with --reporter=dot.', occurrenceCount: 2 });
    const b = await add({ statement: 'Run vitest with --reporter=dot!' });
    const c = await add({ statement: 'Use the dot reporter.' });
    const quote = 'Run vitest with --reporter=dot';
    llm.answer(
      pairs([a.id, b.id], [a.id, c.id]),
      sameFact(quote, quote),
      new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'),
    );
    await expect(consolidation.consolidate(boardId)).rejects.toBeInstanceOf(LlmUnavailable);
    expect((await item(b.id)).status).toBe('merged');
    expect(await item(c.id)).toEqual(c);
  });
});

describe('Learning jobs: weekly consolidation after mining, paused while its AI is down', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let now: string;
  let down: boolean;
  let jobs: LearningJobService;
  let boardId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    llm = new FakeLlm();
    now = START;
    down = false;
    const clock = { now: () => now };
    jobs = new LearningJobService({
      store,
      clock,
      notifier,
      mining: new MiningService({ store, notifier }),
      consolidation: new KbConsolidation({ store, clock, notifier, llm }),
      consolidationDown: () => down,
      manifests: null,
    });
    boardId = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      for (const [email, role] of [
        [ADMIN, 'admin'],
        [DEV, 'dev'],
      ] as const) {
        await tx.upsertUser({ email, name: email, active: true });
        await tx.upsertMember({ boardId: board.id, email, role });
      }
      return board.id;
    });
  });

  const job = (name: 'mining' | 'consolidation') =>
    store.transaction((tx) => tx.getBoardJob(boardId, name));

  it('runs consolidation after mining when both are due, then not again for a week', async () => {
    const ran = await jobs.runDue();
    expect(ran.map((r) => r.job)).toEqual(['mining', 'consolidation']);
    expect(ran[1]?.result).toMatchObject({ kind: 'consolidation', candidates: 0, proposed: 0 });
    expect(await job('consolidation')).toMatchObject({ lastRunAt: START, runningUntil: null });
    now = at(CONSOLIDATION_INTERVAL_MS - 60_000);
    expect(await jobs.runDue()).toEqual([]);
    now = at(CONSOLIDATION_INTERVAL_MS);
    expect((await jobs.runDue()).map((r) => r.job)).toEqual(['mining', 'consolidation']);
  });

  it("doesn't claim consolidation while its model is down, and runs it on the next check after", async () => {
    down = true;
    expect((await jobs.runDue()).map((r) => r.job)).toEqual(['mining']);
    expect(await job('consolidation')).toBeNull();
    down = false;
    now = at(60 * 60 * 1000);
    expect((await jobs.runDue()).map((r) => r.job)).toEqual(['consolidation']);
  });

  it('records an outage met mid-run as skipped, without moving the last run, so the next check tries again', async () => {
    for (const id of ['s1k1', 's1k2']) {
      await store.transaction((tx) =>
        tx.insertKbItem({
          id,
          boardId,
          status: 'open',
          type: 'gotcha',
          statement: id,
          evidence: id,
          suggestedTarget: null,
          sourceGlobIds: [],
          source: 'submitted',
          signal: null,
          agentSetVersion: null,
          submittedBy: DEV,
          createdAt: START,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          document: null,
          outcome: null,
          ...UNPROCESSED,
          processing: 'drafted',
          version: 1,
        }),
      );
    }
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    const ran = await jobs.runDue();
    expect(ran[1]).toEqual({
      boardId,
      job: 'consolidation',
      result: { kind: 'skipped', reason: 'AI unavailable: AWS sign-in expired' },
    });
    expect(await job('consolidation')).toMatchObject({ lastRunAt: null, runningUntil: null });
    now = at(60 * 60 * 1000);
    llm.answer(pairs());
    expect((await jobs.runDue()).map((r) => r.result.kind)).toEqual(['consolidation']);
  });

  it('lets admins run consolidation now, and refuses developers', async () => {
    expect(errorCode(await jobs.runNow(DEV, boardId, 'consolidation'))).toBe('forbidden');
    const started = unwrap(await jobs.runNow(ADMIN, boardId, 'consolidation'));
    // Its lease covers the worst case: 21 calls to the 2-minute deadline, 15 minutes, and a mining run's 30.
    expect(started.job).toMatchObject({ job: 'consolidation', runningUntil: at(87 * 60 * 1000) });
    expect(await started.finished).toMatchObject({
      lastRunAt: START,
      lastResult: { kind: 'consolidation' },
    });
    // A model known to be down skips the run without calls.
    down = true;
    const skipped = unwrap(await jobs.runNow(ADMIN, boardId, 'consolidation'));
    expect(await skipped.finished).toMatchObject({
      lastRunAt: START,
      lastResult: { kind: 'skipped', reason: 'AI unavailable' },
    });
    expect(llm.calls).toEqual([]);
  });

  it('tries a skipped Run now again at the next hourly check, though the board ran within the week', async () => {
    expect((await jobs.runDue()).map((r) => r.job)).toEqual(['mining', 'consolidation']);
    now = at(DAY);
    // Run now while the model is down mid-run: skipped, and the last run stays.
    await store.transaction((tx) =>
      tx.insertKbItem({
        id: 's1k1',
        boardId,
        status: 'open',
        type: 'gotcha',
        statement: 's1k1',
        evidence: 's1k1',
        suggestedTarget: null,
        sourceGlobIds: [],
        source: 'submitted',
        signal: null,
        agentSetVersion: null,
        submittedBy: DEV,
        createdAt: START,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        document: null,
        outcome: null,
        ...UNPROCESSED,
        processing: 'drafted',
        version: 1,
      }),
    );
    await store.transaction(async (tx) => {
      const first = await tx.getKbItem('s1k1');
      if (first !== null) await tx.insertKbItem({ ...first, id: 's1k2' });
    });
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    const skipped = unwrap(await jobs.runNow(ADMIN, boardId, 'consolidation'));
    expect(await skipped.finished).toMatchObject({ lastRunAt: START, lastResult: { kind: 'skipped' } });
    // The model is back: the next hourly check runs it, a week early.
    now = at(DAY + 60 * 60 * 1000);
    llm.answer(pairs());
    const ran = await jobs.runDue();
    expect(ran.map((r) => r.result.kind)).toEqual(['consolidation']);
    expect(await job('consolidation')).toMatchObject({ lastRunAt: now });
  });

  it('backs off a failing run: 1 hour, then 2, 4 and so on up to a day, and runs weekly again once it succeeds', async () => {
    expect([1, 2, 3, 5, 6, 10].map(failedRetryMs)).toEqual(
      [1, 2, 4, 16, 24, 24].map((h) => h * 60 * 60 * 1000),
    );
    expect(FAILED_RETRY_MAX_MS).toBe(DAY);
    const HOUR = 60 * 60 * 1000;
    // Two candidates, so the pair call runs; its answer isn't JSON, which fails the run.
    for (const id of ['s1k1', 's1k2'])
      await store.transaction((tx) =>
        tx.insertKbItem({
          id,
          boardId,
          status: 'open',
          type: 'gotcha',
          statement: id,
          evidence: id,
          suggestedTarget: null,
          sourceGlobIds: [],
          source: 'submitted',
          signal: null,
          agentSetVersion: null,
          submittedBy: DEV,
          createdAt: START,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          document: null,
          outcome: null,
          ...UNPROCESSED,
          processing: 'drafted',
          version: 1,
        }),
      );
    const consolidationRuns = async () =>
      (await jobs.runDue()).filter((r) => r.job === 'consolidation').map((r) => r.result);
    llm.answer('not JSON');
    expect(await consolidationRuns()).toEqual([
      { kind: 'failed', error: 'The candidate-pair answer was not usable JSON', at: START, failures: 1 },
    ]);
    let failedAt = START;
    for (const [failures, wait] of [
      [2, HOUR],
      [3, 2 * HOUR],
      [4, 4 * HOUR],
    ] as const) {
      now = at(wait - 60_000, failedAt);
      expect(await consolidationRuns()).toEqual([]);
      now = at(wait, failedAt);
      llm.answer('not JSON');
      expect(await consolidationRuns()).toMatchObject([{ kind: 'failed', at: now, failures }]);
      failedAt = now;
    }
    expect(await job('consolidation')).toMatchObject({ lastRunAt: null });
    // The next try is 8 hours on; it succeeds, and the board is back on its weekly run.
    now = at(8 * HOUR, failedAt);
    llm.answer(pairs());
    expect(await consolidationRuns()).toMatchObject([{ kind: 'consolidation' }]);
    expect(await job('consolidation')).toMatchObject({ lastRunAt: now });
    const succeeded = now;
    now = at(CONSOLIDATION_INTERVAL_MS - 60_000, succeeded);
    expect(await consolidationRuns()).toEqual([]);
    now = at(CONSOLIDATION_INTERVAL_MS, succeeded);
    expect(await consolidationRuns()).toMatchObject([{ kind: 'consolidation' }]);
  });

  it('keeps the failures in a row through a skip, so an AI that alternates between down and failing still backs off', async () => {
    const HOUR = 60 * 60 * 1000;
    for (const id of ['s1k1', 's1k2'])
      await store.transaction((tx) =>
        tx.insertKbItem({
          id,
          boardId,
          status: 'open',
          type: 'gotcha',
          statement: id,
          evidence: id,
          suggestedTarget: null,
          sourceGlobIds: [],
          source: 'submitted',
          signal: null,
          agentSetVersion: null,
          submittedBy: DEV,
          createdAt: START,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          document: null,
          outcome: null,
          ...UNPROCESSED,
          processing: 'drafted',
          version: 1,
        }),
      );
    const consolidationRuns = async () =>
      (await jobs.runDue()).filter((r) => r.job === 'consolidation').map((r) => r.result);
    llm.answer('not JSON');
    expect(await consolidationRuns()).toMatchObject([{ kind: 'failed', failures: 1 }]);
    now = at(HOUR);
    llm.answer('not JSON');
    expect(await consolidationRuns()).toMatchObject([{ kind: 'failed', failures: 2 }]);
    // Down for the next try: skipped, keeping the two failures.
    now = at(3 * HOUR);
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    expect(await consolidationRuns()).toEqual([
      { kind: 'skipped', reason: 'AI unavailable: AWS sign-in expired', failures: 2 },
    ]);
    // Skipped again (known down): still two.
    down = true;
    const skipped = unwrap(await jobs.runNow(ADMIN, boardId, 'consolidation'));
    expect((await skipped.finished).lastResult).toEqual({ kind: 'skipped', reason: 'AI unavailable', failures: 2 });
    // Back but failing: the third failure in a row, so the next try waits 4 hours, not 1.
    down = false;
    now = at(4 * HOUR);
    llm.answer('not JSON');
    expect(await consolidationRuns()).toMatchObject([{ kind: 'failed', at: now, failures: 3 }]);
    now = at(8 * HOUR - 60_000);
    expect(await consolidationRuns()).toEqual([]);
    now = at(8 * HOUR);
    llm.answer(pairs());
    expect(await consolidationRuns()).toMatchObject([{ kind: 'consolidation' }]);
  });

  it("gives consolidation a lease that covers its worst case, and leaves mining's as it was", async () => {
    expect(CONSOLIDATION_LEASE_MS).toBe(
      (1 + MAX_CONSOLIDATION_PAIRS) * 2 * 60_000 + 15 * 60_000 + BOARD_JOB_LEASE_MS,
    );
    expect(BOARD_JOB_LEASE_MS).toBe(30 * 60_000);
    const mining = unwrap(await jobs.runNow(ADMIN, boardId, 'mining'));
    expect(mining.job.runningUntil).toBe(at(BOARD_JOB_LEASE_MS));
    await mining.finished;
  });

  it("refuses consolidation's Run now where the service has no consolidation", async () => {
    const without = new LearningJobService({
      store,
      clock: { now: () => now },
      notifier,
      mining: new MiningService({ store, notifier }),
      manifests: null,
    });
    expect(errorCode(await without.runNow(ADMIN, boardId, 'consolidation'))).toBe('invalid_input');
  });
});
