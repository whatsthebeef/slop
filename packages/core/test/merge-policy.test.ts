import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { KbPipeline } from '../src/app/kb-pipeline.js';
import { KnowledgeService, readMergePolicy } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import type { KbItem } from '../src/domain/kb.js';
import { isAgentSetKind } from '../src/domain/knowledge.js';
import {
  checkMergePolicy,
  MERGE_POLICY_PATH_MAX,
  MERGE_POLICY_PATHS_MAX,
  parseMergePolicy,
  renderMergePolicy,
} from '../src/domain/merge-policy.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const errorOf = <T>(result: Result<T>) => (result.ok ? null : result.error);

describe('parseMergePolicy', () => {
  it('accepts either list, both, or an empty object, trimmed and without repeats', () => {
    expect(unwrap(parseMergePolicy('{}'))).toEqual({});
    expect(unwrap(parseMergePolicy('{"exclusivePaths": [" apps/server/drizzle/** ", "apps/server/drizzle/**"]}'))).toEqual({
      exclusivePaths: ['apps/server/drizzle/**'],
    });
    expect(unwrap(parseMergePolicy('{"sizeIgnoredPaths": ["pnpm-lock.yaml"], "exclusivePaths": []}'))).toEqual({
      exclusivePaths: [],
      sizeIgnoredPaths: ['pnpm-lock.yaml'],
    });
  });

  it.each([
    ['not JSON', 'x', 'not valid JSON'],
    ['an array', '[]', 'JSON object'],
    ['null', 'null', 'JSON object'],
    ['an unknown key', '{"exclusive": []}', 'unknown keys: exclusive'],
    ['a non-array', '{"exclusivePaths": "a/**"}', 'must be a list'],
    ['a non-string entry', '{"exclusivePaths": [1]}', 'only strings'],
    ['an empty entry', '{"exclusivePaths": [" "]}', 'empty entry'],
    ['a newline', '{"exclusivePaths": ["a\\nb"]}', 'one line'],
    ['a NUL', '{"sizeIgnoredPaths": ["a\\u0000b"]}', 'one line'],
    ['a parent path', '{"exclusivePaths": ["../x/**"]}', 'no ..'],
    ['an absolute path', '{"exclusivePaths": ["/etc/**"]}', 'no ..'],
    ['an over-long entry', JSON.stringify({ exclusivePaths: ['x'.repeat(MERGE_POLICY_PATH_MAX + 1)] }), 'longer than'],
    [
      'too many entries',
      JSON.stringify({ sizeIgnoredPaths: Array.from({ length: MERGE_POLICY_PATHS_MAX + 1 }, (_, i) => `p${String(i)}`) }),
      'more than',
    ],
  ])('rejects %s', (_, text, message) => {
    const error = errorOf(parseMergePolicy(text));
    expect(error?.code).toBe('invalid_input');
    expect(error?.message).toContain(message);
  });

  it('checks parsed values the same way and renders canonical JSON', () => {
    expect(errorOf(checkMergePolicy('x'))?.code).toBe('invalid_input');
    const policy = { exclusivePaths: ['a/**'], sizeIgnoredPaths: ['b'] };
    expect(renderMergePolicy(policy)).toBe('{\n  "exclusivePaths": [\n    "a/**"\n  ],\n  "sizeIgnoredPaths": [\n    "b"\n  ]\n}\n');
    expect(renderMergePolicy({})).toBe('{}\n');
    expect(unwrap(parseMergePolicy(renderMergePolicy(policy)))).toEqual(policy);
  });

  it('is not an agent-set kind, so it never bumps the agent-set version', () => {
    expect(isAgentSetKind('merge_policy')).toBe(false);
  });
});

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const IMPLEMENTER = '---\nname: implementer\ndescription: Implements plans\n---\n\n# Implementer\n';
const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'h1', files: [{ path: 'agents/implementer.md', content: IMPLEMENTER }] }),
};

