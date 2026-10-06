import { readFile } from 'node:fs/promises';
import { KnowledgeService } from '@slop/core';
import type { CatalogAgentSet, KnowledgeDoc, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsCatalog, hashAgentSet } from '../src/catalog.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('catalog agent-set hash', () => {
  it('is stable, order-independent and ignores files that are not delivered', () => {
    const files = [
      { path: 'agents/a.md', content: 'A' },
      { path: 'settings.json', content: '{}' },
    ];
    const hash = hashAgentSet(files);
    expect(hashAgentSet([...files].reverse())).toBe(hash);
    expect(hashAgentSet([...files, { path: 'README.md', content: 'docs' }])).toBe(hash);
    expect(hashAgentSet([{ path: 'agents/a.md', content: 'B' }, { path: 'settings.json', content: '{}' }])).not.toBe(hash);
  });

  it('reads the repo catalog with its hash', async () => {
    const set = await new FsCatalog(new URL('../../../catalog', import.meta.url).pathname).agentSet();
    expect(set.files.map((f) => f.path)).toContain('agents/orchestrator.md');
    expect(set.hash).toBe(hashAgentSet(set.files));
  });
});

describe('layered agent set in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let catalogSet: CatalogAgentSet;
  let knowledge: KnowledgeService;

  const doc = (patch: Partial<KnowledgeDoc>): KnowledgeDoc => ({
    boardId,
    kind: 'agent',
    name: 'agents/tester.md',
    area: null,
    audience: [],
    description: '',
    content: '',
    layer: 'overlay',
    version: 1,
    source: 'edit',
    updatedBy: ADMIN,
    updatedAt: new Date().toISOString(),
    ...patch,
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('agent_set'));
    store = new PgStore(database.db);
    catalogSet = { hash: 'h1', files: [{ path: 'agents/tester.md', content: '# Tester\n' }] };
    knowledge = new KnowledgeService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve(catalogSet) },
    });
    boardId = await store.transaction(async (tx) => {
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
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('round-trips the layer, and keeps it in history', async () => {
    await store.transaction((tx) => tx.saveKnowledge(doc({ content: '- rule one' })));
    await store.transaction((tx) => tx.saveKnowledge(doc({ layer: 'file', content: 'Whole file', version: 2 })));
    expect(await store.transaction((tx) => tx.getKnowledge(boardId, 'agent', 'agents/tester.md'))).toMatchObject({
      layer: 'file',
      content: 'Whole file',
    });
    const history = await database.db.execute(
      sql`select layer, version from knowledge_history where board_id = ${boardId} and name = 'agents/tester.md'`,
    );
    expect(history.map((r) => [r.layer, r.version])).toEqual([['overlay', 1]]);
  });

  it('records the catalog hash on the board and bumps the version only when it changes', async () => {
    const before = await store.transaction((tx) => tx.getBoard(boardId));
    expect(before?.agentCatalogHash).toBeNull();
    expect(await knowledge.syncCatalogAgentSet()).toContain(boardId);
    expect(await store.transaction((tx) => tx.getBoard(boardId))).toMatchObject({
      agentCatalogHash: 'h1',
      agentSetVersion: (before?.agentSetVersion ?? 0) + 1,
    });
    expect(await knowledge.syncCatalogAgentSet()).not.toContain(boardId);
    catalogSet = { ...catalogSet, hash: 'h2' };
    expect(await knowledge.syncCatalogAgentSet()).toContain(boardId);
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.agentSetVersion).toBe((before?.agentSetVersion ?? 0) + 2);
  });

  it('migration 0012 turns unedited catalog copies into empty overlays and leaves edited files alone', async () => {
    await store.transaction(async (tx) => {
      await tx.saveKnowledge(doc({ name: 'agents/copy.md', layer: 'file', content: 'Catalog copy', source: 'catalog:agents' }));
      await tx.saveKnowledge(doc({ name: 'agents/edited.md', layer: 'file', content: 'Edited', source: 'kb:s1k1' }));
      await tx.saveKnowledge(doc({ kind: 'doc', name: 'build', layer: 'file', content: 'Doc', source: 'catalog:agents' }));
    });
    // Re-running the migration's statements also shows it is idempotent.
    const migration = await readFile(new URL('../drizzle/0012_agent_layers.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await database.db.execute(sql.raw(statement));
    const rows = await store.transaction((tx) => tx.listKnowledge(boardId));
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('agents/copy.md')).toMatchObject({ layer: 'overlay', content: '' });
    expect(byName.get('agents/edited.md')).toMatchObject({ layer: 'file', content: 'Edited' });
    expect(byName.get('build')).toMatchObject({ layer: 'file', content: 'Doc' });
    // The board serves the catalog for the old copy (orphaned here: not in this catalog) and its own edited file.
    const served = unwrap(await knowledge.agentSet(ADMIN, boardId)).files.map((f) => f.path);
    expect(served).toEqual(['agents/edited.md', 'agents/tester.md']);
  });
});
