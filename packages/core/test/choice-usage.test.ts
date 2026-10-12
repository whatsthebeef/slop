import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { ChatService } from '../src/app/chat-service.js';
import { DecisionService } from '../src/app/decision-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { MiningService } from '../src/app/mining-service.js';
import { SearchService } from '../src/app/search-service.js';
import {
  CHOICE_DISCUSSION_MIN_RETURNS,
  CHOICE_MIN_GLOBS,
  CHOICE_MIN_RETURNS,
  CHOICE_USAGE_RETENTION_DAYS,
  NO_GLOB,
} from '../src/domain/choice-usage.js';
import type { DecisionSourceKind } from '../src/domain/decisions.js';
import type { Result } from '../src/domain/errors.js';
import type { LearningWire } from '../src/domain/kb.js';
import type { Board } from '../src/domain/types.js';
import { FakeEmbedder, vectorOf } from '../src/testing/fake-embedder.js';
import { learningSeed } from '../src/testing/learning-seed.js';
import { TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const DEV = 'dev@example.com';
const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-10-12T12:00:00.000Z';
const at = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString();
const dayOf = (days: number) => at(days).slice(0, 10);

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** Says "Exponential [1]" to any question: the one source the chat finds is its first. */
class CitingLlm implements Llm {
  complete(): Promise<string> {
    return Promise.resolve('Exponential [1]');
  }
}

describe('Choices that keep mattering', () => {
  let store: MemoryStore;
  let search: SearchService;
  let mining: MiningService;
  let board: Board;
  let globIds: string[];
  let ref: number;

  /** A choice: its knowledge item (found by "retry backoff") and its row; returns the choice id and item id. */
  const choice = async (
    patch: { sourceKind?: DecisionSourceKind; statement?: string; quote?: string; globId?: string | null; globs?: string[]; replaced?: boolean } = {},
  ): Promise<{ id: number; itemId: number }> => {
    const n = ++ref;
    const statement = patch.statement ?? `Retry backoff ${String(n)} is exponential`;
    const externalRef = `decision:r${String(n)}`;
    return store.transaction(async (tx) => {
      await tx.replaceItem(
        {
          boardId: board.id,
          sourceType: 'decision',
          externalRef,
          title: statement,
          occurredAt: NOW,
          authority: 'decision',
          status: 'active',
          supersededBy: null,
          globIds: patch.globs ?? [],
          globGroup: null,
          externalUrl: null,
          contentHash: externalRef,
          state: 'ready',
        },
        [{ position: 0, header: `[${statement}]`, text: statement }],
      );
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
      const [found] = await tx.keywordCandidates({ boardId: board.id, query: statement, mode: 'all_time' }, 1);
      const itemId = found?.itemId ?? -1;
      const decision = await tx.upsertDecision({
        boardId: board.id,
        itemId,
        globId: patch.globId === undefined ? globIds[0] ?? null : patch.globId,
        group: null,
        statement,
        quote: patch.quote ?? `${statement} because bursts overload the queue`,
        decidedBy: null,
        decidedAt: NOW,
        sourceKind: patch.sourceKind ?? 'implementation_plan',
        sourceRef: `artifact:r${String(n)}`,
        sourceLabel: `record ${String(n)}`,
        sourceUrl: null,
        createdAt: NOW,
      });
      if (patch.replaced === true) await tx.updateDecision(decision.id, { replacedBy: decision.id + 100, replaceState: 'applied' });
      return { id: decision.id, itemId };
    });
  };

  const usage = (boardId = board.id, from = '2000-01-01') => store.transaction((tx) => tx.listChoiceUsage(boardId, from));
  /** `returns` returns of the choice spread over the globs (one each, round robin). */
  const use = (id: number, returns: number, on: readonly string[], day = dayOf(-1)) =>
    store.transaction(async (tx) => {
      const item = (await tx.getDecision(id))?.itemId ?? -1;
      for (let i = 0; i < returns; i++) await tx.recordChoiceUsage(board.id, [item], on[i % Math.max(on.length, 1)] ?? null, day);
    });
  const raisedFor = async (id: number) => (await store.transaction((tx) => tx.listKbSignals(board.id))).find((r) => r.key === `choice_in_use:${String(id)}`);
  const learnings = () => store.transaction((tx) => learningSeed(tx).listSeeded(board.id));

  beforeEach(async () => {
    store = new MemoryStore();
    ref = 0;
    const embedder = new FakeEmbedder();
    search = new SearchService({ store, clock: { now: () => NOW }, embedder });
    mining = new MiningService({ store, notifier: new RecordingNotifier() });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      const created = await tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      board = { ...created, agentSetVersion: 3, version: 2 };
      await tx.updateBoard(board, created.version);
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      globIds = [];
      for (let i = 1; i <= 6; i++) {
        const id = `s${String(board.id)}t${String(i)}`;
        globIds.push(id);
        await tx.insertGlob(glob({ id, boardId: board.id, title: `Retry backoff job ${String(i)}`, summary: 'retry backoff' }), null);
      }
    });
  });

  describe('usage recording', () => {
    it('counts a keyword search once per retrieval, per choice, and ignores items that are not choices', async () => {
      const a = await choice({ statement: 'Retry backoff is exponential' });
      const b = await choice({ statement: 'Retry backoff caps at one minute' });
      await store.transaction((tx) =>
        tx.replaceItem(
          { boardId: board.id, sourceType: 'glob_plan', externalRef: 'plan', title: 'retry backoff plan', occurredAt: NOW, authority: 'approved_plan', status: 'active', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: 'p', state: 'ready' },
          [{ position: 0, header: '[plan]', text: 'retry backoff plan' }],
        ),
      );
      unwrap(await search.text(DEV, { boardId: board.id, query: 'retry backoff' }));
      expect(await usage()).toEqual(
        expect.arrayContaining([
          { decisionId: a.id, day: dayOf(0), globId: NO_GLOB, count: 1 },
          { decisionId: b.id, day: dayOf(0), globId: NO_GLOB, count: 1 },
        ]),
      );
      expect(await usage()).toHaveLength(2);
      unwrap(await search.text(DEV, { boardId: board.id, query: 'retry backoff' }));
      expect((await usage()).map((r) => r.count)).toEqual([2, 2]);
    });

    it('counts a semantic search, under the glob it was scoped to', async () => {
      const g = globIds[0] ?? '';
      const c = await choice({ statement: 'Retry backoff is exponential', globs: [g] });
      unwrap(await search.semantic(DEV, { boardId: board.id, query: 'Retry backoff is exponential', globId: g }));
      expect(await usage()).toEqual([{ decisionId: c.id, day: dayOf(0), globId: g, count: 1 }]);
    });

    it('counts the choices a context bundle hands an agent, on that glob, and not the glob\'s own', async () => {
      const own = globIds[0] ?? '';
      const asked = globIds[1] ?? '';
      const mine = await choice({ statement: 'Retry backoff job is mine', globId: own, globs: [own] });
      const other = await choice({ statement: 'Retry backoff job is shared', globId: null });
      const artifacts = new ArtifactService({ store, clock: { now: () => NOW }, notifier: new RecordingNotifier(), related: (tx, g) => search.related(tx, g) });
      unwrap(await artifacts.context(DEV, asked));
      const rows = await usage();
      expect(rows).toContainEqual({ decisionId: other.id, day: dayOf(0), globId: asked, count: 1 });
      expect(rows).toContainEqual({ decisionId: mine.id, day: dayOf(0), globId: asked, count: 1 });
      // One get_context is one return of each choice it lists.
      expect(rows.every((r) => r.count === 1)).toBe(true);
      unwrap(await artifacts.context(DEV, asked));
      expect((await usage()).every((r) => r.count === 2)).toBe(true);
    });

    it('counts a choice chat cites once, and one it only found not at all', async () => {
      const cited = await choice({ statement: 'Retry backoff is exponential' });
      const chat = new ChatService({ store, clock: { now: () => NOW }, search, llm: new CitingLlm() });
      unwrap(await chat.ask(DEV, { boardId: board.id, question: 'retry backoff exponential' }));
      expect(await usage()).toEqual([{ decisionId: cited.id, day: dayOf(0), globId: NO_GLOB, count: 1 }]);
      // Found but not cited (the model used no source): nothing more.
      const quiet = new ChatService({ store, clock: { now: () => NOW }, search, llm: { complete: () => Promise.resolve("I couldn't find anything about that in the board's records.") } });
      unwrap(await quiet.ask(DEV, { boardId: board.id, question: 'retry backoff exponential' }));
      expect(await usage()).toEqual([{ decisionId: cited.id, day: dayOf(0), globId: NO_GLOB, count: 1 }]);
    });

    it('prunes rows older than 90 days when the board is mined, and shows the rest on the glob view', async () => {
      const c = await choice({ globId: globIds[0] ?? null });
      await use(c.id, 1, [globIds[1] ?? ''], dayOf(-(CHOICE_USAGE_RETENTION_DAYS + 5)));
      await use(c.id, 3, [globIds[1] ?? '', globIds[2] ?? ''], dayOf(-2));
      await mining.mine(board.id, NOW);
      expect((await usage()).map((r) => r.day)).not.toContain(dayOf(-(CHOICE_USAGE_RETENTION_DAYS + 5)));
      const decisions = new DecisionService({ store, clock: { now: () => NOW }, notifier: new RecordingNotifier() });
      const [view] = unwrap(await decisions.forGlob(DEV, board.id, globIds[0] ?? ''));
      expect(view?.usage).toEqual({ returns: 3, globs: 2 });
    });
  });

  describe('the choice_in_use signal', () => {
    const first3 = () => globIds.slice(0, CHOICE_MIN_GLOBS + 1).slice(1);

    it('raises a pattern learning for a choice from a record returned 5 times on 3 globs', async () => {
      const c = await choice();
      await use(c.id, CHOICE_MIN_RETURNS, first3());
      const result = await mining.mine(board.id, NOW);
      expect(result.raised).toHaveLength(1);
      const [raised] = await learnings();
      expect(raised).toMatchObject({ type: 'pattern', source: 'mined' });
      expect(raised?.statement).toContain('Retry backoff 1 is exponential');
      expect(raised?.statement).toContain(first3().join(', '));
      expect(raised?.evidence).toContain('because bursts overload the queue');
      expect(raised?.evidence).toContain('record 1');
      expect(await raisedFor(c.id)).toMatchObject({ itemId: raised?.id });
    });

    it('needs both the returns and the globs, and counts only the last 30 days', async () => {
      const few = await choice();
      await use(few.id, CHOICE_MIN_RETURNS - 1, first3());
      const narrow = await choice();
      await use(narrow.id, 20, first3().slice(0, CHOICE_MIN_GLOBS - 1));
      const stale = await choice();
      await use(stale.id, CHOICE_MIN_RETURNS, first3(), dayOf(-40));
      expect((await mining.mine(board.id, NOW)).raised).toEqual([]);
      // A retrieval that had no glob is a return but names no glob.
      const unscoped = await choice();
      await use(unscoped.id, CHOICE_MIN_RETURNS, []);
      await use(unscoped.id, 1, first3().slice(0, CHOICE_MIN_GLOBS - 1));
      expect((await mining.mine(board.id, NOW)).raised).toEqual([]);
      await use(few.id, 1, first3());
      expect((await mining.mine(board.id, NOW)).raised).toHaveLength(1);
    });

    it('counts the glob a choice was taken on for nothing', async () => {
      const taken = globIds[0] ?? '';
      const c = await choice({ globId: taken });
      await use(c.id, 6, [taken, globIds[1] ?? '', globIds[2] ?? '']);
      expect((await mining.mine(board.id, NOW)).raised).toEqual([]);
    });

    it('asks 10 returns of a choice that came from discussion, and skips accepted learnings and replaced choices', async () => {
      const talk = await choice({ sourceKind: 'inbox' });
      await use(talk.id, CHOICE_DISCUSSION_MIN_RETURNS - 1, first3());
      const known = await choice({ sourceKind: 'kb_item', globId: null });
      await use(known.id, 12, first3());
      const old = await choice({ replaced: true });
      await use(old.id, 12, first3());
      expect((await mining.mine(board.id, NOW)).raised).toEqual([]);
      await use(talk.id, 1, first3());
      const raised = (await mining.mine(board.id, NOW)).raised;
      expect(raised).toHaveLength(1);
      expect(await raisedFor(talk.id)).toMatchObject({ itemId: raised[0] });
    });

    it('skips a choice a document already says', async () => {
      const said = await choice({ quote: 'Retries back off exponentially because bursts overload the queue' });
      await use(said.id, 8, first3());
      await store.transaction((tx) =>
        tx.saveKnowledge({
          boardId: board.id,
          kind: 'doc',
          name: 'conventions_doc',
          area: 'conventions',
          audience: [],
          description: '',
          content: '# Conventions\n\nRetries   back off exponentially\nbecause bursts overload the queue.\n',
          layer: 'file',
          version: 1,
          source: 'upload',
          updatedBy: DEV,
          updatedAt: NOW,
        }),
      );
      expect((await mining.mine(board.id, NOW)).raised).toEqual([]);
    });

    it('raises a choice once: the open item is refreshed, and a rejected one is never raised again', async () => {
      const c = await choice();
      await use(c.id, 6, first3());
      const [id] = (await mining.mine(board.id, NOW)).raised;
      // Still open next week: refreshed, not raised twice.
      await use(c.id, 1, first3(), dayOf(6));
      const again = await mining.mine(board.id, at(7));
      expect(again.raised).toEqual([]);
      expect(await learnings()).toHaveLength(1);

      const found = (await learnings()).find((l) => l.id === id) as LearningWire;
      await store.transaction((tx) =>
        learningSeed(tx, TEST_KB_WRITES).updateSeeded({ ...found, status: 'rejected', decidedBy: DEV, decidedAt: at(7), decisionReason: 'Not for the docs', version: found.version + 1 }, found.version),
      );
      // Not after the 12 weeks any other rejected signal waits, and not at any rate.
      await use(c.id, 60, first3(), dayOf(7 * 14));
      expect((await mining.mine(board.id, at(7 * 14))).raised).toEqual([]);
      expect(await learnings()).toHaveLength(1);
      expect(await raisedFor(c.id)).toMatchObject({ itemId: id });
    });
  });
});
