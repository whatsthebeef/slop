import { GlobService, KnowledgeService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

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
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'empty', files: [] }) },
    });
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
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
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
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
      document: null,
      outcome: null,
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

  it('writes a decision only against the version it read', async () => {
    const { id } = unwrap(await submit('Prefer small commits'));
    const item = await store.transaction((tx) => tx.getKbItem(id));
    if (item === null) throw new Error(`KB item ${id} was not stored`);
    const decided = {
      ...item,
      status: 'rejected' as const,
      decidedBy: ADMIN,
      decidedAt: '2026-10-06T09:00:00.000Z',
      decisionReason: 'Too vague',
      version: 2,
    };
    expect(await store.transaction((tx) => tx.updateKbItem(decided, 2))).toBe(false);
    expect(await store.transaction((tx) => tx.updateKbItem(decided, 1))).toBe(true);
    expect(await store.transaction((tx) => tx.getKbItem(id))).toEqual(decided);
    expect(await store.transaction((tx) => tx.updateKbItem({ ...decided, version: 3 }, 1))).toBe(false);
    expect((await store.transaction((tx) => tx.listKbItems(boardId, 'rejected'))).map((i) => i.id)).toContain(id);
  });

  it('round-trips a document proposal and its applied outcome', async () => {
    const document = {
      name: 'architecture',
      area: 'architecture',
      audience: ['investigator'],
      description: 'How the code is laid out',
      content: '# Architecture\n',
    };
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: null,
        type: 'pattern',
        statement: 'New document: architecture',
        evidence: 'README.md',
        document,
      }),
    );
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({ document, sourceGlobIds: [], outcome: null });
    const approved = unwrap(await knowledge.approve(ADMIN, id, 1, { as: 'document' }));
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'doc', name: 'architecture', version: 1 });
    expect(await store.transaction((tx) => tx.getKbItem(id))).toEqual(approved);
    expect(await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'architecture'))).toMatchObject({
      area: 'architecture',
      audience: ['investigator'],
      content: '# Architecture\n',
      source: `kb:${id}`,
    });
  });

  it('bumps the agent-set version when an agent file edit is approved', async () => {
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'agent',
        name: 'agents/tester.md',
        area: null,
        audience: [],
        description: '',
        content: 'Test it.\n',
        layer: 'file',
        version: 1,
        source: 'catalog:agents',
        updatedBy: ADMIN,
        updatedAt: new Date().toISOString(),
      }),
    );
    const before = (await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion ?? 0;
    const { id } = unwrap(await submit('Run the server tests against Postgres'));
    const approved = unwrap(
      await knowledge.approve(ADMIN, id, 1, {
        as: 'edit',
        target: { kind: 'agent', name: 'agents/tester.md' },
        content: 'Test it against Postgres.\n',
      }),
    );
    expect(approved.outcome).toEqual({ kind: 'applied', target: 'agent', name: 'agents/tester.md', version: 2 });
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion).toBe(before + 1);
  });

  it('lets one of two concurrent decisions win; the other gets a version conflict and writes nothing', async () => {
    const { id } = unwrap(await submit('Keep migrations additive'));
    const results = await Promise.all([
      knowledge.approve(ADMIN, id, 1, { as: 'learning' }),
      knowledge.reject(ADMIN, id, 1, 'Duplicate'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => (r.ok ? [] : [r.error.code]))).toEqual(['version_conflict']);
    expect((await store.transaction((tx) => tx.getKbItem(id)))?.version).toBe(2);
  });

  it('turns racing agent-file approvals into version conflicts, never a server error', async () => {
    const files = ['agents/a.md', 'agents/b.md', 'agents/c.md'];
    await store.transaction(async (tx) => {
      for (const name of files) {
        await tx.saveKnowledge({
          boardId,
          kind: 'agent',
          name,
          area: null,
          audience: [],
          description: '',
          content: 'Old.\n',
          layer: 'file',
          version: 1,
          source: 'catalog:agents',
          updatedBy: ADMIN,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    const before = (await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion ?? 0;
    const ids = await Promise.all(files.map(async (f) => unwrap(await submit(`Change ${f}`)).id));
    const results = await Promise.all(
      ids.map((id, i) =>
        knowledge.approve(ADMIN, id, 1, { as: 'edit', target: { kind: 'agent', name: files[i] ?? '' }, content: 'New.\n' }),
      ),
    );
    expect(results.flatMap((r) => (r.ok ? [] : [r.error.code])).every((c) => c === 'version_conflict')).toBe(true);
    const approved = results.filter((r) => r.ok).length;
    expect(approved).toBeGreaterThan(0);
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion).toBe(before + approved);
    // A losing approval wrote nothing: its file is unchanged and its item still open.
    for (const [i, r] of results.entries()) {
      if (r.ok) continue;
      expect((await store.transaction((tx) => tx.getKnowledge(boardId, 'agent', files[i] ?? '')))?.content).toBe('Old.\n');
      expect((await store.transaction((tx) => tx.getKbItem(ids[i] ?? '')))?.status).toBe('open');
    }
  });
});
