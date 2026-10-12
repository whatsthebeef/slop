import { describe, expect, it } from 'vitest';
import { kbItems, kbJobHint } from '../src/app/kb-items.js';
import { retryLearningStep } from '../src/app/learning-writes.js';
import { MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import { claimLeaseMs, laneOf, LLM_CLAIM_LEASE_MS, maxAttemptsOf, outboxBackoffMs } from '../src/domain/events.js';
import { kbEffectsFor, kbStepOf, kbStepOfKind, withProcessing } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import { TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { assessmentOf } from '../src/domain/decision-glob.js';
import { NOW } from './fixtures.js';
import { document, drafted, full, item, job, newStore, OTHER, routed } from './kb-fixtures.js';

describe('the KB pipeline steps on the outbox', () => {
  it('runs both steps on the llm lane, giving up after the pipeline\'s three attempts, with the outbox backoff', () => {
    expect([laneOf('kb_route'), laneOf('kb_draft')]).toEqual(['llm', 'llm']);
    expect(maxAttemptsOf('llm')).toBe(MAX_PROCESSING_ATTEMPTS);
    expect(maxAttemptsOf('default')).toBe(8);
    expect([0, 1, 2, 20].map((n) => outboxBackoffMs(n))).toEqual([5_000, 10_000, 20_000, 3_600_000]);
    // The llm lane's three attempts span minutes; a claim there holds the job for at least the lease.
    expect([0, 1, 2].map((n) => outboxBackoffMs(n, 'llm'))).toEqual([30_000, 60_000, 120_000]);
    expect([0, 1, 7].map((n) => claimLeaseMs(n, 'llm'))).toEqual([LLM_CLAIM_LEASE_MS, LLM_CLAIM_LEASE_MS, 3_600_000]);
    expect(claimLeaseMs(1)).toBe(10_000);
    expect([kbStepOfKind('kb_route'), kbStepOfKind('kb_draft'), kbStepOfKind('reconcile_pr')]).toEqual(['route', 'draft', null]);
  });

  it('reads the next step from the item alone', () => {
    expect(kbStepOf(item())).toBe('route');
    expect(kbStepOf(routed())).toBe('draft');
    expect(kbStepOf(drafted())).toBeNull();
    expect(kbStepOf(routed({ status: 'approved' }))).toBeNull();
    expect(kbStepOf(item({ status: 'merged' }))).toBeNull();
    // A document proposal is its own draft; one with no target (from before routing) is routed to its document.
    expect(kbStepOf(routed({ document }))).toBeNull();
    expect(kbStepOf(item({ document }))).toBe('route');
  });

  it('queues routing for a new item, and drafting when it is routed, retargeted, reopened or loses its draft', () => {
    const route = [{ kind: 'kb_route', globId: 's1k1' }];
    const draft = [{ kind: 'kb_draft', globId: 's1k1' }];
    expect(kbEffectsFor(null, item())).toEqual(route);
    expect(kbEffectsFor(null, routed())).toEqual(draft);
    expect(kbEffectsFor(null, drafted())).toEqual([]);
    expect(kbEffectsFor(null, routed({ document }))).toEqual([]);
    expect(kbEffectsFor(item(), routed())).toEqual(draft);
    expect(kbEffectsFor(routed(), routed({ target: OTHER }))).toEqual(draft);
    expect(kbEffectsFor(drafted(), routed())).toEqual(draft);
    expect(kbEffectsFor(routed({ status: 'merged' }), routed())).toEqual(draft);
  });

  it('never queues a step again for an unrelated change, so a failed job is only retried when asked', () => {
    expect(kbEffectsFor(item(), item({ evidence: 'more' }))).toEqual([]);
    expect(kbEffectsFor(routed(), routed({ occurrenceCount: 2 }))).toEqual([]);
    expect(kbEffectsFor(drafted(), drafted({ staleSince: NOW }))).toEqual([]);
    expect(kbEffectsFor(routed(), routed({ status: 'rejected' }))).toEqual([]);
    expect(kbEffectsFor(item(), item({ status: 'merged' }))).toEqual([]);
  });

  it('derives the pipeline fields from the step\'s newest job', () => {
    expect(withProcessing(item(), [])).toMatchObject({ processing: 'pending', processingError: null, processingAttempts: 0, processAfter: null });
    expect(withProcessing(routed(), [job({ kind: 'kb_route', state: 'done' })])).toMatchObject({ processing: 'routed', processingAttempts: 0 });
    const retrying = job({ attempts: 1, lastError: 'Bedrock is down', runAfter: '2026-10-05T12:00:05.000Z' });
    expect(withProcessing(item(), [retrying])).toMatchObject({
      processing: 'pending',
      processingAttempts: 1,
      processingError: 'Bedrock is down',
      processAfter: '2026-10-05T12:00:05.000Z',
    });
    const failed = job({ id: 2, kind: 'kb_draft', state: 'failed', attempts: 3, lastError: 'Sonnet is down' });
    expect(withProcessing(routed(), [failed])).toMatchObject({ processing: 'failed', processingAttempts: 3, processingError: 'Sonnet is down', processAfter: null });
    // An admin's retry queued a newer job: it reads as waiting again.
    expect(withProcessing(routed(), [failed, job({ id: 3, kind: 'kb_draft' })])).toMatchObject({ processing: 'routed', processingAttempts: 0, processingError: null });
    // Other items' and other steps' jobs are ignored.
    expect(withProcessing(routed(), [job({ globId: 's1k2', kind: 'kb_draft', state: 'failed' }), job({ state: 'failed' })])).toMatchObject({ processing: 'routed' });
    expect(withProcessing(drafted(), [failed])).toMatchObject({ processing: 'drafted', processingError: null });
    // A decided item has left the pipeline, whatever its jobs say.
    const decided = routed({ status: 'approved', processing: 'failed', processingError: 'x', processingAttempts: 3 });
    expect(withProcessing(decided, [failed])).toMatchObject({ processing: 'none', processingError: null, processingAttempts: 0, processAfter: null });
  });

  it('writes through the adapter queue the step a change makes due, once per item and kind, and retries on request', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) =>
      tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] }),
    );
    const kinds = () => store.state.outboxJobs.map((j) => [j.kind, j.state]);
    await store.transaction(async (tx) => {
      expect(await kbItems(tx, TEST_KB_WRITES).insertKbItem(item())).toBe(true);
      expect(await kbItems(tx, TEST_KB_WRITES).insertKbItem(item())).toBe(false);
    });
    expect(kinds()).toEqual([['kb_route', 'pending']]);
    await store.transaction(async (tx) => {
      expect(await kbItems(tx, TEST_KB_WRITES).updateKbItem(routed({ version: 2 }), 1)).toBe(true);
      // A stale version writes nothing and queues nothing.
      expect(await kbItems(tx, TEST_KB_WRITES).updateKbItem(routed({ target: OTHER, version: 2 }), 1)).toBe(false);
      // A retarget while the draft job still waits queues no second one.
      expect(await kbItems(tx, TEST_KB_WRITES).updateKbItem(routed({ target: OTHER, version: 3 }), 2)).toBe(true);
    });
    expect(kinds()).toEqual([['kb_route', 'pending'], ['kb_draft', 'pending']]);
    store.state.outboxJobs = store.state.outboxJobs.map((j) => (j.kind === 'kb_draft' ? { ...j, state: 'failed', attempts: 3, lastError: 'Sonnet is down' } : j));
    const failed = await store.transaction((tx) => kbItems(tx).getKbItem('s1k1'));
    expect(failed).toMatchObject({ processing: 'failed', processingError: 'Sonnet is down' });
    expect(await store.transaction((tx) => retryLearningStep(tx, TEST_KB_WRITES, 's1k1', 3))).toBe(true);
    const retried = await store.transaction((tx) => kbItems(tx).getKbItem('s1k1'));
    expect(retried).toMatchObject({ processing: 'routed', processingAttempts: 0, processingError: null, version: 4 });
    expect(kinds()).toEqual([['kb_route', 'pending'], ['kb_draft', 'failed'], ['kb_draft', 'pending']]);
  });

  it('names the board of a settled pipeline job for the Knowledge page, and nothing for other effects', () => {
    expect(kbJobHint({ kind: 'kb_draft', globId: 's12k3' })).toEqual({ kind: 'board.kb', boardId: 12 });
    expect(kbJobHint({ kind: 'reconcile_pr', globId: 's12t3', generation: 1 })).toBeNull();
  });

  describe('a learning is its decision glob', () => {
    const read = (store: MemoryStore, id = 's1k1') => store.transaction((tx) => kbItems(tx).getKbItem(id));

    it('round-trips every field through the glob, its artifacts, attachments and links', async () => {
      const store = await newStore();
      const item = full();
      await store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).insertKbItem(item));
      expect(await read(store)).toEqual(item);
      const glob = await store.transaction((tx) => tx.getGlob('s1k1'));
      expect(glob?.links).toEqual([
        { id: 's1k5', kind: 'possibly_covered_by', source: 'pipeline', detail: { quote: 'q', shortQuote: true, claim: 'duplicate', ownQuote: 'o', tooShort: 'both', alsoTarget: { quote: 't', reason: 'r' }, via: 's1k6' } },
        { id: 's1k4', kind: 'contradicts', source: 'pipeline', detail: { note: 'Conflicts', position: 1 } },
        { id: 's1k9', kind: 'kept_apart_from', source: 'explicit' },
      ]);
      // Two evidence entries from one learning keep distinct labels.
      expect(store.state.artifacts.filter((a) => a.label.startsWith('evidence:')).map((a) => a.label)).toEqual(['evidence:s1k8', 'evidence:s1k8#2']);

      // An update writes only what changed, and reads back as written.
      const next: KbItem = { ...item, evidence: 'Changed evidence', draft: null, draftedAgainstVersion: null, rationale: null, version: 2 };
      const before = store.state.artifacts.length;
      await store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).updateKbItem(next, 1));
      // (The assessment follows the draft.)
      expect(store.state.artifacts.slice(before).map((a) => [a.kind, a.content === ''])).toEqual([['plan', false], ['draft', true], ['assessment', false]]);
      expect(await read(store)).toMatchObject({ evidence: 'Changed evidence', draft: null, processing: 'routed', version: 2 });
      // Evidence merged in is never taken away.
      await expect(store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).updateKbItem({ ...next, extraEvidence: [], version: 3 }, 2))).rejects.toThrow(/never taken away/);
    });

    it('reads each status from the decision rows, and a person\'s retitle survives the pipeline\'s writes', async () => {
      const store = await newStore();
      const decided = { decidedBy: 'admin@example.com', decidedAt: '2026-10-05T13:00:00.000Z' };
      await store.transaction(async (tx) => {
        const kb = kbItems(tx, TEST_KB_WRITES);
        await kb.insertKbItem(drafted({ id: 's1k1', status: 'approved', outcome: { kind: 'learning' }, decisionReason: 'Good', ...decided }));
        await kb.insertKbItem(drafted({ id: 's1k2', status: 'rejected', decisionReason: 'No', ...decided }));
        await kb.insertKbItem(drafted({ id: 's1k3', status: 'merged', duplicateOf: 's1k1', mergeNote: { by: 'intake', quote: 'a', survivorQuote: 'b', at: NOW } }));
        await kb.insertKbItem(drafted({ id: 's1k4', status: 'covered', coveredBy: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build_test_lint', section: null } }));
        await kb.insertKbItem(drafted({ id: 's1k5', status: 'suppressed', suppressedBy: 's1k2' }));
      });
      expect(await read(store, 's1k1')).toMatchObject({ status: 'approved', outcome: { kind: 'learning' }, decisionReason: 'Good', ...decided });
      expect(await store.transaction((tx) => tx.getGlob('s1k1'))).toMatchObject({ status: 'reviewing', attributes: { outcome: { kind: 'accept', by: decided.decidedBy, at: decided.decidedAt } } });
      expect(await read(store, 's1k2')).toMatchObject({ status: 'rejected', decisionReason: 'No', ...decided });
      expect(await read(store, 's1k3')).toMatchObject({ status: 'merged', duplicateOf: 's1k1', mergeNote: { quote: 'a' }, decidedBy: null });
      expect(await read(store, 's1k4')).toMatchObject({ status: 'covered', coveredBy: { kind: 'knowledge', name: 'build_test_lint' } });
      expect(await read(store, 's1k5')).toMatchObject({ status: 'suppressed', suppressedBy: 's1k2' });
      for (const id of ['s1k2', 's1k3', 's1k4', 's1k5']) {
        expect(await store.transaction((tx) => tx.getGlob(id))).toMatchObject({ status: 'signed_off', attributes: { archived: true } });
      }

      const open = 's1k6';
      await store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).insertKbItem(routed({ id: open })));
      const glob = await store.transaction((tx) => tx.getGlob(open));
      if (glob === null) throw new Error('missing');
      await store.transaction((tx) => tx.updateGlob({ ...glob, title: 'A better title', version: glob.version + 1 }, glob.version));
      const current = await read(store, open);
      if (current === null) throw new Error('missing');
      await store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).updateKbItem({ ...current, occurrenceCount: 2, version: current.version + 1 }, current.version));
      expect((await store.transaction((tx) => tx.getGlob(open)))?.title).toBe('A better title');
      // A new statement gives it a new title.
      const again = await read(store, open);
      if (again === null) throw new Error('missing');
      await store.transaction((tx) => kbItems(tx, TEST_KB_WRITES).updateKbItem({ ...again, statement: 'A new statement', version: again.version + 1 }, again.version));
      expect((await store.transaction((tx) => tx.getGlob(open)))?.title).toBe('A new statement');
    });
  });

  describe('the assessment of a learning', () => {
    const attributes = { scope: { kind: 'project' as const, ref: null }, origin: { kind: 'submitted' as const }, channel: 'agent' as const, outcome: null };

    it('suggests accepting an open, drafted learning with no flags', () => {
      expect(assessmentOf({ attributes, item: drafted(), preview: null, conflicts: [] }).suggested).toBe('accept');
    });

    it('never suggests accepting a learning that is no longer open, whatever its fields say', () => {
      for (const status of ['approved', 'rejected', 'merged', 'suppressed'] as const) {
        const item = drafted({ status, processing: 'drafted' });
        expect(assessmentOf({ attributes, item, preview: null, conflicts: [] }).suggested, status).not.toBe('accept');
      }
    });
  });
});
