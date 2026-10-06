import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import { appendOverlay, composeAgentSet, composeFile, lineDiff, mergeJson, overlayProblem } from '../src/domain/agent-set.js';
import type { Result } from '../src/domain/errors.js';
import type { KnowledgeKind, KnowledgeLayer } from '../src/domain/knowledge.js';
import type { Catalog, CatalogAgentSet } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const errorCode = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

describe('agent-set composition', () => {
  it('appends the overlay under Board rules, or serves the catalog text alone', () => {
    expect(appendOverlay('# Tester\n\nTest it.\n\n', '- Use Postgres.\n')).toBe('# Tester\n\nTest it.\n\n## Board rules\n\n- Use Postgres.\n');
    expect(appendOverlay('# Tester\n', '  \n')).toBe('# Tester\n');
    // An overlay that brings its own heading isn't given a second one.
    expect(appendOverlay('# T\n', '## Board rules\n\n- x')).toBe('# T\n\n## Board rules\n\n- x\n');
  });

  it('deep-merges JSON: objects recurse, arrays concatenate without duplicates, overlay scalars win', () => {
    const base = { permissions: { allow: ['Bash(ls)', 'Read'], deny: [] }, model: 'a', hooks: { Stop: [{ command: 'x' }] } };
    const overlay = { permissions: { allow: ['Read', 'Bash(pnpm test)'] }, model: 'b', hooks: { Stop: [{ command: 'x' }, { command: 'y' }] }, extra: 1 };
    expect(mergeJson(base, overlay)).toEqual({
      permissions: { allow: ['Bash(ls)', 'Read', 'Bash(pnpm test)'], deny: [] },
      model: 'b',
      hooks: { Stop: [{ command: 'x' }, { command: 'y' }] },
      extra: 1,
    });
    expect(mergeJson([1], { a: 1 })).toEqual({ a: 1 });
  });

  it('composes settings as merged JSON and leaves kinds without overlays alone', () => {
    expect(composeFile('settings', '{"a":[1]}\n', '{"a":[2],"b":true}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": true\n}\n');
    expect(composeFile('settings', '{"a":1}\n', '')).toBe('{"a":1}\n');
    expect(composeFile('hook', 'echo hi\n', 'echo board\n')).toBe('echo hi\n');
  });

  it('checks overlays: markdown anything, settings a JSON object, hooks and mcp none', () => {
    expect(overlayProblem('agent', '- rule')).toBeNull();
    expect(overlayProblem('settings', '{"a":1}')).toBeNull();
    expect(overlayProblem('settings', '[1]')).not.toBeNull();
    expect(overlayProblem('settings', '{oops')).not.toBeNull();
    expect(overlayProblem('hook', 'echo')).not.toBeNull();
    expect(overlayProblem('mcp', '{}')).not.toBeNull();
    expect(overlayProblem('hook', '')).toBeNull();
  });

  it('serves catalog files, overlays, board files and overrides, and lists orphans without serving them', () => {
    const row = (kind: KnowledgeKind, name: string, layer: KnowledgeLayer, content: string) => ({ kind, name, layer, content });
    const composed = composeAgentSet(
      [
        { path: 'agents/a.md', content: 'A\n' },
        { path: 'agents/b.md', content: 'B\n' },
        { path: 'agents/c.md', content: 'C\n' },
        { path: 'hooks/h.sh', content: 'h\n' },
        { path: 'README.md', content: 'not delivered' },
      ],
      [
        row('agent', 'agents/b.md', 'overlay', '- b rule'),
        row('agent', 'agents/c.md', 'file', 'Board C\n'),
        row('agent', 'agents/mine.md', 'file', 'Mine\n'),
        row('agent', 'agents/gone.md', 'overlay', '- stale'),
        row('hook', 'hooks/h.sh', 'overlay', ''),
      ],
    );
    expect(composed.files).toEqual([
      { path: 'agents/a.md', content: 'A\n' },
      { path: 'agents/b.md', content: 'B\n\n## Board rules\n\n- b rule\n' },
      { path: 'agents/c.md', content: 'Board C\n' },
      { path: 'agents/mine.md', content: 'Mine\n' },
      { path: 'hooks/h.sh', content: 'h\n' },
    ]);
    expect(composed.entries.map((e) => `${e.path}:${e.status}`)).toEqual([
      'agents/a.md:catalog',
      'agents/b.md:overlay',
      'agents/c.md:override',
      'agents/gone.md:orphaned',
      'agents/mine.md:board_file',
      'hooks/h.sh:catalog',
    ]);
  });
});

describe('lineDiff', () => {
  const render = (a: string, b: string) =>
    lineDiff(a, b).map((l) => `${l.op === 'same' ? ' ' : l.op === 'added' ? '+' : '-'}${l.text}`);

  it('marks kept, removed and added lines in order', () => {
    expect(render('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([' a', '-b', '+B', ' c', '+d']);
  });

  it('handles empty sides and identical texts', () => {
    expect(render('', 'x\ny')).toEqual(['+x', '+y']);
    expect(render('x\n', '')).toEqual(['-x']);
    expect(render('same\n', 'same\n')).toEqual([' same']);
    expect(lineDiff('', '')).toEqual([]);
  });

  it('finds the longest common subsequence in the middle', () => {
    expect(render('h\n1\n2\n3\n4\nt', 'h\n2\nx\n4\n5\nt')).toEqual([' h', '-1', ' 2', '-3', '+x', ' 4', '+5', ' t']);
  });
});

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

describe('layered agent set on a board', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let knowledge: KnowledgeService;
  let globs: GlobService;
  let boardId: number;
  let catalogSet: CatalogAgentSet;

  const catalog: Catalog = {
    kbEntries: () => Promise.resolve([]),
    agentSet: () => Promise.resolve(catalogSet),
  };

  const board = async () => {
    const found = await store.transaction((tx) => tx.getBoard(boardId));
    if (found === null) throw new Error('no board');
    return found;
  };

  const row = (kind: KnowledgeKind, name: string) => store.transaction((tx) => tx.getKnowledge(boardId, kind, name));

  const saveRow = (kind: KnowledgeKind, name: string, layer: KnowledgeLayer, content: string, source = 'edit') =>
    store.transaction((tx) =>
      tx.saveKnowledge({ boardId, kind, name, area: null, audience: [], description: '', content, layer, version: 1, source, updatedBy: ADMIN, updatedAt: NOW }),
    );

  const submit = async () => {
    const glob = unwrap(
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
    );
    return unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: glob.id, type: 'agent-behaviour', statement: 'Test first', evidence: 'run' })).id;
  };

  beforeEach(async () => {
    catalogSet = {
      hash: 'h1',
      files: [
        { path: 'agents/tester.md', content: '# Tester\n\nTest it.\n' },
        { path: 'settings.json', content: '{\n  "permissions": { "allow": ["Read"] }\n}\n' },
        { path: 'hooks/after_push.sh', content: 'echo pushed\n' },
      ],
    };
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    const boards = new BoardService({ store, notifier });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await knowledge.adoptCatalogAgentSet(ADMIN, boardId));
  });

  it('bumps the agent-set version of every board when the catalog hash changes, and not otherwise', async () => {
    expect((await board()).agentCatalogHash).toBe('h1');
    expect(await knowledge.syncCatalogAgentSet()).toEqual([]);
    expect((await board()).agentSetVersion).toBe(1);

    catalogSet = { hash: 'h2', files: [...catalogSet.files, { path: 'agents/new.md', content: 'New agent\n' }] };
    notifier.hints.length = 0;
    expect(await knowledge.syncCatalogAgentSet()).toEqual([boardId]);
    const after = await board();
    expect(after).toMatchObject({ agentSetVersion: 2, agentCatalogHash: 'h2' });
    expect(notifier.hints).toContainEqual({ kind: 'board.changed', boardId });
    // The new catalog file reaches the board with no copy.
    expect(unwrap(await knowledge.agentSet(DEV, boardId)).files.map((f) => f.path)).toContain('agents/new.md');
    expect(await knowledge.syncCatalogAgentSet()).toEqual([]);
    expect((await board()).agentSetVersion).toBe(2);
  });

  it('writes an approved agent edit as the overlay and serves catalog text plus Board rules', async () => {
    const id = await submit();
    const approved = unwrap(
      await knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind: 'agent', name: 'agents/tester.md' }, content: '- Write the test first.\n' }),
    );
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'agent', name: 'agents/tester.md', version: 1 });
    expect(await row('agent', 'agents/tester.md')).toMatchObject({ layer: 'overlay', content: '- Write the test first.\n', source: `kb:${id}` });
    expect((await board()).agentSetVersion).toBe(2);
    const served = unwrap(await knowledge.agentSet(DEV, boardId)).files.find((f) => f.path === 'agents/tester.md');
    expect(served?.content).toBe('# Tester\n\nTest it.\n\n## Board rules\n\n- Write the test first.\n');

    // A catalog change keeps the board's rules on top of the new catalog text.
    catalogSet = { hash: 'h2', files: [{ path: 'agents/tester.md', content: '# Tester\n\nTest it well.\n' }, ...catalogSet.files.slice(1)] };
    const view = unwrap(await knowledge.agentSetFile(DEV, boardId, 'agents/tester.md'));
    expect(view).toMatchObject({
      layer: 'overlay',
      status: 'overlay',
      content: '- Write the test first.\n',
      catalog: '# Tester\n\nTest it well.\n',
      served: '# Tester\n\nTest it well.\n\n## Board rules\n\n- Write the test first.\n',
      version: 1,
    });
  });

  it('merges a settings overlay, and refuses invalid settings JSON and hook overlays', async () => {
    const id = await submit();
    const edit = (kind: KnowledgeKind, name: string, content: string) =>
      knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind, name }, content });
    expect(errorCode(await edit('settings', 'settings.json', '{nope'))).toBe('invalid_input');
    expect(errorCode(await edit('hook', 'hooks/after_push.sh', 'echo board\n'))).toBe('invalid_input');
    expect(errorCode(await edit('agent', 'agents/unknown.md', '- x'))).toBe('not_found');
    unwrap(await edit('settings', 'settings.json', '{ "permissions": { "allow": ["Bash(pnpm test)"] } }'));
    const served = unwrap(await knowledge.agentSet(DEV, boardId)).files.find((f) => f.path === 'settings.json');
    expect(JSON.parse(served?.content ?? '')).toEqual({ permissions: { allow: ['Read', 'Bash(pnpm test)'] } });
  });

  it('edits a whole board file as a file', async () => {
    await saveRow('agent', 'agents/tester.md', 'file', 'Board tester.\n', 'kb:s1k1');
    const id = await submit();
    unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind: 'agent', name: 'agents/tester.md' }, content: 'Board tester, revised.\n' }));
    expect(await row('agent', 'agents/tester.md')).toMatchObject({ layer: 'file', content: 'Board tester, revised.\n', version: 2 });
  });

  it('lets admins turn a legacy override back into the catalog file plus board rules', async () => {
    await saveRow('agent', 'agents/tester.md', 'file', 'Old fork.\n', 'kb:s1k1');
    expect(unwrap(await knowledge.agentSetIndex(DEV, boardId)).entries.find((e) => e.path === 'agents/tester.md')?.status).toBe('override');
    expect(errorCode(await knowledge.useCatalogVersion(DEV, boardId, 'agents/tester.md'))).toBe('forbidden');
    expect(errorCode(await knowledge.useCatalogVersion(ADMIN, boardId, 'agents/missing.md'))).toBe('not_found');
    expect(errorCode(await knowledge.useCatalogVersion(ADMIN, boardId, 'hooks/after_push.sh', 'echo'))).toBe('invalid_input');

    const before = (await board()).agentSetVersion;
    expect(unwrap(await knowledge.useCatalogVersion(ADMIN, boardId, 'agents/tester.md', '- Keep this.'))).toEqual({ version: 2 });
    expect(await row('agent', 'agents/tester.md')).toMatchObject({ layer: 'overlay', content: '- Keep this.', version: 2 });
    expect((await board()).agentSetVersion).toBe(before + 1);
    const served = unwrap(await knowledge.agentSet(DEV, boardId)).files.find((f) => f.path === 'agents/tester.md');
    expect(served?.content).toBe('# Tester\n\nTest it.\n\n## Board rules\n\n- Keep this.\n');
    // Already following the catalog: nothing to reset.
    expect(errorCode(await knowledge.useCatalogVersion(ADMIN, boardId, 'agents/tester.md'))).toBe('invalid_input');
  });

  it('keeps an overlay whose catalog file is gone, listed as orphaned and not served', async () => {
    await saveRow('agent', 'agents/retired.md', 'overlay', '- old rule');
    const index = unwrap(await knowledge.agentSetIndex(DEV, boardId));
    expect(index.entries.find((e) => e.path === 'agents/retired.md')?.status).toBe('orphaned');
    expect(unwrap(await knowledge.agentSet(DEV, boardId)).files.map((f) => f.path)).not.toContain('agents/retired.md');
    expect(unwrap(await knowledge.agentSetFile(DEV, boardId, 'agents/retired.md'))).toMatchObject({ served: null, catalog: null });
    expect(unwrap(await knowledge.agentSetForDownload(boardId)).files).toEqual(unwrap(await knowledge.agentSet(DEV, boardId)).files);
  });
});
