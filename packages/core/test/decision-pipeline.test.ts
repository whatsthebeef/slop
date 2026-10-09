import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { DecisionPipeline, EXTRACT_SYSTEM, MAX_DECISIONS_PER_SOURCE, SUPERSEDE_SYSTEM } from '../src/app/decision-pipeline.js';
import { DecisionService } from '../src/app/decision-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import { SearchIndexer } from '../src/app/search-indexer.js';
import { RELATED_LIMIT, SearchService } from '../src/app/search-service.js';
import { decisionRef } from '../src/domain/decisions.js';
import type { Decision } from '../src/domain/decisions.js';
import type { Result } from '../src/domain/errors.js';
import { UNPROCESSED } from '../src/domain/kb.js';
import type { KbItem } from '../src/domain/kb.js';
import type { Artifact, ArtifactKind } from '../src/domain/knowledge.js';
import type { Glob } from '../src/domain/types.js';
import { FakeEmbedder } from '../src/testing/fake-embedder.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const START = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';

// No trailing full stop: a quote is kept without sentence punctuation at its ends.
const POLLING = 'We will poll the server every thirty seconds for new sync jobs';
const PUSH = 'Replacing s1t1, we will push sync jobs over a websocket connection instead of polling';
const RETRY = 'Failed syncs are retried three times with exponential backoff';

const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

interface Entry {
  readonly statement?: string;
  readonly quote: string;
  readonly decidedBy?: string | null;
  readonly decidedAt?: string | null;
}
const extractAnswer = (...entries: Entry[]): string =>
  JSON.stringify({
    decisions: entries.map((e) => ({ statement: e.statement ?? e.quote, quote: e.quote, decidedBy: e.decidedBy ?? null, decidedAt: e.decidedAt ?? null })),
  });
const replaces = (...items: { id: number; oldQuote: string; newQuote: string; reason?: string; sameSubject?: boolean }[]): string =>
  JSON.stringify({ replaces: items.map((i) => ({ reason: 'Same question, new answer.', sameSubject: true, ...i })) });

/** A check answer naming whichever earlier decision in the prompt contains `old`, whatever its number. */
const replacing =
  (old: string, quotes: { oldQuote: string; newQuote: string }) =>
  (prompt: string): string => {
    const blocks = prompt.split('Earlier decisions:\n')[1]?.split(/\n(?=\[\d+\] )/) ?? [];
    const id = blocks.findIndex((b) => b.includes(old)) + 1;
    return replaces({ id, ...quotes });
  };

/** Answers extraction calls by a phrase in the document shown, and supersession checks from a queue. */
class FakeLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  readonly extractions: { match: string; answer: string | Error }[] = [];
  readonly checks: (string | Error | ((prompt: string) => string))[] = [];
  complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    if (request.system === EXTRACT_SYSTEM) {
      const found = this.extractions.find((e) => request.prompt.includes(e.match));
      if (found === undefined) return Promise.reject(new Error('No canned extraction'));
      return found.answer instanceof Error ? Promise.reject(found.answer) : Promise.resolve(found.answer);
    }
    const next = this.checks.shift();
    if (next === undefined) return Promise.reject(new Error('No canned check'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === 'function' ? next(request.prompt) : next);
  }
  count(system: string): number {
    return this.calls.filter((c) => c.system === system).length;
  }
}

