import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { DEDUPE_SYSTEM, KbPipeline, ROUTE_SYSTEM } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import type { KbItem } from '../src/domain/kb.js';
import type { Catalog } from '../src/ports.js';
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

/** A fake LLM answering from a queue of canned answers (or errors), recording each request. */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(private readonly answers: (string | Error)[] = []) {}
  answer(...answers: (string | Error)[]): void {
    this.answers.push(...answers);
  }
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt });
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const json = (value: unknown) => JSON.stringify(value);
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
const NO_MATCH = json({ suppressedBy: null, duplicateOf: null, coveredBy: null, contradicts: [] });

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
    expect(notifier.hints).toContainEqual({ kind: 'board.changed', boardId });
    expect(await pipeline.processNext()).toBeNull();
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
    llm.answer(toNewDoc('testing'), json({ duplicateOf: first, suppressedBy: null, coveredBy: null, contradicts: [] }));
    await pipeline.processNext();

    expect(llm.calls[2]?.prompt).toContain(`- ${first} (gotcha): Generated files live in src/gen/`);
    expect(await item(second)).toMatchObject({ status: 'merged', duplicateOf: first, processing: 'routed' });
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

  it('suppresses an item matching a rejected one', async () => {
    const rejected = await submit();
    const decided = await item(rejected);
    unwrap(await knowledge.reject(ADMIN, rejected, decided.version, 'Not true here'));
    const id = await submit({ statement: 'src/gen/ holds generated code' });
    llm.answer(toNewDoc('testing'), json({ suppressedBy: rejected, duplicateOf: null, coveredBy: null, contradicts: [] }));
    expect(await pipeline.processNext()).toBe(id);

    expect(llm.calls[1]?.prompt).toContain(`- ${rejected}: Generated files live in src/gen/ (rejected: Not true here)`);
    expect(await item(id)).toMatchObject({ status: 'suppressed', suppressedBy: rejected });
  });

  it('closes an item covered by an approved item, adding its evidence to the approved one without changing the decision', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const before = await item(approvedId);
    const id = await submit({ sourceGlobId: otherGlobId });
    llm.answer(toNewDoc('testing'), json({ coveredBy: { kind: 'item', id: approvedId }, contradicts: [] }));
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

  it('closes an item the target already says as covered by that knowledge', async () => {
    const id = await submit({ statement: 'Tests run with vitest' });
    llm.answer(toDoc('build_test_lint', 'Test'), json({ coveredBy: { kind: 'target' } }));
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      status: 'covered',
      coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build_test_lint', section: 'Test' },
    });
  });

  it('keeps a contradicting item open with its contradictions, ignoring references it was not shown', async () => {
    const approvedId = await submit();
    unwrap(await knowledge.approve(ADMIN, approvedId, (await item(approvedId)).version, { as: 'learning' }));
    const id = await submit({ statement: 'Tests run with jest' });
    llm.answer(
      toDoc('build_test_lint', 'Test'),
      json({
        duplicateOf: 's99k1',
        coveredBy: { kind: 'item', id: 's99k2' },
        contradicts: [
          { kind: 'target', ref: '## Test', note: 'The doc says vitest' },
          { kind: 'item', ref: approvedId, note: 'Conflicts' },
          { kind: 'item', ref: 's99k3', note: 'Unknown' },
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
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      processing: 'pending',
      processingAttempts: 1,
      processingError: 'The routing answer was not usable JSON',
      processAfter: '2026-10-05T12:00:30.000Z',
    });
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
    expect(notifier.hints).toContainEqual({ kind: 'board.changed', boardId });
    advance(3_600_000);
    expect(await pipeline.processNext()).toBeNull();
    expect(unwrap(await knowledge.approve(ADMIN, id, failed.version, { as: 'learning' })).status).toBe('approved');
  });

  it('fails an item when the dedupe answer is unusable', async () => {
    const id = await submit();
    llm.answer(toDoc('build_test_lint', 'Test'), 'not json');
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({ processing: 'pending', processingError: 'The dedupe answer was not usable JSON' });
  });

  it('skips routing for document proposals: the target is that document', async () => {
    const proposal = {
      area: 'architecture',
      audience: ['implementer'],
      description: 'How the code is laid out',
      content: '# Architecture\n',
    };
    const fresh = await submit({ sourceGlobId: null, document: { ...proposal, name: 'architecture' } });
    const replacing = await submit({ sourceGlobId: null, document: { ...proposal, name: 'build_test_lint' } });
    expect(await item(fresh)).toMatchObject({
      processing: 'routed',
      target: {
        kind: 'doc',
        name: 'architecture',
        section: null,
        newDocument: { area: 'architecture', audience: ['implementer'], description: 'How the code is laid out' },
      },
    });
    expect(await item(replacing)).toMatchObject({ processing: 'routed', target: { name: 'build_test_lint', newDocument: null } });
    expect(await pipeline.processNext()).toBeNull();

    // A document proposal from before routing (pending after the migration) is routed without the LLM.
    const legacy = await item(fresh);
    await store.transaction((tx) => tx.updateKbItem({ ...legacy, processing: 'pending', target: null }, legacy.version));
    expect(await pipeline.processNext()).toBe(fresh);
    expect(await item(fresh)).toMatchObject({ processing: 'routed', target: { name: 'architecture' } });
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
    expect(await second.processNext()).toBeNull();
    advance(5 * 60_000);
    llm.answer(toNewDoc('testing'), NO_MATCH);
    expect(await second.processNext()).toBe(crashed);
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
    llm.answer(toNewDoc('testing'), json({ duplicateOf: first }));
    await pipeline.processNext();
    const merged = await item(second);
    expect(merged.status).toBe('merged');
    expect(errorCode(await knowledge.approve(ADMIN, second, merged.version, { as: 'learning' }))).toBe('invalid_input');
    expect(errorCode(await knowledge.reject(ADMIN, second, merged.version, 'No'))).toBe('invalid_input');
  });
});
