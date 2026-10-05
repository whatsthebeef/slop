import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
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
  agentSet: () => Promise.resolve([]),
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
