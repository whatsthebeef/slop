import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { kbItems } from '../src/app/kb-items.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Glob } from '../src/domain/types.js';
import type { Catalog, Tx } from '../src/ports.js';
import { TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { drafted } from './kb-fixtures.js';

const ADMIN = 'admin@example.com';
const LATER = '2026-10-06T09:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

/** A store whose conditional glob writes to one glob lose, as if another writer got there first. */
class RacingStore extends MemoryStore {
  losing: string | null = null;
  override transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return super.transaction((tx) => {
      const losing = this.losing;
      if (losing === null) return work(tx);
      return work({
        ...tx,
        updateGlob: (next: Glob, expectedVersion: number) =>
          next.id === losing ? Promise.resolve(false) : tx.updateGlob(next, expectedVersion),
      });
    });
  }
}

describe('reopening a merge (s15t72)', () => {
  let store: RacingStore;
  let knowledge: KnowledgeService;
  let boardId: number;

  const item = async (id: string) => {
    const found = await store.transaction((tx) => kbItems(tx).getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };

  beforeEach(async () => {
    store = new RacingStore();
    const notifier = new RecordingNotifier();
    knowledge = new KnowledgeService({ store, clock: { now: () => LATER }, catalog, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(
      await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    ).id;
    await store.transaction(async (tx) => {
      const kb = kbItems(tx, TEST_KB_WRITES);
      if (!(await kb.insertKbItem(drafted({ id: `s${String(boardId)}k1`, boardId }))))
        throw new Error('survivor not inserted');
      const merged = drafted({
        id: `s${String(boardId)}k2`,
        boardId,
        status: 'merged',
        processing: 'none',
        duplicateOf: `s${String(boardId)}k1`,
        mergeNote: { by: 'intake', quote: 'a', survivorQuote: 'b', at: LATER },
      });
      if (!(await kb.insertKbItem(merged))) throw new Error('merged not inserted');
    });
  });

  it('keeps the pair apart on both learnings', async () => {
    const survivor = `s${String(boardId)}k1`;
    const loser = `s${String(boardId)}k2`;
    const reopened = unwrap(await knowledge.reopen(ADMIN, loser, (await item(loser)).version));
    expect(reopened).toMatchObject({ status: 'open', duplicateOf: null, mergeNote: null, keptApartFrom: [survivor] });
    expect((await item(survivor)).keptApartFrom).toEqual([loser]);
  });

  it("rolls the reopen back as a version conflict when the other learning's write loses", async () => {
    const survivor = `s${String(boardId)}k1`;
    const loser = `s${String(boardId)}k2`;
    const before = await item(loser);
    const survivorBefore = await item(survivor);
    const outboxBefore = store.state.outbox.length;
    store.losing = survivor;
    const result = await knowledge.reopen(ADMIN, loser, before.version);
    store.losing = null;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('version_conflict');
    // The conflict carries the learning as it still is: the reopen was rolled back with the transaction.
    expect(result.error).toMatchObject({ currentItem: { id: loser, status: 'merged', duplicateOf: survivor, version: before.version } });
    expect(await item(loser)).toEqual(before);
    expect(await item(survivor)).toEqual(survivorBefore);
    expect(store.state.outbox).toHaveLength(outboxBefore);
  });
});
