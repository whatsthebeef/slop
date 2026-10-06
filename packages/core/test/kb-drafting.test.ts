import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import {
  DRAFT_SYSTEM,
  KbPipeline,
  MAX_PROCESSING_ATTEMPTS,
  ROUTE_SYSTEM,
} from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning, TargetChange } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import type { KbItem } from '../src/domain/kb.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: Result<T>) => (result.ok ? null : result.error);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';

const IMPLEMENTER =
  '---\nname: implementer\ndescription: Implements plans\n---\n\n# Implementer\n\n## Rules\n\n- Follow the plan.\n';
const BUILD_DOC =
  '---\narea: build\naudience: [implementer, tester]\ndescription: Build and test commands\n---\n# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n';

const catalogFiles = [
  { path: 'agents/implementer.md', content: IMPLEMENTER },
  { path: 'settings.json', content: '{}\n' },
];
const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'h1', files: catalogFiles }),
};

/** A fake LLM answering from a queue of canned answers (or errors, or functions), recording each request. */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string; maxTokens: number }[] = [];
  constructor(private readonly answers: (string | Error | (() => Promise<string>))[] = []) {}
  answer(...answers: (string | Error | (() => Promise<string>))[]): void {
    this.answers.push(...answers);
  }
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string> {
    this.calls.push(request);
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    if (typeof next === 'function') return next();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const json = (value: unknown) => JSON.stringify(value);
const draftAnswer = (section: string | null, content: string, rationale = 'Adds the rule') =>
  json({ section, content, rationale });

describe('KB pipeline: drafting and approving drafts', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let knowledge: KnowledgeService;
  let pipeline: KbPipeline;
  let router: FakeLlm;
  let drafter: FakeLlm;
  let now: string;
  let boardId: number;
  let globId: string;

  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };

  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  const submit = async (patch: Partial<NewLearning> = {}) =>
    unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: globId,
        type: 'gotcha',
        statement: 'Use the dot reporter for vitest',
        evidence: 'Long logs filled the context in s1t2',
        ...patch,
      }),
    ).id;

  /** Submits an item with its target set by an admin, so it skips routing and waits for its draft. */
  const targeted = async (target: TargetChange, patch: Partial<NewLearning> = {}) => {
    const id = await submit(patch);
    unwrap(await knowledge.changeTarget(ADMIN, id, (await item(id)).version, target));
    return id;
  };

  const drafted = async (
    target: TargetChange,
    answer: string,
    patch: Partial<NewLearning> = {},
  ) => {
    const id = await targeted(target, patch);
    drafter.answer(answer);
    expect(await pipeline.process(id)).toBe(true);
    expect((await item(id)).processing).toBe('drafted');
    return id;
  };

  const doc = async (name: string) =>
    (await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', name)))?.content;
  const board = async () => {
    const found = await store.transaction((tx) => tx.getBoard(boardId));
    if (found === null) throw new Error('No board');
    return found;
  };
  const preview = async (id: string) => {
    const listed = unwrap(await knowledge.proposals(DEV, boardId));
    return [...listed.open, ...listed.decided.items, ...listed.closed.items].find((i) => i.id === id)?.preview;
  };
  const approveDraft = async (
    id: string,
    patch: Partial<{ content: string; section: string | null }> = {},
  ) => knowledge.approve(ADMIN, id, (await item(id)).version, { as: 'draft', ...patch });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    const clock = { now: () => now };
    router = new FakeLlm();
    drafter = new FakeLlm();
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    pipeline = new KbPipeline({ store, clock, catalog, notifier, route: router, draft: drafter });
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
      await boards.create(ADMIN, {
        name: 'b',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    globId = unwrap(
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
    unwrap(
      await knowledge.importDocuments(
        ADMIN,
        boardId,
        [{ fileName: 'build_test_lint.md', content: BUILD_DOC }],
        'upload',
      ),
    );
    notifier.hints.length = 0;
  });

  it("appends a draft that names the document's title as its section instead of replacing the whole document", async () => {
    const id = await drafted({ kind: 'doc', name: 'build_test_lint', section: null }, draftAnswer('Build', '## Reporters\n\nUse dot.'));
    expect((await item(id)).draft).toEqual({ section: null, content: '## Reporters\n\nUse dot.' });
    unwrap(await approveDraft(id));
    expect(await doc('build_test_lint')).toBe('# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n\n## Reporters\n\nUse dot.\n');
  });

  it('routes, then drafts the routed section in the next step, showing Sonnet the evidence and the whole target', async () => {
    const id = await submit();
    router.answer(
      json({
        target: { kind: 'document', name: 'build_test_lint', section: 'Test' },
        catalogCandidate: false,
      }),
      json({ contradicts: [] }),
    );
    expect(await pipeline.processNext()).toBe(id);
    expect((await item(id)).processing).toBe('routed');

    drafter.answer(
      draftAnswer(
        'Test',
        '## Test\n\nRun vitest with `--reporter=dot`.',
        'Quiet output keeps logs short',
      ),
    );
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({
      processing: 'drafted',
      draft: { section: 'Test', content: '## Test\n\nRun vitest with `--reporter=dot`.' },
      rationale: 'Quiet output keeps logs short',
      draftedAgainstVersion: 1,
      target: { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null },
      processAfter: null,
      processingAttempts: 0,
    });
    expect(router.calls.map((c) => c.system)).toContain(ROUTE_SYSTEM);
    const [call] = drafter.calls;
    expect(call?.system).toBe(DRAFT_SYSTEM);
    expect(call?.maxTokens).toBeGreaterThanOrEqual(8_000);
    expect(call?.prompt).toContain('Learning (gotcha): Use the dot reporter for vitest');
    expect(call?.prompt).toContain('Evidence: Long logs filled the context in s1t2');
    expect(call?.prompt).toContain(`Source globs: ${globId}`);
    expect(call?.prompt).toContain('Target: document build_test_lint, section "Test"');
    // The whole body, without frontmatter.
    expect(call?.prompt).toContain('# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.');
    expect(call?.prompt).not.toContain('area: build');
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    expect(await pipeline.processNext()).toBeNull();

    expect(await preview(id)).toEqual({
      version: 1,
      stale: false,
      diff: [
        { op: 'same', text: '# Build' },
        { op: 'same', text: '' },
        { op: 'same', text: '## Test' },
        { op: 'same', text: '' },
        { op: 'removed', text: 'Run vitest.' },
        { op: 'added', text: 'Run vitest with `--reporter=dot`.' },
        { op: 'same', text: '' },
        { op: 'same', text: '## Lint' },
        { op: 'same', text: '' },
        // One unchanged line isn't worth a marker.
        { op: 'same', text: 'Run eslint.' },
      ],
    });
  });

  it('approves a draft in one click: the section is spliced in and the document keeps its frontmatter', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Test' },
      draftAnswer('Test', '## Test\n\nRun vitest with `--reporter=dot`.'),
    );
    const approved = unwrap(await approveDraft(id));
    expect(approved).toMatchObject({
      status: 'approved',
      outcome: { kind: 'applied', target: 'doc', name: 'build_test_lint', version: 2 },
    });
    expect(await doc('build_test_lint')).toBe(
      '# Build\n\n## Test\n\nRun vitest with `--reporter=dot`.\n\n## Lint\n\nRun eslint.\n',
    );
    const saved = await store.transaction((tx) =>
      tx.getKnowledge(boardId, 'doc', 'build_test_lint'),
    );
    expect(saved).toMatchObject({
      area: 'build',
      audience: ['implementer', 'tester'],
      description: 'Build and test commands',
      source: `kb:${id}`,
    });
    expect(await preview(id)).toBeNull();
  });

  it('appends a new section when the drafter adds one, naming it as the target section', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: null },
      draftAnswer(null, '## Reporters\n\nUse the dot reporter.'),
    );
    expect(await item(id)).toMatchObject({
      draft: { section: null },
      target: { section: 'Reporters' },
    });
    unwrap(await approveDraft(id));
    expect(await doc('build_test_lint')).toBe(
      '# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n\n## Reporters\n\nUse the dot reporter.\n',
    );
  });

  it('lets the drafter pick a better section of the same target than routing chose', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Lint' },
      draftAnswer('## Test', 'Run vitest --reporter=dot.'),
    );
    // The heading is added when the content comes without it.
    expect(await item(id)).toMatchObject({
      target: { name: 'build_test_lint', section: 'Test' },
      draft: { section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.' },
    });
  });

  it("drafts an agent file's board rules with the catalog as read-only context; approving writes only the overlay", async () => {
    const before = (await board()).agentSetVersion;
    const id = await drafted(
      { kind: 'agent', name: 'agents/implementer.md', section: 'Testing' },
      draftAnswer('Testing', '- Write the regression test before the fix.'),
      { type: 'agent-behaviour', statement: 'Write the regression test before the fix' },
    );
    expect(await item(id)).toMatchObject({
      draftedAgainstVersion: 0,
      draft: {
        section: 'Testing',
        content: '### Testing\n\n- Write the regression test before the fix.',
      },
    });
    const [call] = drafter.calls;
    expect(call?.prompt).toContain(
      'Target: the board rules of agent file agents/implementer.md, section "Testing"',
    );
    expect(call?.prompt).toContain(
      `Catalog text of agents/implementer.md (context only; never changed):\n<<<\n${IMPLEMENTER}`,
    );
    expect(call?.prompt).toContain(
      'Current board rules of agents/implementer.md (the text you change):\n<<<\n(empty)\n>>>',
    );

    unwrap(await approveDraft(id));
    const row = await store.transaction((tx) =>
      tx.getKnowledge(boardId, 'agent', 'agents/implementer.md'),
    );
    expect(row).toMatchObject({
      layer: 'overlay',
      content: '### Testing\n\n- Write the regression test before the fix.\n',
      version: 1,
    });
    expect((await board()).agentSetVersion).toBe(before + 1);
    expect(catalogFiles[0]?.content).toBe(IMPLEMENTER);
    const served = unwrap(await knowledge.agentSet(DEV, boardId)).files.find(
      (f) => f.path === 'agents/implementer.md',
    );
    expect(served?.content).toBe(
      `${IMPLEMENTER}\n## Board rules\n\n### Testing\n\n- Write the regression test before the fix.\n`,
    );
  });

  it('drafts a whole new document after showing the existing ones, and approving creates it with the proposed frontmatter', async () => {
    const id = await drafted(
      {
        kind: 'doc',
        name: 'testing',
        section: 'ignored',
        newDocument: { area: 'testing', audience: ['tester'], description: 'How tests run' },
      },
      draftAnswer(
        'Anything',
        '---\narea: x\n---\n# Testing\n\n## Reporters\n\nUse dot.\n',
        'A home for test practice',
      ),
    );
    expect(await item(id)).toMatchObject({
      draftedAgainstVersion: 0,
      draft: { section: null, content: '# Testing\n\n## Reporters\n\nUse dot.' },
      target: { name: 'testing', section: null, newDocument: { area: 'testing' } },
    });
    const prompt = drafter.calls[0]?.prompt ?? '';
    expect(prompt).toContain(
      'Target: a new document "testing" [area: testing; for: tester] How tests run',
    );
    expect(prompt).toContain(
      "Existing documents (don't overlap them):\n- build_test_lint [area: build] Build and test commands",
    );
    expect((await preview(id))?.diff).toContainEqual({ op: 'added', text: '# Testing' });

    expect(unwrap(await approveDraft(id)).outcome).toEqual({
      kind: 'applied',
      target: 'doc',
      name: 'testing',
      version: 1,
    });
    const saved = await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'testing'));
    expect(saved).toMatchObject({
      area: 'testing',
      audience: ['tester'],
      description: 'How tests run',
      content: '# Testing\n\n## Reporters\n\nUse dot.\n',
    });
  });

  it('retries unusable drafts and errors with backoff, then marks drafting failed with the target kept, still decidable', async () => {
    const id = await targeted({ kind: 'doc', name: 'build_test_lint', section: 'Test' });
    drafter.answer('{"section": "Test"}');
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      processing: 'routed',
      processingAttempts: 1,
      processingError: 'The draft answer was not usable JSON',
      processAfter: '2026-10-05T12:00:30.000Z',
    });
    expect(await pipeline.processNext()).toBeNull();
    for (let attempt = 2; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      advance(120_000);
      drafter.answer(new Error('Sonnet is down'));
      expect(await pipeline.processNext()).toBe(id);
    }
    const failed = await item(id);
    expect(failed).toMatchObject({
      status: 'open',
      processing: 'failed',
      processingError: 'Sonnet is down',
      target: { name: 'build_test_lint' },
      draft: null,
    });
    expect(router.calls).toHaveLength(0);
    advance(3_600_000);
    expect(await pipeline.processNext()).toBeNull();
    expect(errorOf(await approveDraft(id))?.code).toBe('invalid_input');
    // Edit then approve still works without a draft.
    unwrap(
      await approveDraft(id, { section: 'Test', content: '## Test\n\nRun vitest --reporter=dot.' }),
    );
    expect(await doc('build_test_lint')).toContain('Run vitest --reporter=dot.');
  });

  it('retries a failed item as an admin: back to routing without a target, to drafting with one', async () => {
    // Drafting failed: the target stands and drafting starts again with fresh attempts.
    const id = await targeted({ kind: 'doc', name: 'build_test_lint', section: 'Test' });
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      drafter.answer(new Error('Sonnet is down'));
      expect(await pipeline.processNext()).toBe(id);
      advance(120_000);
    }
    const failed = await item(id);
    expect(failed.processing).toBe('failed');
    expect(errorOf(await knowledge.retryProcessing(DEV, id, failed.version))?.code).toBe('forbidden');
    expect(errorOf(await knowledge.retryProcessing(ADMIN, id, failed.version - 1))?.code).toBe('version_conflict');
    notifier.hints.length = 0;
    const retried = unwrap(await knowledge.retryProcessing(ADMIN, id, failed.version));
    expect(retried).toMatchObject({
      processing: 'routed',
      processingError: null,
      processingAttempts: 0,
      processAfter: null,
      target: { name: 'build_test_lint', section: 'Test' },
      version: failed.version + 1,
    });
    expect(await item(id)).toEqual(retried);
    expect(notifier.hints).toEqual([{ kind: 'board.kb', boardId }]);
    // Only failed items can be retried.
    expect(errorOf(await knowledge.retryProcessing(ADMIN, id, retried.version))?.code).toBe('invalid_input');
    drafter.answer(draftAnswer('Test', '## Test\n\nRun vitest --reporter=dot.'));
    expect(await pipeline.processNext()).toBe(id);
    expect((await item(id)).processing).toBe('drafted');

    // Routing failed: no target, so it goes back to routing.
    const other = await submit({ statement: 'Another rule' });
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      router.answer(new Error('Haiku is down'));
      expect(await pipeline.processNext()).toBe(other);
      advance(120_000);
    }
    const unrouted = await item(other);
    expect(unrouted).toMatchObject({ processing: 'failed', target: null });
    expect(unwrap(await knowledge.retryProcessing(ADMIN, other, unrouted.version))).toMatchObject({
      processing: 'pending',
      processingError: null,
      processingAttempts: 0,
      processAfter: null,
    });
    expect(await pipeline.processNext()).toBe(other);
    expect(router.calls.length).toBe(MAX_PROCESSING_ATTEMPTS + 1);
  });

  it('applies an edited draft (edit then approve), with its own section', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Test' },
      draftAnswer('Test', '## Test\n\nX'),
    );
    unwrap(
      await approveDraft(id, { section: '## Lint', content: '## Lint\n\nRun eslint --quiet.' }),
    );
    expect(await doc('build_test_lint')).toBe(
      '# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint --quiet.\n',
    );
  });

  it('refuses a stale draft on approve and sends it back to be drafted again', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Test' },
      draftAnswer('Test', '## Test\n\nNew'),
    );
    // A write that bypasses the service (so nothing re-queued the draft).
    await store.transaction(async (tx) => {
      const current = await tx.getKnowledge(boardId, 'doc', 'build_test_lint');
      if (current === null) throw new Error('No doc');
      await tx.saveKnowledge({
        ...current,
        content: `${current.content}\n## Format\n\nPrettier.\n`,
        version: current.version + 1,
      });
    });
    expect((await preview(id))?.stale).toBe(true);
    const refused = errorOf(await approveDraft(id));
    expect(refused?.code).toBe('version_conflict');
    expect(refused?.message).toContain('drafted again');
    expect(await item(id)).toMatchObject({
      status: 'open',
      processing: 'routed',
      draft: null,
      draftedAgainstVersion: null,
    });
    expect(await doc('build_test_lint')).not.toContain('New');

    drafter.answer(draftAnswer('Test', '## Test\n\nNewer'));
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({ processing: 'drafted', draftedAgainstVersion: 2 });
    expect(drafter.calls[1]?.prompt).toContain('## Format');
  });

  it('re-queues other drafts when an approval or import changes their target, but not the item being approved', async () => {
    const first = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Test' },
      draftAnswer('Test', '## Test\n\nOne'),
    );
    const second = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Lint' },
      draftAnswer('Lint', '## Lint\n\nTwo'),
    );
    const elsewhere = await drafted(
      { kind: 'agent', name: 'agents/implementer.md', section: null },
      draftAnswer(null, '- Three'),
    );

    unwrap(await approveDraft(first));
    expect(await item(first)).toMatchObject({ status: 'approved', processing: 'drafted' });
    expect(await item(second)).toMatchObject({ status: 'open', processing: 'routed', draft: null });
    expect(await item(elsewhere)).toMatchObject({ processing: 'drafted' });

    // The next loop drafts it against the new text.
    drafter.answer(draftAnswer('Lint', '## Lint\n\nTwo'));
    expect(await pipeline.processNext()).toBe(second);
    expect(await item(second)).toMatchObject({ processing: 'drafted', draftedAgainstVersion: 2 });

    unwrap(
      await knowledge.importDocuments(
        ADMIN,
        boardId,
        [{ fileName: 'build_test_lint.md', content: BUILD_DOC }],
        'upload',
      ),
    );
    expect(await item(second)).toMatchObject({ processing: 'routed' });
  });

  it('releases a draft whose target changed during the Sonnet call, to draft it again', async () => {
    const id = await targeted({ kind: 'doc', name: 'build_test_lint', section: 'Test' });
    drafter.answer(async () => {
      unwrap(
        await knowledge.importDocuments(
          ADMIN,
          boardId,
          [{ fileName: 'build_test_lint.md', content: `${BUILD_DOC}\n## More\n` }],
          'upload',
        ),
      );
      return draftAnswer('Test', '## Test\n\nStale');
    });
    await pipeline.processNext();
    expect(await item(id)).toMatchObject({
      processing: 'routed',
      draft: null,
      processAfter: null,
      processingAttempts: 0,
    });
    drafter.answer(draftAnswer('Test', '## Test\n\nFresh'));
    expect(await pipeline.processNext()).toBe(id);
    expect(await item(id)).toMatchObject({
      processing: 'drafted',
      draftedAgainstVersion: 2,
      draft: { content: '## Test\n\nFresh' },
    });
  });

  it('changes the target as an admin: the draft is cleared and drafted again without routing', async () => {
    const id = await drafted(
      { kind: 'doc', name: 'build_test_lint', section: 'Test' },
      draftAnswer('Test', '## Test\n\nX'),
    );
    const version = (await item(id)).version;
    expect(
      errorOf(
        await knowledge.changeTarget(DEV, id, version, { kind: 'doc', name: 'x', section: null }),
      )?.code,
    ).toBe('forbidden');
    expect(
      errorOf(
        await knowledge.changeTarget(ADMIN, id, version, {
          kind: 'settings',
          name: 'settings.json',
          section: null,
        }),
      )?.code,
    ).toBe('invalid_input');
    expect(
      errorOf(
        await knowledge.changeTarget(ADMIN, id, version, {
          kind: 'doc',
          name: 'nothing',
          section: null,
        }),
      )?.code,
    ).toBe('not_found');
    expect(
      errorOf(
        await knowledge.changeTarget(ADMIN, id, version, {
          kind: 'agent',
          name: 'agents/nobody.md',
          section: null,
        }),
      )?.code,
    ).toBe('not_found');
    expect(
      errorOf(
        await knowledge.changeTarget(ADMIN, id, version - 1, {
          kind: 'doc',
          name: 'build_test_lint',
          section: null,
        }),
      )?.code,
    ).toBe('version_conflict');

    const moved = unwrap(
      await knowledge.changeTarget(ADMIN, id, version, {
        kind: 'agent',
        name: 'agents/implementer.md',
        section: '### Testing',
      }),
    );
    expect(moved).toMatchObject({
      processing: 'routed',
      draft: null,
      rationale: null,
      draftedAgainstVersion: null,
      target: {
        kind: 'agent',
        name: 'agents/implementer.md',
        section: 'Testing',
        newDocument: null,
      },
    });
    drafter.answer(draftAnswer('Testing', '### Testing\n\n- Y'));
    expect(await pipeline.processNext()).toBe(id);
    expect(router.calls).toHaveLength(0);
    expect(await item(id)).toMatchObject({
      processing: 'drafted',
      target: { name: 'agents/implementer.md' },
    });
  });

  it('approves a document proposal as its draft', async () => {
    const id = await submit({
      sourceGlobId: null,
      document: {
        name: 'architecture',
        area: 'architecture',
        audience: ['implementer'],
        description: 'Layout',
        content: '# Architecture\n',
      },
    });
    expect(await item(id)).toMatchObject({ processing: 'drafted', draft: null });
    expect(await preview(id)).toBeNull();
    unwrap(await approveDraft(id));
    expect(await doc('architecture')).toBe('# Architecture\n');
  });
});
