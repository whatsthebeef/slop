import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { CLASSIFY_SYSTEM, FindingsPipeline, MAX_FINDINGS_PER_SOURCE, SPLIT_INPUT_LIMIT, SPLIT_SYSTEM } from '../src/app/findings-pipeline.js';
import { CODERABBIT_BODY_LIMIT } from '../src/app/findings-service.js';
import { FindingsService } from '../src/app/findings-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import type { Result } from '../src/domain/errors.js';
import type { ReviewFinding, ReviewSource } from '../src/domain/findings.js';
import { LLM_WAITING_PREFIX } from '../src/domain/kb.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const START = '2026-10-05T12:00:00.000Z';

/** A fake LLM answering from a queue of canned answers (or errors), recording each request. */
class FakeLlm implements Llm {
  readonly calls: { system: string; prompt: string }[] = [];
  constructor(private readonly answers: (string | Error)[] = []) {}
  answer(...answers: (string | Error)[]): void {
    this.answers.push(...answers);
  }
  complete(request: LlmRequest): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt });
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

/** A fake LLM that never answers: it only rejects when the caller's deadline aborts the call. */
class HangingLlm implements Llm {
  complete(request: LlmRequest): Promise<string> {
    return new Promise((_, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}

const json = (value: unknown) => JSON.stringify(value);

const STRUCTURED = `## Review (round 1)

#### IN-SCOPE

1. **[src/job.ts:10]** The job retries forever.
2. Missing test for the retry path.

#### SUGGESTIONS

None.
`;

const FREE_FORM = `# Finalise summary

Two review rounds. The reviewer found that the job retries forever when the store is down, and that
nothing tests the retry path. Both were fixed in round 2.
`;

describe('Findings pipeline', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let pipeline: FindingsPipeline;
  let artifacts: ArtifactService;
  let findings: FindingsService;
  let now: string;
  let boardId: number;
  let globId: string;

  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };

  const putReview = async (content: string, commitSha = 'abc1234') =>
    unwrap(await artifacts.putArtifact(DEV, globId, 'local_review', content, { commitSha, runId: null, agentSetVersion: 4 }));

  const sources = () => store.transaction((tx) => tx.listReviewSources(globId));
  const stored = () => store.transaction((tx) => tx.listFindings(globId));
  const finding = async (id: number): Promise<ReviewFinding> => {
    const found = await store.transaction((tx) => tx.getFinding(id));
    if (found === null) throw new Error(`No finding ${String(id)}`);
    return found;
  };
  const source = async (id: number): Promise<ReviewSource> => {
    const found = await store.transaction((tx) => tx.getReviewSource(id));
    if (found === null) throw new Error(`No source ${String(id)}`);
    return found;
  };
  /** Processes everything due, answering every classification with `answer`. */
  const drain = async (answer = json({ class: 'missing-test', note: 'No test' })) => {
    for (let i = 0; i < 50; i++) {
      llm.answer(answer);
      if ((await pipeline.processNext()) === null) return;
    }
    throw new Error('The pipeline did not drain');
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    const clock = { now: () => now };
    llm = new FakeLlm();
    pipeline = new FindingsPipeline({ store, clock, notifier, llm });
    artifacts = new ArtifactService({ store, clock, notifier });
    findings = new FindingsService({ store, clock, notifier });
    const boards = new BoardService({ store, notifier });
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    globId = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Work',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    notifier.hints.length = 0;
  });

  it('queues a local review for splitting when it is put, but no other artifact and no ignored result', async () => {
    const artifact = await putReview(STRUCTURED);
    expect(notifier.hints).toEqual([
      { kind: 'glob.artifacts', boardId, globId },
      { kind: 'glob.findings', boardId, globId },
    ]);
    notifier.hints.length = 0;
    unwrap(await artifacts.putArtifact(DEV, globId, 'postplan', 'Plan', { commitSha: null, runId: null, agentSetVersion: null }));
    expect(notifier.hints).toEqual([{ kind: 'glob.artifacts', boardId, globId }]);
    notifier.hints.length = 0;
    const ignored = unwrap(
      await artifacts.putArtifact(DEV, globId, 'local_review', STRUCTURED, { commitSha: null, runId: 'not-current', agentSetVersion: null }),
    );
    expect(ignored).toMatchObject({ ignored: true });
    expect(notifier.hints).toEqual([]);
    expect(await sources()).toEqual([
      expect.objectContaining({
        kind: 'local_review',
        artifactId: 'id' in artifact ? artifact.id : null,
        boardId,
        commitSha: 'abc1234',
        agentSetVersion: 4,
        state: 'pending',
        attempts: 0,
      }),
    ]);
    expect(llm.calls).toHaveLength(0);
  });

  it("splits a change_reviewer document by its sections without the model, then classifies each finding", async () => {
    await putReview(STRUCTURED);
    notifier.hints.length = 0;
    expect(await pipeline.processNext()).toMatch(/^source:/);
    expect(llm.calls).toHaveLength(0);
    expect((await sources())[0]).toMatchObject({ state: 'split', error: null, processAfter: null });
    expect(await stored()).toEqual([
      expect.objectContaining({
        source: 'local_review',
        severity: 'in_scope',
        round: 1,
        path: 'src/job.ts',
        line: '10',
        text: '**[src/job.ts:10]** The job retries forever.',
        commitSha: 'abc1234',
        agentSetVersion: 4,
        state: 'pending',
      }),
      expect.objectContaining({ severity: 'in_scope', path: null, text: 'Missing test for the retry path.' }),
    ]);
    expect(notifier.hints).toEqual([{ kind: 'glob.findings', boardId, globId }]);

    const [first] = await stored();
    llm.answer(json({ class: 'edge-case', note: 'Retries without a limit\nand more lines' }));
    expect(await pipeline.processNext()).toBe(`finding:${String(first?.id)}`);
    const call = llm.calls[0];
    expect(call?.system).toBe(CLASSIFY_SYSTEM);
    expect(CLASSIFY_SYSTEM).toContain('- missing-test: new or changed behaviour without a test');
    // The finding alone, never the whole review.
    expect(call?.prompt).toContain('src/job.ts:10');
    expect(call?.prompt).toContain('The job retries forever.');
    expect(call?.prompt).not.toContain('Missing test for the retry path.');
    expect(await finding(first?.id ?? 0)).toMatchObject({
      class: 'edge-case',
      classNote: 'Retries without a limit',
      state: 'classified',
      classifiedAt: now,
      processAfter: null,
    });
    expect(notifier.hints).toHaveLength(2);
  });

  it('splits a free-form review with the model, keeping only findings whose quote is in the review', async () => {
    await putReview(FREE_FORM);
    llm.answer(
      json({
        findings: [
          { severity: 'in_scope', path: 'src/job.ts', line: 10, quote: 'the job retries   forever when the store is down', text: 'Retries forever.' },
          { severity: 'suggestion', path: null, line: null, quote: 'nothing tests the retry path', text: '' },
          { severity: 'in_scope', path: null, line: null, quote: 'the cache is never cleared', text: 'Invented.' },
          { severity: 'loud', path: 'has space.ts', line: null, quote: 'Both were fixed', text: 'Not a problem, but quoted.' },
        ],
      }),
    );
    await pipeline.processNext();
    expect(llm.calls[0]?.system).toBe(SPLIT_SYSTEM);
    expect(llm.calls[0]?.prompt).toContain('nothing tests the retry path');
    expect((await stored()).map((f) => ({ severity: f.severity, path: f.path, line: f.line, text: f.text }))).toEqual([
      { severity: 'in_scope', path: 'src/job.ts', line: '10', text: 'Retries forever.' },
      // No text of its own: the quote stands in.
      { severity: 'suggestion', path: null, line: null, text: 'nothing tests the retry path' },
      { severity: 'unknown', path: null, line: null, text: 'Not a problem, but quoted.' },
    ]);
  });

  it('stores a finding repeated in a later version of the review only once', async () => {
    await putReview(STRUCTURED);
    await drain();
    await putReview(`${STRUCTURED.replace('src/job.ts:10', 'src/job.ts:14')}\n## Review (round 2)\n\n#### IN-SCOPE\n\n1. A new problem.\n`, 'def5678');
    await drain();
    expect((await sources()).map((s) => s.state)).toEqual(['split', 'split']);
    expect((await stored()).map((f) => [f.text, f.commitSha])).toEqual([
      ['**[src/job.ts:10]** The job retries forever.', 'abc1234'],
      ['Missing test for the retry path.', 'abc1234'],
      ['A new problem.', 'def5678'],
    ]);
  });

  it('retries an unknown class with backoff, then marks the finding failed after the last attempt', async () => {
    await putReview('#### IN-SCOPE\n\n1. One problem.\n');
    await pipeline.processNext();
    const [only] = await stored();
    const id = only?.id ?? 0;
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      llm.answer(json({ class: 'vibes', note: 'n' }));
      expect(await pipeline.processNext()).toBe(`finding:${String(id)}`);
      const current = await finding(id);
      expect(current).toMatchObject({ attempts: attempt, error: 'The model answered an unknown class: vibes' });
      if (attempt < MAX_PROCESSING_ATTEMPTS) {
        expect(current.state).toBe('pending');
        // Backing off: not due again until the backoff ends.
        expect(await pipeline.processNext()).toBeNull();
        advance(30_000 * 2 ** (attempt - 1));
      }
    }
    expect(await finding(id)).toMatchObject({ state: 'failed', processAfter: null });
    expect(notifier.hints.at(-1)).toEqual({ kind: 'glob.findings', boardId, globId });
    expect(await pipeline.processNext()).toBeNull();
  });

