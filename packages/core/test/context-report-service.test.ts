import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { ContextReportService } from '../src/app/context-report-service.js';
import { ContextTuningService } from '../src/app/context-tuning-service.js';
import { SearchService } from '../src/app/search-service.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { countShares, shareOf, sharesOf } from '../src/domain/context-report.js';
import type { NewDecision } from '../src/domain/decisions.js';
import type { Result } from '../src/domain/errors.js';
import type { SearchHit } from '../src/domain/search.js';
import { FakeEmbedder } from '../src/testing/fake-embedder.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'out@example.com';
const NOW = '2026-10-12T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysFrom = (at: string, days: number): string => new Date(Date.parse(at) + days * DAY).toISOString();

describe('context report helpers', () => {
  it('shares are 0 with nothing to share and sort largest first', () => {
    expect(shareOf(1, 0)).toBe(0);
    expect(shareOf(1, 4)).toBe(0.25);
    expect(countShares(['b', 'a', 'a'])).toEqual([
      { key: 'a', count: 2, share: 2 / 3 },
      { key: 'b', count: 1, share: 1 / 3 },
    ]);
    expect(sharesOf(new Map())).toEqual([]);
  });
});

describe('ContextReportService', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let report: ContextReportService;
  let boardId: number;
  let nextItem: number;

  const choice = async (patch: Partial<NewDecision> = {}) => {
    const input: NewDecision = {
      boardId,
      itemId: nextItem++,
      globId: null,
      group: null,
      statement: `Choice ${String(nextItem)}\nsecond line`,
      quote: 'q',
      decidedBy: null,
      decidedAt: daysFrom(NOW, -100),
      sourceKind: 'plan',
      sourceRef: `ref:${String(nextItem)}`,
      sourceLabel: 'label',
      sourceUrl: null,
      createdAt: daysFrom(NOW, -20),
      ...patch,
    };
    return store.transaction((tx) => tx.upsertDecision(input));
  };

  const decisionGlob = (id: string, attributes: DecisionAttributes) =>
    store.transaction((tx) => tx.insertGlob(glob({ id, boardId, title: id, category: 'decision', status: 'signed_off', createdAt: daysFrom(NOW, -3), attributes }), null));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    nextItem = 1;
    const tuning = new ContextTuningService({ store, clock: { now: () => NOW }, notifier });
    report = new ContextReportService({ store, clock: { now: () => NOW }, tuning });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('is for members only', async () => {
    const result = await report.report(OUTSIDER, boardId);
    expect(result.ok ? null : result.error.code).toBe('forbidden');
  });

  it('is empty on a new board and still lists the settings', async () => {
    const empty = unwrap(await report.report(DEV, boardId));
    expect(empty).toMatchObject({
      windowDays: 30,
      retrievals: { total: 0, bySource: [], byTier: [] },
      topRetrieved: [],
      choices: { total: 0, newThisWeek: 0, replaced: { autoApplied: 0, confirmed: 0, undone: 0, unverifiedOpen: 0 } },
      inbox: { attachedViaSuggestion: 0, attachedElsewhere: 0, kept: 0, discarded: 0 },
      conflicts: [],
    });
    expect(empty.settings).toHaveLength(13);
    expect(empty.history).toEqual([]);
    expect(empty.conflictsNote).not.toBe('');
  });

  it('counts retrievals by source type and tier within 30 days, and ranks the most retrieved choices with their globs', async () => {
    await store.transaction(async (tx) => {
      await tx.recordContextRetrievals(boardId, daysFrom(NOW, -1).slice(0, 10), [
        { sourceType: 'decision', tier: 'decision', count: 6 },
        { sourceType: 'meeting', tier: 'discussion', count: 2 },
      ]);
      await tx.recordContextRetrievals(boardId, daysFrom(NOW, -2).slice(0, 10), [{ sourceType: 'decision', tier: 'decision', count: 2 }]);
      await tx.recordContextRetrievals(boardId, daysFrom(NOW, -60).slice(0, 10), [{ sourceType: 'doc', tier: 'discussion', count: 50 }]);
      await tx.insertGlob(glob({ id: 's1t1', boardId, title: 'Retry work' }), null);
    });
    const a = await choice();
    const b = await choice();
    await store.transaction(async (tx) => {
      await tx.recordChoiceUsage(boardId, [a.itemId], 's1t1', daysFrom(NOW, -1).slice(0, 10));
      await tx.recordChoiceUsage(boardId, [a.itemId], 's1t2', daysFrom(NOW, -1).slice(0, 10));
      await tx.recordChoiceUsage(boardId, [b.itemId], null, daysFrom(NOW, -1).slice(0, 10));
      await tx.recordChoiceUsage(boardId, [a.itemId], 's1t1', daysFrom(NOW, -60).slice(0, 10));
    });
    const r = unwrap(await report.report(DEV, boardId));
    expect(r.retrievals.total).toBe(10);
    expect(r.retrievals.bySource).toEqual([
      { key: 'decision', count: 8, share: 0.8 },
      { key: 'meeting', count: 2, share: 0.2 },
    ]);
    expect(r.retrievals.byTier.map((t) => t.key)).toEqual(['decision', 'discussion']);
    expect(r.topRetrieved).toEqual([
      {
        decisionId: a.id,
        statement: a.statement.split('\n')[0],
        sourceKind: 'plan',
        returns: 2,
        globs: [
          { id: 's1t1', title: 'Retry work' },
          { id: 's1t2', title: 's1t2' },
        ],
        globCount: 2,
      },
      { decisionId: b.id, statement: b.statement.split('\n')[0], sourceKind: 'plan', returns: 1, globs: [], globCount: 0 },
    ]);
  });

  it('counts choices by source, new this week and replacement states, and what people decided on promoted learnings and cards', async () => {
    await choice({ sourceKind: 'inbox', createdAt: daysFrom(NOW, -2) });
    const old = await choice({ sourceKind: 'plan' });
    const hint = await choice({ sourceKind: 'plan' });
    const undone = await choice({ sourceKind: 'plan' });
    await store.transaction(async (tx) => {
      await tx.updateDecision(old.id, { replaceState: 'applied', replacedBy: hint.id });
      await tx.updateDecision(hint.id, { replaceState: 'hint', replacedBy: undone.id });
      await tx.updateDecision(undone.id, { replaceState: 'undone', replacedBy: old.id });
    });
    const mined = (id: number, outcome: DecisionAttributes['outcome']): DecisionAttributes => ({
      scope: { kind: 'project', ref: null },
      origin: { kind: 'mined' },
      channel: 'mined',
      outcome,
      signal: {
        key: `choice_in_use:${String(id)}`,
        kind: 'choice_in_use',
        agent: null,
        label: 'l',
        window: { from: NOW, to: NOW },
        figures: { affected: 3, eligible: 3, rate: 1, count: 10 },
        globIds: [],
        examples: [],
        measuredAt: NOW,
      },
    });
    await decisionGlob('s1k1', mined(old.id, { kind: 'accept', by: ADMIN, at: daysFrom(NOW, -1) }));
    await decisionGlob('s1k2', mined(hint.id, { kind: 'reject', by: ADMIN, at: daysFrom(NOW, -1) }));
    await decisionGlob('s1k3', mined(undone.id, null));
    await decisionGlob('s1k4', {
      scope: { kind: 'project', ref: null },
      origin: { kind: 'replacement', oldId: 1, newId: 2 },
      channel: 'mined',
      outcome: { kind: 'reject', by: ADMIN, at: daysFrom(NOW, -1) },
    });
    const r = unwrap(await report.report(ADMIN, boardId));
    expect(r.choices.total).toBe(4);
    expect(r.choices.bySource).toEqual([
      { key: 'plan', count: 3, share: 0.75 },
      { key: 'inbox', count: 1, share: 0.25 },
    ]);
    expect(r.choices.newThisWeek).toBe(1);
    expect(r.choices.replaced).toEqual({ autoApplied: 1, confirmed: 0, undone: 1, unverifiedOpen: 1 });
    expect(r.choices.cards).toEqual({ confirmed: 0, dismissed: 1 });
    expect(r.choices.promoted).toEqual({ raised: 3, accepted: 1, rejected: 1 });
  });

  it('reads the inbox: attached via suggestion or elsewhere, kept and discarded', async () => {
    const add = async (n: number) =>
      (
        await store.transaction((tx) =>
          tx.insertInboxItem({ boardId, title: `t${String(n)}`, text: `x${String(n)}`, source: 'paste', sourceRef: '', sourceLabel: '', sourceType: 'doc', occurredAt: NOW, createdAt: NOW, createdBy: DEV, contentHash: `h${String(n)}` }),
        )
      ).item;
    const first = await add(1);
    const second = await add(2);
    const third = await add(3);
    const fourth = await add(4);
    await store.transaction(async (tx) => {
      await tx.updateInboxItem({ ...first, suggestions: [{ globId: 's1t1', reason: 'r' }], version: first.version + 1 }, first.version);
      await tx.insertInboxLink({ inboxId: first.id, globId: 's1t1', artifactId: null, linkedBy: DEV, linkedAt: daysFrom(NOW, -1) });
      await tx.insertInboxLink({ inboxId: first.id, globId: 's1t2', artifactId: null, linkedBy: DEV, linkedAt: daysFrom(NOW, -1) });
      await tx.updateInboxItem({ ...second, status: 'kept', version: second.version + 1 }, second.version);
      await tx.updateInboxItem({ ...third, status: 'discarded', version: third.version + 1 }, third.version);
      await tx.updateInboxItem({ ...fourth, status: 'discarded', version: fourth.version + 1 }, fourth.version);
    });
    const r = unwrap(await report.report(DEV, boardId));
    expect(r.inbox).toEqual({ attachedViaSuggestion: 1, attachedElsewhere: 1, kept: 1, discarded: 2 });
  });

  it('lists a moved setting with its history', async () => {
    await store.transaction((tx) => tx.setContextSetting(boardId, 'inbox_candidates', 10, NOW));
    const tuning = new ContextTuningService({ store, clock: { now: () => NOW }, notifier });
    unwrap(await tuning.reset(ADMIN, boardId, 'inbox_candidates'));
    const r = unwrap(await report.report(DEV, boardId));
    expect(r.settings.find((s) => s.key === 'inbox_candidates')?.value).toBe(8);
    expect(r.history).toMatchObject([{ key: 'inbox_candidates', outcome: 'reset' }]);
  });
});

