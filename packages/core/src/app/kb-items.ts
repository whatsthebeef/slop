import type { Effect } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import { KB_STEP_KIND, KB_STEP_KINDS, kbEffectsFor, kbStepOf, withProcessing } from '../domain/kb.js';
import type { KbItem, KbItemStatus } from '../domain/kb.js';
import type { Hint, Tx } from '../ports.js';

/**
 * KB items as the pipeline, the Knowledge page and the services read and write them. Every caller goes through this
 * rather than the store, so where an item lives can change behind it. The pipeline's queue is the outbox: a write queues
 * the step it makes due (`kbEffectsFor`) in the same transaction, and each read takes the item's pipeline fields from its
 * next step's newest job (`withProcessing`), not from the stored item.
 */
export interface KbItems {
  getKbItem(id: string): Promise<KbItem | null>;
  /** A board's items, oldest first, optionally with one status. */
  listKbItems(boardId: number, status?: KbItemStatus): Promise<KbItem[]>;
  /** A board's newest `limit` items with one of `statuses`, newest first by decision (else submission), and how many there are. */
  listRecentKbItems(boardId: number, statuses: readonly KbItemStatus[], limit: number): Promise<{ items: KbItem[]; total: number }>;
  /** Inserts a new item and queues its first step; false if the ID already exists. */
  insertKbItem(item: KbItem): Promise<boolean>;
  /** Writes `item` if the stored version is still `expectedVersion` and queues any step the change makes due; false otherwise. */
  updateKbItem(item: KbItem, expectedVersion: number): Promise<boolean>;
  /** Queues the item's step again (an admin's Retry after it failed); the item as it reads afterwards. */
  retryStep(item: KbItem): Promise<KbItem>;
}

export const kbItems = (tx: Tx): KbItems => {
  const withJobs = async (items: readonly KbItem[]): Promise<KbItem[]> => {
    if (items.length === 0) return [];
    const jobs = await tx.latestOutboxJobs(
      items.map((i) => i.id),
      KB_STEP_KINDS,
    );
    return items.map((i) => withProcessing(i, jobs));
  };
  const one = async (item: KbItem | null): Promise<KbItem | null> => (item === null ? null : ((await withJobs([item]))[0] ?? null));
  return {
    getKbItem: async (id) => one(await tx.getKbItem(id)),
    listKbItems: async (boardId, status) => withJobs(await tx.listKbItems(boardId, status)),
    listRecentKbItems: async (boardId, statuses, limit) => {
      const page = await tx.listRecentKbItems(boardId, statuses, limit);
      return { items: await withJobs(page.items), total: page.total };
    },
    insertKbItem: async (item) => {
      if (!(await tx.insertKbItem(item))) return false;
      await tx.enqueueEffects(kbEffectsFor(null, item));
      return true;
    },
    updateKbItem: async (item, expectedVersion) => {
      const before = await tx.getKbItem(item.id);
      if (before?.version !== expectedVersion || !(await tx.updateKbItem(item, expectedVersion))) return false;
      await tx.enqueueEffects(kbEffectsFor(before, item));
      return true;
    },
    retryStep: async (item) => {
      const step = kbStepOf(item);
      if (step !== null) {
        const effect: Effect = { kind: KB_STEP_KIND[step], globId: item.id };
        await tx.enqueueEffects([effect]);
      }
      return (await one(item)) ?? item;
    },
  };
};

/**
 * The live hint for a pipeline job the outbox settled (failed, retrying, or waiting with a new reason): the board's
 * Knowledge page refetches. Null for any other effect.
 */
export const kbJobHint = (effect: Effect): Hint | null => {
  if (effect.kind !== 'kb_route' && effect.kind !== 'kb_draft') return null;
  const parsed = parseId(effect.globId);
  return parsed === null ? null : { kind: 'board.kb', boardId: parsed.boardId };
};