  it('waits without counting an attempt while the LLM is unavailable', async () => {
    await putReview(FREE_FORM);
    for (let probe = 0; probe < MAX_PROCESSING_ATTEMPTS + 1; probe++) {
      llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
      expect(await pipeline.processNext()).toMatch(/^source:/);
      expect(await pipeline.processNext()).toBeNull();
      advance(60_000);
    }
    expect((await sources())[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
      error: `${LLM_WAITING_PREFIX}AWS sign-in expired`,
    });
    // It carries on once the LLM is back.
    llm.answer(json({ findings: [{ severity: 'in_scope', path: null, line: null, quote: 'nothing tests the retry path', text: 'No test.' }] }));
    await pipeline.processNext();
    expect((await sources())[0]).toMatchObject({ state: 'split', error: null });

    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    await pipeline.processNext();
    expect((await stored())[0]).toMatchObject({ state: 'pending', attempts: 0, error: `${LLM_WAITING_PREFIX}AWS sign-in expired` });
  });

  it('fails a hanging call at its deadline and backs off', async () => {
    // The split has its own, longer deadline than classification.
    pipeline = new FindingsPipeline({ store, clock: { now: () => now }, notifier, llm: new HangingLlm(), llmTimeoutMs: 20, splitTimeoutMs: 40 });
    await putReview(FREE_FORM);
    await pipeline.processNext();
    const [current] = await sources();
    expect(current).toMatchObject({ state: 'pending', attempts: 1, error: 'The model did not answer within 0.04 s' });
    expect(current?.processAfter).toBe(new Date(Date.parse(now) + 30_000).toISOString());
  });

