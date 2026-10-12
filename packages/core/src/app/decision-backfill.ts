import * as machine from '../domain/machine.js';
import type { Decision } from '../domain/decisions.js';
import type { KbItem } from '../domain/kb.js';
import { defaultScope, kbItemKey, decisionGlobTitle, proposalText } from '../domain/decision-glob.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Store, Tx } from '../ports.js';
import { applyDecisionStep, createDecisionForExtracted, createDecisionInTx, DECISION_SYSTEM_ACTOR, decisionContext } from './decision-glob.js';
import { kbItems } from './kb-items.js';

/** KB items and extracted decisions decided within this many days are migrated; older ones are left as they are. */
export const BACKFILL_DAYS = 30;
/** Items per transaction. */
export const BACKFILL_BATCH = 50;

export interface BackfillCounts {
  /** Open KB items given a decision glob in Planning. */
  readonly open: number;
  /** KB items decided in the window, given a signed-off glob (rejected ones archived). */
  readonly decided: number;
  /** Extracted decisions (not from a KB item) in the window, given a signed-off glob. */
  readonly extracted: number;
  /** Items and decisions that already had a glob, or could not be migrated (their glob was deleted). */
  readonly skipped: number;
}

const SYSTEM = { email: DECISION_SYSTEM_ACTOR, role: 'dev' } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The glob that fronts a KB item, created at the item's date. An open item's glob stays in Planning (no assessment: it is
 * written on demand, to avoid a burst of writes); a decided item's ends Signed off with the item's outcome (a rejection archived).
 */
const itemGlob = async (tx: Tx, clock: Clock, item: KbItem): Promise<'created' | 'skipped'> => {
  // The item was linked to a glob that has since been deleted: the deletion sticks, the glob is not made again.
  if (item.decisionGlobId !== undefined && item.decisionGlobId !== null && (await tx.getGlob(item.decisionGlobId)) === null) {
    return 'skipped';
  }
  const created = await createDecisionInTx(tx, { clock }, {
    boardId: item.boardId,
    actor: SYSTEM,
    title: decisionGlobTitle(item.statement),
    summary: item.statement,
    payload: proposalText(item),
    attributes: { scope: defaultScope(item.type), origin: { kind: 'kb_item', id: item.id }, channel: 'migration', kbItemId: item.id, outcome: null },
    id: item.id,
    creationKey: kbItemKey(item.id),
    at: item.createdAt,
  });
  if (!created.ok) return 'skipped';
  if (created.value.created && (item.status === 'approved' || item.status === 'rejected')) {
    const by = item.decidedBy ?? DECISION_SYSTEM_ACTOR;
    const ctx = decisionContext(clock, null, item.decidedAt ?? item.createdAt);
    await applyDecisionStep(tx, created.value.glob.id, (glob) =>
      item.status === 'rejected'
        ? machine.decisionRejected(glob, { by, reason: item.decisionReason ?? '' }, ctx)
        : machine.decisionApproved(glob, { by }, ctx, 'signed_off'),
    );
  }
  await linkItem(tx, item, created.value.glob);
  return created.value.created ? 'created' : 'skipped';
};

/**
 * Stores the glob's ID on the item. The write bumps the item's version, so a reader holding the old copy can't write the
 * link back to null; when the item moved meanwhile nothing is written (the creation key still finds the glob, and the
 * next run links it).
 */
const linkItem = async (tx: Tx, item: KbItem, glob: Glob): Promise<void> => {
  if (item.decisionGlobId === glob.id) return;
  await kbItems(tx).updateKbItem({ ...item, decisionGlobId: glob.id, version: item.version + 1 }, item.version);
};

/** An extracted decision: a signed-off glob (outcome accept) at the decision's date, scoped to its glob or the project. */
const extractedDecision = async (tx: Tx, clock: Clock, decision: Decision): Promise<'created' | 'skipped'> => {
  const created = await createDecisionForExtracted(tx, { clock }, decision, SYSTEM, 'migration', decision.decidedAt);
  if (!created.ok) return 'skipped';
  if (created.value.created) {
    const ctx = decisionContext(clock, null, decision.decidedAt);
    await applyDecisionStep(tx, created.value.glob.id, (glob) => machine.decisionApproved(glob, { by: decision.decidedBy ?? DECISION_SYSTEM_ACTOR }, ctx, 'signed_off'));
  }
  return created.value.created ? 'created' : 'skipped';
};

/**
 * Gives the board's knowledge proposals and recent decisions their decision globs (idempotent: every glob is keyed on its
 * source, so a second run creates nothing). Open KB items become Planning globs; KB items decided in the last
 * `BACKFILL_DAYS` days and extracted decisions of the same age become Signed off, dated as the original so reports and aging
 * are not skewed. Decisions taken from a KB item are skipped (their item is covered). Older rows are not migrated.
 * Work is done in batches of `BACKFILL_BATCH`, one transaction each.
 */
export const backfillBoard = async (store: Store, clock: Clock, boardId: number): Promise<BackfillCounts> => {
  const cutoff = new Date(Date.parse(clock.now()) - BACKFILL_DAYS * DAY_MS).toISOString();
  const { items, decisions } = await store.transaction(async (tx) => ({
    items: await kbItems(tx).listKbItems(boardId),
    decisions: await tx.listDecisions(boardId),
  }));
  const recent = (at: string | null): boolean => at !== null && at >= cutoff;
  type Job = (tx: Tx) => Promise<'created' | 'skipped'>;
  const jobs: { kind: 'open' | 'decided' | 'extracted'; run: Job }[] = [
    ...items.filter((i) => i.status === 'open').map((item) => ({ kind: 'open' as const, run: (tx: Tx) => itemGlob(tx, clock, item) })),
    ...items
      .filter((i) => (i.status === 'approved' || i.status === 'rejected') && recent(i.decidedAt))
      .map((item) => ({ kind: 'decided' as const, run: (tx: Tx) => itemGlob(tx, clock, item) })),
    ...decisions
      .filter((d) => d.sourceKind !== 'kb_item' && d.replacedBy === null && recent(d.decidedAt))
      .map((decision) => ({ kind: 'extracted' as const, run: (tx: Tx) => extractedDecision(tx, clock, decision) })),
  ];
  const counts = { open: 0, decided: 0, extracted: 0, skipped: 0 };
  for (let start = 0; start < jobs.length; start += BACKFILL_BATCH) {
    const batch = jobs.slice(start, start + BACKFILL_BATCH);
    const outcomes = await store.transaction(async (tx) => {
      const done: ('created' | 'skipped')[] = [];
      // Sequential: a transaction holds a single connection.
      for (const job of batch) done.push(await job.run(tx));
      return done;
    });
    batch.forEach((job, index) => {
      if (outcomes[index] === 'created') counts[job.kind]++;
      else counts.skipped++;
    });
  }
  return counts;
};

/** The same for every board (what the server runs at start). */
export const backfillDecisionGlobs = async (store: Store, clock: Clock): Promise<BackfillCounts & { readonly boards: number }> => {
  const boards = await store.transaction((tx) => tx.listAllBoards());
  const total = { open: 0, decided: 0, extracted: 0, skipped: 0 };
  for (const board of boards) {
    const counts = await backfillBoard(store, clock, board.id);
    total.open += counts.open;
    total.decided += counts.decided;
    total.extracted += counts.extracted;
    total.skipped += counts.skipped;
  }
  return { ...total, boards: boards.length };
};