describe('SearchService.recordUse', () => {
  it('counts the hits by source type and tier for the report', async () => {
    const store = new MemoryStore();
    const search = new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() });
    const hit = (itemId: number, source: SearchHit['citation']['source'], authority: SearchHit['authority']): SearchHit => ({
      itemId,
      header: 'h',
      text: 't',
      score: 1,
      citation: { source, date: NOW, title: 't', link: null, globId: null },
      status: 'active',
      authority,
      supersededBy: null,
      label: null,
    });
    await store.transaction(async (tx) => {
      await search.recordUse(tx, 1, [hit(1, 'decision', 'decision'), hit(2, 'decision', 'decision'), hit(3, 'meeting', 'discussion')], null);
      await search.recordUse(tx, 1, [hit(1, 'decision', 'decision')], 'g');
      await search.recordUse(tx, 1, [], 'g');
    });
    const rows = await store.transaction((tx) => tx.listContextRetrievals(1, '2026-10-01'));
    expect(rows.sort((a, b) => a.sourceType.localeCompare(b.sourceType))).toEqual([
      { day: '2026-10-12', sourceType: 'decision', tier: 'decision', count: 3 },
      { day: '2026-10-12', sourceType: 'meeting', tier: 'discussion', count: 1 },
    ]);
    await store.transaction((tx) => tx.pruneContextRetrievals(1, '2026-10-13'));
    expect(await store.transaction((tx) => tx.listContextRetrievals(1, '2026-10-01'))).toEqual([]);
  });
});