class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  private readonly answers: string[] = [];
  answer(...answers: string[]): void {
    this.answers.push(...answers);
  }
  complete(request: { system: string; prompt: string }): Promise<string> {
    this.calls.push(request);
    const next = this.answers.shift();
    return next === undefined ? Promise.reject(new Error('No canned answer')) : Promise.resolve(next);
  }
}

const json = (value: unknown) => JSON.stringify(value);
const POLICY = { exclusivePaths: ['apps/server/drizzle/**'], sizeIgnoredPaths: ['pnpm-lock.yaml'] };
const CANONICAL = renderMergePolicy(POLICY);
const TARGET = { kind: 'merge_policy' as const, name: 'merge-policy', section: null };

describe('the merge policy through the KB', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;
  let pipeline: KbPipeline;
  let router: FakeLlm;
  let drafter: FakeLlm;
  let boardId: number;
  let globId: string;

  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  const submit = async (patch: Partial<NewLearning> = {}) =>
    unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: globId,
        type: 'decision',
        statement: 'Only one open glob may change apps/server/drizzle at a time',
        evidence: 's15f11',
        ...patch,
      }),
    ).id;
  const row = () => store.transaction((tx) => tx.getKnowledge(boardId, 'merge_policy', 'merge-policy'));
  const agentSetVersion = async () => (await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion;
  /** An item targeted at the spec by an admin and drafted with `content`. */
  const drafted = async (content: unknown) => {
    const id = await submit();
    unwrap(await knowledge.changeTarget(ADMIN, id, (await item(id)).version, TARGET));
    drafter.answer(json({ section: null, content, rationale: 'Sets the launch' }));
    expect(await pipeline.process(id)).toBe(true);
    return id;
  };
  const approveDraft = async (id: string, patch: { content?: string } = {}) =>
    knowledge.approve(ADMIN, id, (await item(id)).version, { as: 'draft', ...patch });

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-08T12:00:00.000Z' };
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
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
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
  });

  it('routes a learning to the policy, showing the model its current value (or that it is not set)', async () => {
    const id = await submit();
    router.answer(json({ target: { kind: 'merge_policy', name: 'whatever', section: 'x' }, catalogCandidate: false }), json({ contradicts: [] }));
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({ processing: 'routed', target: { kind: 'merge_policy', name: 'merge-policy', section: null, newDocument: null } });
    expect(router.calls[0]?.prompt).toContain('Merge policy (merge-policy):\n(not set)');
    expect(router.calls[0]?.system).toContain('"merge_policy"');
  });

  it('drafts the first value as a whole JSON object; approving creates the row, with no agent-set bump and not in the bundle', async () => {
    const before = await agentSetVersion();
    const id = await drafted(POLICY);
    expect(drafter.calls[0]?.prompt).toContain('Target: the merge policy');
    expect(drafter.calls[0]?.prompt).toContain('(not set yet)');
    expect(await item(id)).toMatchObject({ processing: 'drafted', draft: { section: null, content: CANONICAL }, draftedAgainstVersion: 0 });

    const approved = unwrap(await approveDraft(id));
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'merge_policy', name: 'merge-policy', version: 1 });
    expect(await row()).toMatchObject({ content: CANONICAL, layer: 'file', version: 1, source: `kb:${id}` });
    expect(await agentSetVersion()).toBe(before);
    const set = unwrap(await knowledge.agentSet(DEV, boardId));
    expect(set.version).toBe(before);
    expect(set.files.map((f) => f.path)).toEqual(['agents/implementer.md']);
    expect(unwrap(await knowledge.agentSetIndex(DEV, boardId)).entries.map((e) => e.path)).toEqual(['agents/implementer.md']);
    expect(unwrap(await knowledge.mergePolicy(DEV, boardId))).toMatchObject({ policy: POLICY, content: CANONICAL, version: 1, problem: null });
    const read = await store.transaction((tx) => readMergePolicy(tx, boardId));
    expect(read).toEqual(POLICY);
  });

  it('updates an existing value, accepting a draft given as JSON text', async () => {
    unwrap(await approveDraft(await drafted(POLICY)));
    const id = await drafted(json({ exclusivePaths: ['apps/server/drizzle/**', 'db/**'] }));
    expect(drafter.calls[1]?.prompt).toContain('"apps/server/drizzle/**"');
    unwrap(await approveDraft(id));
    expect(await row()).toMatchObject({ content: renderMergePolicy({ exclusivePaths: ['apps/server/drizzle/**', 'db/**'] }), version: 2 });
  });

  it('fails an invalid draft (to retry) and refuses an invalid edited draft, writing nothing', async () => {
    const id = await submit();
    unwrap(await knowledge.changeTarget(ADMIN, id, (await item(id)).version, TARGET));
    drafter.answer(json({ section: null, content: { exclusivePaths: 'x' }, rationale: 'r' }));
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({ processing: 'routed', draft: null, processingAttempts: 1 });
    expect((await item(id)).processingError).toContain('The drafted merge policy is invalid');

    const good = await drafted(POLICY);
    const refused = await approveDraft(good, { content: '{"exclusivePaths": ["../x"]}' });
    expect(errorOf(refused)?.code).toBe('invalid_input');
    expect(await row()).toBeNull();
    expect((await item(good)).status).toBe('open');
  });

  it('has no side door: only an approved item writes it, including its first value', async () => {
    // Uploads and imports write documents, whatever the file is called.
    unwrap(await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'merge-policy.json', content: '{"exclusivePaths": ["a/**"]}' }], 'upload'));
    expect(await row()).toBeNull();
    // A non-admin cannot approve; an admin's edit is checked and refuses other names.
    const id = await submit();
    const version = (await item(id)).version;
    const edit = (content: string, name = 'merge-policy') =>
      knowledge.approve(ADMIN, id, version, { as: 'edit', target: { kind: 'merge_policy', name }, content });
    expect(errorOf(await knowledge.approve(DEV, id, version, { as: 'edit', target: TARGET, content: '{}' }))?.code).toBe('forbidden');
    expect(errorOf(await edit('{"exclusivePaths": "x"}'))?.code).toBe('invalid_input');
    expect(errorOf(await edit(json(POLICY), 'other'))?.code).toBe('invalid_input');
    expect(await row()).toBeNull();
    unwrap(await edit(json({ sizeIgnoredPaths: ['pnpm-lock.yaml'], exclusivePaths: ['apps/server/drizzle/**'] })));
    expect(await row()).toMatchObject({ content: CANONICAL, version: 1 });
  });

  it('keeps the approval for a person: an agent may not approve a merge-policy item, but may reject it', async () => {
    const id = await drafted(POLICY);
    const refused = await knowledge.decideByAgent(ADMIN, id, (await item(id)).version, 'approve');
    expect(errorOf(refused)?.code).toBe('forbidden');
    expect(errorOf(refused)?.message).toContain('merge policy');
    expect(await row()).toBeNull();
    unwrap(await knowledge.decideByAgent(ADMIN, id, (await item(id)).version, 'reject', { reason: 'not now' }));
  });

  it('refuses a retarget to the policy under another name', async () => {
    const id = await submit();
    const refused = await knowledge.changeTarget(ADMIN, id, (await item(id)).version, { ...TARGET, name: 'agents/implementer.md' });
    expect(errorOf(refused)?.code).toBe('invalid_input');
  });

  it('never serves, or acts on, a stored value that fails the check', async () => {
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'merge_policy',
        name: 'merge-policy',
        area: null,
        audience: [],
        description: '',
        content: '{"exclusivePaths": ["../x"]}',
        layer: 'file',
        version: 4,
        source: 'import',
        updatedBy: ADMIN,
        updatedAt: '2026-10-08T12:00:00.000Z',
      }),
    );
    const view = unwrap(await knowledge.mergePolicy(DEV, boardId));
    expect(view).toMatchObject({ policy: null, version: 4 });
    expect(view.problem).toContain('version 4');
    expect(await store.transaction((tx) => readMergePolicy(tx, boardId))).toEqual({});
  });
});
