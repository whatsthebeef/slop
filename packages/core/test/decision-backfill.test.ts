import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { backfillBoard, backfillDecisionGlobs, BACKFILL_BATCH } from '../src/app/decision-backfill.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { decisionOf, isArchivedDecision } from '../src/domain/decision-glob.js';
import { UNPROCESSED } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const NOW = '2026-10-20T12:00:00.000Z';
const day = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

describe('decision backfill', () => {
  let store: MemoryStore;
  let boardId: number;
  let workId: string;
  let boards: BoardService;
  let nextItem = 1;
  const clock = { now: () => NOW };

  const kbItem = (patch: Partial<KbItem>): KbItem => {
    const n = nextItem++;
    return {
      id: `s${boardId}k${n}`,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: `Statement ${n}`,
      evidence: 'Evidence',
      suggestedTarget: null,
      sourceGlobIds: [],
      source: 'submitted',
      signal: null,
      agentSetVersion: null,
      submittedBy: 'dev@example.com',
      createdAt: day(NOW, -5),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      version: 1,
      ...patch,
    };
  };
  const insert = async (item: KbItem) => {
    await store.transaction(async (tx) => {
      if (!(await tx.insertKbItem(item))) throw new Error('duplicate item');
    });
    return item;
  };
  const decisionsOf = (): Promise<Glob[]> => store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions' }));
  const byKey = (key: string) => store.transaction((tx) => tx.findGlobByCreationKey(boardId, key));
  const need = (glob: Glob | null): Glob => {
    if (glob === null) throw new Error('No glob');
    return glob;
  };
  const extracted = (patch: { decidedAt: string; sourceKind: 'inbox' | 'kb_item' | 'plan'; globId: string | null; ref: string }) =>
    store.transaction((tx) =>
      tx.upsertDecision({
        boardId,
        itemId: nextItem++,
        globId: patch.globId,
        group: null,
        statement: `Extracted ${patch.ref}`,
        quote: 'The quote',
        decidedBy: 'dev@example.com',
        decidedAt: patch.decidedAt,
        sourceKind: patch.sourceKind,
        sourceRef: patch.ref,
        sourceLabel: 'A meeting',
        sourceUrl: null,
        createdAt: patch.decidedAt,
      }),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    nextItem = 1;
    const notifier = new RecordingNotifier();
    boards = new BoardService({ store, notifier });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: ADMIN, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    const globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    workId = unwrap(await globs.create(ADMIN, { boardId, title: 'Work', summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null })).id;
  });

  it('gives open items a Planning glob, decided items a signed-off one, and leaves older and pipeline-closed items alone', async () => {
    const open = await insert(kbItem({}));
    const approved = await insert(kbItem({ status: 'approved', decidedBy: 'admin@example.com', decidedAt: day(NOW, -3), outcome: { kind: 'learning' } }));
    const rejected = await insert(kbItem({ status: 'rejected', decidedBy: 'admin@example.com', decidedAt: day(NOW, -2), decisionReason: 'No' }));
    const old = await insert(kbItem({ status: 'approved', decidedBy: 'admin@example.com', decidedAt: day(NOW, -40), outcome: { kind: 'learning' } }));
    const covered = await insert(kbItem({ status: 'covered' }));
    const merged = await insert(kbItem({ status: 'merged', duplicateOf: open.id }));

    const counts = await backfillBoard(store, clock, boardId);
    expect(counts).toEqual({ open: 1, decided: 2, extracted: 0, skipped: 0 });

    expect(await byKey(`kb:${old.id}`)).toBeNull();
    expect(await byKey(`kb:${covered.id}`)).toBeNull();
    expect(await byKey(`kb:${merged.id}`)).toBeNull();

    const planning = await byKey(`kb:${open.id}`);
    expect(planning).toMatchObject({ category: 'decision', status: 'planning', createdAt: open.createdAt, signedOffAt: null, doingSince: null, title: open.statement });
    expect(decisionOf(need(planning))).toMatchObject({ channel: 'migration', kbItemId: open.id, outcome: null, scope: { kind: 'future_work', ref: null } });
    // Assessments are written on demand, not in a burst at migration.
    expect(await store.transaction((tx) => tx.artifactVersions(planning?.id ?? '', 'assessment', ''))).toEqual([]);
    expect((await store.transaction((tx) => tx.artifactVersions(planning?.id ?? '', 'plan', ''))).map((a) => [a.version, a.provenance.by])).toEqual([[1, 'backfill']]);

    const done = await byKey(`kb:${approved.id}`);
    expect(done).toMatchObject({ status: 'signed_off', signedOffAt: approved.decidedAt, doingSince: null });
    expect(decisionOf(need(done))?.outcome).toMatchObject({ kind: 'accept', by: 'admin@example.com', at: approved.decidedAt });
    expect(isArchivedDecision(need(done))).toBe(false);

    const refused = await byKey(`kb:${rejected.id}`);
    expect(refused).toMatchObject({ status: 'signed_off', signedOffAt: rejected.decidedAt });
    expect(isArchivedDecision(need(refused))).toBe(true);
    expect(decisionOf(need(refused))?.outcome).toMatchObject({ kind: 'reject', reason: 'No' });

    // The items now point at their globs, and the work listing is unchanged.
    expect((await store.transaction((tx) => tx.getKbItem(open.id)))?.decisionGlobId).toBe(planning?.id);
    expect((await store.transaction((tx) => tx.listGlobs(boardId, {}))).map((g) => g.id)).toEqual([workId]);
  });

  it('keeps the original dates on the events, so reports and aging are not skewed', async () => {
    const approved = await insert(kbItem({ status: 'approved', decidedBy: 'admin@example.com', decidedAt: day(NOW, -3), outcome: { kind: 'learning' } }));
    await backfillBoard(store, clock, boardId);
    const glob = await byKey(`kb:${approved.id}`);
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z'));
    const mine = events.filter((e) => e.globId === glob?.id).map((e) => [e.type, e.at, e.actor]);
    expect(mine).toEqual([
      ['GlobCreated', approved.createdAt, 'slop'],
      ['ArtifactAdded', approved.createdAt, 'slop'],
      ['StatusChanged', approved.decidedAt, null],
      ['DecisionDecided', approved.decidedAt, null],
    ]);
  });

  it('migrates recent extracted decisions that came from a glob or inbox item, scoped to their glob or the project', async () => {
    const fromGlob = await extracted({ decidedAt: day(NOW, -4), sourceKind: 'plan', globId: workId, ref: 'plan:1' });
    const fromInbox = await extracted({ decidedAt: day(NOW, -6), sourceKind: 'inbox', globId: null, ref: 'inbox:2' });
    const fromKb = await extracted({ decidedAt: day(NOW, -1), sourceKind: 'kb_item', globId: null, ref: 'learning:1' });
    const stale = await extracted({ decidedAt: day(NOW, -45), sourceKind: 'plan', globId: workId, ref: 'plan:3' });
    const replaced = await extracted({ decidedAt: day(NOW, -2), sourceKind: 'plan', globId: workId, ref: 'plan:4' });
    await store.transaction((tx) => tx.updateDecision(replaced.id, { replacedBy: fromGlob.id }));
    const gone = await extracted({ decidedAt: day(NOW, -2), sourceKind: 'plan', globId: 's1t99', ref: 'plan:5' });

    const counts = await backfillBoard(store, clock, boardId);
    expect(counts).toEqual({ open: 0, decided: 0, extracted: 2, skipped: 1 });
    for (const skipped of [fromKb, stale, replaced, gone]) expect(await byKey(`decision:${String(skipped.id)}`)).toBeNull();

    const a = await byKey(`decision:${String(fromGlob.id)}`);
    expect(a).toMatchObject({ status: 'signed_off', signedOffAt: fromGlob.decidedAt, createdAt: fromGlob.decidedAt, title: 'Extracted plan:1' });
    expect(decisionOf(need(a))).toMatchObject({
      scope: { kind: 'glob', ref: workId },
      source: { kind: 'extracted', decisionId: fromGlob.id },
      channel: 'migration',
      outcome: { kind: 'accept', by: 'dev@example.com' },
    });
    const b = await byKey(`decision:${String(fromInbox.id)}`);
    expect(decisionOf(need(b))?.scope).toEqual({ kind: 'project', ref: null });
  });

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    await insert(kbItem({}));
    await insert(kbItem({ status: 'rejected', decidedBy: 'admin@example.com', decidedAt: day(NOW, -2), decisionReason: 'No' }));
    await extracted({ decidedAt: day(NOW, -4), sourceKind: 'inbox', globId: null, ref: 'inbox:2' });
    const first = await backfillDecisionGlobs(store, clock);
    expect(first).toEqual({ open: 1, decided: 1, extracted: 1, skipped: 0, boards: 1 });
    const before = await decisionsOf();
    const events = (await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z'))).length;
    const second = await backfillDecisionGlobs(store, clock);
    expect(second).toEqual({ open: 0, decided: 0, extracted: 0, skipped: 3, boards: 1 });
    expect(await decisionsOf()).toEqual(before);
    expect((await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z'))).length).toBe(events);
  });

  it('links an item whose glob exists but whose link is missing (a run that stopped halfway)', async () => {
    const open = await insert(kbItem({}));
    await backfillBoard(store, clock, boardId);
    const glob = await byKey(`kb:${open.id}`);
    await store.transaction(async (tx) => {
      const current = await tx.getKbItem(open.id);
      if (current === null) throw new Error('missing');
      await tx.updateKbItem({ ...current, decisionGlobId: null, version: current.version + 1 }, current.version);
    });
    await backfillBoard(store, clock, boardId);
    expect((await store.transaction((tx) => tx.getKbItem(open.id)))?.decisionGlobId).toBe(glob?.id);
    expect(await decisionsOf()).toHaveLength(1);
  });

  it('works through more items than one batch', async () => {
    for (let i = 0; i < BACKFILL_BATCH + 5; i++) await insert(kbItem({}));
    expect((await backfillBoard(store, clock, boardId)).open).toBe(BACKFILL_BATCH + 5);
    expect(await decisionsOf()).toHaveLength(BACKFILL_BATCH + 5);
  });

  it('covers every board', async () => {
    const other = unwrap(await boards.create(ADMIN, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    await insert(kbItem({}));
    await store.transaction(async (tx) => {
      await tx.insertKbItem({ ...kbItem({ boardId: other }), id: `s${other}k1`, boardId: other });
    });
    expect(await backfillDecisionGlobs(store, clock)).toMatchObject({ open: 2, boards: 2 });
  });
});
