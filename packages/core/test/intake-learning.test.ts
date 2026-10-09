import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { IntakeService, LlmUnavailable } from '../src/app/intake-service.js';
import type { LlmRequest } from '../src/app/intake-service.js';
import { IntakeLearningService } from '../src/app/intake-learning-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import {
  INTAKE_PROMPT_VERSION,
  collectOutcome,
  examplesDisagree,
  extractPlanFeatures,
  intakeAccuracy,
  outcomeDue,
  selectExamples,
} from '../src/domain/intake-learning.js';
import type { ExampleCandidate, GlobOutcome, IntakeSnapshot } from '../src/domain/intake-learning.js';
import { FakeEmbedder } from '../src/testing/fake-embedder.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const PLAN = `Add learned categorisation.

## Goal
Show intake the nearest past globs.

## Work
- [ ] Add the snapshot table in apps/server/drizzle/0032_intake_learning.sql
- [x] Record snapshots at create
1. Embed the request with the embedder
2) Show examples on the card

## Rollout order
The migration ships first, then the server, then the web page.

Done when:
- examples show on the card
- the System page shows accuracy
Done when the job has run once.
`;

const snapshot = (over: Partial<IntakeSnapshot> & { globId: string }): IntakeSnapshot => ({
  version: 1,
  boardId: 1,
  request: 'request',
  title: 'title',
  summary: 'summary',
  plan: 'plan',
  creator: 'dev@example.com',
  source: 'web',
  decisions: { type: 'same', category: 'feature', group: null, environment: null, categoryConfidence: 'high', reason: null, model: 'm', promptVersion: 2 },
  features: extractPlanFeatures(''),
  examples: [],
  backfilled: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const event = (type: DomainEvent['type'], globId: string, at: string, data: DomainEvent['data'] = {}, actor: string | null = 'dev@example.com'): DomainEvent => ({
  type,
  globId,
  actor,
  at,
  data,
});

describe('extractPlanFeatures', () => {
  it('counts tasks, done-when lines, untasked sections, areas and paths', () => {
    const f = extractPlanFeatures(PLAN);
    expect(f.tasks).toBe(4);
    expect(f.doneWhenLines).toBe(4);
    // "Rollout order" has prose and no tasks; "Goal" is context.
    expect(f.untaskedSections).toBe(1);
    expect(f.areas).toEqual(expect.arrayContaining(['migration', 'server', 'web', 'llm']));
    expect(f.filePaths).toEqual(['apps/server/drizzle/0032_intake_learning.sql']);
    expect(f.words).toBeGreaterThan(40);
  });

  it('is tolerant of an empty or free-form plan', () => {
    expect(extractPlanFeatures('')).toMatchObject({ tasks: 0, doneWhenLines: 0, untaskedSections: 0, areas: [], filePaths: [], words: 0 });
    expect(extractPlanFeatures('Fix the typo in the heading.').tasks).toBe(0);
  });
});

describe('collectOutcome', () => {
  const snap = snapshot({ globId: 's1f1' });
  const merged = '2026-10-03T00:00:00.000Z';
  const base = { snapshot: snap, mergedAt: merged, reviewStats: null, findings: [], bugs: [] };

  it('records a person\'s category and type change, but not the gate\'s own conversion', () => {
    const outcome = collectOutcome({
      ...base,
      now: '2026-10-04T00:00:00.000Z',
      events: [
        event('FieldsChanged', 's1f1', '2026-10-02T00:00:00.000Z', { category: { from: 'feature', to: 'bug' } }),
        event('FieldsChanged', 's1f1', '2026-10-02T01:00:00.000Z', { type: { from: 'same', to: 'sub' } }),
        event('FieldsChanged', 's1f1', '2026-10-02T02:00:00.000Z', { type: { from: 'sub', to: 'same' } }, null),
      ],
    });
    expect(outcome.corrections.category).toMatchObject({ from: 'feature', to: 'bug', by: 'dev@example.com' });
    expect(outcome.corrections.type).toMatchObject({ from: 'same', to: 'sub' });
    expect(outcome.final).toBe(false);
  });

  it('excludes failed builds inherited from a red base and counts the glob\'s own once per commit', () => {
    const outcome = collectOutcome({
      ...base,
      now: '2026-10-20T00:00:00.000Z',
      events: [
        event('BuildCompleted', 's1f1', '2026-10-02T00:00:00.000Z', { passed: false, sha: 'a1' }, null),
        event('BuildCompleted', 's1f1', '2026-10-02T00:10:00.000Z', { passed: false, sha: 'a1' }, null),
        event('BuildCompleted', 's1f1', '2026-10-02T01:00:00.000Z', { passed: false, sha: 'b2', inheritedFrom: 'main' }, null),
        event('BuildCompleted', 's1f1', '2026-10-02T02:00:00.000Z', { passed: true, sha: 'c3' }, null),
      ],
    });
    expect(outcome.tests.ciFailures).toBe(1);
    expect(outcome.final).toBe(true);
  });

  it('reads the gate verdict, review stats, findings, effort and fix globs', () => {
    const sub = snapshot({ globId: 's1t2', decisions: { ...snap.decisions, type: 'sub', category: 'task' } });
    const outcome = collectOutcome({
      snapshot: sub,
      mergedAt: merged,
      now: '2026-10-04T00:00:00.000Z',
      events: [event('SubReviewCompleted', 's1t2', '2026-10-02T12:00:00.000Z', { passed: false, cause: 'size', changedLines: 2400, limit: 2000 }, null)],
      reviewStats: { riskTier: 'normal', reviewRounds: 2, maxReviewRounds: 3, testFailRounds: 1 },
      findings: [
        { severity: 'in_scope', class: 'logic' },
        { severity: 'in_scope', class: null },
      ],
      bugs: [
        { id: 's1b1', title: 'Regression from s1t2', summary: '', createdAt: '2026-10-05T00:00:00.000Z' },
        { id: 's1b2', title: 'Regression from s1t20', summary: '', createdAt: '2026-10-05T00:00:00.000Z' },
        { id: 's1b3', title: 'Late, s1t2', summary: '', createdAt: '2026-12-05T00:00:00.000Z' },
      ],
    });
    expect(outcome.corrections.subConverted).toBe('size');
    expect(outcome.size.changedLines).toBe(2400);
    expect(outcome.review).toMatchObject({ rounds: 2, maxRounds: 3, testFailRounds: 1, findingsBySeverity: { in_scope: 2 }, findingsByClass: { logic: 1 } });
    expect(outcome.effort.calendarHours).toBe(48);
    expect(outcome.postMerge.fixGlobs).toEqual(['s1b1']);
  });

  it('is due when missing, or not final and now past 14 days', () => {
    expect(outcomeDue(merged, null, merged)).toBe(true);
    expect(outcomeDue(merged, { final: false }, '2026-10-10T00:00:00.000Z')).toBe(false);
    expect(outcomeDue(merged, { final: false }, '2026-10-17T00:00:00.000Z')).toBe(true);
    expect(outcomeDue(merged, { final: true }, '2026-12-01T00:00:00.000Z')).toBe(false);
  });
});

describe('selectExamples', () => {
  const outcome = (globId: string, category: 'bug' | null): GlobOutcome => ({
    globId,
    snapshotVersion: 1,
    boardId: 1,
    mergedAt: '2026-10-03T00:00:00.000Z',
    recordedAt: '2026-10-04T00:00:00.000Z',
    final: false,
    corrections: { category: category === null ? null : { from: 'feature', to: category, by: 'dev@example.com', at: '2026-10-02T00:00:00.000Z' }, type: null, subConverted: null, split: false },
    size: { changedLines: null },
    review: { rounds: null, maxRounds: null, testFailRounds: null, findingsBySeverity: {}, findingsByClass: {} },
    tests: { ciFailures: 0 },
    effort: { calendarHours: 10 },
    postMerge: { fixGlobs: [] },
  });
  const candidates: ExampleCandidate[] = [
    { snapshot: snapshot({ globId: 's1f1' }), outcome: null, distance: 0.1 },
    { snapshot: snapshot({ globId: 's1f2' }), outcome: null, distance: 0.2 },
    { snapshot: snapshot({ globId: 's1f3' }), outcome: outcome('s1f3', 'bug'), distance: 0.5 },
  ];

  it('puts corrected examples first and shows their final values', () => {
    const picked = selectExamples(candidates, 2);
    expect(picked.map((e) => e.globId)).toEqual(['s1f3', 's1f1']);
    expect(picked[0]).toMatchObject({ category: 'bug', corrected: true, note: 'category changed feature -> bug' });
  });

  it('says the nearest examples disagree when their categories differ', () => {
    expect(examplesDisagree(selectExamples(candidates))).toBe(true);
    expect(examplesDisagree(selectExamples(candidates.slice(0, 2)))).toBe(false);
  });
});

describe('intakeAccuracy', () => {
  it('counts corrections per month and prompt version, leaving backfilled snapshots out', () => {
    const snaps = [snapshot({ globId: 's1f1' }), snapshot({ globId: 's1f2', createdAt: '2026-11-01T00:00:00.000Z' }), snapshot({ globId: 's1f3', backfilled: true })];
    const base = collectOutcome({ snapshot: snaps[0] as IntakeSnapshot, mergedAt: '2026-10-03T00:00:00.000Z', now: '2026-10-04T00:00:00.000Z', events: [], reviewStats: null, findings: [], bugs: [] });
    const changed: GlobOutcome = {
      ...base,
      globId: 's1f2',
      corrections: { ...base.corrections, category: { from: 'feature', to: 'bug', by: 'a', at: '2026-11-02T00:00:00.000Z' } },
    };
    const accuracy = intakeAccuracy(snaps, [base, changed, { ...base, globId: 's1f3' }]);
    expect(accuracy).toMatchObject({ snapshots: 3, merged: 2, corrected: 1 });
    expect(accuracy.byMonth).toEqual([
      { key: '2026-10', merged: 1, corrected: 0, rate: 0 },
      { key: '2026-11', merged: 1, corrected: 1, rate: 1 },
    ]);
    expect(accuracy.byPromptVersion).toEqual([{ key: 'v2', merged: 2, corrected: 1, rate: 0.5 }]);
    expect(accuracy.byKind.map((k) => k.key)).toEqual(['same/bug', 'same/feature']);
  });
});

describe('intake learning through the services', () => {
  const DEV = 'dev@example.com';
  let store: MemoryStore;
  let embedder: FakeEmbedder;
  let globs: GlobService;
  let now: string;
  let boardId: number;
  let prompts: LlmRequest[];
  let answer: string;
  let intake: IntakeService;
  let learning: IntakeLearningService;

  beforeEach(async () => {
    store = new MemoryStore();
    embedder = new FakeEmbedder();
    now = '2026-10-05T12:00:00.000Z';
    prompts = [];
    answer = '{"title":"T","summary":"S","type":"same","category":"feature","categoryConfidence":"high","categoryReason":"New capability"}';
    const notifier = new RecordingNotifier();
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    const clock = { now: () => now };
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) }, embedder });
    intake = new IntakeService({
      store,
      embedder,
      model: 'haiku',
      llm: {
        complete: (request) => {
          prompts.push(request);
          return Promise.resolve(answer);
        },
      },
    });
    learning = new IntakeLearningService({ store, clock, embedder });
  });

  const create = async (request: string, over: Partial<Parameters<GlobService['create']>[1]> = {}) =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: request.slice(0, 30),
        summary: request,
        plan: `${request}\n\nDone when: it works.`,
        type: 'same',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...over,
      }),
    );
  const snapshots = () => store.transaction((tx) => tx.listLatestIntakeSnapshots(boardId));
  const merge = (globId: string, at: string) => store.transaction((tx) => tx.appendEvents([event('Merged', globId, at, { sha: 'abc' }, null)]));

  it('freezes a snapshot at create with the intake record, the plan features and an embedding', async () => {
    const glob = await create('Export the board as CSV', {
      intake: { request: 'please export the board as csv', source: 'web', categoryConfidence: 'low', reason: 'Unclear', model: 'haiku', promptVersion: 2, examples: ['s1t9'] },
    });
    const [s] = await snapshots();
    expect(s).toMatchObject({
      globId: glob.id,
      version: 1,
      request: 'please export the board as csv',
      source: 'web',
      examples: ['s1t9'],
      backfilled: false,
      decisions: { type: 'same', category: 'feature', categoryConfidence: 'low', reason: 'Unclear', model: 'haiku', promptVersion: 2 },
      features: { doneWhenLines: 1 },
    });
    expect(store.state.intakeSnapshots[0]?.embedding).toHaveLength(1024);
    // Without intake the summary is the request and the source defaults to api; a failing embedder doesn't stop creation.
    embedder.unavailable = new LlmUnavailable('down', 'fix');
    const plain = await create('Another thing');
    expect((await snapshots()).find((x) => x.globId === plain.id)).toMatchObject({ request: 'Another thing', source: 'api', decisions: { categoryConfidence: null, promptVersion: null } });
    expect(store.state.intakeSnapshots.find((r) => r.snapshot.globId === plain.id)?.embedding).toBeNull();
  });

  it('shows intake the nearest examples, corrected ones first, and records the model and prompt version', async () => {
    const plain = await create('Export the board as CSV file');
    const changed = await create('Export the board as a CSV download');
    unwrap(await globs.update(DEV, changed.id, changed.version, { category: 'bug' }));
    now = '2026-10-06T00:00:00.000Z';
    await merge(plain.id, '2026-10-05T13:00:00.000Z');
    await merge(changed.id, '2026-10-05T14:00:00.000Z');
    await learning.run(boardId, now);

    const proposal = unwrap(await intake.propose(DEV, boardId, { text: 'Export the board as CSV', explicit: {} }));
    const prompt = prompts[0]?.prompt ?? '';
    expect(prompt).toContain("Examples from this board's history");
    expect(prompt.indexOf(changed.id)).toBeLessThan(prompt.indexOf(plain.id));
    expect(prompt).toContain('category changed feature -> bug');
    expect(proposal.examples.map((e) => e.globId)).toEqual([changed.id, plain.id]);
    expect(proposal).toMatchObject({ model: 'haiku', promptVersion: INTAKE_PROMPT_VERSION });
    // The nearest two disagree on the category, so the card asks for confirmation.
    expect(proposal.needsConfirmation).toBe(true);
    // A person's explicit category is not second-guessed.
    expect(unwrap(await intake.propose(DEV, boardId, { text: 'Export the board as CSV', explicit: { category: 'task' } })).needsConfirmation).toBe(false);
  });

  it('asks for confirmation on low confidence, and never fails when the embedder does', async () => {
    answer = '{"title":"T","summary":"S","type":"same","category":"task","categoryConfidence":"low","categoryReason":"Could be a bug"}';
    const low = unwrap(await intake.propose(DEV, boardId, { text: 'something odd', explicit: {} }));
    expect(low).toMatchObject({ categoryConfidence: 'low', categoryReason: 'Could be a bug', needsConfirmation: true, examples: [] });
    embedder.unavailable = new LlmUnavailable('down', 'fix');
    const prompt = prompts.length;
    expect(unwrap(await intake.propose(DEV, boardId, { text: 'x', explicit: {} })).examples).toEqual([]);
    expect(prompts.length).toBe(prompt + 1);
    expect(prompts.at(-1)?.prompt).not.toContain('Examples from');
  });

  it('records the outcome at merge, refreshes it at 14 days, then leaves it', async () => {
    const glob = await create('Add a login page');
    now = '2026-10-06T00:00:00.000Z';
    expect(await learning.run(boardId, now)).toMatchObject({ recorded: 0, refreshed: 0 });
    await merge(glob.id, '2026-10-05T18:00:00.000Z');
    expect(await learning.run(boardId, now)).toMatchObject({ recorded: 1, refreshed: 0 });
    expect((await store.transaction((tx) => tx.listGlobOutcomes(boardId)))[0]).toMatchObject({ globId: glob.id, final: false, mergedAt: '2026-10-05T18:00:00.000Z' });
    // Nothing changes before 14 days, and the same run twice is idempotent.
    expect(await learning.run(boardId, '2026-10-10T00:00:00.000Z')).toMatchObject({ recorded: 0, refreshed: 0 });
    expect(await learning.run(boardId, '2026-10-20T00:00:00.000Z')).toMatchObject({ recorded: 0, refreshed: 1 });
    expect((await store.transaction((tx) => tx.listGlobOutcomes(boardId)))[0]).toMatchObject({ final: true });
    expect(await learning.run(boardId, '2026-11-20T00:00:00.000Z')).toMatchObject({ recorded: 0, refreshed: 0 });
  });

  it('backfills snapshots for globs that have none, marked backfilled, and embeds them', async () => {
    const glob = await create('Older work');
    store.state.intakeSnapshots = [];
    expect(await learning.run(boardId, now)).toMatchObject({ backfilled: 1, embedded: 1 });
    expect(await snapshots()).toMatchObject([{ globId: glob.id, backfilled: true, source: 'backfill', decisions: { type: 'same', category: 'feature', promptVersion: null } }]);
    expect(await learning.run(boardId, now)).toMatchObject({ backfilled: 0, embedded: 0 });
  });

  it('shows accuracy to members only', async () => {
    expect(unwrap(await learning.accuracy(DEV, boardId))).toMatchObject({ snapshots: 0, merged: 0 });
    expect((await learning.accuracy('stranger@example.com', boardId)).ok).toBe(false);
  });
});
