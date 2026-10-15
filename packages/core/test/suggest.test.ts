import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { KbPipeline } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import { boardLearnings } from '../src/app/learning-reads.js';
import { DecisionGlobService } from '../src/app/decision-glob-service.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import type { LearningAssessmentFacts } from '../src/domain/decision-glob.js';
import { SuggestService } from '../src/app/suggest-service.js';
import type { Result } from '../src/domain/errors.js';
import { suggestEffect } from '../src/domain/events.js';
import type { Glob } from '../src/domain/types.js';
import {
  checkSuggestion,
  overlappingMerges,
  prefillOf,
  readSuggestion,
  RULES_MODEL,
  recentOutcomes,
  renderSuggestion,
  rulesSuggestion,
  siblingLearnings,
  SUGGEST_PROMPT_VERSION,
  SUGGEST_SIBLINGS_MAX,
  SUGGESTION_LABEL,
  suggestionStale,
} from '../src/domain/suggestion.js';
import type { StoredSuggestion, Suggestion } from '../src/domain/suggestion.js';
import type { Catalog } from '../src/ports.js';
import { MemoryKbQueue } from '../src/testing/kb-queue.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { learningSeed } from '../src/testing/learning-seed.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';
const BUILD_DOC = '---\narea: build\naudience: [implementer]\ndescription: Build and test commands\n---\n# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n';
const catalog: Catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h1', files: [] }) };

class FakeLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  private readonly answers: (string | Error)[] = [];
  answer(...answers: (string | Error)[]): void {
    this.answers.push(...answers);
  }
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const suggestion = (patch: Partial<Suggestion> = {}): Suggestion => ({ action: 'approve', reason: 'The draft is right.', editedDraft: null, mergeInto: null, mergedText: null, ...patch });

describe('checkSuggestion', () => {
  const learning = { siblingIds: ['s1k2'], learning: true };
  it('accepts each action with what it needs', () => {
    expect(checkSuggestion({ action: 'approve', reason: 'Sound.' }, learning)).toEqual({ ok: true, value: suggestion({ reason: 'Sound.' }) });
    expect(checkSuggestion({ action: 'approve_with_edit', reason: 'r', editedDraft: 'new' }, learning)).toMatchObject({ ok: true, value: { editedDraft: 'new' } });
    expect(checkSuggestion({ action: 'merge_into', reason: 'r', mergeInto: 's1k2', mergedText: 'both' }, learning)).toMatchObject({ ok: true, value: { mergeInto: 's1k2', mergedText: 'both' } });
    expect(checkSuggestion({ action: 'reject', reason: 'Moot.', editedDraft: 'ignored' }, learning)).toMatchObject({ ok: true, value: { editedDraft: null } });
  });

  it('refuses an unknown mergeInto, a missing edited draft or merged text, an unknown action and no reason', () => {
    expect(checkSuggestion({ action: 'merge_into', reason: 'r', mergeInto: 's1k9', mergedText: 'x' }, learning).ok).toBe(false);
    expect(checkSuggestion({ action: 'merge_into', reason: 'r', mergeInto: null, mergedText: 'x' }, learning).ok).toBe(false);
    expect(checkSuggestion({ action: 'merge_into', reason: 'r', mergeInto: 's1k2' }, learning).ok).toBe(false);
    expect(checkSuggestion({ action: 'approve_with_edit', reason: 'r', editedDraft: '  ' }, learning).ok).toBe(false);
    expect(checkSuggestion({ action: 'delete', reason: 'r' }, learning).ok).toBe(false);
    expect(checkSuggestion({ action: 'approve', reason: '' }, learning).ok).toBe(false);
    expect(checkSuggestion(null, learning).ok).toBe(false);
  });

  it('offers approve and reject only for a decision with no knowledge item', () => {
    const plain = { siblingIds: [], learning: false };
    expect(checkSuggestion({ action: 'reject', reason: 'r' }, plain).ok).toBe(true);
    expect(checkSuggestion({ action: 'approve_with_edit', reason: 'r', editedDraft: 'x' }, plain).ok).toBe(false);
  });
});

