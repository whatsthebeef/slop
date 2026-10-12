import { describe, expect, it } from 'vitest';
import { kbItems, kbJobHint } from '../src/app/kb-items.js';
import { MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import { laneOf, maxAttemptsOf, outboxBackoffMs } from '../src/domain/events.js';
import type { OutboxJob } from '../src/domain/events.js';
import { kbEffectsFor, kbStepOf, kbStepOfKind, UNPROCESSED, withProcessing } from '../src/domain/kb.js';
import type { KbItem, KbTarget } from '../src/domain/kb.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';

const TARGET: KbTarget = { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null };
const OTHER: KbTarget = { ...TARGET, section: 'Lint' };

const item = (patch: Partial<KbItem> = {}): KbItem => ({
  id: 's1k1',
  boardId: 1,
  status: 'open',
  type: 'gotcha',
  statement: 'Generated files live in src/gen/',
  evidence: 'A review finding',
  suggestedTarget: null,
  sourceGlobIds: ['s1t1'],
  source: 'submitted',
  signal: null,
  agentSetVersion: null,
  submittedBy: 'dev@example.com',
  createdAt: NOW,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  document: null,
  outcome: null,
  ...UNPROCESSED,
  version: 1,
  ...patch,
});
const routed = (patch: Partial<KbItem> = {}) => item({ target: TARGET, processing: 'routed', ...patch });
const drafted = (patch: Partial<KbItem> = {}) => routed({ draft: { section: 'Test', content: '## Test\n' }, processing: 'drafted', ...patch });
const document = { name: 'architecture', area: 'architecture', audience: [], description: 'Layout', content: '# A\n' };

const job = (patch: Partial<OutboxJob> = {}): OutboxJob => ({
  id: 1,
  globId: 's1k1',
  kind: 'kb_route',
  state: 'pending',
  attempts: 0,
  lastError: null,
  runAfter: NOW,
  ...patch,
});

describe('the KB pipeline steps on the outbox', () => {
  it('runs both steps on the llm lane, giving up after the pipeline\'s three attempts, with the outbox backoff', () => {
    expect([laneOf('kb_route'), laneOf('kb_draft')]).toEqual(['llm', 'llm']);
    expect(maxAttemptsOf('llm')).toBe(MAX_PROCESSING_ATTEMPTS);
    expect(maxAttemptsOf('default')).toBe(8);
    expect([0, 1, 2, 20].map(outboxBackoffMs)).toEqual([5_000, 10_000, 20_000, 3_600_000]);
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
    // A decided item keeps the fields it left the pipeline with.
    const decided = routed({ status: 'approved', processing: 'failed', processingError: 'x', processingAttempts: 3 });
    expect(withProcessing(decided, [])).toEqual(decided);
  });

  it('writes through the adapter queue the step a change makes due, once per item and kind, and retries on request', async () => {
    const store = new MemoryStore();
    const kinds = () => store.state.outboxJobs.map((j) => [j.kind, j.state]);
    await store.transaction(async (tx) => {
      expect(await kbItems(tx).insertKbItem(item())).toBe(true);
      expect(await kbItems(tx).insertKbItem(item())).toBe(false);
    });
    expect(kinds()).toEqual([['kb_route', 'pending']]);
    await store.transaction(async (tx) => {
      expect(await kbItems(tx).updateKbItem(routed({ version: 2 }), 1)).toBe(true);
      // A stale version writes nothing and queues nothing.
      expect(await kbItems(tx).updateKbItem(routed({ target: OTHER, version: 2 }), 1)).toBe(false);
      // A retarget while the draft job still waits queues no second one.
      expect(await kbItems(tx).updateKbItem(routed({ target: OTHER, version: 3 }), 2)).toBe(true);
    });
    expect(kinds()).toEqual([['kb_route', 'pending'], ['kb_draft', 'pending']]);
    store.state.outboxJobs = store.state.outboxJobs.map((j) => (j.kind === 'kb_draft' ? { ...j, state: 'failed', attempts: 3, lastError: 'Sonnet is down' } : j));
    const failed = await store.transaction((tx) => kbItems(tx).getKbItem('s1k1'));
    expect(failed).toMatchObject({ processing: 'failed', processingError: 'Sonnet is down' });
    const retried = await store.transaction((tx) => kbItems(tx).retryStep(routed({ target: OTHER, version: 3 })));
    expect(retried).toMatchObject({ processing: 'routed', processingAttempts: 0, processingError: null });
    expect(kinds()).toEqual([['kb_route', 'pending'], ['kb_draft', 'failed'], ['kb_draft', 'pending']]);
  });

  it('names the board of a settled pipeline job for the Knowledge page, and nothing for other effects', () => {
    expect(kbJobHint({ kind: 'kb_draft', globId: 's12k3' })).toEqual({ kind: 'board.kb', boardId: 12 });
    expect(kbJobHint({ kind: 'reconcile_pr', globId: 's12t3', generation: 1 })).toBeNull();
  });
});
