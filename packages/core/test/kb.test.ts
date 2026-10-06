import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { Approval, NewLearning } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const errorCode = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

describe('submit_learning', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;
  let globs: GlobService;
  let boardId: number;
  let otherBoardId: number;
  let globId: string;

  const createGlob = async (board: number, category: 'feature' | 'task') =>
    unwrap(
      await globs.create(ADMIN, {
        boardId: board,
        title: 'Work',
        summary: '',
        type: 'same',
        category,
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;

  const learning = (patch: Partial<NewLearning> = {}): NewLearning => ({
    sourceGlobId: globId,
    type: 'gotcha',
    statement: 'Generated files live in src/gen/',
    evidence: 'Review finding on src/gen/client.ts',
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    const boards = new BoardService({ store, notifier });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    const input = { repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] };
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', ...input })).id;
    otherBoardId = unwrap(await boards.create(ADMIN, { name: 'other', ...input })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    globId = await createGlob(boardId, 'task');
  });

  it('numbers KB items s<b>k1, s<b>k2 on their own counter', async () => {
    await createGlob(boardId, 'feature');
    const first = unwrap(await knowledge.submitLearning(DEV, boardId, learning()));
    const second = unwrap(
      await knowledge.submitLearning(DEV, boardId, learning({ type: 'pattern' })),
    );
    expect([first.id, second.id]).toEqual([`s${boardId}k1`, `s${boardId}k2`]);
    // Glob counters are untouched by KB items.
    expect(await createGlob(boardId, 'task')).toBe(`s${boardId}t2`);
    expect(await createGlob(boardId, 'feature')).toBe(`s${boardId}f2`);
  });

  it('records an open, submitted item with its submitter, provenance and source glob', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(
        DEV,
        boardId,
        learning({
          statement: '  Never edit src/gen/  ',
          suggestedTarget: 'agents/implementer.md',
          agentSetVersion: 7,
        }),
      ),
    );
    const item = await store.transaction((tx) => tx.getKbItem(id));
    expect(item).toEqual({
      id,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: 'Never edit src/gen/',
      evidence: 'Review finding on src/gen/client.ts',
      suggestedTarget: 'agents/implementer.md',
      sourceGlobIds: [globId],
      source: 'submitted',
      agentSetVersion: 7,
      submittedBy: DEV,
      createdAt: NOW,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      version: 1,
    });
    const open = await store.transaction((tx) => tx.listKbItems(boardId, 'open'));
    expect(open.map((i) => i.id)).toEqual([id]);
    expect(await store.transaction((tx) => tx.listKbItems(boardId, 'approved'))).toEqual([]);
  });

  it('stores no agent-set version or target when none is given', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, learning({ suggestedTarget: '  ' })),
    );
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({
      agentSetVersion: null,
      suggestedTarget: null,
    });
  });

  it('refuses people who are not members of the board', async () => {
    expect(errorCode(await knowledge.submitLearning(OUTSIDER, boardId, learning()))).toBe(
      'forbidden',
    );
  });

  it('refuses a source glob from another board, or one that does not exist', async () => {
    const elsewhere = await createGlob(otherBoardId, 'task');
    expect(
      errorCode(
        await knowledge.submitLearning(DEV, boardId, learning({ sourceGlobId: elsewhere })),
      ),
    ).toBe('not_found');
    expect(
      errorCode(await knowledge.submitLearning(DEV, boardId, learning({ sourceGlobId: 's99t1' }))),
    ).toBe('not_found');
  });

  it('refuses empty statements and evidence, unknown types and bad versions', async () => {
    expect(
      errorCode(await knowledge.submitLearning(DEV, boardId, learning({ statement: '   ' }))),
    ).toBe('invalid_input');
    expect(
      errorCode(await knowledge.submitLearning(DEV, boardId, learning({ evidence: '' }))),
    ).toBe('invalid_input');
    expect(
      errorCode(await knowledge.submitLearning(DEV, boardId, learning({ type: 'opinion' }))),
    ).toBe('invalid_input');
    expect(
      errorCode(await knowledge.submitLearning(DEV, boardId, learning({ agentSetVersion: 1.5 }))),
    ).toBe('invalid_input');
    // Refused submissions use no IDs.
    expect(unwrap(await knowledge.submitLearning(DEV, boardId, learning())).id).toBe(
      `s${boardId}k1`,
    );
  });
});

