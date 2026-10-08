import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { KbPipeline } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import { effectBasisOf } from '../src/domain/effect-check.js';
import type { Result } from '../src/domain/errors.js';
import type { KbItem } from '../src/domain/kb.js';
import { isAgentSetKind } from '../src/domain/knowledge.js';
import { checkLocalRun, LOCAL_RUN_COMMAND_MAX, parseLocalRun, renderLocalRun } from '../src/domain/local-run.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const errorOf = <T>(result: Result<T>) => (result.ok ? null : result.error);

describe('parseLocalRun', () => {
  it('accepts launch alone, or build and launch, trimmed', () => {
    expect(unwrap(parseLocalRun('{"launch": " scripts/session.sh "}'))).toEqual({ launch: 'scripts/session.sh' });
    expect(unwrap(parseLocalRun('{"launch": "b", "build": "a"}'))).toEqual({ build: 'a', launch: 'b' });
  });

  it.each([
    ['not JSON', 'launch: x', 'not valid JSON'],
    ['an array', '["x"]', 'JSON object'],
    ['null', 'null', 'JSON object'],
    ['no launch', '{"build": "x"}', 'needs launch'],
    ['an empty launch', '{"launch": "  "}', 'launch is empty'],
    ['an empty build', '{"build": "", "launch": "x"}', 'build is empty'],
    ['a non-string', '{"launch": 3}', 'launch must be a string'],
    ['a newline', '{"launch": "a\\nrm -rf /"}', 'one line'],
    ['a carriage return', '{"launch": "a\\rb"}', 'one line'],
    ['a NUL', '{"launch": "a\\u0000b"}', 'one line'],
    ['an unknown key', '{"launch": "x", "env": {}}', 'unknown keys: env'],
    ['an over-long command', JSON.stringify({ launch: 'x'.repeat(LOCAL_RUN_COMMAND_MAX + 1) }), 'longer than'],
  ])('rejects %s', (_, text, message) => {
    const error = errorOf(parseLocalRun(text));
    expect(error?.code).toBe('invalid_input');
    expect(error?.message).toContain(message);
  });

  it('checks parsed values the same way', () => {
    expect(unwrap(checkLocalRun({ launch: 'x' }))).toEqual({ launch: 'x' });
    expect(errorOf(checkLocalRun('x'))?.code).toBe('invalid_input');
  });

  it('renders canonical JSON: build first, two spaces, trailing newline', () => {
    expect(renderLocalRun({ launch: 'b', build: 'a' })).toBe('{\n  "build": "a",\n  "launch": "b"\n}\n');
    expect(renderLocalRun({ launch: 'b' })).toBe('{\n  "launch": "b"\n}\n');
  });

  it('is not an agent-set kind, so it never bumps the agent-set version or uses its effect basis', () => {
    expect(isAgentSetKind('local_run')).toBe(false);
    expect(isAgentSetKind('doc')).toBe(false);
    expect(isAgentSetKind('agent')).toBe(true);
    const outcome = { kind: 'applied', target: 'local_run', name: 'local-run', version: 1, agentSetVersion: 3 } as const;
    expect(effectBasisOf(outcome, '2026-10-08T00:00:00.000Z')).toEqual({ kind: 'time', since: '2026-10-08T00:00:00.000Z' });
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
const SPEC = { build: 'pnpm install', launch: 'scripts/session.sh' };
const CANONICAL = renderLocalRun(SPEC);
const TARGET = { kind: 'local_run' as const, name: 'local-run', section: null };

describe('the local-run spec through the KB', () => {
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
        statement: 'Sessions launch with scripts/session.sh after pnpm install',
        evidence: 's15f11',
        ...patch,
      }),
    ).id;
  const row = () => store.transaction((tx) => tx.getKnowledge(boardId, 'local_run', 'local-run'));
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

  it('routes a learning to the spec, showing the model its current value (or that it is not set)', async () => {
    const id = await submit();
    router.answer(json({ target: { kind: 'local_run', name: 'whatever', section: 'x' }, catalogCandidate: false }), json({ contradicts: [] }));
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({ processing: 'routed', target: { kind: 'local_run', name: 'local-run', section: null, newDocument: null } });
    expect(router.calls[0]?.prompt).toContain('Local-run spec (local-run):\n(not set)');
    expect(router.calls[0]?.system).toContain('"local_run"');
  });

  it('drafts the first value as a whole JSON object and approving creates the row without bumping the agent-set version', async () => {
    const before = await agentSetVersion();
    const id = await drafted(SPEC);
    expect(drafter.calls[0]?.prompt).toContain('Target: the local-run spec');
    expect(drafter.calls[0]?.prompt).toContain('(not set yet)');
    expect(await item(id)).toMatchObject({ processing: 'drafted', draft: { section: null, content: CANONICAL }, draftedAgainstVersion: 0 });
    const listed = unwrap(await knowledge.proposals(DEV, boardId));
    expect(listed.open.find((i) => i.id === id)?.preview?.diff).toEqual([
      { op: 'added', text: '{' },
      { op: 'added', text: '  "build": "pnpm install",' },
      { op: 'added', text: '  "launch": "scripts/session.sh"' },
      { op: 'added', text: '}' },
    ]);

    const approved = unwrap(await approveDraft(id));
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'local_run', name: 'local-run', version: 1 });
    expect(approved.effectCheck).toBeNull();
    expect(await row()).toMatchObject({ content: CANONICAL, layer: 'file', version: 1, source: `kb:${id}` });
    expect(await agentSetVersion()).toBe(before);

    // Served beside the agent set, not in its files.
    const set = unwrap(await knowledge.agentSet(DEV, boardId));
    expect(set).toMatchObject({ version: before, localRun: SPEC, localRunProblem: null });
    expect(set.files.map((f) => f.path)).toEqual(['agents/implementer.md']);
    expect(unwrap(await knowledge.agentSetIndex(DEV, boardId)).entries.map((e) => e.path)).toEqual(['agents/implementer.md']);
    expect(unwrap(await knowledge.localRun(DEV, boardId))).toMatchObject({ spec: SPEC, content: CANONICAL, version: 1, problem: null });
  });

  it('updates an existing value, accepting a draft given as JSON text', async () => {
    unwrap(await approveDraft(await drafted(SPEC)));
    const id = await drafted(json({ launch: 'scripts/session.sh --watch' }));
    expect(drafter.calls[1]?.prompt).toContain('"launch": "scripts/session.sh"');
    unwrap(await approveDraft(id));
    expect(await row()).toMatchObject({ content: renderLocalRun({ launch: 'scripts/session.sh --watch' }), version: 2 });
  });

  it('fails an invalid draft (to retry) and refuses an invalid edited draft, writing nothing', async () => {
    const id = await submit();
    unwrap(await knowledge.changeTarget(ADMIN, id, (await item(id)).version, TARGET));
    drafter.answer(json({ section: null, content: { build: 'x' }, rationale: 'r' }));
    expect(await pipeline.process(id)).toBe(true);
    expect(await item(id)).toMatchObject({ processing: 'routed', draft: null, processingAttempts: 1 });
    expect((await item(id)).processingError).toContain('The drafted local-run spec is invalid: The local-run spec needs launch');

    const good = await drafted(SPEC);
    const refused = await approveDraft(good, { content: '{"launch": "a\\nb"}' });
    expect(errorOf(refused)?.code).toBe('invalid_input');
    expect(await row()).toBeNull();
    expect((await item(good)).status).toBe('open');
  });

  it('applies and checks an admin edit to the spec, and refuses other names', async () => {
    const id = await submit();
    const version = (await item(id)).version;
    const edit = (content: string, name = 'local-run') =>
      knowledge.approve(ADMIN, id, version, { as: 'edit', target: { kind: 'local_run', name }, content });
    expect(errorOf(await edit('{"launch": ""}'))?.code).toBe('invalid_input');
    expect(errorOf(await edit(json(SPEC), 'other'))?.code).toBe('invalid_input');
    expect(await row()).toBeNull();
    unwrap(await edit(json({ launch: 'scripts/session.sh', build: 'pnpm install' })));
    expect(await row()).toMatchObject({ content: CANONICAL, version: 1 });
  });

  it('refuses a retarget to the spec under another name', async () => {
    const id = await submit();
    const refused = await knowledge.changeTarget(ADMIN, id, (await item(id)).version, { ...TARGET, name: 'agents/implementer.md' });
    expect(errorOf(refused)?.code).toBe('invalid_input');
  });

  it('never serves a stored value that fails the check', async () => {
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'local_run',
        name: 'local-run',
        area: null,
        audience: [],
        description: '',
        content: '{"launch": "a", "extra": 1}',
        layer: 'file',
        version: 4,
        source: 'import',
        updatedBy: ADMIN,
        updatedAt: '2026-10-08T12:00:00.000Z',
      }),
    );
    const set = unwrap(await knowledge.agentSetForDownload(boardId));
    expect(set.localRun).toBeNull();
    expect(set.localRunProblem).toContain('version 4');
    expect(set.localRunProblem).toContain('unknown keys: extra');
    expect(unwrap(await knowledge.localRun(DEV, boardId))).toMatchObject({ spec: null, version: 4 });
  });
});