describe('stored suggestions', () => {
  const stored = (patch: Partial<StoredSuggestion> = {}): StoredSuggestion => ({
    suggestion: suggestion({ action: 'approve_with_edit', editedDraft: 'Line one\nLine two' }),
    model: 'm',
    at: START,
    stamp: { draftVersion: 2, targetVersion: 3, promptVersion: SUGGEST_PROMPT_VERSION },
    ...patch,
  });

  it('round-trips through the artifact text', () => {
    const value = stored();
    const text = renderSuggestion(value);
    expect(text).toContain('Approve with an edit');
    expect(readSuggestion(text)).toEqual(value);
    expect(readSuggestion('## Assessment\n\nNone.')).toBeNull();
  });

  it('is stale once the draft or the target moved, or the prompt changed', () => {
    const value = stored();
    expect(suggestionStale(value, value.stamp)).toBe(false);
    expect(suggestionStale(value, { ...value.stamp, draftVersion: 3 })).toBe(true);
    expect(suggestionStale(value, { ...value.stamp, targetVersion: 4 })).toBe(true);
    expect(suggestionStale(value, { ...value.stamp, promptVersion: SUGGEST_PROMPT_VERSION + 1 })).toBe(true);
  });

  it('pre-fills the decide form: approve, approve with the edit, reject with the reason, or a merge as a rejection naming the other learning', () => {
    expect(prefillOf(suggestion())).toEqual({ outcome: 'accept' });
    expect(prefillOf(suggestion({ action: 'approve_with_edit', editedDraft: 'x' }))).toEqual({ outcome: 'accept_with_edits', editedDraft: 'x' });
    expect(prefillOf(suggestion({ action: 'reject', reason: 'Moot.' }))).toEqual({ outcome: 'reject', reason: 'Moot.' });
    expect(prefillOf(suggestion({ action: 'merge_into', mergeInto: 's1k4', mergedText: 't', reason: 'Same fact.' }))).toEqual({ outcome: 'reject', reason: 'Merged into s1k4: Same fact.' });
  });
});