describe('KB review', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;
  let boardId: number;
  let globId: string;
  const later = '2026-10-06T09:00:00.000Z';

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

  const item = async (id: string) => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  const doc = (kind: 'doc' | 'agent', name: string) =>
    store.transaction((tx) => tx.getKnowledge(boardId, kind, name));

  const agentSetVersion = async () => (await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion;

  const proposal = {
    name: 'architecture',
    area: 'architecture',
    audience: ['investigator', 'implementer'],
    description: 'How the code is laid out',
    content: '# Architecture\n\nHexagonal.\n',
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => later };
    const boards = new BoardService({ store, notifier });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
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
        [{ fileName: 'build.md', content: '---\narea: build\naudience: [tester]\ndescription: Commands\n---\nRun pnpm build.\n' }],
        'upload',
      ),
    );
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'agent',
        name: 'agents/implementer.md',
        area: null,
        audience: [],
        description: '',
        content: 'Implement the plan.\n',
        layer: 'file',
        version: 1,
        source: 'catalog:agents',
        updatedBy: ADMIN,
        updatedAt: NOW,
      }),
    );
  });

  it('lets only board admins approve or reject', async () => {
    const id = await submit();
    expect(errorCode(await knowledge.approve(DEV, id, 1, { as: 'learning' }))).toBe('forbidden');
    expect(errorCode(await knowledge.reject(DEV, id, 1, 'No'))).toBe('forbidden');
    expect(errorCode(await knowledge.approve(OUTSIDER, id, 1, { as: 'learning' }))).toBe('forbidden');
    expect(errorCode(await knowledge.approve(ADMIN, 's99k1', 1, { as: 'learning' }))).toBe('not_found');
    expect((await item(id)).status).toBe('open');
  });

  it('refuses a stale version with the current item', async () => {
    const id = await submit();
    const stale = await knowledge.approve(ADMIN, id, 2, { as: 'learning' });
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.error.code === 'version_conflict' && 'currentItem' in stale.error) {
      expect(stale.error.currentItem).toMatchObject({ id, version: 1, status: 'open' });
    } else {
      throw new Error('Expected a version conflict with the current item');
    }
  });

  it('decides only open items', async () => {
    const id = await submit();
    unwrap(await knowledge.reject(ADMIN, id, 1, 'Not true'));
    expect(errorCode(await knowledge.approve(ADMIN, id, 2, { as: 'learning' }))).toBe('invalid_input');
    expect(errorCode(await knowledge.reject(ADMIN, id, 2, 'Again'))).toBe('invalid_input');
    // A client still holding version 1 is told the item changed.
    expect(errorCode(await knowledge.approve(ADMIN, id, 1, { as: 'learning' }))).toBe('version_conflict');
  });

  it('approves as a learning, with an edited statement, and serves it in the conventions', async () => {
    const id = await submit();
    const approved = unwrap(
      await knowledge.approve(ADMIN, id, 1, { as: 'learning', statement: '  Never edit src/gen/ by hand  ' }),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      statement: 'Never edit src/gen/ by hand',
      outcome: { kind: 'learning' },
      decidedBy: ADMIN,
      decidedAt: later,
      version: 2,
    });
    expect(await item(id)).toEqual(approved);
    expect(unwrap(await knowledge.approvedLearnings(DEV, boardId))).toEqual([
      { id, type: 'gotcha', statement: 'Never edit src/gen/ by hand', sourceGlobIds: [globId], approvedAt: later },
    ]);
    expect(errorCode(await knowledge.approvedLearnings(OUTSIDER, boardId))).toBe('forbidden');
  });

  it('applies an edit to a document as a new version, keeping its frontmatter', async () => {
    const id = await submit();
    const approval: Approval = {
      as: 'edit',
      target: { kind: 'doc', name: 'build' },
      content: 'Run pnpm build.\n\nGenerated files live in src/gen/.\n',
    };
    const before = await agentSetVersion();
    const approved = unwrap(await knowledge.approve(ADMIN, id, 1, approval));
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'doc', name: 'build', version: 2 });
    expect(await doc('doc', 'build')).toMatchObject({
      version: 2,
      area: 'build',
      audience: ['tester'],
      description: 'Commands',
      content: 'Run pnpm build.\n\nGenerated files live in src/gen/.\n',
      source: `kb:${id}`,
      updatedBy: ADMIN,
    });
    expect(await agentSetVersion()).toBe(before);
    // Applied items are not served as learnings: the document now carries them.
    expect(unwrap(await knowledge.approvedLearnings(DEV, boardId))).toEqual([]);
  });

  it('applies an edit to an agent file and bumps the agent-set version', async () => {
    const id = await submit({ type: 'agent-behaviour', statement: 'Write the regression test first' });
    const before = await agentSetVersion();
    const approved = unwrap(
      await knowledge.approve(ADMIN, id, 1, {
        as: 'edit',
        target: { kind: 'agent', name: 'agents/implementer.md' },
        content: 'Implement the plan.\nWrite the regression test before the fix.\n',
      }),
    );
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'agent', name: 'agents/implementer.md', version: 2 });
    expect((await doc('agent', 'agents/implementer.md'))?.content).toBe(
      'Implement the plan.\nWrite the regression test before the fix.\n',
    );
    expect(await agentSetVersion()).toBe((before ?? 0) + 1);
  });

  it('refuses edits to a target that does not exist, or with empty content, and writes nothing', async () => {
    const id = await submit();
    expect(
      errorCode(await knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind: 'doc', name: 'nope' }, content: 'x' })),
    ).toBe('not_found');
    expect(
      errorCode(await knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind: 'doc', name: 'build' }, content: ' ' })),
    ).toBe('invalid_input');
    expect((await item(id)).status).toBe('open');
    expect((await doc('doc', 'build'))?.version).toBe(1);
  });

  it('rejects with a required reason and keeps the item', async () => {
    const id = await submit();
    expect(errorCode(await knowledge.reject(ADMIN, id, 1, '   '))).toBe('invalid_input');
    const rejected = unwrap(await knowledge.reject(ADMIN, id, 1, ' Already in the build doc '));
    expect(rejected).toMatchObject({
      status: 'rejected',
      decisionReason: 'Already in the build doc',
      decidedBy: ADMIN,
      decidedAt: later,
      outcome: null,
      version: 2,
    });
    expect(unwrap(await knowledge.proposals(DEV, boardId, 'rejected')).map((i) => i.id)).toEqual([id]);
    expect(unwrap(await knowledge.proposals(DEV, boardId, 'open'))).toEqual([]);
    expect(errorCode(await knowledge.proposals(OUTSIDER, boardId))).toBe('forbidden');
  });

  it('records a document proposal, without a source glob, and approving it creates the document', async () => {
    const id = await submit({
      sourceGlobId: null,
      type: 'pattern',
      statement: 'New document: architecture',
      evidence: 'README.md, packages/',
      document: { ...proposal, name: 'docs/architecture.md', content: '---\narea: ignored\n---\n# Architecture\n\nHexagonal.' },
    });
    expect(await item(id)).toMatchObject({ sourceGlobIds: [], document: proposal });
    expect(errorCode(await knowledge.approve(ADMIN, id, 1, { as: 'learning' }))).toBe('invalid_input');
    const approved = unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'document' }));
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'doc', name: 'architecture', version: 1 });
    expect(await doc('doc', 'architecture')).toMatchObject({
      area: 'architecture',
      audience: ['investigator', 'implementer'],
      description: 'How the code is laid out',
      content: '# Architecture\n\nHexagonal.\n',
      version: 1,
      source: `kb:${id}`,
    });
    expect(unwrap(await knowledge.index(DEV, boardId)).map((d) => d.name)).toContain('architecture');
  });

  it('approves a document proposal with edited content, updating an existing document', async () => {
    const id = await submit({ document: { ...proposal, name: 'build', area: 'build', content: 'Old' } });
    unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'document', content: 'Run pnpm -r build.' }));
    expect(await doc('doc', 'build')).toMatchObject({ version: 2, area: 'build', content: 'Run pnpm -r build.\n' });
  });

  it('refuses approving a statement as a document, and bad document proposals', async () => {
    const id = await submit();
    expect(errorCode(await knowledge.approve(ADMIN, id, 1, { as: 'document' }))).toBe('invalid_input');
    const bad = (patch: Partial<typeof proposal>) =>
      knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: null,
        type: 'pattern',
        statement: 'New document',
        evidence: 'The repo',
        document: { ...proposal, ...patch },
      });
    expect(errorCode(await bad({ area: ' ' }))).toBe('invalid_input');
    expect(errorCode(await bad({ description: '' }))).toBe('invalid_input');
    expect(errorCode(await bad({ description: 'two\nlines' }))).toBe('invalid_input');
    expect(errorCode(await bad({ name: 'a b' }))).toBe('invalid_input');
    expect(errorCode(await bad({ audience: ['tester, qa'] }))).toBe('invalid_input');
    expect(errorCode(await bad({ content: '---\narea: x\n---\n' }))).toBe('invalid_input');
    // Statements still need their source glob.
    expect(
      errorCode(
        await knowledge.submitLearning(DEV, boardId, { sourceGlobId: null, type: 'gotcha', statement: 's', evidence: 'e' }),
      ),
    ).toBe('invalid_input');
  });
});