  it('never lets two calls claim the same source while one holds its lease', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      called = resolve;
    });
    const gated: Llm = {
      complete: async () => {
        called();
        await gate;
        return json({ findings: [] });
      },
    };
    pipeline = new FindingsPipeline({ store, clock: { now: () => now }, notifier, llm: gated });
    await putReview(FREE_FORM);
    const first = pipeline.processNext();
    await reached;
    try {
      // The source is leased and nothing else is due.
      expect(await pipeline.processNext()).toBeNull();
    } finally {
      release();
    }
    expect(await first).toMatch(/^source:/);
    expect((await sources())[0]?.state).toBe('split');
  });

  it("drops a split whose glob was deleted during the model's call", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      called = resolve;
    });
    const gated: Llm = {
      complete: async () => {
        called();
        await gate;
        return json({ findings: [{ severity: 'in_scope', path: null, line: null, quote: 'nothing tests the retry path', text: 'x' }] });
      },
    };
    pipeline = new FindingsPipeline({ store, clock: { now: () => now }, notifier, llm: gated });
    await putReview(FREE_FORM);
    const running = pipeline.processNext();
    await reached;
    await store.transaction((tx) => tx.deleteGlob(globId));
    release();
    await running;
    expect(store.state.findings).toEqual([]);
    expect(store.state.reviewSources).toEqual([]);
  });

  it('writes no findings when the conditional write marking the source split fails (s15f8)', async () => {
    await putReview(STRUCTURED);
    // A store whose source update loses the race even though the version read matched.
    const transaction = store.transaction.bind(store);
    store.transaction = <T>(work: Parameters<typeof transaction<T>>[0]) =>
      transaction<T>((tx) =>
        work({ ...tx, updateReviewSource: (next, expected) => (next.state === 'split' ? Promise.resolve(false) : tx.updateReviewSource(next, expected)) }),
      );
    notifier.hints.length = 0;
    await pipeline.processNext();
    expect(store.state.findings).toEqual([]);
    expect(notifier.hints).toEqual([]);
  });

  it('splits a blank local review into no findings without the model (s15f8)', async () => {
    await putReview(STRUCTURED);
    // Puts refuse blank content, so blank the stored review (as an artifact with no text would be).
    store.state.artifacts = store.state.artifacts.map((a) => ({ ...a, content: '  \n\t\n' }));
    expect(await pipeline.processNext()).toMatch(/^source:/);
    expect(llm.calls).toHaveLength(0);
    expect((await sources())[0]).toMatchObject({ state: 'split', error: null });
    expect(await stored()).toEqual([]);
  });

  it("shows why processing waits while the LLM is unavailable (s15f8)", async () => {
    await putReview(FREE_FORM);
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Run aws sso login'));
    await pipeline.processNext();
    expect(unwrap(await findings.forGlob(DEV, globId))).toMatchObject({ sources: { pending: 1 }, waiting: 'AWS sign-in expired' });
    advance(LLM_WAIT_MS);
    llm.answer(json({ findings: [{ severity: 'in_scope', path: null, line: null, quote: 'nothing tests the retry path', text: 'No test.' }] }));
    await pipeline.processNext();
    expect(unwrap(await findings.forGlob(DEV, globId)).waiting).toBeNull();
    llm.answer(new LlmUnavailable('No model access', 'Request access'));
    await pipeline.processNext();
    expect(unwrap(await findings.forGlob(DEV, globId))).toMatchObject({ pending: 1, waiting: 'No model access' });
  });

  it('turns a CodeRabbit comment into one finding without the model, once per comment', async () => {
    const comment = {
      externalId: 'coderabbit:991',
      body: '_⚠️ Potential issue_\n\n**Unchecked null** on `user`.\n\n<details>\n<summary>Prompt for AI agents</summary>\nx\n</details>',
      path: 'src/user.ts',
      line: '42',
      commitSha: 'feed123',
    };
    const recorded = unwrap(await findings.recordCodeRabbitComment(globId, comment));
    expect(recorded).toMatchObject({ kind: 'coderabbit_comment', externalId: 'coderabbit:991', artifactId: null });
    expect(unwrap(await findings.recordCodeRabbitComment(globId, comment))).toBeNull();
    expect(await findings.recordCodeRabbitComment('s9t9', comment)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await pipeline.processNext();
    expect(llm.calls).toHaveLength(0);
    expect(await stored()).toEqual([
      expect.objectContaining({
        source: 'coderabbit',
        severity: 'in_scope',
        path: 'src/user.ts',
        line: '42',
        commitSha: 'feed123',
        text: '_⚠️ Potential issue_\n\n**Unchecked null** on `user`.',
      }),
    ]);
  });

  it("shows members a glob's findings with counts per class, and refuses others", async () => {
    await putReview(STRUCTURED);
    await drain();
    const view = unwrap(await findings.forGlob(DEV, globId));
    expect(view).toMatchObject({
      byClass: [{ class: 'missing-test', total: 2, inScope: 2, suggestions: 0 }],
      pending: 0,
      failed: 0,
      sources: { pending: 0, failed: 0 },
      waiting: null,
    });
    expect(view.findings).toHaveLength(2);
    expect(await findings.forGlob(OUTSIDER, globId)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await findings.forGlob(DEV, 's9t9')).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('deletes findings and sources with their glob', async () => {
    await putReview(STRUCTURED);
    await drain();
    expect(await stored()).toHaveLength(2);
    await store.transaction((tx) => tx.deleteGlob(globId));
    expect(await stored()).toEqual([]);
    expect(await sources()).toEqual([]);
  });

  it('fails a source whose review artifact is gone without retrying', async () => {
    await store.transaction(async (tx) => {
      await tx.insertReviewSource({
        boardId,
        globId,
        kind: 'local_review',
        artifactId: 999,
        externalId: null,
        commitSha: null,
        agentSetVersion: null,
        content: null,
        path: null,
        line: null,
        createdAt: now,
      });
    });
    await pipeline.processNext();
    const [gone] = await sources();
    expect(await source(gone?.id ?? 0)).toMatchObject({ state: 'failed', error: 'The review is no longer stored' });
  });

  it('retries an unusable split answer with backoff, then fails the source after the last attempt (s15f8)', async () => {
    await putReview(FREE_FORM);
    notifier.hints.length = 0;
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
      llm.answer('Sorry, I cannot help with that.');
      expect(await pipeline.processNext()).toMatch(/^source:/);
      const [current] = await sources();
      expect(current).toMatchObject({ attempts: attempt, error: 'The split answer was not usable JSON' });
      if (attempt < MAX_PROCESSING_ATTEMPTS) {
        expect(current?.state).toBe('pending');
        expect(current?.processAfter).toBe(new Date(Date.parse(now) + 30_000 * 2 ** (attempt - 1)).toISOString());
        // Only the final failure is worth a hint.
        expect(notifier.hints).toEqual([]);
        advance(30_000 * 2 ** (attempt - 1));
      }
    }
    expect((await sources())[0]).toMatchObject({ state: 'failed', processAfter: null });
    expect(notifier.hints).toEqual([{ kind: 'glob.findings', boardId, globId }]);
    expect(await stored()).toEqual([]);
    expect(await pipeline.processNext()).toBeNull();
    expect(unwrap(await findings.forGlob(DEV, globId)).sources).toEqual({ pending: 0, failed: 1 });
  });

  it('keeps at most MAX_FINDINGS_PER_SOURCE findings from the split model (s15f8)', async () => {
    const many = Array.from({ length: 70 }, (_, i) => `Problem number ${String(i)} is here.`).join('\n');
    await putReview(`# Summary\n\n${many}\n`);
    llm.answer(
      json({
        findings: Array.from({ length: 70 }, (_, i) => ({
          severity: 'suggestion',
          path: null,
          line: null,
          quote: `Problem number ${String(i)} is here`,
          text: `Problem ${String(i)}.`,
        })),
      }),
    );
    await pipeline.processNext();
    const kept = await stored();
    expect(kept).toHaveLength(MAX_FINDINGS_PER_SOURCE);
    expect(kept.at(-1)?.text).toBe(`Problem ${String(MAX_FINDINGS_PER_SOURCE - 1)}.`);
  });

  it('shows the split model only the first SPLIT_INPUT_LIMIT characters and drops quotes from beyond them (s15f8)', async () => {
    await putReview(`# Summary\n\nEarly problem: the cache is never cleared.\n${'.'.repeat(SPLIT_INPUT_LIMIT)}\nLate problem: the queue never drains.\n`);
    llm.answer(
      json({
        findings: [
          { severity: 'in_scope', path: null, line: null, quote: 'the cache is never cleared', text: 'Cache.' },
          { severity: 'in_scope', path: null, line: null, quote: 'the queue never drains', text: 'Queue.' },
        ],
      }),
    );
    await pipeline.processNext();
    expect(llm.calls[0]?.prompt).not.toContain('Late problem');
    expect((await stored()).map((f) => f.text)).toEqual(['Cache.']);
  });

  it('lets another call take a source whose lease ran out, as after a crashed worker (s15f8)', async () => {
    await putReview(FREE_FORM);
    const [queued] = await sources();
    if (queued === undefined) throw new Error('No source');
    // A worker claimed it and died before writing anything back.
    await store.transaction((tx) =>
      tx.updateReviewSource({ ...queued, processAfter: new Date(Date.parse(now) + 2 * 60_000).toISOString(), version: queued.version + 1 }, queued.version),
    );
    expect(await pipeline.processNext()).toBeNull();
    advance(2 * 60_000);
    llm.answer(json({ findings: [{ severity: 'in_scope', path: null, line: null, quote: 'nothing tests the retry path', text: 'No test.' }] }));
    expect(await pipeline.processNext()).toBe(`source:${String(queued.id)}`);
    expect((await sources())[0]).toMatchObject({ state: 'split', attempts: 0 });
  });

  it('never lets two calls claim the same finding while one holds its lease (s15f8)', async () => {
    await putReview('#### IN-SCOPE\n\n1. Only problem.\n');
    await pipeline.processNext();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      called = resolve;
    });
    let calls = 0;
    const gated: Llm = {
      complete: async () => {
        calls++;
        called();
        await gate;
        return json({ class: 'scope', note: 'n' });
      },
    };
    pipeline = new FindingsPipeline({ store, clock: { now: () => now }, notifier, llm: gated });
    const first = pipeline.processNext();
    await reached;
    try {
      expect(await pipeline.processNext()).toBeNull();
    } finally {
      release();
    }
    expect(await first).toMatch(/^finding:/);
    expect(calls).toBe(1);
    expect((await stored())[0]).toMatchObject({ state: 'classified', class: 'scope' });
  });

  it("accepts 'other' with its note, in any case, cutting a long note (s15f8)", async () => {
    await putReview('#### IN-SCOPE\n\n1. Only problem.\n');
    await pipeline.processNext();
    llm.answer(json({ class: ' Other ', note: `Would be "observability": ${'n'.repeat(300)}` }));
    await pipeline.processNext();
    const [only] = await stored();
    expect(only).toMatchObject({ state: 'classified', class: 'other' });
    expect(only?.classNote).toHaveLength(200);
    expect(only?.classNote?.startsWith('Would be "observability"')).toBe(true);
  });

  it('counts a non-JSON classification as a failed attempt (s15f8)', async () => {
    await putReview('#### IN-SCOPE\n\n1. Only problem.\n');
    await pipeline.processNext();
    llm.answer('missing-test');
    await pipeline.processNext();
    expect((await stored())[0]).toMatchObject({ state: 'pending', attempts: 1, error: 'The class answer was not usable JSON', class: null });
  });

  it('publishes a hint when a CodeRabbit comment is queued, caps its body, and splits an empty comment into nothing (s15f8)', async () => {
    const recorded = unwrap(
      await findings.recordCodeRabbitComment(globId, {
        externalId: 'coderabbit:1',
        body: 'w'.repeat(CODERABBIT_BODY_LIMIT + 500),
        path: null,
        line: null,
        commitSha: null,
      }),
    );
    expect(recorded?.content).toHaveLength(CODERABBIT_BODY_LIMIT);
    expect(notifier.hints).toEqual([{ kind: 'glob.findings', boardId, globId }]);
    // A repeat is not queued and not hinted.
    notifier.hints.length = 0;
    unwrap(await findings.recordCodeRabbitComment(globId, { externalId: 'coderabbit:1', body: 'x', path: null, line: null, commitSha: null }));
    expect(notifier.hints).toEqual([]);

    unwrap(
      await findings.recordCodeRabbitComment(globId, {
        externalId: 'coderabbit:2',
        body: '<details>\n<summary>Committable suggestion</summary>\nx\n</details>',
        path: 'a.ts',
        line: '1',
        commitSha: null,
      }),
    );
    await pipeline.processNext();
    await pipeline.processNext();
    expect(llm.calls).toHaveLength(0);
    expect((await sources()).map((s) => s.state)).toEqual(['split', 'split']);
    // The long comment is one finding, cut to the finding text limit; the empty one none.
    expect((await stored()).map((f) => f.text.length)).toEqual([4000]);
  });
});