describe('suggest', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let knowledge: KnowledgeService;
  let globs: GlobService;
  let pipeline: KbPipeline;
  let queue: MemoryKbQueue;
  let drafter: FakeLlm;
  let llm: FakeLlm;
  let suggest: SuggestService;
  let now: string;
  let boardId: number;
  let workId: string;
  const clock = { now: () => now };

  const item = async (id: string) => {
    const found = await store.transaction((tx) => learningSeed(tx).readSeeded(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  /** A learning aimed at the Lint section of the build doc and drafted. */
  const drafted = async (statement: string, content: string, patch: Partial<NewLearning> = {}) => {
    const made = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: workId, type: 'gotcha', statement, evidence: `Evidence for ${statement}`, ...patch }));
    unwrap(await knowledge.changeTarget(ADMIN, made.id, (await item(made.id)).version, { kind: 'doc', name: 'build_test_lint', section: 'Lint' }));
    drafter.answer(JSON.stringify({ section: 'Lint', content, rationale: 'r' }));
    expect(await queue.process(made.id)).toBe(true);
    return made;
  };
  const glob = async (id: string): Promise<Glob> => {
    const found = await store.transaction((tx) => tx.getGlob(id));
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const jobs = () => store.state.outbox.filter((e) => e.kind === 'suggest_decision');
  const reads = () => store.transaction((tx) => boardLearnings(tx, boardId));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    drafter = new FakeLlm();
    llm = new FakeLlm();
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    pipeline = new KbPipeline({ store, clock, catalog, notifier, route: new FakeLlm(), draft: drafter });
    queue = new MemoryKbQueue(store, pipeline, clock, notifier);
    suggest = new SuggestService({ store, clock, notifier, knowledge, llm, model: 'test-model' });
    const boards = new BoardService({ store, notifier });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    workId = unwrap(await globs.create(ADMIN, { boardId, title: 'Existing work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null })).id;
    unwrap(await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'upload'));
  });

  describe('input assembly', () => {
    it('picks the other open learnings on the same target, with their drafts, and leaves out decided ones and other targets', async () => {
      const first = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      const second = await drafted('Lint the whole repo', 'Run eslint . from the root.');
      const other = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: workId, type: 'gotcha', statement: 'Unrouted', evidence: 'e' }));
      const all = await reads();
      const read = all.find((l) => l.glob.id === first.id);
      if (read === undefined) throw new Error('missing');
      const siblings = siblingLearnings(read, all);
      expect(siblings.map((s) => s.id)).toEqual([second.id]);
      expect(siblings[0]?.section).toBe('Lint');
      expect(siblings[0]?.draft).toContain('Run eslint . from the root.');
      expect(siblings.map((s) => s.id)).not.toContain(other.id);
      // Once the second is approved it is an outcome, not a sibling.
      unwrap(await knowledge.approve(ADMIN, second.id, (await item(second.id)).version, { as: 'draft' }));
      const after = await reads();
      const again = after.find((l) => l.glob.id === first.id);
      if (again === undefined) throw new Error('missing');
      expect(siblingLearnings(again, after)).toEqual([]);
      expect(recentOutcomes(again, after).map((o) => o.id)).toEqual([second.id]);
    });

    it('caps the siblings', async () => {
      for (let i = 0; i < SUGGEST_SIBLINGS_MAX + 3; i++) await drafted(`Learning number ${String(i)}`, `Content ${String(i)}`);
      const all = await reads();
      const [read] = all;
      if (read === undefined) throw new Error('missing');
      expect(siblingLearnings(read, all)).toHaveLength(SUGGEST_SIBLINGS_MAX);
    });

    it('picks merged work since the learning was submitted whose title or summary overlaps its area', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      const self = await glob(made.id);
      const work = (id: string, title: string, summary: string, updatedAt: string): Glob => ({ ...self, id, category: 'task', title, updatedAt, status: 'signed_off' });
      const after = '2026-10-06T00:00:00.000Z';
      const merged = [
        work('s1t7', 'Make eslint run in the lint section', 'Warnings now fail the build_test_lint run', after),
        work('s1t8', 'Rename the login button', 'Styling only', after),
        work('s1t9', 'Old eslint change', 'eslint lint warnings', '2026-10-01T00:00:00.000Z'),
      ];
      const picked = overlappingMerges(self, ['build_test_lint', 'Lint', self.title], merged);
      expect(picked.map((m) => m.id)).toEqual(['s1t7']);
      expect(overlappingMerges(self, [], merged)).toEqual([]);
    });
  });

  describe('the recommendation is always there and never older than the draft', () => {
    const latest = async (id: string) => {
      const versions = await store.transaction((tx) => tx.artifactVersions(id, 'assessment', SUGGESTION_LABEL));
      const last = versions.at(-1);
      return { count: versions.length, stored: last === undefined ? null : readSuggestion(last.content) };
    };

    it('leans on the statement alone at creation, then is written again once routed and drafted, with no model call', async () => {
      const made = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: workId, type: 'gotcha', statement: 'Lint with warnings as errors', evidence: 'Seen twice' }));
      const first = await latest(made.id);
      expect(first.stored).toMatchObject({ model: RULES_MODEL, suggestion: { action: 'approve' }, stamp: { draftVersion: null } });
      expect(first.stored?.suggestion.reason).toContain('statement alone');

      unwrap(await knowledge.changeTarget(ADMIN, made.id, (await item(made.id)).version, { kind: 'doc', name: 'build_test_lint', section: 'Lint' }));
      drafter.answer(JSON.stringify({ section: 'Lint', content: 'Run eslint --max-warnings 0.', rationale: 'r' }));
      expect(await queue.process(made.id)).toBe(true);
      const after = await latest(made.id);
      expect(after.count).toBeGreaterThan(first.count);
      expect(after.stored?.stamp.draftVersion).not.toBeNull();
      expect(after.stored?.suggestion.reason).toBe('Drafted, and nothing was flagged.');
      expect(llm.requests).toEqual([]);
      const view = unwrap(await suggest.view(ADMIN, made.id));
      expect(view.stale).toBe(false);
    });

    it('is written again when the learning is drafted again, and never replaces a model answer made for the current draft', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      llm.answer(JSON.stringify({ action: 'approve', reason: 'Sound.' }));
      unwrap(await suggest.request(ADMIN, made.id));
      expect(await suggest.run(made.id)).toBe('done');
      const modelled = await latest(made.id);
      expect(modelled.stored?.model).toBe('test-model');
      // Assessing again (nothing moved) keeps the model's answer.
      const decisions = new DecisionGlobService({ store, clock, notifier, knowledge, globs });
      unwrap(await decisions.assess(ADMIN, made.id));
      expect((await latest(made.id)).count).toBe(modelled.count);
    });

    it('leans to reject, never to nothing, when the statement may already be covered', () => {
      const attributes: DecisionAttributes = { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null };
      const facts: LearningAssessmentFacts = {
        status: 'open',
        coveredBy: null,
        possiblyCoveredBy: { knowledgeKind: 'doc', name: 'build_test_lint', section: 'Lint', quote: 'Run eslint.', reason: 'Already says it' },
        contradicts: [],
        catalogCandidate: false,
        staleSince: null,
        processing: 'drafted',
        document: null,
        target: null,
        draft: null,
        occurrenceCount: 1,
        sourceGlobIds: [],
      };
      const stored = rulesSuggestion({ attributes, item: facts, preview: null, conflicts: [] }, 1, START);
      expect(stored.suggestion.action).toBe('reject');
      expect(stored.suggestion.reason).toContain('safer');
      expect(rulesSuggestion({ attributes, item: { ...facts, possiblyCoveredBy: null }, preview: null, conflicts: [] }, null, START).suggestion.action).toBe('approve');
    });
  });

  describe('a new draft queues a recommendation for a picked-up learning only', () => {
    it('queues none for an unpicked learning, one after a redraft once picked up', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      expect(jobs()).toHaveLength(0);
      unwrap(await globs.pickUp(ADMIN, made.id, (await glob(made.id)).version, false));
      // Picking up asks for one straight away.
      expect(jobs()).toHaveLength(1);
      // The first job ran: a pending one would absorb the next.
      store.state.outboxJobs = store.state.outboxJobs.map((j) => (j.kind === 'suggest_decision' ? { ...j, state: 'done' as const } : j));
      store.state.outbox = store.state.outbox.filter((e) => e.kind !== 'suggest_decision');
      // Retargeting redrafts against the new section.
      unwrap(await knowledge.changeTarget(ADMIN, made.id, (await item(made.id)).version, { kind: 'doc', name: 'build_test_lint', section: 'Test' }));
      drafter.answer(JSON.stringify({ section: 'Test', content: 'Run vitest run.', rationale: 'r' }));
      expect(await queue.process(made.id)).toBe(true);
      expect(jobs()).toHaveLength(1);
    });
  });

  describe('request and run', () => {
    const answer = (value: unknown) => llm.answer(JSON.stringify(value));

    it('queues one job on demand, for admins and POs only', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      expect((await suggest.request(DEV, made.id)).ok).toBe(false);
      expect(jobs()).toEqual([]);
      unwrap(await suggest.request(ADMIN, made.id));
      unwrap(await suggest.request(ADMIN, made.id));
      expect(jobs()).toEqual([suggestEffect(made.id)]);
      expect((await suggest.request(ADMIN, workId)).ok).toBe(false);
    });

    it('asks the model once with the inputs and stores the answer as a labelled assessment version, then marks it stale when the target changes', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      const rival = await drafted('Lint the whole repo', 'Run eslint . from the root.');
      answer({ action: 'merge_into', reason: `Same section as ${rival.id}.`, mergeInto: rival.id, mergedText: 'Run eslint . --max-warnings 0.' });
      expect(await suggest.run(made.id)).toBe('done');

      const [request] = llm.requests;
      expect(request?.spend).toEqual({ boardId, source: 'suggest', globId: made.id });
      expect(request?.prompt).toContain(`${rival.id} (section "Lint")`);
      expect(request?.prompt).toContain('Run eslint --max-warnings 0.');
      expect(request?.prompt).toContain('Run eslint.');

      const versions = (await store.transaction((tx) => tx.artifactVersions(made.id, 'assessment', SUGGESTION_LABEL))).filter((v) => readSuggestion(v.content)?.model !== RULES_MODEL);
      expect(versions).toHaveLength(1);
      // The deterministic assessment (no label) is untouched.
      expect((await store.transaction((tx) => tx.artifactVersions(made.id, 'assessment', ''))).every((a) => !a.content.includes('## Suggestion'))).toBe(true);

      const viewed = unwrap(await suggest.view(ADMIN, made.id));
      expect(viewed).toMatchObject({ stale: false, pending: false, suggestion: { model: 'test-model', suggestion: { action: 'merge_into', mergeInto: rival.id } } });
      expect(notifier.hints).toContainEqual({ kind: 'glob.artifacts', boardId, globId: made.id });

      // Approving the rival moves the target's version and drafts this one again: the model's answer no longer matches, so the rules' recommendation for the new draft replaces it as the latest.
      unwrap(await knowledge.approve(ADMIN, rival.id, (await item(rival.id)).version, { as: 'draft' }));
      expect(unwrap(await suggest.view(ADMIN, made.id))).toMatchObject({ stale: false, suggestion: { model: RULES_MODEL } });
    });

    it('does not store an answer that merges into an unknown learning: the attempt fails', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      answer({ action: 'merge_into', reason: 'r', mergeInto: 's1k99', mergedText: 'x' });
      await expect(suggest.run(made.id)).rejects.toThrow(/Unusable suggestion/);
      expect((await store.transaction((tx) => tx.artifactVersions(made.id, 'assessment', SUGGESTION_LABEL))).filter((v) => readSuggestion(v.content)?.model !== RULES_MODEL)).toEqual([]);
      llm.answer('not json at all');
      await expect(suggest.run(made.id)).rejects.toThrow(/Unusable suggestion/);
    });

    it('waits without spending an attempt while the model is unavailable or busy, and drops a job whose glob is gone', async () => {
      const made = await drafted('Lint with warnings as errors', 'Run eslint --max-warnings 0.');
      llm.answer(new LlmUnavailable('AWS sign-in expired', 'Sign in'));
      const down = await suggest.run(made.id);
      expect(down).toMatchObject({ state: 'pending' });
      expect(JSON.stringify(down)).toContain('AWS sign-in expired');
      llm.answer(new LlmBusy());
      const busy = await suggest.run(made.id);
      expect(busy).toMatchObject({ state: 'pending' });
      expect(JSON.stringify(busy)).toContain('Bedrock busy');
      expect(await suggest.run('s1k404')).toBe('dropped');
    });
  });
});
