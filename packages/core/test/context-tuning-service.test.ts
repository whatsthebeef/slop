import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { ContextTuningService } from '../src/app/context-tuning-service.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { DEFAULT_CONTEXT_SETTINGS } from '../src/domain/context-settings.js';
import type { Decision, DecisionSourceKind, NewDecision } from '../src/domain/decisions.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const errorCode = (result: Result<unknown>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-12T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysFrom = (at: string, days: number): string => new Date(Date.parse(at) + days * DAY).toISOString();

describe('ContextTuningService', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: ContextTuningService;
  let clockNow: string;
  let boardId: number;
  let nextItem: number;
  let nextGlob: number;

  const choice = async (kind: DecisionSourceKind, patch: Partial<NewDecision> = {}): Promise<Decision> => {
    const input: NewDecision = {
      boardId,
      itemId: nextItem++,
      globId: null,
      group: null,
      statement: `Choice number ${String(nextItem)} about the shared retry helper`,
      quote: 'q',
      decidedBy: null,
      decidedAt: daysFrom(NOW, -200),
      sourceKind: kind,
      sourceRef: `ref:${String(nextItem)}`,
      sourceLabel: 'label',
      sourceUrl: null,
      createdAt: daysFrom(NOW, -20),
      ...patch,
    };
    return store.transaction((tx) => tx.upsertDecision(input));
  };

  const decisionGlob = async (attributes: DecisionAttributes): Promise<void> => {
    const id = `s${String(boardId)}k${String(nextGlob++)}`;
    await store.transaction((tx) => tx.insertGlob(glob({ id, boardId, category: 'decision', status: 'signed_off', attributes }), null));
  };

  const replacementCards = async (confirmed: number, dismissed: number, at: string): Promise<void> => {
    for (let i = 0; i < confirmed + dismissed; i++) {
      await decisionGlob({
        scope: { kind: 'project', ref: null },
        origin: { kind: 'replacement', oldId: 1000 + i, newId: 2000 + i },
        channel: 'mined',
        outcome: { kind: i < confirmed ? 'accept' : 'reject', by: ADMIN, at },
      });
    }
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    clockNow = NOW;
    nextItem = 1;
    nextGlob = 1;
    service = new ContextTuningService({ store, clock: { now: () => clockNow }, notifier });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('moves nothing and records nothing without evidence', async () => {
    expect(await service.tune(boardId, NOW)).toEqual({ kind: 'context_tuning', moves: [], held: 6 });
    expect(unwrap(await service.view(ADMIN, boardId)).history).toEqual([]);
  });

  it('moves a setting one step on enough evidence, records the change and tells the board', async () => {
    await replacementCards(4, 1, daysFrom(NOW, -2));
    const result = await service.tune(boardId, NOW);
    expect(result).toEqual({
      kind: 'context_tuning',
      moves: [{ key: 'replacement_similarity', before: 0.75, after: 0.725, outcome: 'replacements_confirmed' }],
      held: 5,
    });
    expect((await store.transaction((tx) => tx.getContextSettings(boardId))).replacement_similarity).toBe(0.725);
    const [row] = unwrap(await service.view(DEV, boardId)).history;
    expect(row).toMatchObject({ boardId, key: 'replacement_similarity', before: 0.75, after: 0.725, outcome: 'replacements_confirmed', at: NOW });
    expect(row?.evidence).toContain('4 of 5 proposed replacements confirmed');
    expect(notifier.hints).toContainEqual({ kind: 'board.changed', boardId });
  });

  it('does not move the same setting again on the same evidence, nor within 7 days, but does on new evidence after 7', async () => {
    await replacementCards(5, 0, daysFrom(NOW, -2));
    expect((await service.tune(boardId, NOW)).moves).toHaveLength(1);
    expect((await service.tune(boardId, daysFrom(NOW, 7))).moves).toEqual([]);
    // Fresh decisions inside the first week: the setting is still held back until a week has passed.
    await replacementCards(5, 0, daysFrom(NOW, 3));
    expect((await service.tune(boardId, daysFrom(NOW, 6))).moves).toEqual([]);
    const later = await service.tune(boardId, daysFrom(NOW, 8));
    expect(later.moves).toEqual([{ key: 'replacement_similarity', before: 0.725, after: 0.7, outcome: 'replacements_confirmed' }]);
    expect(unwrap(await service.view(ADMIN, boardId)).history.map((h) => h.after)).toEqual([0.7, 0.725]);
  });

  it('reads choices, promotions and usage from the board: discussion choices replaced often lower the weight', async () => {
    for (let i = 0; i < 10; i++) {
      const d = await choice('inbox');
      if (i < 6) await store.transaction((tx) => tx.updateDecision(d.id, { replaceState: 'applied', replacedBy: d.id + 1 }));
      const r = await choice('implementation_plan');
      if (i < 1) await store.transaction((tx) => tx.updateDecision(r.id, { replaceState: 'confirmed', replacedBy: r.id + 1 }));
    }
    const result = await service.tune(boardId, NOW);
    expect(result.moves).toEqual([{ key: 'discussion_weight', before: 0.6, after: 0.55, outcome: 'discussion_replaced_often' }]);
  });

  it('reads decided promotions of choices in use, by the choice’s source', async () => {
    const outcome = (kind: 'accept' | 'reject') => ({ kind, by: ADMIN, at: daysFrom(NOW, -1) });
    for (let i = 0; i < 6; i++) {
      const d = await choice('inbox');
      await decisionGlob({
        scope: { kind: 'project', ref: null },
        origin: { kind: 'mined' },
        channel: 'mined',
        outcome: outcome('reject'),
        signal: {
          key: `choice_in_use:${String(d.id)}`,
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
    }
    const result = await service.tune(boardId, NOW);
    expect(result.moves).toEqual([{ key: 'promotion_discussion_min_returns', before: 10, after: 11, outcome: 'promotions_rejected' }]);
  });

  it('counts retrievals of old choices that the implementation record names or does not', async () => {
    const day = daysFrom(NOW, -3).slice(0, 10);
    for (let i = 0; i < 4; i++) {
      const d = await choice('plan', { statement: `Always wrap outbound calls in the retry helper ${String(i)}` });
      const globId = `s${String(boardId)}t${String(i + 1)}`;
      await store.transaction(async (tx) => {
        await tx.recordChoiceUsage(boardId, [d.itemId], globId, day);
        for (let n = 0; n < 2; n++) await tx.recordChoiceUsage(boardId, [d.itemId], globId, day);
        // Three of the four records name the choice, by title or id.
        await tx.insertArtifact({
          globId,
          kind: 'implementation_plan',
          label: '',
          content: i === 0 ? 'Nothing about it.' : i === 1 ? `Followed choice ${String(d.id)}.` : `We always wrap outbound calls in the retry helper ${String(i)}.`,
          link: null,
          commitSha: null,
          provenance: { by: 'routine', actor: 'x', runId: null, agentSetVersion: null },
          createdAt: NOW,
        });
      });
    }
    // 4 choices x 3 returns = 12 retrievals; 9 cited (75%): the half-life lengthens.
    const result = await service.tune(boardId, NOW);
    expect(result.moves).toEqual([{ key: 'recency_half_life_days', before: 90, after: 105, outcome: 'old_choices_cited' }]);
  });

  it('reads inbox attaches against what was suggested', async () => {
    for (let i = 0; i < 5; i++) {
      const { item } = await store.transaction((tx) =>
        tx.insertInboxItem({
          boardId,
          title: `t${String(i)}`,
          text: `text ${String(i)}`,
          source: 'paste',
          sourceRef: '',
          sourceLabel: '',
          sourceType: 'doc',
          occurredAt: NOW,
          createdAt: NOW,
          createdBy: DEV,
          contentHash: `h${String(i)}`,
        }),
      );
      await store.transaction(async (tx) => {
        await tx.updateInboxItem({ ...item, suggestions: [{ globId: 's1t1', reason: 'r' }], version: item.version + 1 }, item.version);
        await tx.insertInboxLink({ inboxId: item.id, globId: 's1t9', artifactId: null, linkedBy: DEV, linkedAt: daysFrom(NOW, -1) });
      });
    }
    expect((await service.tune(boardId, NOW)).moves).toEqual([{ key: 'inbox_candidates', before: 8, after: 9, outcome: 'attached_to_unsuggested' }]);
  });

  it('views every setting with its default, bounds, effect and current value', async () => {
    await replacementCards(5, 0, daysFrom(NOW, -2));
    await service.tune(boardId, NOW);
    const view = unwrap(await service.view(DEV, boardId));
    expect(view.settings).toHaveLength(16);
    expect(view.settings.find((s) => s.key === 'replacement_similarity')).toMatchObject({
      value: 0.725,
      default: 0.75,
      min: 0.6,
      max: 0.9,
      learned: true,
      label: 'Replacement similarity',
    });
    expect(view.settings.find((s) => s.key === 'replacement_similarity')?.effect).not.toBe('');
    expect(view.settings.find((s) => s.key === 'discussion_weight')?.value).toBe(DEFAULT_CONTEXT_SETTINGS.discussion_weight);
    expect(errorCode(await service.view('stranger@example.com', boardId))).toBe('forbidden');
  });

  it('lets admins reset a setting to its default and files the reset', async () => {
    await replacementCards(5, 0, daysFrom(NOW, -2));
    await service.tune(boardId, NOW);
    clockNow = daysFrom(NOW, 1);
    const view = unwrap(await service.reset(ADMIN, boardId, 'replacement_similarity'));
    expect(view.settings.find((s) => s.key === 'replacement_similarity')?.value).toBe(0.75);
    expect(view.history[0]).toMatchObject({ key: 'replacement_similarity', before: 0.725, after: 0.75, outcome: 'reset', at: clockNow });
    expect(view.history).toHaveLength(2);
    // A reset is a change: the setting waits 7 days before moving again.
    await replacementCards(5, 0, daysFrom(NOW, 2));
    expect((await service.tune(boardId, daysFrom(NOW, 3))).moves).toEqual([]);
  });

  it('records no reset for a setting already at its default, and refuses non-admins and unknown keys', async () => {
    const view = unwrap(await service.reset(ADMIN, boardId, 'discussion_weight'));
    expect(view.history).toEqual([]);
    expect(errorCode(await service.reset(DEV, boardId, 'discussion_weight'))).toBe('forbidden');
    expect(errorCode(await service.reset(ADMIN, boardId, 'nope'))).toBe('invalid_input');
  });
});