describe('decisions', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let embedder: FakeEmbedder;
  let pipeline: DecisionPipeline;
  let now: string;
  let boardId: number;

  const clock = { now: () => now };
  const decisions = async (): Promise<Decision[]> => store.transaction((tx) => tx.listDecisions(boardId));
  const byQuote = async (quote: string): Promise<Decision> => {
    const found = (await decisions()).find((d) => d.quote === quote);
    if (found === undefined) throw new Error(`No decision quoting ${quote}`);
    return found;
  };
  const itemOf = (d: Decision) => [...store.state.searchItems.values()].find((i) => i.id === d.itemId);

  const addGlob = async (patch: Partial<Glob> = {}) => {
    const g = makeGlob({ boardId, ...patch });
    await store.transaction((tx) => tx.insertGlob(g, null));
    return g;
  };
  const addArtifact = (globId: string, kind: ArtifactKind, content: string, label = '', createdAt = now): Promise<Artifact> =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind,
        label,
        content,
        link: null,
        commitSha: null,
        provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: null },
        createdAt,
      }),
    );
  /** Discovers and runs every queued step: extractions first, then supersession checks. */
  const run = async (): Promise<string[]> => {
    await pipeline.syncBoard(boardId);
    const done: string[] = [];
    for (let i = 0; i < 40; i++) {
      const step = await pipeline.processNext();
      if (step === null) break;
      done.push(step);
    }
    return done;
  };
  const record = (decided: string) => `# Record\n\nDid the work.\n\n## Decisions\n\n${decided}\n\n## Notes\n\nNothing else was settled here.`;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    llm = new FakeLlm();
    embedder = new FakeEmbedder();
    now = START;
    pipeline = new DecisionPipeline({ store, clock, notifier, llm, embedder });
    boardId = await store.transaction(async (tx) => {
      for (const email of [DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
      const board = await tx.insertBoard({ name: 'demo', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  describe('extraction', () => {
    it('keeps a decision only when its quote is in the Decisions section the model was shown', async () => {
      const g = await addGlob({ id: 's1t1', group: 'sync' });
      await addArtifact(g.id, 'implementation_plan', record(`- ${POLLING}\n- Rejected: long polling.`));
      llm.extractions.push({
        match: 'poll the server',
        answer: extractAnswer(
          { statement: 'Poll every 30 seconds.', quote: POLLING, decidedBy: 'ana@example.com', decidedAt: '2026-09-01' },
          // Not in the text at all.
          { quote: 'We will use gRPC streaming between all of the services.' },
          // In the text, but far too short to rest a decision on.
          { quote: 'long polling' },
          // In the record, but outside the section the model sees.
          { quote: 'Nothing else was settled here.' },
        ),
      });
      await run();
      const found = await decisions();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        statement: 'Poll every 30 seconds.',
        quote: POLLING,
        decidedBy: 'ana@example.com',
        decidedAt: '2026-09-01T00:00:00.000Z',
        globId: 's1t1',
        group: 'sync',
        sourceKind: 'implementation_plan',
        sourceRef: 'artifact:s1t1:implementation_plan:',
        sourceLabel: 's1t1 implementation record',
        sourceUrl: `/boards/${String(boardId)}?glob=s1t1`,
        replacedBy: null,
        replaceState: null,
      });
      // The model saw only the Decisions section.
      const shown = llm.calls[0]?.prompt ?? '';
      expect(shown).toContain('Rejected: long polling');
      expect(shown).not.toContain('Nothing else was settled');
      const item = itemOf(found[0] as Decision);
      expect(item).toMatchObject({
        sourceType: 'decision',
        authority: 'decision',
        status: 'active',
        title: 'Poll every 30 seconds.',
        globIds: ['s1t1'],
        globGroup: 'sync',
        externalRef: decisionRef('artifact:s1t1:implementation_plan:', POLLING),
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      const chunk = store.state.searchChunks.find((c) => c.itemId === item?.id);
      expect(chunk?.text).toContain('Decided by: ana@example.com');
      expect(chunk?.text).toContain(`Source quote: "${POLLING}"`);
    });

    it('does nothing for a record without a Decisions section, and reads plan.md and Clarifications whole', async () => {
      const g = await addGlob({ id: 's1t1' });
      await addArtifact(g.id, 'implementation_plan', '# Record\n\nNo decisions heading here.');
      await addArtifact(g.id, 'plan', `# Plan\n\n${RETRY}`);
      await addArtifact(g.id, 'attachment', `The answers: ${POLLING}`, 'Clarifications');
      await addArtifact(g.id, 'attachment', `Design notes: ${PUSH}`, 'notes');
      llm.extractions.push({ match: 'exponential', answer: extractAnswer({ quote: RETRY }) }, { match: 'The answers', answer: extractAnswer({ quote: POLLING }) });
      const steps = await run();
      expect(steps.filter((s) => s.startsWith('source:'))).toHaveLength(2);
      expect(llm.count(EXTRACT_SYSTEM)).toBe(2);
      expect((await decisions()).map((d) => [d.sourceKind, d.sourceLabel]).sort()).toEqual([
        ['attachment', 's1t1 Clarifications'],
        ['plan', 's1t1 plan.md'],
      ]);
    });

    it('turns an approved decision learning into a decision without asking the model', async () => {
      const learning = (id: string, type: KbItem['type'], statement: string): KbItem => ({
        id,
        boardId,
        status: 'approved',
        type,
        statement,
        evidence: 'because',
        suggestedTarget: null,
        sourceGlobIds: [],
        source: 'submitted',
        signal: null,
        agentSetVersion: null,
        submittedBy: DEV,
        createdAt: '2026-08-01T00:00:00.000Z',
        decidedBy: 'admin@example.com',
        decidedAt: '2026-08-02T00:00:00.000Z',
        decisionReason: null,
        document: null,
        outcome: null,
        ...UNPROCESSED,
        processing: 'drafted',
        version: 2,
      });
      await store.transaction(async (tx) => {
        await tx.insertKbItem(learning('k1', 'decision', 'Dates are stored in UTC and shown in the board time zone.'));
        await tx.insertKbItem(learning('k2', 'gotcha', 'The cache needs a restart after a config change.'));
      });
      await run();
      expect(llm.calls).toHaveLength(0);
      const found = await decisions();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        globId: null,
        sourceKind: 'kb_item',
        sourceRef: 'learning:k1',
        decidedBy: 'admin@example.com',
        decidedAt: '2026-08-02T00:00:00.000Z',
        statement: 'Dates are stored in UTC and shown in the board time zone.',
        sourceUrl: `/boards/${String(boardId)}/knowledge`,
      });
      expect(found[0]?.quote).toBe(found[0]?.statement);
    });

    it('falls back to the artifact date when the model gives no usable date', async () => {
      const g = await addGlob({ id: 's1t1' });
      await addArtifact(g.id, 'implementation_plan', record(`- ${POLLING}\n- ${RETRY}`), '', '2026-07-01T09:00:00.000Z');
      llm.extractions.push({
        match: 'poll the server',
        answer: extractAnswer({ quote: POLLING, decidedAt: 'last Tuesday' }, { quote: RETRY, decidedAt: '2026-08-15T10:00:00Z' }),
      });
      await run();
      expect((await byQuote(POLLING)).decidedAt).toBe('2026-07-01T09:00:00.000Z');
      expect((await byQuote(RETRY)).decidedAt).toBe('2026-08-15T10:00:00.000Z');
    });

    it('caps the decisions of one source', async () => {
      const g = await addGlob({ id: 's1t1' });
      const quotes = Array.from({ length: MAX_DECISIONS_PER_SOURCE + 5 }, (_, i) => `Decision number ${String(i)} is that we keep things simple`);
      await addArtifact(g.id, 'implementation_plan', record(quotes.map((q) => `- ${q}`).join('\n')));
      llm.extractions.push({ match: 'Decision number', answer: extractAnswer(...quotes.map((quote) => ({ quote }))) });
      await run();
      expect(await decisions()).toHaveLength(MAX_DECISIONS_PER_SOURCE);
    });

    it('is idempotent: a second run asks nothing and changes nothing', async () => {
      const g = await addGlob({ id: 's1t1' });
      await addArtifact(g.id, 'implementation_plan', record(`- ${POLLING}`));
      llm.extractions.push({ match: 'poll the server', answer: extractAnswer({ quote: POLLING }) });
      await run();
      const before = JSON.stringify([await decisions(), [...store.state.searchItems.values()], store.state.searchChunks]);
      const calls = llm.calls.length;
      expect(await run()).toEqual([]);
      expect(llm.calls).toHaveLength(calls);
      expect(JSON.stringify([await decisions(), [...store.state.searchItems.values()], store.state.searchChunks])).toBe(before);
    });

    it('replaces the decisions of a changed source, keeping what a supersession set on those still there', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}\n- ${RETRY}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }, { quote: RETRY, decidedAt: '2026-06-02' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      // Retry and polling come from one record, so neither is compared with the other: only push is checked.
      llm.checks.push(replacing(POLLING, { oldQuote: POLLING, newQuote: PUSH }));
      await run();
      expect((await byQuote(POLLING)).replaceState).toBe('applied');

      // The record is rewritten: polling stays, retry goes, a new decision arrives.
      const FRESH = 'Sync jobs are limited to ten per user at a time';
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}\n- ${FRESH}`));
      llm.extractions.length = 0;
      llm.extractions.push({ match: FRESH, answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }, { quote: FRESH, decidedAt: '2026-06-03' }) });
      llm.checks.length = 0;
      llm.checks.push(replaces());
      await run();
      const found = await decisions();
      expect(found.map((d) => d.quote).sort()).toEqual([FRESH, POLLING, PUSH].sort());
      const polling = await byQuote(POLLING);
      expect(polling).toMatchObject({ replaceState: 'applied', replacedBy: (await byQuote(PUSH)).id });
      expect(itemOf(polling)).toMatchObject({ status: 'superseded', supersededBy: (await byQuote(PUSH)).itemId });
    });

    it('removes the decisions of a source that is gone, and old decisions it replaced stand again', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      expect((await byQuote(POLLING)).replaceState).toBe('applied');
      await store.transaction((tx) => tx.deleteGlob('s1t2'));
      const polling = await byQuote(POLLING);
      expect(polling).toMatchObject({ replacedBy: null, replaceState: null });
      expect(itemOf(polling)).toMatchObject({ status: 'active', supersededBy: null });
      expect(await decisions()).toHaveLength(1);
      // A source whose Decisions section is removed loses its decisions too.
      await addArtifact(a.id, 'implementation_plan', '# Record\n\nNothing decided.');
      await run();
      expect(await decisions()).toEqual([]);
      expect([...store.state.searchItems.values()].filter((i) => i.sourceType === 'decision')).toEqual([]);
    });

    it('waits without spending attempts while the LLM is unavailable, and fails after repeated errors', async () => {
      const g = await addGlob({ id: 's1t1' });
      await addArtifact(g.id, 'implementation_plan', record(`- ${POLLING}`));
      llm.extractions.push({ match: 'poll the server', answer: new LlmUnavailable('No credentials', 'Sign in') });
      await pipeline.syncBoard(boardId);
      expect(await pipeline.processNext()).toBe('source:artifact:s1t1:implementation_plan:');
      const source = await store.transaction((tx) => tx.getDecisionSource(boardId, 'artifact:s1t1:implementation_plan:'));
      expect(source).toMatchObject({ state: 'pending', attempts: 0 });
      expect(source?.processAfter).toBe(new Date(Date.parse(START) + LLM_WAIT_MS).toISOString());
      expect(source?.lastError).toContain('No credentials');
      // Not due yet.
      expect(await pipeline.processNext()).toBeNull();
      // Errors count attempts, then fail the source.
      llm.extractions[0] = { match: 'poll the server', answer: new Error('boom') };
      for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
        now = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
        expect(await pipeline.processNext()).not.toBeNull();
        const row = await store.transaction((tx) => tx.getDecisionSource(boardId, 'artifact:s1t1:implementation_plan:'));
        expect(row?.attempts).toBe(attempt);
        expect(row?.state).toBe(attempt === MAX_PROCESSING_ATTEMPTS ? 'failed' : 'pending');
      }
      expect(await pipeline.processNext()).toBeNull();
      expect(await decisions()).toEqual([]);
    });

    it('treats an answer that is not JSON as a failed attempt', async () => {
      const g = await addGlob({ id: 's1t1' });
      await addArtifact(g.id, 'implementation_plan', record(`- ${POLLING}`));
      llm.extractions.push({ match: 'poll the server', answer: 'I found some decisions.' });
      await run();
      const row = await store.transaction((tx) => tx.getDecisionSource(boardId, 'artifact:s1t1:implementation_plan:'));
      expect(row).toMatchObject({ state: 'pending', attempts: 1 });
      expect(row?.lastError).toContain('not usable');
    });
  });

  describe('supersession', () => {
    /** Two decisions on the same question in one group: the older (polling) and the newer (push). */
    const twoDecisions = async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
    };

    it('applies a replacement when both quotes are found, marking the old decision superseded', async () => {
      await twoDecisions();
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'push sync jobs over a websocket', reason: 'Push replaces polling.' }));
      await run();
      const old = await byQuote(POLLING);
      const next = await byQuote(PUSH);
      expect(old).toMatchObject({
        replacedBy: next.id,
        replaceState: 'applied',
        replaceOldQuote: 'poll the server every thirty seconds',
        replaceNewQuote: 'push sync jobs over a websocket',
        replaceReason: 'Push replaces polling.',
      });
      expect(itemOf(old)).toMatchObject({ status: 'superseded', supersededBy: next.itemId });
      expect(itemOf(next)).toMatchObject({ status: 'active', supersededBy: null });
      expect((await decisions()).every((d) => d.checkedAt !== null)).toBe(true);
      expect(notifier.hints).toContainEqual({ kind: 'glob.decisions', boardId, globId: 's1t1' });
    });

    it('only proposes a replacement whose quote is not in the decision (a hint, nothing applied)', async () => {
      await twoDecisions();
      llm.checks.push(replaces({ id: 1, oldQuote: 'we have always polled every thirty seconds', newQuote: 'push sync jobs over a websocket' }));
      await run();
      const old = await byQuote(POLLING);
      expect(old).toMatchObject({ replaceState: 'hint', replacedBy: (await byQuote(PUSH)).id });
      expect(itemOf(old)?.status).toBe('active');
    });

    it('proposes rather than applies when a quote is too short to rest on', async () => {
      await twoDecisions();
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server', newQuote: 'websocket' }));
      await run();
      expect((await byQuote(POLLING)).replaceState).toBe('hint');
    });

    it('ignores a replacement that names an unknown decision, and an empty answer', async () => {
      await twoDecisions();
      llm.checks.push(replaces({ id: 9, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      expect((await decisions()).map((d) => d.replaceState)).toEqual([null, null]);
      expect((await decisions()).every((d) => d.checkedAt !== null)).toBe(true);
    });

    it('does not ask for decisions with no earlier candidate, or from another scope', async () => {
      const a = await addGlob({ id: 's1t1' });
      const b = await addGlob({ id: 's1t2' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${RETRY}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'exponential', answer: extractAnswer({ quote: RETRY, decidedAt: '2026-09-01' }) },
      );
      await run();
      // No shared glob or group, and nothing the keyword search finds: no check call.
      expect(llm.count(SUPERSEDE_SYSTEM)).toBe(0);
      expect((await decisions()).every((d) => d.checkedAt !== null)).toBe(true);
    });

    it('finds semantically near decisions of other globs through the keyword search', async () => {
      const a = await addGlob({ id: 's1t1' });
      const b = await addGlob({ id: 's1t2' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${POLLING} Now every ten seconds, as s1t1 said.`));
      const NEWER = `${POLLING} Now every ten seconds, as s1t1 said.`;
      llm.extractions.push(
        { match: 'Now every ten seconds', answer: extractAnswer({ quote: NEWER, decidedAt: '2026-09-01' }) },
        { match: POLLING, answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'Now every ten seconds' }));
      await run();
      expect(llm.count(SUPERSEDE_SYSTEM)).toBe(1);
      expect((await byQuote(POLLING)).replaceState).toBe('applied');
    });

    it('never applies a replacement for a pair a person undid', async () => {
      await twoDecisions();
      const service = new DecisionService({ store, clock, notifier });
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      const old = await byQuote(POLLING);
      unwrap(await service.undo(DEV, old.id));
      expect(await byQuote(POLLING)).toMatchObject({ replaceState: 'undone' });
      expect(itemOf(old)?.status).toBe('active');
      // The check runs again for the newer decision (its supersession record is reset), and the model says the same.
      const next = await byQuote(PUSH);
      await store.transaction((tx) => tx.updateDecision(next.id, { checkedAt: null }));
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      expect(await byQuote(POLLING)).toMatchObject({ replaceState: 'undone', replacedBy: next.id });
      expect(itemOf(old)?.status).toBe('active');
    });

    it('does not let a superseded decision replace anything, so replacements never cycle', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      // The same moment, each naming the other's glob: each is a candidate for the other.
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ statement: `Against s1t2, ${POLLING}`, quote: POLLING, decidedAt: '2026-09-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: PUSH, newQuote: POLLING }), replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      const states = (await decisions()).map((d) => d.replaceState);
      expect(states.filter((s) => s === 'applied')).toHaveLength(1);
      // The superseded one was not even asked about.
      expect(llm.count(SUPERSEDE_SYSTEM)).toBe(1);
    });

    it('never compares decisions of one source with each other, however much they overlap', async () => {
      const a = await addGlob({ id: 's1t1' });
      const GENERAL = 'Time zones are a server-wide setting and not a per board setting';
      const SPECIFIC = 'The server-wide time zone setting is not stored per board either';
      await addArtifact(a.id, 'plan', `${GENERAL}. ${SPECIFIC}.`);
      llm.extractions.push({ match: 'server-wide', answer: extractAnswer({ quote: GENERAL, decidedAt: '2026-09-01' }, { quote: SPECIFIC, decidedAt: '2026-09-01' }) });
      llm.checks.push(replaces({ id: 1, oldQuote: GENERAL, newQuote: SPECIFIC }));
      await run();
      expect(llm.count(SUPERSEDE_SYSTEM)).toBe(0);
      expect((await decisions()).map((d) => d.replaceState)).toEqual([null, null]);
    });

    it('does not apply a same-source replacement the model names anyway', async () => {
      const a = await addGlob({ id: 's1t1' });
      await addArtifact(a.id, 'plan', `${POLLING}. ${PUSH}.`);
      llm.extractions.push({ match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }, { quote: PUSH, decidedAt: '2026-09-01' }) });
      await run();
      const polling = await byQuote(POLLING);
      const push = await byQuote(PUSH);
      // Even if a stale check answer reached it, the pair is refused when it is written.
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await store.transaction((tx) => tx.updateDecision(push.id, { checkedAt: null }));
      await run();
      expect((await byQuote(POLLING)).replaceState).toBeNull();
      expect(itemOf(polling)?.status).toBe('active');
    });

    it('only proposes a replacement the model does not class as the same subject', async () => {
      await twoDecisions();
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'push sync jobs over a websocket', sameSubject: false }));
      await run();
      const old = await byQuote(POLLING);
      expect(old).toMatchObject({ replaceState: 'hint', replacedBy: (await byQuote(PUSH)).id });
      expect(itemOf(old)?.status).toBe('active');
    });

    it('only proposes a replacement when the answer has no same-subject classification', async () => {
      await twoDecisions();
      llm.checks.push(JSON.stringify({ replaces: [{ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'push sync jobs over a websocket', reason: 'Shared words.' }] }));
      await run();
      expect((await byQuote(POLLING)).replaceState).toBe('hint');
    });

    it('only proposes a replacement across globs unless the newer decision names the older glob', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      const UNNAMED = 'We will push sync jobs over a websocket connection instead of polling';
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${UNNAMED}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: UNNAMED, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'push sync jobs over a websocket' }));
      await run();
      expect(await byQuote(POLLING)).toMatchObject({ replaceState: 'hint', replacedBy: (await byQuote(UNNAMED)).id });
    });

    it('still applies a real contradiction between two sources of one glob', async () => {
      const a = await addGlob({ id: 's1t1' });
      await addArtifact(a.id, 'plan', POLLING);
      await addArtifact(a.id, 'attachment', PUSH, 'Clarifications');
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: 'poll the server every thirty seconds', newQuote: 'push sync jobs over a websocket' }));
      await run();
      expect(await byQuote(POLLING)).toMatchObject({ replaceState: 'applied', replacedBy: (await byQuote(PUSH)).id });
    });

    it('does not offer an already superseded decision as a candidate', async () => {
      await twoDecisions();
      const c = await addGlob({ id: 's1t3', group: 'sync' });
      const LATER = 'We will use server-sent events for all sync jobs from now on';
      await addArtifact(c.id, 'implementation_plan', record(`- ${LATER}`));
      llm.extractions.push({ match: 'server-sent', answer: extractAnswer({ quote: LATER, decidedAt: '2026-10-01' }) });
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }), replaces());
      await run();
      const prompt = llm.calls.filter((c2) => c2.system === SUPERSEDE_SYSTEM).at(-1)?.prompt ?? '';
      expect(prompt).toContain(PUSH);
      expect(prompt).not.toContain(POLLING);
    });

    it('waits without spending attempts while the LLM is unavailable', async () => {
      await twoDecisions();
      llm.checks.push(new LlmUnavailable('Expired', 'Sign in'));
      await run();
      const next = await byQuote(PUSH);
      expect(next).toMatchObject({ checkedAt: null, attempts: 0 });
      expect(next.processAfter).toBe(new Date(Date.parse(START) + LLM_WAIT_MS).toISOString());
      expect(await pipeline.processNext()).toBeNull();
      now = new Date(Date.parse(now) + LLM_WAIT_MS + 1).toISOString();
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      expect(await pipeline.processNext()).toBe(`check:${String(next.id)}`);
      expect((await byQuote(POLLING)).replaceState).toBe('applied');
    });

    it('marks a decision checked after repeated failures so it does not block the queue', async () => {
      await twoDecisions();
      for (let i = 0; i < MAX_PROCESSING_ATTEMPTS; i++) llm.checks.push(new Error('boom'));
      await run();
      for (let i = 0; i < MAX_PROCESSING_ATTEMPTS; i++) {
        now = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
        await pipeline.processNext();
      }
      const next = await byQuote(PUSH);
      expect(next.checkedAt).not.toBeNull();
      expect(next.lastError).toBe('boom');
      expect((await byQuote(POLLING)).replaceState).toBeNull();
    });

    it('ignores an embedder that fails: keyword candidates still reach the check', async () => {
      const a = await addGlob({ id: 's1t1' });
      const b = await addGlob({ id: 's1t2' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      embedder.unavailable = new LlmUnavailable('No access', 'Fix it');
      llm.checks.push(replaces());
      await run();
      // The keyword search still found the older decision: the failed embedder didn't stop the check.
      expect(llm.count(SUPERSEDE_SYSTEM)).toBe(1);
      expect((await decisions()).every((d) => d.checkedAt !== null)).toBe(true);
    });
  });

  describe('people', () => {
    it('lists the decisions of a glob with what replaced them, for members only', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
      const service = new DecisionService({ store, clock, notifier });
      const older = unwrap(await service.forGlob(DEV, boardId, 's1t1'));
      expect(older).toHaveLength(1);
      expect(older[0]).toMatchObject({ status: 'superseded', quote: POLLING, replacedBy: { statement: PUSH, state: 'applied', globId: 's1t2' }, replaces: [] });
      const newer = unwrap(await service.forGlob(DEV, boardId, 's1t2'));
      expect(newer[0]).toMatchObject({ status: 'current', replacedBy: null, replaces: [{ statement: POLLING, state: 'applied' }] });
      expect(errorCode(await service.forGlob(OUTSIDER, boardId, 's1t1'))).toBe('forbidden');
      expect(errorCode(await service.forGlob(DEV, boardId, 's9t9'))).toBe('not_found');
    });

    it('confirms a proposed replacement and undoes an applied one', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: 'we always polled', newQuote: PUSH }));
      await run();
      const service = new DecisionService({ store, clock, notifier });
      const old = await byQuote(POLLING);
      expect(old.replaceState).toBe('hint');
      expect(errorCode(await service.confirm(OUTSIDER, old.id))).toBe('forbidden');
      expect(errorCode(await service.confirm(DEV, old.id, boardId + 1))).toBe('not_found');
      expect(errorCode(await service.confirm(DEV, 9999))).toBe('not_found');
      const confirmed = unwrap(await service.confirm(DEV, old.id, boardId));
      expect(confirmed).toMatchObject({ status: 'superseded', replacedBy: { state: 'confirmed' } });
      expect(itemOf(old)).toMatchObject({ status: 'superseded', supersededBy: (await byQuote(PUSH)).itemId });
      // Only a proposal can be confirmed.
      expect(errorCode(await service.confirm(DEV, old.id))).toBe('invalid_input');
      const undone = unwrap(await service.undo(DEV, old.id));
      expect(undone).toMatchObject({ status: 'current', replacedBy: null });
      expect(await byQuote(POLLING)).toMatchObject({ replaceState: 'undone' });
      expect(itemOf(old)).toMatchObject({ status: 'active', supersededBy: null });
      expect(errorCode(await service.undo(DEV, old.id))).toBe('invalid_input');
      expect(errorCode(await service.undo(OUTSIDER, old.id))).toBe('forbidden');
      expect(notifier.hints.filter((h) => h.kind === 'glob.decisions').length).toBeGreaterThan(0);
    });

    it('refuses to confirm a replacement into a decision that is itself superseded', async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync' });
      const b = await addGlob({ id: 's1t2', group: 'sync' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: 'we always polled', newQuote: PUSH }));
      await run();
      const old = await byQuote(POLLING);
      const next = await byQuote(PUSH);
      await store.transaction((tx) => tx.updateDecision(next.id, { replacedBy: 12345, replaceState: 'applied' }));
      const service = new DecisionService({ store, clock, notifier });
      expect(errorCode(await service.confirm(DEV, old.id))).toBe('invalid_input');
    });
  });

  describe('search and context', () => {
    const seedPair = async () => {
      const a = await addGlob({ id: 's1t1', group: 'sync', title: 'Sync transport' });
      const b = await addGlob({ id: 's1t2', group: 'sync', title: 'Sync rework' });
      await addArtifact(a.id, 'implementation_plan', record(`- ${POLLING}`));
      await addArtifact(b.id, 'implementation_plan', record(`- ${PUSH}`));
      llm.extractions.push(
        { match: 'poll the server', answer: extractAnswer({ quote: POLLING, decidedAt: '2026-06-01' }) },
        { match: 'websocket', answer: extractAnswer({ quote: PUSH, decidedAt: '2026-09-01' }) },
      );
      llm.checks.push(replaces({ id: 1, oldQuote: POLLING, newQuote: PUSH }));
      await run();
    };

    it('returns the current decision first, with its source, and labels the one it replaced', async () => {
      await seedPair();
      const search = new SearchService({ store, clock, embedder });
      const hits = unwrap(await search.text(DEV, { boardId, query: 'sync jobs', sourceTypes: ['decision'] }));
      expect(hits.map((h) => h.status)).toEqual(['active', 'superseded']);
      expect(hits[0]?.citation).toMatchObject({ source: 'decision', globId: 's1t2', link: `/boards/${String(boardId)}?glob=s1t2` });
      expect(hits[1]?.label).toMatch(/^superseded by ".+" on 2026-09-01$/);
      const history = unwrap(await search.text(DEV, { boardId, query: 'sync jobs', mode: 'all_time', sourceTypes: ['decision'] }));
      expect(history).toHaveLength(2);
      expect(history.find((h) => h.status === 'superseded')?.label).toContain('on 2026-09-01');
    });

    it('puts current decisions first in related, leaves out the glob\'s own, and shows superseded ones labelled', async () => {
      await seedPair();
      const asker = await addGlob({ id: 's1t9', title: 'sync jobs', summary: 'How sync jobs reach clients.' });
      await addArtifact(asker.id, 'plan', 'sync jobs plan text mentioning sync jobs many times: sync jobs sync jobs');
      await new SearchIndexer({ store, clock, embedder, changes: { mergedDiff: () => Promise.resolve(null) }, llm }).syncBoard(boardId);
      const search = new SearchService({ store, clock, embedder });
      const related = await store.transaction((tx) => search.related(tx, asker));
      expect(related.length).toBeLessThanOrEqual(RELATED_LIMIT);
      expect(related[0]?.citation.source).toBe('decision');
      expect(related[0]?.status).toBe('active');
      const decisionHits = related.filter((h) => h.citation.source === 'decision');
      expect(decisionHits.map((h) => h.status)).toEqual(['active', 'superseded']);
      expect(related.some((h) => h.citation.globId === 's1t9')).toBe(false);
      // A glob's own decisions aren't repeated in related: they come in the bundle's `decisions`.
      const own = await store.transaction((tx) => search.related(tx, makeGlob({ id: 's1t2', boardId, title: 'sync jobs' })));
      expect(own.some((h) => h.citation.globId === 's1t2')).toBe(false);
    });

    it('gives the context bundle the glob\'s decisions and the order of authority', async () => {
      await seedPair();
      const artifacts = new ArtifactService({ store, clock, notifier });
      const old = unwrap(await artifacts.context(DEV, 's1t1'));
      expect(old.decisions).toHaveLength(1);
      expect(old.decisions[0]).toMatchObject({ status: 'superseded', sourceLabel: 's1t1 implementation record', replacedBy: { statement: PUSH } });
      expect(old.authority).toContain('merged code and the implementation record win');
      expect(old.authority.indexOf('current decisions')).toBeLessThan(old.authority.indexOf('plan.md'));
      expect(unwrap(await artifacts.context(DEV, 's1t2')).decisions[0]).toMatchObject({ status: 'current', replaces: [{ statement: POLLING }] });
    });

    it('is not swept away by the search indexer', async () => {
      await seedPair();
      const before = [...store.state.searchItems.values()].filter((i) => i.sourceType === 'decision').length;
      expect(before).toBe(2);
      const indexer = new SearchIndexer({ store, clock, embedder, changes: { mergedDiff: () => Promise.resolve(null) }, llm });
      await indexer.syncBoard(boardId);
      await indexer.syncBoard(boardId);
      const items = [...store.state.searchItems.values()].filter((i) => i.sourceType === 'decision');
      expect(items).toHaveLength(2);
      expect(items.filter((i) => i.status === 'superseded')).toHaveLength(1);
    });
  });
});
