import { GlobService, KnowledgeService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('KB items in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let knowledge: KnowledgeService;
  let boardId: number;
  let globId: string;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb'));
    store = new PgStore(database.db);
    const deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    knowledge = new KnowledgeService({
      ...deps,
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve([]) },
    });
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Source',
        summary: '',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
  });

  afterAll(async () => {
    await drop();
  });

  const submit = (statement: string) =>
    knowledge.submitLearning(DEV, boardId, {
      sourceGlobId: globId,
      type: 'agent-behaviour',
      statement,
      evidence: 'Developer corrected the agent in the session',
      suggestedTarget: 'agents/implementer.md',
      agentSetVersion: 3,
    });

  it('round-trips a KB item through insert, get and list', async () => {
    const { id } = unwrap(await submit('Write the regression test before the fix'));
    const item = await store.transaction((tx) => tx.getKbItem(id));
    expect(item).toMatchObject({
      id,
      boardId,
      status: 'open',
      type: 'agent-behaviour',
      statement: 'Write the regression test before the fix',
      evidence: 'Developer corrected the agent in the session',
      suggestedTarget: 'agents/implementer.md',
      sourceGlobIds: [globId],
      source: 'submitted',
      agentSetVersion: 3,
      submittedBy: DEV,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      version: 1,
    });
    expect(Number.isNaN(Date.parse(item?.createdAt ?? ''))).toBe(false);
    expect(
      (await store.transaction((tx) => tx.listKbItems(boardId, 'open'))).map((i) => i.id),
    ).toContain(id);
    expect(await store.transaction((tx) => tx.listKbItems(boardId, 'rejected'))).toEqual([]);
    expect(await store.transaction((tx) => tx.getKbItem('s999k1'))).toBeNull();
  });

  it('refuses a second item with the same ID', async () => {
    const { id } = unwrap(await submit('Run the formatter on changed files only'));
    const existing = await store.transaction((tx) => tx.getKbItem(id));
    if (existing === null) throw new Error(`KB item ${id} was not stored`);
    expect(
      await store.transaction((tx) => tx.insertKbItem({ ...existing, statement: 'Another' })),
    ).toBe(false);
    expect((await store.transaction((tx) => tx.getKbItem(id)))?.statement).toBe(
      'Run the formatter on changed files only',
    );
  });

  it('hands out unique IDs to concurrent submissions', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => submit(`Learning ${String(i)}`)),
    );
    const ids = results.map((r) => unwrap(r).id);
    expect(new Set(ids).size).toBe(20);
    expect(ids.every((id) => new RegExp(`^s${String(boardId)}k\\d+$`).test(id))).toBe(true);
    const stored = (await store.transaction((tx) => tx.listKbItems(boardId))).map((i) => i.id);
    expect(ids.every((id) => stored.includes(id))).toBe(true);
  });
});
