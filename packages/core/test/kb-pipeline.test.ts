import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { DEDUPE_SYSTEM, KbPipeline, ROUTE_SYSTEM } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import { llmWaitingReason } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { Catalog, Tx } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const errorCode = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';

const IMPLEMENTER = '---\nname: implementer\ndescription: Implements plans\n---\n\n# Implementer\n\n## Rules\n\n- Follow the plan.\n';

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () =>
    Promise.resolve({
      hash: 'h1',
      files: [
        { path: 'agents/implementer.md', content: IMPLEMENTER },
        { path: 'settings.json', content: '{}\n' },
      ],
    }),
};

type Answer = string | Error | (() => Promise<string>);

/** A fake LLM answering from a queue of canned answers (or errors, or calls), recording each request. */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(private readonly answers: Answer[] = []) {}
  answer(...answers: Answer[]): void {
    this.answers.push(...answers);
  }
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt });
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    if (typeof next === 'function') return next();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

/** A fake LLM that never answers: it only rejects when the caller's deadline aborts the call. */
class HangingLlm implements Llm {
  readonly signals: (AbortSignal | undefined)[] = [];
  complete(request: LlmRequest): Promise<string> {
    this.signals.push(request.signal);
    return new Promise((_, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}

const json = (value: unknown) => JSON.stringify(value);
/** The dedupe answer's `checked` entries: each ref with the same relation. */
const classed = (relation: string, ...refs: string[]) => refs.map((ref) => ({ ref, relation }));
const toDoc = (name: string, section: string | null = null) =>
  json({ target: { kind: 'document', name, section, newDocument: null }, catalogCandidate: false, catalogReason: null });
const toNewDoc = (name: string) =>
  json({
    target: {
      kind: 'document',
      name,
      section: null,
      newDocument: { area: 'testing', audience: ['tester', 'not valid!'], description: 'How tests run' },
    },
    catalogCandidate: false,
    catalogReason: null,
  });
/** How many probes the waiting test makes: more than the attempts that would fail an item. */
const MAX_PROBES = 4;
const NO_MATCH = json({ suppressedBy: null, duplicateOf: null, coveredBy: null, contradicts: [] });
/** The default statement, and one that says the same in other words (both long enough to close on). */
const GEN = 'Generated files live in src/gen/';
const GEN_AGAIN = 'Code in src/gen/ is generated';
/** A merge or suppression claim on `id`: a quote from its statement and one from the new item's (`newQuote`). */
const claim = (id: string, quote = GEN, newQuote = GEN_AGAIN) => ({ id, quote, newQuote });

describe('KB pipeline: routing and dedupe', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let knowledge: KnowledgeService;
  let pipeline: KbPipeline;
  let llm: FakeLlm;
  let now: string;
  let boardId: number;
  let globId: string;
  let otherGlobId: string;

  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };

  const submit = async (patch: Partial<NewLearning> = {}) =>
    unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: globId,
        type: 'gotcha',
        statement: 'Generated files live in src/gen/',
        evidence: 'Review finding on src/gen/client.ts',
        ...patch,
      }),
    ).id;

  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  /** Submits an item and routes it to a new document with nothing to compare against (one call). */
  const routedAlone = async (patch: Partial<NewLearning> = {}) => {
    const id = await submit(patch);
    llm.answer(toNewDoc('testing'));
    expect(await pipeline.processNext()).toBe(id);
    return id;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    const clock = { now: () => now };
    llm = new FakeLlm();
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    pipeline = new KbPipeline({ store, clock, catalog, notifier, route: llm, draft: new FakeLlm() });
    const boards = new BoardService({ store, notifier });
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    const create = async () =>
      unwrap(
        await globs.create(ADMIN, {
          boardId,
          title: 'Work',
          summary: '',
          type: 'same',
          category: 'task',
          group: null,
          environment: null,
          autoTrigger: false,
          idempotencyKey: null,
        }),
      ).id;
    globId = await create();
    otherGlobId = await create();
    unwrap(
      await knowledge.importDocuments(
        ADMIN,
        boardId,
        [
          {
            fileName: 'build_test_lint.md',
            content:
              '---\narea: build\naudience: [implementer, tester]\ndescription: Build and test commands\n---\n# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n',
          },
        ],
        'upload',
      ),
    );
    notifier.hints.length = 0;
  });

  it('leaves a new statement pending for the pipeline and returns its ID straight away', async () => {
    const id = await submit();
    expect(await item(id)).toMatchObject({ processing: 'pending', target: null, occurrenceCount: 1, processingAttempts: 0 });
  });

  it('routes to a document section, showing the model the document index and agent files', async () => {
    const id = await submit({ suggestedTarget: 'build_test_lint' });
    llm.answer(toDoc('build_test_lint', '## Test'), NO_MATCH);
    expect(await pipeline.processNext()).toBe(id);

    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      processAfter: null,
      target: { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null },
      catalogCandidate: false,
      contradicts: [],
    });
    const [route, dedupe] = llm.calls;
    expect(route?.system).toBe(ROUTE_SYSTEM);
    expect(route?.prompt).toContain('Suggested target: build_test_lint');
    expect(route?.prompt).toContain('- build_test_lint [area: build; for: implementer, tester] Build and test commands');
    expect(route?.prompt).toContain('headings: Test | Lint');
    expect(route?.prompt).toContain('- agents/implementer.md [agent] Implements plans');
    // Settings take no prose learnings.
    expect(route?.prompt).not.toContain('settings.json');
    // Dedupe sees the routed section's current text.
    expect(dedupe?.system).toBe(DEDUPE_SYSTEM);
    expect(dedupe?.prompt).toContain('## Test\n\nRun vitest.');
    expect(dedupe?.prompt).not.toContain('Run eslint.');
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    // Next in line: its draft.
    expect((await store.transaction((tx) => tx.nextKbItemToProcess(now)))?.id).toBe(id);
  });

  it("routes to an agent file's board rules and flags a catalog candidate with its reason", async () => {
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'agent',
        name: 'agents/implementer.md',
        area: null,
        audience: [],
        description: '',
        content: '### Testing\n\n- Run the fast checks.\n',
        layer: 'overlay',
        version: 1,
        source: 'edit',
        updatedBy: ADMIN,
        updatedAt: START,
      }),
    );
    const id = await submit({ type: 'agent-behaviour', statement: 'Write the regression test before the fix' });
    llm.answer(
      json({
        target: { kind: 'agent_file', name: 'agents/implementer.md', section: 'Testing', newDocument: null },
        catalogCandidate: true,
        catalogReason: 'Holds for any codebase',
      }),
      NO_MATCH,
    );
    await pipeline.processNext();

    expect(await item(id)).toMatchObject({
      processing: 'routed',
      target: { kind: 'agent', name: 'agents/implementer.md', section: 'Testing', newDocument: null },
      catalogCandidate: true,
      catalogReason: 'Holds for any codebase',
    });
    expect(llm.calls[0]?.prompt).toContain('board-rule headings: Testing');
    // The served file (catalog plus board rules) is what dedupe compares against.
    expect(llm.calls[1]?.prompt).toContain('### Testing\n\n- Run the fast checks.');
  });

  it('routes to a new document with proposed frontmatter, skipping dedupe when there is nothing to compare', async () => {
    const id = await routedAlone();
    expect(await item(id)).toMatchObject({
      processing: 'routed',
      target: {
        kind: 'doc',
        name: 'testing',
        section: null,
        newDocument: { area: 'testing', audience: ['tester'], description: 'How tests run' },
      },
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('merges a near-duplicate of an open item into it, adding its evidence, count and globs', async () => {
    const first = await routedAlone();
    const second = await submit({ sourceGlobId: otherGlobId, statement: 'Code in src/gen/ is generated', evidence: 'Tester note' });
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', first), duplicateOf: claim(first), suppressedBy: null, coveredBy: null, contradicts: [] }));
    expect(await pipeline.process(second)).toBe(true);

    expect(llm.calls[2]?.prompt).toContain(`- ${first} (gotcha): Generated files live in src/gen/`);
    expect(await item(second)).toMatchObject({
      status: 'merged',
      duplicateOf: first,
      processing: 'routed',
      mergeNote: { by: 'intake', quote: GEN_AGAIN, survivorQuote: GEN, at: START },
    });
    const merged = await item(first);
    expect(merged).toMatchObject({
      status: 'open',
      occurrenceCount: 2,
      sourceGlobIds: [globId, otherGlobId],
      extraEvidence: [{ itemId: second, globIds: [otherGlobId], evidence: 'Tester note', submittedBy: DEV, at: START }],
    });
    // Merged items leave the open queue.
    const open = await store.transaction((tx) => tx.listKbItems(boardId, 'open'));
    expect(open.map((i) => i.id)).toEqual([first]);
  });

  it('leaves open a near-duplicate an admin kept apart from the item it matches, holding nothing on either (s15f8)', async () => {
    const first = await routedAlone();
    const second = await submit({ sourceGlobId: otherGlobId, statement: 'Code in src/gen/ is generated' });
    // An admin reopened a merge between them (or between one and an item the other holds).
    const pending = await item(second);
    await store.transaction((tx) => tx.updateKbItem({ ...pending, keptApartFrom: [first], version: pending.version + 1 }, pending.version));
    const before = await item(first);
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', first), duplicateOf: claim(first), suppressedBy: null, coveredBy: null, contradicts: [] }));
    expect(await pipeline.process(second)).toBe(true);
    expect(await item(second)).toMatchObject({ status: 'open', duplicateOf: null, processing: 'routed' });
    expect(await item(first)).toEqual(before);
  });

  it('makes an open item it merges into due again at once, so a claim running on it is redone without waiting out the lease', async () => {
    const first = await routedAlone();
    // A worker has claimed the first item for drafting (its lease runs for five minutes).
    const claimed = await item(first);
    const lease = '2026-10-05T12:05:00.000Z';
    await store.transaction((tx) => tx.updateKbItem({ ...claimed, processAfter: lease, version: claimed.version + 1 }, claimed.version));
    const second = await submit({ sourceGlobId: otherGlobId, statement: 'Code in src/gen/ is generated' });
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', first), duplicateOf: claim(first), suppressedBy: null, coveredBy: null, contradicts: [] }));
    expect(await pipeline.processNext()).toBe(second);
    expect(await item(first)).toMatchObject({ occurrenceCount: 2, processing: 'routed', processAfter: null });

    // An item backing off after a failure keeps its backoff.
    const third = await submit({ statement: 'Generated code is kept in src/gen/' });
    const backingOff = await item(first);
    const backoff = '2026-10-05T12:01:00.000Z';
    await store.transaction((tx) =>
      tx.updateKbItem(
        { ...backingOff, processingError: 'Bedrock is down', processingAttempts: 1, processAfter: backoff, version: backingOff.version + 1 },
        backingOff.version,
      ),
    );
    llm.answer(
      toNewDoc('testing'),
      json({ checked: classed('same fact', first), duplicateOf: claim(first, GEN, 'Generated code is kept in src/gen/'), contradicts: [] }),
    );
    expect(await pipeline.process(third)).toBe(true);
    expect(await item(first)).toMatchObject({ occurrenceCount: 3, processAfter: backoff });
  });

  it('suppresses an item matching a rejected one', async () => {
    const rejected = await submit();
    const decided = await item(rejected);
    unwrap(await knowledge.reject(ADMIN, rejected, decided.version, 'Not true here'));
    const id = await submit({ statement: GEN_AGAIN });
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', rejected), suppressedBy: claim(rejected), duplicateOf: null, coveredBy: null, contradicts: [] }));
    expect(await pipeline.processNext()).toBe(id);

    expect(llm.calls[1]?.prompt).toContain(`- ${rejected}: Generated files live in src/gen/ (rejected: Not true here)`);
    expect(await item(id)).toMatchObject({
      status: 'suppressed',
      suppressedBy: rejected,
      mergeNote: { by: 'intake', quote: GEN_AGAIN, survivorQuote: GEN, at: START },
    });
  });

  it('closes on quotes the model ended with punctuation the statements lack (s15b8)', async () => {
    const rejected = await submit();
    unwrap(await knowledge.reject(ADMIN, rejected, (await item(rejected)).version, 'Not true here'));
    const id = await submit({ statement: GEN_AGAIN });
    const value = claim(rejected, `"${GEN}."`, `${GEN_AGAIN}.`);
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', rejected), suppressedBy: value, contradicts: [] }));
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({
      status: 'suppressed',
      suppressedBy: rejected,
      mergeNote: { quote: GEN_AGAIN, survivorQuote: GEN },
    });
  });

  describe.each([
    ['merge', 'duplicateOf', 'duplicate', 'merged'],
    ['suppression', 'suppressedBy', 'suppressed', 'suppressed'],
  ] as const)('a %s claim closes the item only on two verbatim quotes long enough (s15b8)', (_, answerField, claimKind, closedAs) => {
    /** The item the claim names (open, or rejected), and a new item saying the same in other words. */
    const setUp = async () => {
      let other: string;
      if (claimKind === 'duplicate') {
        other = await routedAlone();
      } else {
        other = await submit();
        unwrap(await knowledge.reject(ADMIN, other, (await item(other)).version, 'Not true here'));
      }
      const id = await submit({ sourceGlobId: otherGlobId, statement: GEN_AGAIN });
      return { other, id, before: await item(other) };
    };
    const answer = (other: string, value: unknown) =>
      llm.answer(toNewDoc('testing'), json({ fact: 'src/gen/ is generated', checked: classed('same fact', other), [answerField]: value, contradicts: [] }));

    it('closes on both quotes and keeps them on the closed item', async () => {
      const { other, id } = await setUp();
      answer(other, claim(other, ` generated FILES live in  src/gen/`, 'code in src/gen/ is generated'));
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({
        status: closedAs,
        [answerField]: other,
        possiblyCoveredBy: null,
        mergeNote: { by: 'intake', quote: 'code in src/gen/ is generated', survivorQuote: 'generated FILES live in  src/gen/', at: START },
      });
      // A suppression adds nothing to the rejected item; a merge adds the evidence to the open one.
      expect((await item(other)).occurrenceCount).toBe(claimKind === 'duplicate' ? 2 : 1);

      // Reopening it clears the note, so its card no longer says what it closed on.
      const reopened = unwrap(await knowledge.reopen(ADMIN, id, (await item(id)).version));
      expect(reopened).toMatchObject({ status: 'open', duplicateOf: null, suppressedBy: null, mergeNote: null });
    });

    it.each([
      ['no quotes (the ID alone)', (other: string) => other],
      ['a missing quote from the new item', (other: string) => ({ id: other, quote: GEN })],
      ['a missing quote from the matched item', (other: string) => ({ id: other, newQuote: GEN_AGAIN })],
      ['an unverifiable quote from the matched item', (other: string) => claim(other, 'Generated files are checked in', GEN_AGAIN)],
      ['an unverifiable quote from the new item', (other: string) => claim(other, GEN, 'Code in src/gen/ is hand written')],
      ['swapped quotes (each in the other statement)', (other: string) => claim(other, GEN_AGAIN, GEN)],
    ])('leaves the item open, with no hint, on %s', async (_, value) => {
      const { other, id, before } = await setUp();
      answer(other, value(other));
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({
        status: 'open',
        processing: 'routed',
        duplicateOf: null,
        suppressedBy: null,
        mergeNote: null,
        possiblyCoveredBy: null,
      });
      expect(await item(other)).toEqual(before);
    });

    it.each([
      ['the matched item', 'Generated files', GEN_AGAIN, 'quote'],
      ['the new item', GEN, 'is generated', 'ownQuote'],
      ['both items', 'Generated files', 'is generated', 'both'],
    ] as const)('leaves the item open but flags it when the quote from %s is verbatim but too short', async (...test) => {
      const [, quote, newQuote, tooShort] = test;
      const { other, id, before } = await setUp();
      answer(other, claim(other, quote, newQuote));
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({
        status: 'open',
        processing: 'routed',
        duplicateOf: null,
        suppressedBy: null,
        mergeNote: null,
        possiblyCoveredBy: {
          kind: 'item',
          id: other,
          quote,
          ownQuote: newQuote,
          shortQuote: true,
          claim: claimKind,
          tooShort,
        },
      });
      expect(await item(other)).toEqual(before);
    });
  });

  describe('one hint at a time, beside any contradictions (s15b8)', () => {
    /** An open, a rejected and an approved item, and a new item routed to a section with text. */
    const setUp = async () => {
      const open = await routedAlone();
      const rejected = await submit();
      unwrap(await knowledge.reject(ADMIN, rejected, (await item(rejected)).version, 'Not true here'));
      const approved = await submit({ statement: 'Generated files are committed to git' });
      unwrap(await knowledge.approve(ADMIN, approved, (await item(approved)).version, { as: 'learning' }));
      const id = await submit({ sourceGlobId: otherGlobId, statement: GEN_AGAIN });
      return { open, rejected, approved, id };
    };
    const short = (id: string) => claim(id, 'Generated files', GEN_AGAIN);
    const hint = (id: string, kind: 'duplicate' | 'suppressed') => ({
      kind: 'item',
      id,
      quote: 'Generated files',
      ownQuote: GEN_AGAIN,
      shortQuote: true,
      claim: kind,
      tooShort: 'quote',
    });

    it("keeps suppression's hint over merge's", async () => {
      const { open, rejected, id } = await setUp();
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: classed('same fact', rejected, open),
          suppressedBy: short(rejected),
          duplicateOf: short(open),
          contradicts: [],
        }),
      );
      expect(await pipeline.process(id)).toBe(true);
      const result = await item(id);
      expect(result).toMatchObject({ status: 'open', suppressedBy: null, duplicateOf: null, contradicts: [] });
      expect(result.possiblyCoveredBy).toEqual(hint(rejected, 'suppressed'));
    });

    it("keeps merge's hint over the target's, with the target's quote and reason beside it", async () => {
      const { open, id } = await setUp();
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: classed('same fact', open, 'current text'),
          duplicateOf: short(open),
          coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'Names the runner' },
          contradicts: [],
        }),
      );
      expect(await pipeline.process(id)).toBe(true);
      const result = await item(id);
      expect(result).toMatchObject({ status: 'open', duplicateOf: null, coveredBy: null });
      expect(result.possiblyCoveredBy).toEqual({
        ...hint(open, 'duplicate'),
        alsoTarget: { quote: 'Run vitest', reason: 'Names the runner' },
      });
    });

    /** Marks the new item as kept apart from `other`, as reopening a merge between them would. */
    const keepApart = async (id: string, other: string) => {
      const pending = await item(id);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...pending, keptApartFrom: [other], version: pending.version + 1 }, pending.version),
      );
    };

    it('names no item an admin kept apart from this one, showing a target hint it hid instead', async () => {
      const { rejected, id } = await setUp();
      await keepApart(id, rejected);
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: classed('same fact', rejected, 'current text'),
          suppressedBy: short(rejected),
          coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'Names the runner' },
          contradicts: [],
        }),
      );
      expect(await pipeline.process(id)).toBe(true);
      const result = await item(id);
      expect(result).toMatchObject({ status: 'open', suppressedBy: null });
      expect(result.possiblyCoveredBy).toEqual({
        knowledgeKind: 'doc',
        name: 'build_test_lint',
        section: 'Test',
        quote: 'Run vitest',
        reason: 'Names the runner',
      });
    });

    it.each([
      ['an open item it may repeat', 'open'],
      ['an approved item that may cover it', 'approved'],
    ] as const)('names no %s when an admin kept them apart, and no hint when none is hidden', async (_, which) => {
      const ids = await setUp();
      const other = ids[which];
      await keepApart(ids.id, other);
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: classed('same fact', other),
          duplicateOf: which === 'open' ? short(other) : null,
          coveredBy: which === 'approved' ? { kind: 'item', id: other, quote: 'Generated files' } : null,
          contradicts: [],
        }),
      );
      expect(await pipeline.process(ids.id)).toBe(true);
      expect(await item(ids.id)).toMatchObject({ status: 'open', duplicateOf: null, coveredBy: null, possiblyCoveredBy: null });
    });

    it("stores merge's hint and a verified contradiction together", async () => {
      const { open, approved, id } = await setUp();
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: [...classed('same fact', open), ...classed('contradicts', approved)],
          duplicateOf: short(open),
          contradicts: [{ kind: 'item', ref: approved, quote: 'Generated files are committed', note: 'Says they are committed' }],
        }),
      );
      expect(await pipeline.process(id)).toBe(true);
      const result = await item(id);
      expect(result).toMatchObject({
        status: 'open',
        duplicateOf: null,
        contradicts: [{ kind: 'item', ref: approved, note: 'Says they are committed' }],
      });
      expect(result.possiblyCoveredBy).toEqual(hint(open, 'duplicate'));
    });
  });

  describe('a merge carries a short-quote match with a rejected item to the item merged into (s15b8)', () => {
    /** An open item, a rejected one, and a new item merging into the open one while it may match the rejected one. */
    const setUp = async () => {
      const open = await routedAlone();
      const rejected = await submit({ statement: 'Generated files are committed to git' });
      unwrap(await knowledge.reject(ADMIN, rejected, (await item(rejected)).version, 'Not true here'));
      const id = await submit({ sourceGlobId: otherGlobId, statement: GEN_AGAIN });
      llm.answer(
        toDoc('build_test_lint', 'Test'),
        json({
          checked: classed('same fact', open, rejected, 'current text'),
          duplicateOf: claim(open),
          suppressedBy: claim(rejected, 'Generated files', GEN_AGAIN),
          coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'Names the runner' },
          contradicts: [],
        }),
      );
      return { open, rejected, id };
    };

    it('flags the open item with the hint, naming the merged item its own quote is from', async () => {
      const { open, rejected, id } = await setUp();
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({ status: 'merged', duplicateOf: open, possiblyCoveredBy: null });
      const survivor = await item(open);
      expect(survivor).toMatchObject({ status: 'open', occurrenceCount: 2, contradicts: [] });
      expect(survivor.possiblyCoveredBy).toEqual({
        kind: 'item',
        id: rejected,
        quote: 'Generated files',
        ownQuote: GEN_AGAIN,
        shortQuote: true,
        claim: 'suppressed',
        tooShort: 'quote',
        via: id,
      });
    });

    it('keeps a hint the open item already has', async () => {
      const { open, id } = await setUp();
      const own = { knowledgeKind: 'doc' as const, name: 'testing', section: null, quote: 'Its own', reason: 'Earlier' };
      const current = await item(open);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...current, possiblyCoveredBy: own, version: current.version + 1 }, current.version),
      );
      expect(await pipeline.process(id)).toBe(true);
      expect((await item(open)).possiblyCoveredBy).toEqual(own);
    });

    it('carries nothing when the open item is kept apart from the rejected one', async () => {
      const { open, rejected, id } = await setUp();
      const current = await item(open);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...current, keptApartFrom: [rejected], version: current.version + 1 }, current.version),
      );
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(open)).toMatchObject({ occurrenceCount: 2, possiblyCoveredBy: null });
    });
  });

  describe('a suppression re-reads the rejected item when it writes (s15b8)', () => {
    const setUp = async () => {
      const rejected = await submit();
      unwrap(await knowledge.reject(ADMIN, rejected, (await item(rejected)).version, 'Not true here'));
      const id = await submit({ sourceGlobId: otherGlobId, statement: GEN_AGAIN });
      return { rejected, id };
    };
    const answer = (rejected: string) =>
      json({ checked: classed('same fact', rejected), suppressedBy: claim(rejected), duplicateOf: null, contradicts: [] });

    it('leaves the item open when an admin kept it apart from the rejected item', async () => {
      const { rejected, id } = await setUp();
      const pending = await item(id);
      await store.transaction((tx) =>
        tx.updateKbItem({ ...pending, keptApartFrom: [rejected], version: pending.version + 1 }, pending.version),
      );
      llm.answer(toNewDoc('testing'), answer(rejected));
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({ status: 'open', processing: 'routed', suppressedBy: null, mergeNote: null });
    });

    it('writes nothing when the rejected item changes after it is re-read, before the write commits', async () => {
      const { rejected, id } = await setUp();
      const before = await item(rejected);
      // A change another transaction commits between the re-read and this one's commit (Postgres, read committed):
      // seen here as a write right after the re-read.
      let armed = false;
      const transaction = store.transaction.bind(store);
      store.transaction = <T>(work: (tx: Tx) => Promise<T>) =>
        transaction((tx) =>
          work({
            ...tx,
            getKbItem: async (itemId) => {
              const read = await tx.getKbItem(itemId);
              if (armed && itemId === rejected && read !== null) {
                armed = false;
                await tx.updateKbItem({ ...read, decisionReason: 'Edited', version: read.version + 1 }, read.version);
              }
              return read;
            },
          }),
        );
      llm.answer(toNewDoc('testing'), () => {
        armed = true;
        return Promise.resolve(answer(rejected));
      });
      expect(await pipeline.process(id)).toBe(true);
      // Rolled back: still pending, to be retried when its lease ends, and the rejected item unchanged.
      expect(await item(id)).toMatchObject({ status: 'open', processing: 'pending', suppressedBy: null, mergeNote: null });
      expect(await item(rejected)).toEqual(before);
    });

    it('leaves the item open when the rejected item is no longer rejected by the time it writes', async () => {
      const { rejected, id } = await setUp();
      llm.answer(toNewDoc('testing'), async () => {
        // Changed while the dedupe call ran (no service does this today: the check is a defence).
        const current = await item(rejected);
        await store.transaction((tx) =>
          tx.updateKbItem({ ...current, status: 'open', version: current.version + 1 }, current.version),
        );
        return answer(rejected);
      });
      expect(await pipeline.process(id)).toBe(true);
      expect(await item(id)).toMatchObject({ status: 'open', processing: 'routed', suppressedBy: null, mergeNote: null });
    });
  });

  it('closes an item covered by an approved item, adding its evidence to the approved one without changing the decision', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const before = await item(approvedId);
    const id = await submit({ sourceGlobId: otherGlobId });
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', approvedId), coveredBy: { kind: 'item', id: approvedId, quote: 'generated files live in  src/gen/' }, contradicts: [] }));
    await pipeline.processNext();

    expect(await item(id)).toMatchObject({ status: 'covered', coveredBy: { kind: 'item', id: approvedId } });
    expect(await item(approvedId)).toMatchObject({
      status: 'approved',
      outcome: before.outcome,
      decidedBy: before.decidedBy,
      occurrenceCount: 2,
      sourceGlobIds: [globId, otherGlobId],
      extraEvidence: [{ itemId: id }],
    });
  });

  it("never closes a revise-or-revert item against its original or another item raised for it (s15f8)", async () => {
    const originalId = await submit();
    unwrap(await knowledge.approve(ADMIN, originalId, (await item(originalId)).version, { as: 'learning' }));
    const original = await item(originalId);
    const signal = {
      key: `effect:${originalId}`,
      kind: 'ci_after_local' as const,
      agent: null,
      label: 'CI failing after local checks passed',
      window: { from: START, to: START },
      figures: { affected: 1, eligible: 3, rate: 0.333, count: 1 },
      globIds: [],
      examples: [],
      measuredAt: START,
    };
    /** A submitted item made into one raised for the original, quoting it as the effect check does. */
    const raisedFor = async (sourceGlobId: string) => {
      const id = await submit({ sourceGlobId });
      const current = await item(id);
      const statement = `Revise or revert ${originalId} (${original.statement}): after 3 globs the rate of CI failing after local checks passed is 33% (1/3), against 33% (1/3) before.`;
      await store.transaction((tx) => tx.updateKbItem({ ...current, statement, signal, version: current.version + 1 }, current.version));
      return id;
    };
    // An earlier one for the same original, rejected.
    const earlier = await raisedFor(globId);
    const earlierItem = await item(earlier);
    unwrap(await knowledge.reject(ADMIN, earlier, earlierItem.version, 'Not now'));
    const id = await raisedFor(otherGlobId);
    const before = await item(originalId);
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({
        checked: [...classed('same fact', originalId), ...classed('same fact', earlier)],
        coveredBy: { kind: 'item', id: originalId, quote: 'generated files live in src/gen/' },
        // Both quotes verbatim and long enough: only the exclusion keeps it open.
        suppressedBy: claim(earlier, 'the rate of CI failing after local checks passed', 'the rate of CI failing after local checks passed'),
        duplicateOf: null,
        contradicts: [],
      }),
    );
    await pipeline.processNext();

    const dedupePrompt = llm.calls[1]?.prompt ?? '';
    expect(dedupePrompt).not.toContain(`- ${originalId} `);
    expect(dedupePrompt).not.toContain(`- ${earlier}:`);
    expect(await item(id)).toMatchObject({ status: 'open', coveredBy: null, suppressedBy: null, possiblyCoveredBy: null });
    expect(await item(originalId)).toEqual(before);
  });

  it.each([
    ['too few words', 'src/gen/'],
    ['too few characters', 'files live in src'],
  ])('leaves an item open, only flagged, when its coverage quote from the approved item has %s (s15f8)', async (_, quote) => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const before = await item(approvedId);
    const id = await submit({ sourceGlobId: otherGlobId });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({ checked: classed('same fact', approvedId), coveredBy: { kind: 'item', id: approvedId, quote }, contradicts: [] }),
    );
    await pipeline.processNext();

    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      coveredBy: null,
      possiblyCoveredBy: { kind: 'item', id: approvedId, quote, shortQuote: true },
    });
    expect(await item(approvedId)).toEqual(before);
  });

  it('lets an admin reopen a closed item: back to drafting with its target, never deduplicated again', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const id = await submit({ sourceGlobId: otherGlobId });
    llm.answer(toDoc('build_test_lint', 'Test'), json({ checked: classed('same fact', approvedId), coveredBy: { kind: 'item', id: approvedId, quote: 'generated files live in  src/gen/' }, contradicts: [] }));
    await pipeline.processNext();
    const closed = await item(id);
    expect(closed.status).toBe('covered');
    const evidenceHolder = await item(approvedId);

    expect(errorCode(await knowledge.reopen(DEV, id, closed.version))).toBe('forbidden');
    expect(errorCode(await knowledge.reopen(ADMIN, id, closed.version - 1))).toBe('version_conflict');
    expect(errorCode(await knowledge.reopen(ADMIN, approvedId, evidenceHolder.version))).toBe('invalid_input');
    notifier.hints.length = 0;
    const reopened = unwrap(await knowledge.reopen(ADMIN, id, closed.version));
    expect(reopened).toMatchObject({
      status: 'open',
      coveredBy: null,
      processing: 'routed',
      target: { kind: 'doc', name: 'build_test_lint', section: 'Test' },
    });
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    // The approved item keeps the evidence the closing added.
    expect(await item(approvedId)).toEqual(evidenceHolder);
    // The pipeline drafts it (here the drafter has no answer) without routing or deduplicating it again.
    const calls = llm.calls.length;
    expect(await pipeline.processNext()).toBe(id);
    expect(llm.calls).toHaveLength(calls);
    expect(await item(id)).toMatchObject({ status: 'open', processing: 'routed', processingAttempts: 1 });
    // And an admin can decide it now.
    expect(unwrap(await knowledge.reject(ADMIN, id, (await item(id)).version, 'Covered after all')).status).toBe('rejected');
  });

  it('refuses to reopen a closed item that has no target, since only routing and dedupe could give it one', async () => {
    const id = await submit();
    const current = await item(id);
    await store.transaction((tx) =>
      tx.updateKbItem({ ...current, status: 'merged', duplicateOf: 's1k99', target: null, version: current.version + 1 }, current.version),
    );
    const refused = await knowledge.reopen(ADMIN, id, current.version + 1);
    expect(errorCode(refused)).toBe('invalid_input');
    expect(await item(id)).toMatchObject({ status: 'merged', processing: 'pending' });
  });

  it('keeps an item open and flags it when the target text may already say it, never closing it', async () => {
    const id = await submit({ statement: 'Tests run with vitest' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({ checked: classed('same fact', 'current text'), coveredBy: { kind: 'target', quote: 'run  VITEST.', reason: 'Names the runner' } }),
    );
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      coveredBy: null,
      possiblyCoveredBy: { knowledgeKind: 'doc', name: 'build_test_lint', section: 'Test', quote: 'run  VITEST', reason: 'Names the runner' },
    });
  });

  it('drops a coverage claim whose quote is not in the text it was shown', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const targetId = await submit({ statement: 'Run aws sso login when Bedrock calls fail' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({ checked: classed('same fact', 'current text'), coveredBy: { kind: 'target', quote: 'Run aws sso login', reason: 'Run locally' } }),
    );
    await pipeline.processNext();
    expect(await item(targetId)).toMatchObject({ status: 'open', coveredBy: null, possiblyCoveredBy: null });

    const itemId = await submit({ sourceGlobId: otherGlobId });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({ checked: classed('same fact', approvedId), coveredBy: { kind: 'item', id: approvedId, quote: 'Docker compose from worktrees' }, contradicts: [] }),
    );
    await pipeline.processNext();
    expect(await item(itemId)).toMatchObject({ status: 'open', coveredBy: null, possiblyCoveredBy: null });
    expect(await item(approvedId)).toMatchObject({ occurrenceCount: 1, extraEvidence: [] });
  });

  it('ignores target coverage and target contradictions when the target had no text to show (a new document)', async () => {
    const first = await routedAlone();
    const id = await submit({ sourceGlobId: otherGlobId, statement: 'Tests live next to the code' });
    llm.answer(
      toNewDoc('testing_conventions'),
      json({
        checked: classed('contradicts', 'current text', first),
        coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'x' },
        contradicts: [
          { kind: 'target', ref: '', quote: 'Run vitest.', note: 'Says otherwise' },
          { kind: 'item', ref: first, quote: 'Generated files live in src/gen/', note: 'Conflicts' },
        ],
      }),
    );
    expect(await pipeline.process(id)).toBe(true);
    expect(llm.calls[2]?.prompt).toContain('(none;');
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      coveredBy: null,
      possiblyCoveredBy: null,
      contradicts: [{ kind: 'item', ref: first, note: 'Conflicts' }],
    });
  });

  it('keeps a contradicting item open with its contradictions, ignoring references it was not shown', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const id = await submit({ statement: 'Tests run with jest' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({
        checked: [...classed('same fact', 's99k1', 's99k2'), ...classed('contradicts', 'current text', approvedId, 's99k3')],
        duplicateOf: claim('s99k1', GEN, 'Tests run with jest'),
        coveredBy: { kind: 'item', id: 's99k2' },
        contradicts: [
          { kind: 'target', ref: '## Test', quote: 'Run vitest.', note: 'The doc says vitest' },
          { kind: 'item', ref: approvedId, quote: 'Generated files live in src/gen/', note: 'Conflicts' },
          { kind: 'item', ref: 's99k3', quote: 'x', note: 'Unknown' },
          { kind: 'target', ref: '## Test', quote: 'Made up sentence', note: 'Hallucinated' },
        ],
      }),
    );
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      duplicateOf: null,
      coveredBy: null,
      contradicts: [
        { kind: 'knowledge', ref: 'build_test_lint § Test', note: 'The doc says vitest' },
        { kind: 'item', ref: approvedId, note: 'Conflicts' },
      ],
    });
  });

  it('retries unusable answers and LLM errors with backoff, then marks the item failed but still decidable', async () => {
    const id = await submit();
    llm.answer('Sure! Here is my answer.');
    notifier.hints.length = 0;
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      processing: 'pending',
      processingAttempts: 1,
      processingError: 'The routing answer was not usable JSON',
      processAfter: '2026-10-05T12:00:30.000Z',
    });
    // The page shows the error while it retries.
    expect(notifier.hints).toEqual([{ kind: 'board.kb', boardId }]);
    // Not due yet.
    expect(await pipeline.processNext()).toBeNull();

    advance(30_000);
    llm.answer(new Error('Bedrock is down'));
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({ processing: 'pending', processingAttempts: 2, processingError: 'Bedrock is down' });

    advance(60_000);
    // An agent file that doesn't exist is as unusable as bad JSON.
    llm.answer(json({ target: { kind: 'agent_file', name: 'agents/nobody.md', section: null } }));
    await pipeline.processNext();
    const failed = await item(id);
    expect(failed).toMatchObject({
      status: 'open',
      processing: 'failed',
      processingAttempts: 3,
      processingError: 'The routing answer was not usable JSON',
      processAfter: null,
    });
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    advance(3_600_000);
    expect(await pipeline.processNext()).toBeNull();
    expect(unwrap(await knowledge.approve(ADMIN, id, failed.version, { as: 'learning' })).status).toBe('approved');
  });

  it('abandons an LLM call that outlives its deadline and retries it with backoff like any other failure', async () => {
    const hanging = new HangingLlm();
    const timed = new KbPipeline({
      store,
      clock: { now: () => now },
      catalog,
      notifier,
      route: hanging,
      draft: hanging,
      llmTimeoutMs: 20,
    });
    const id = await submit();
    expect(await timed.processNext()).toBe(id);
    expect(hanging.signals).toHaveLength(1);
    expect(hanging.signals[0]?.aborted).toBe(true);
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'pending',
      processingAttempts: 1,
      processingError: 'The model did not answer within 0.02 s',
      processAfter: '2026-10-05T12:00:30.000Z',
    });
    // The worker is free again: the next due item is processed.
    advance(30_000);
    llm.answer(toDoc('build_test_lint', 'Test'), NO_MATCH);
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({ processing: 'routed', processingError: null, processingAttempts: 0 });
  });

  it('waits while the LLM is unavailable: no attempt counted, never failed, due again a minute later', async () => {
    const id = await submit();
    // One ordinary failure first: its attempt stays counted.
    llm.answer(new Error('Bedrock is down'));
    await pipeline.processNext();
    advance(30_000);
    const expired = new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`');
    notifier.hints.length = 0;
    for (let probe = 0; probe < MAX_PROBES; probe++) {
      llm.answer(expired);
      expect(await pipeline.processNext()).toBe(id);
      const waiting = await item(id);
      expect(waiting).toMatchObject({
        status: 'open',
        processing: 'pending',
        processingAttempts: 1,
        processingError: 'AI unavailable: AWS sign-in expired',
        processAfter: new Date(Date.parse(now) + 60_000).toISOString(),
      });
      expect(llmWaitingReason(waiting)).toBe('AWS sign-in expired');
      expect(await pipeline.processNext()).toBeNull();
      advance(60_000);
    }
    // The card heard of it once, not on every probe.
    expect(notifier.hints).toEqual([{ kind: 'board.kb', boardId }]);

    // Also from the dedupe call.
    llm.answer(toDoc('build_test_lint', 'Test'), expired);
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({ processing: 'pending', processingAttempts: 1, target: null });

    advance(60_000);
    llm.answer(toDoc('build_test_lint', 'Test'), NO_MATCH);
    await pipeline.processNext();
    const routed = await item(id);
    expect(routed).toMatchObject({ processing: 'routed', processingError: null, processingAttempts: 0 });
    expect(llmWaitingReason(routed)).toBeNull();
  });

  it('backs off on a busy Bedrock without spending an attempt: three busy answers never fail an item', async () => {
    const id = await submit();
    llm.answer(new Error('Bedrock is down'));
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({ processingAttempts: 1 });
    advance(30_000);
    const delays: number[] = [];
    for (let round = 0; round < 6; round++) {
      llm.answer(new LlmBusy());
      expect(await pipeline.processNext()).toBe(id);
      const waiting = await item(id);
      expect(waiting).toMatchObject({ status: 'open', processing: 'pending', processingAttempts: 1 });
      expect(waiting.processingError).toMatch(/^Waiting: Bedrock busy \(retrying at \d\d:\d\d UTC\)$/);
      const delay = Date.parse(waiting.processAfter ?? '') - Date.parse(now);
      delays.push(delay);
      expect(await pipeline.processNext()).toBeNull();
      advance(delay);
    }
    // 1, 2, 4, 8, 15, 15 minutes, each with up to 25% jitter.
    [1, 2, 4, 8, 15, 15].forEach((minutes, i) => {
      expect(delays[i]).toBeGreaterThanOrEqual(minutes * 60_000);
      expect(delays[i]).toBeLessThanOrEqual(minutes * 60_000 * 1.25);
    });
    // A real failure still counts.
    llm.answer(new Error('Bedrock is down'));
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({ processing: 'pending', processingAttempts: 2, processingError: 'Bedrock is down' });
  });

  it('requeues only the items that failed because Bedrock was busy, at their stage with fresh attempts', async () => {
    const busyRouting = await submit({ statement: 'Busy while routing' });
    const busyDrafting = await submit({ statement: 'Busy while drafting' });
    const real = await submit({ statement: 'Real failure' });
    const fail = async (id: string, error: string, target: KbItem['target']) => {
      await store.transaction(async (tx) => {
        const current = await tx.getKbItem(id);
        if (current === null) throw new Error('missing');
        await tx.updateKbItem(
          { ...current, processing: 'failed', processingAttempts: 3, processingError: error, processAfter: null, target, version: current.version + 1 },
          current.version,
        );
      });
    };
    const target = { kind: 'doc', name: 'build_test_lint', section: null, newDocument: null } as const;
    await fail(busyRouting, 'Bedrock is unable to process your request.', null);
    await fail(busyDrafting, 'Too many requests, please wait before trying again.', target);
    await fail(real, 'The routing answer was not usable JSON', null);

    expect(await pipeline.requeueBusyFailed()).toBe(2);
    expect(await item(busyRouting)).toMatchObject({ processing: 'pending', processingAttempts: 0, processingError: null });
    expect(await item(busyDrafting)).toMatchObject({ processing: 'routed', processingAttempts: 0, processingError: null });
    expect(await item(real)).toMatchObject({ processing: 'failed', processingAttempts: 3 });
    expect(await pipeline.requeueBusyFailed()).toBe(0);
  });

  it('accepts the dedupe answer with its restated fact and checked relations, merging only a "same fact" candidate', async () => {
    const first = await routedAlone();
    const second = await submit({ sourceGlobId: otherGlobId, statement: 'Code in src/gen/ is generated' });
    llm.answer(
      toNewDoc('testing'),
      json({
        fact: 'src/gen/ holds generated code',
        checked: [{ ref: first, relation: 'same fact' }],
        suppressedBy: null,
        duplicateOf: claim(first),
        coveredBy: null,
        contradicts: [],
      }),
    );
    expect(await pipeline.process(second)).toBe(true);
    expect(await item(second)).toMatchObject({ status: 'merged', duplicateOf: first });
  });

  it('closes and flags nothing for a "related topic only" answer, whatever else the answer claims', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const openId = await routedAlone({ sourceGlobId: otherGlobId, statement: 'Never edit src/gen/ by hand' });
    const id = await submit({ statement: 'Run vitest with --reporter=dot in agent runs' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({
        fact: 'Agent runs pass --reporter=dot to vitest',
        checked: [
          { ref: 'current text', relation: 'related topic only' },
          { ref: approvedId, relation: 'related topic only' },
          { ref: openId, relation: 'unrelated' },
        ],
        suppressedBy: null,
        duplicateOf: claim(openId, 'Never edit src/gen/ by hand', 'Run vitest with --reporter=dot in agent runs'),
        coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'Mentions vitest' },
        contradicts: [
          { kind: 'target', ref: 'Test', quote: 'Run vitest.', note: 'x' },
          { kind: 'item', ref: approvedId, quote: 'Generated files live in src/gen/', note: 'y' },
        ],
      }),
    );
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      duplicateOf: null,
      coveredBy: null,
      possiblyCoveredBy: null,
      contradicts: [],
    });
    expect(await item(openId)).toMatchObject({ occurrenceCount: 1 });

    // The same claims backed by "same fact" (and an item it didn't list) stand on their quotes.
    const covered = await submit({ sourceGlobId: otherGlobId, statement: 'Tests run with vitest' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({
        fact: 'The tests run with vitest',
        checked: [{ ref: 'Current text', relation: 'same fact' }],
        coveredBy: { kind: 'target', quote: 'Run vitest.', reason: 'Says so' },
        contradicts: [],
      }),
    );
    expect(await pipeline.process(covered)).toBe(true);
    expect(await item(covered)).toMatchObject({ status: 'open', possiblyCoveredBy: { quote: 'Run vitest' } });
  });

  it('closes and flags nothing for a candidate the answer did not class, and reads relations loosely spelled', async () => {
    const first = await routedAlone();
    const unlisted = await submit({ sourceGlobId: otherGlobId, statement: 'Code in src/gen/ is generated' });
    llm.answer(
      toNewDoc('testing'),
      json({ fact: 'src/gen/ is generated', checked: classed('related topic only', 's1k77'), duplicateOf: claim(first), contradicts: [] }),
    );
    expect(await pipeline.process(unlisted)).toBe(true);
    expect(await item(unlisted)).toMatchObject({ status: 'open', duplicateOf: null, possiblyCoveredBy: null });
    expect(await item(first)).toMatchObject({ occurrenceCount: 1 });
    // Nor does a short quote on it flag the item.
    const shortQuote = await submit({ sourceGlobId: otherGlobId, statement: GEN_AGAIN });
    llm.answer(
      toNewDoc('testing'),
      json({ checked: classed('related topic only', 's1k77'), duplicateOf: claim(first, 'Generated files', GEN_AGAIN), contradicts: [] }),
    );
    expect(await pipeline.process(shortQuote)).toBe(true);
    expect(await item(shortQuote)).toMatchObject({ status: 'open', duplicateOf: null, possiblyCoveredBy: null });

    const spelled = await submit({ sourceGlobId: otherGlobId, statement: 'src/gen/ holds generated code' });
    llm.answer(
      toNewDoc('testing'),
      json({ checked: [{ ref: ` ${first} `, relation: 'Same_Fact' }], duplicateOf: claim(first, GEN, 'src/gen/ holds generated code') }),
    );
    expect(await pipeline.process(spelled)).toBe(true);
    expect(await item(spelled)).toMatchObject({ status: 'merged', duplicateOf: first });
    const hyphenated = await submit({ sourceGlobId: otherGlobId, statement: 'Generated sources sit under src/gen/' });
    llm.answer(
      toNewDoc('testing'),
      json({ checked: [{ ref: first, relation: 'same-fact' }], duplicateOf: claim(first, GEN, 'Generated sources sit under src/gen/') }),
    );
    expect(await pipeline.process(hyphenated)).toBe(true);
    expect(await item(hyphenated)).toMatchObject({ status: 'merged' });
  });

  it('waits rather than counting an attempt when the deadline fires on a call that found the LLM unavailable', async () => {
    const unavailableOnAbort: Llm = {
      complete: (request: LlmRequest) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`')));
        }),
    };
    const timed = new KbPipeline({
      store,
      clock: { now: () => now },
      catalog,
      notifier,
      route: unavailableOnAbort,
      draft: unavailableOnAbort,
      llmTimeoutMs: 20,
    });
    const id = await submit();
    expect(await timed.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({ processing: 'pending', processingAttempts: 0, processingError: 'AI unavailable: AWS sign-in expired' });
  });

  it('fails an item when the dedupe answer is unusable', async () => {
    const id = await submit();
    llm.answer(toDoc('build_test_lint', 'Test'), 'not json');
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({ processing: 'pending', processingError: 'The dedupe answer was not usable JSON' });
  });

  it('skips routing and drafting for document proposals: the target is that document, the proposal its draft', async () => {
    const proposal = {
      area: 'architecture',
      audience: ['implementer'],
      description: 'How the code is laid out',
      content: '# Architecture\n',
    };
    const fresh = await submit({ sourceGlobId: null, document: { ...proposal, name: 'architecture' } });
    const replacing = await submit({ sourceGlobId: null, document: { ...proposal, name: 'build_test_lint' } });
    expect(await item(fresh)).toMatchObject({
      processing: 'drafted',
      draft: null,
      target: {
        kind: 'doc',
        name: 'architecture',
        section: null,
        newDocument: { area: 'architecture', audience: ['implementer'], description: 'How the code is laid out' },
      },
    });
    expect(await item(replacing)).toMatchObject({ processing: 'drafted', target: { name: 'build_test_lint', newDocument: null } });
    expect(await pipeline.processNext()).toBeNull();

    // A document proposal from before routing (pending after the migration) is routed without the LLM...
    const legacy = await item(fresh);
    await store.transaction((tx) => tx.updateKbItem({ ...legacy, processing: 'pending', target: null }, legacy.version));
    expect(await pipeline.processNext()).toBe(fresh);
    expect(await item(fresh)).toMatchObject({ processing: 'drafted', target: { name: 'architecture' } });
    // ...and one routed before drafting existed is marked drafted, also without it.
    const routed = await item(replacing);
    await store.transaction((tx) => tx.updateKbItem({ ...routed, processing: 'routed' }, routed.version));
    expect(await pipeline.processNext()).toBe(replacing);
    expect(await item(replacing)).toMatchObject({ processing: 'drafted', draft: null });
    expect(llm.calls).toHaveLength(0);
  });

  it('claims an item exclusively while it is processed, and retries a crashed claim after the lease', async () => {
    const id = await submit();
    let release: (answer: string) => void = () => undefined;
    let called: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      called = resolve;
    });
    const slow: Llm = {
      complete: () =>
        new Promise<string>((resolve) => {
          release = resolve;
          called();
        }),
    };
    const clock = { now: () => now };
    const first = new KbPipeline({ store, clock, catalog, notifier, route: slow, draft: slow });
    const second = new KbPipeline({ store, clock, catalog, notifier, route: llm, draft: llm });
    const running = first.processNext();
    await reached;
    expect(await second.processNext()).toBeNull();
    expect(await second.process(id)).toBe(false);
    release(toNewDoc('testing'));
    expect(await running).toBe(id);
    expect(await item(id)).toMatchObject({ processing: 'routed' });

    // A worker that crashed mid-item leaves its lease; the item is retried once it ends.
    const crashed = await submit();
    const held = await item(crashed);
    await store.transaction((tx) =>
      tx.updateKbItem({ ...held, processAfter: '2026-10-05T12:05:00.000Z', version: held.version + 1 }, held.version),
    );
    expect(await second.process(crashed)).toBe(false);
    advance(5 * 60_000);
    llm.answer(toNewDoc('testing'), NO_MATCH);
    expect(await second.process(crashed)).toBe(true);
  });

  it('drops its result when the item is decided while it is processed', async () => {
    const id = await submit();
    const deciding: Llm = {
      complete: async () => {
        unwrap(await knowledge.reject(ADMIN, id, (await item(id)).version, 'No'));
        return toNewDoc('testing');
      },
    };
    const racing = new KbPipeline({ store, clock: { now: () => now }, catalog, notifier, route: deciding, draft: deciding });
    await racing.processNext();
    expect(await item(id)).toMatchObject({ status: 'rejected', processing: 'pending', target: null });
  });

  it('refuses to decide items the pipeline closed', async () => {
    const first = await routedAlone();
    const second = await submit();
    llm.answer(toNewDoc('testing'), json({ checked: classed('same fact', first), duplicateOf: claim(first, GEN, GEN) }));
    await pipeline.process(second);
    const merged = await item(second);
    expect(merged.status).toBe('merged');
    expect(errorCode(await knowledge.approve(ADMIN, second, merged.version, { as: 'learning' }))).toBe('invalid_input');
    expect(errorCode(await knowledge.reject(ADMIN, second, merged.version, 'No'))).toBe('invalid_input');
  });
});
