import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import {
  appendClarification,
  canAnswer,
  checkNewQuestion,
  clarificationEntry,
  mergeQuestions,
  nextQuestionId,
  planChangedQuestion,
  questionAwaits,
  startHoldsOf,
  startQuestions,
} from '../src/domain/questions.js';
import type { NewQuestion, OpenQuestion } from '../src/domain/questions.js';
import type { Glob } from '../src/domain/types.js';
import { NOW, board, ctx, dev, glob, other, po, relationFacts, run } from './fixtures.js';

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = (result: Result<Transition>): string | null => (result.ok ? null : result.error.code);
const message = (result: Result<Transition>): string => (result.ok ? '' : result.error.message);
const effectKinds = (t: Transition) => t.effects.map((e) => e.kind);

const ask = (patch: Partial<NewQuestion> = {}): NewQuestion => ({
  text: 'Does the scope include prod?',
  blocking: 'start',
  source: 'create',
  raisedBy: { kind: 'intake', actor: null },
  ...patch,
});
const stored = (patch: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: 'q1',
  text: 'Does the scope include prod?',
  raisedBy: { kind: 'intake', actor: null },
  source: 'create',
  blocking: 'start',
  raisedAt: NOW,
  ...patch,
});
const HEAD = 'a2a88c8aaaa';
const open = (patch: Partial<Glob> = {}): Glob =>
  glob({ id: 's1t2', status: 'pr_open', type: 'same', pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' }, implementer: dev.email, ...patch });

const createInput = (patch: Partial<m.CreateInput> = {}): m.CreateInput => ({
  id: 's1t1',
  boardId: 1,
  title: 'Fix login timeout',
  type: 'sub',
  category: 'task',
  group: null,
  environment: null,
  autoTrigger: false,
  ...patch,
});

describe('question helpers', () => {
  it('splits open start and merge holds, and ignores answered, dismissed, overridden and notice questions', () => {
    const g = glob({
      questions: [
        stored(),
        stored({ id: 'q2', blocking: 'merge' }),
        stored({ id: 'q3', blocking: 'none' }),
        stored({ id: 'q4', answer: { text: 'yes', by: dev.email, at: NOW } }),
        stored({ id: 'q5', blocking: 'merge', dismissed: { by: dev.email, at: NOW, note: null } }),
        stored({ id: 'q6', startOverridden: { by: dev.email, at: NOW } }),
      ],
    });
    expect(startQuestions(g).map((q) => q.id)).toEqual(['q1']);
    expect(mergeQuestions(g).map((q) => q.id)).toEqual(['q2']);
    expect(questionAwaits(g)).toEqual([{ id: 'q1', state: 'question', why: 'Waiting for an answer: Does the scope include prod?' }]);
  });

  it('startHoldsOf lists start relations first, then questions', () => {
    const g = glob({ id: 's1t2', questions: [stored()] });
    const holds = startHoldsOf(g, relationFacts('s1t2', [['s1t1', 'open']]));
    expect(holds.map((h) => h.id)).toEqual(['s1t1', 'q1']);
  });

  it('allocates the next ID past the highest, not the count', () => {
    expect(nextQuestionId([])).toBe('q1');
    expect(nextQuestionId([{ id: 'q1' }, { id: 'q7' }, { id: 'odd' }])).toBe('q8');
  });

  it('checks text, options and key, and trims them', () => {
    expect(checkNewQuestion(ask({ text: '   ' })).ok).toBe(false);
    expect(checkNewQuestion(ask({ text: 'x'.repeat(1001) })).ok).toBe(false);
    expect(checkNewQuestion(ask({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).ok).toBe(false);
    expect(checkNewQuestion(ask({ options: ['same', 'Same'] })).ok).toBe(false);
    const ok = checkNewQuestion(ask({ text: ' Prod? ', options: [' yes ', '', 'no'], key: ' k ' }));
    expect(ok.ok && ok.value).toMatchObject({ text: 'Prod?', options: ['yes', 'no'], key: 'k' });
  });

  it('a run of this glob can never answer; a member without a run can', () => {
    const g = glob({ runs: [run({ id: 'run-9' })] });
    expect(canAnswer(g, 'run-9')).toBe(false);
    expect(canAnswer(g, undefined)).toBe(true);
    expect(canAnswer(g, null)).toBe(true);
    expect(canAnswer(g, 'run-elsewhere')).toBe(true);
  });

  it('writes the Clarifications entry for an answer and for a dismissal, and appends to what is there', () => {
    const answered = stored({ id: 'q2', source: 'plan_save', raisedBy: { kind: 'system', actor: null }, answer: { text: 'Re-run', option: 'Re-run', by: dev.email, at: '2026-10-06T08:00:00.000Z' } });
    expect(clarificationEntry(answered)).toBe(
      '### Q (q2, plan save, raised by system, 2026-10-05)\nDoes the scope include prod?\n**Answer (dev@example.com, 2026-10-06):** Re-run',
    );
    const dismissed = stored({ dismissed: { by: other.email, at: NOW, note: 'Prod is out of scope.' } });
    expect(clarificationEntry(dismissed)).toContain('**Dismissed (other@example.com, 2026-10-05):** go ahead as is. Prod is out of scope.');
    expect(appendClarification('', answered)).toBe(clarificationEntry(answered));
    expect(appendClarification('Earlier note\n', answered)).toBe(`Earlier note\n\n${clarificationEntry(answered)}`);
  });
});

describe('planChangedQuestion', () => {
  const versions = [
    { version: 1, createdAt: '2026-10-05T10:00:00.000Z' },
    { version: 2, createdAt: '2026-10-05T12:30:00.000Z' },
  ];
  const working = (patch: Partial<Glob> = {}): Glob => glob({ status: 'implementing', runs: [run({ queuedAt: '2026-10-05T11:00:00.000Z' })], ...patch });

  it('asks while the run works, naming the version it used', () => {
    expect(planChangedQuestion(working(), versions, 2)).toMatchObject({
      key: 'plan:v2',
      blocking: 'merge',
      source: 'plan_save',
      options: ['Re-run', 'Accept as is', 'Follow up'],
      text: 'plan.md changed to v2 during the run; the run used v1. Re-run, accept as is, or follow up?',
    });
  });

  it('counts v1 as used even when it was written a moment after the run was queued (both are made with the glob)', () => {
    const created = [{ version: 1, createdAt: '2026-10-05T11:00:00.050Z' }, { version: 2, createdAt: '2026-10-05T11:05:00.000Z' }];
    expect(planChangedQuestion(working(), created, 2)?.text).toContain('the run used v1');
    expect(planChangedQuestion(working(), created, 1)).toBeNull();
  });

  it('asks after the run ended too, until the glob merges', () => {
    const ended = working({ status: 'pr_open', runs: [run({ state: 'ended', outcome: 'completed', queuedAt: '2026-10-05T11:00:00.000Z' })] });
    expect(planChangedQuestion(ended, versions, 2)).not.toBeNull();
    expect(planChangedQuestion({ ...ended, status: 'reviewing' }, versions, 2)).toBeNull();
    expect(planChangedQuestion({ ...ended, status: 'signed_off' }, versions, 2)).toBeNull();
  });

  it('asks nothing for a plan saved before the run, without a run, or for investigate-only runs', () => {
    expect(planChangedQuestion(working({ runs: [run({ queuedAt: '2026-10-05T13:00:00.000Z' })] }), versions, 2)).toBeNull();
    expect(planChangedQuestion(glob({ runs: [] }), versions, 2)).toBeNull();
    expect(planChangedQuestion(working({ runs: [run({ purpose: 'investigate', queuedAt: '2026-10-05T11:00:00.000Z' })] }), versions, 2)).toBeNull();
  });

  it('counts a work run even when an investigation ran after it', () => {
    const runs = [run({ id: 'run-1', queuedAt: '2026-10-05T11:00:00.000Z' }), run({ id: 'run-2', purpose: 'investigate', queuedAt: '2026-10-05T13:00:00.000Z' })];
    expect(planChangedQuestion(working({ runs }), versions, 2)).not.toBeNull();
  });
});

describe('question commands', () => {
  it('checks and trims them', () => {
    expect(checkNewQuestion(ask({ commands: ['a', 'b', 'c', 'd', 'e', 'f'] })).ok).toBe(false);
    expect(checkNewQuestion(ask({ commands: ['x'.repeat(301)] })).ok).toBe(false);
    expect(checkNewQuestion(ask({ commands: ['one\ntwo'] })).ok).toBe(false);
    const ok = checkNewQuestion(ask({ commands: [' git status ', ' '] }));
    expect(ok.ok && ok.value.commands).toEqual(['git status']);
  });

  it('are stored on the raised question', () => {
    const t = value(m.raiseQuestion(glob({ type: 'sub', status: 'implementing', runs: [run()] }), ask({ blocking: 'merge', commands: ['bash x.sh'] }), ctx(dev)));
    expect(t.glob.questions?.[0]?.commands).toEqual(['bash x.sh']);
  });
});

describe('raising a question (row Q1)', () => {
  it('stores it with the next ID and logs QuestionRaised', () => {
    const t = value(m.raiseQuestion(glob({ type: 'sub', status: 'implementing', runs: [run()] }), ask({ blocking: 'merge', options: ['a', 'b'] }), ctx(dev)));
    expect(t.glob.questions).toEqual([{ id: 'q1', text: 'Does the scope include prod?', options: ['a', 'b'], raisedBy: { kind: 'intake', actor: null }, source: 'create', blocking: 'merge', raisedAt: NOW }]);
    expect(t.events.map((e) => [e.type, e.data])).toEqual([['QuestionRaised', { id: 'q1', blocking: 'merge', source: 'create', raisedBy: 'intake' }]]);
  });

  it('a repeated key changes nothing, even once answered', () => {
    const g = glob({ questions: [stored({ key: 'plan:v2', answer: { text: 'ok', by: dev.email, at: NOW } })] });
    expect(value(m.raiseQuestion(g, ask({ key: 'plan:v2' }), ctx(null))).changed).toBe(false);
    expect(value(m.raiseQuestion(g, ask({ key: 'plan:v3' }), ctx(null))).glob.questions?.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('holds a sub in Planning as waiting, and a same without marking it waiting', () => {
    const sub = value(m.raiseQuestion(glob({ type: 'sub' }), ask(), ctx(null))).glob;
    expect(sub.waiting).toEqual({ since: NOW });
    expect(m.allowedActions(sub, dev)).toEqual(expect.arrayContaining(['start_anyway']));
    const same = value(m.raiseQuestion(glob({ type: 'same' }), ask(), ctx(null))).glob;
    expect(same.waiting ?? null).toBeNull();
    const actions = m.allowedActions(same, dev);
    expect(actions).not.toContain('start');
    expect(actions).toContain('start_anyway');
  });

  it('stores a start question as a notice once the glob has started, and on a super', () => {
    expect(value(m.raiseQuestion(glob({ type: 'sub', status: 'implementing' }), ask(), ctx(null))).glob.questions?.[0]?.blocking).toBe('none');
    expect(value(m.raiseQuestion(glob({ type: 'super' }), ask(), ctx(null))).glob.questions?.[0]?.blocking).toBe('none');
  });

  it('refuses a merge question on a merged glob, and makes one a notice while the merge is under way', () => {
    expect(code(m.raiseQuestion(glob({ status: 'reviewing' }), ask({ blocking: 'merge' }), ctx(null)))).toBe('invalid_transition');
    expect(value(m.raiseQuestion(glob({ status: 'merging' }), ask({ blocking: 'merge' }), ctx(null))).glob.questions?.[0]?.blocking).toBe('none');
  });

  it('refuses decision and action globs, bad input and a 21st question', () => {
    expect(code(m.raiseQuestion(glob({ category: 'decision', type: null }), ask(), ctx(null)))).toBe('invalid_transition');
    expect(code(m.raiseQuestion(glob(), ask({ text: '' }), ctx(null)))).toBe('invalid_input');
    const full = glob({ questions: Array.from({ length: 20 }, (_, i) => stored({ id: `q${String(i + 1)}` })) });
    expect(code(m.raiseQuestion(full, ask(), ctx(null)))).toBe('invalid_input');
  });
});

describe('a question at creation', () => {
  it('holds a sub in Planning: waiting, no provisioning, no run', () => {
    const t = value(m.create(createInput({ questions: [ask()] }), board, ctx()));
    expect(t.glob).toMatchObject({ status: 'planning', waiting: { since: NOW }, provisioning: 'none', runs: [] });
    expect(t.glob.questions).toEqual([expect.objectContaining({ id: 'q1', blocking: 'start' })]);
    expect(effectKinds(t)).toEqual([]);
    expect(t.events.map((e) => e.type)).toEqual(['GlobCreated', 'QuestionRaised', 'Waiting']);
  });

  it('a notice question does not hold, and a same only hides Start', () => {
    const sub = value(m.create(createInput({ questions: [ask({ blocking: 'none' })] }), board, ctx()));
    expect(sub.glob.status).toBe('implementing');
    expect(effectKinds(sub)).toEqual(['provision', 'fire_routine']);
    const same = value(m.create(createInput({ type: 'same', questions: [ask()] }), board, ctx()));
    expect(same.glob.status).toBe('planning');
    expect(m.allowedActions(same.glob, dev)).not.toContain('start');
  });

  it('a held sub also keeps its relations in view', () => {
    const t = value(m.create(createInput({ questions: [ask()] }), board, ctx(), relationFacts('s1t1', [['s1t0', 'open']])));
    const waiting = t.events.find((e) => e.type === 'Waiting');
    expect(waiting?.data['for']).toEqual(['s1t0', 'q1']);
  });

  it('dedupes by key, and checks every question', () => {
    const t = value(m.create(createInput({ questions: [ask({ key: 'type' }), ask({ key: 'type' })] }), board, ctx()));
    expect(t.glob.questions).toHaveLength(1);
    expect(code(m.create(createInput({ questions: [ask({ text: '' })] }), board, ctx()))).toBe('invalid_input');
  });
});

describe('the start gate and open start questions', () => {
  const held = (patch: Partial<Glob> = {}): Glob => glob({ type: 'sub', status: 'planning', waiting: { since: NOW }, questions: [stored()], ...patch });

  it('Start is refused with the question in the reason', () => {
    const same = glob({ type: 'same', questions: [stored()] });
    const refused = m.start(same, ctx(dev));
    expect(code(refused)).toBe('invalid_transition');
    expect(message(refused)).toBe('Waiting for an answer: Does the scope include prod? (use Start now)');
  });

  it('released changes nothing while a start question is open, and starts the sub once none is', () => {
    expect(value(m.released(held(), ctx(null))).changed).toBe(false);
    const answered = held({ questions: [stored({ answer: { text: 'no', by: dev.email, at: NOW } })] });
    const t = value(m.released(answered, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'implementing', waiting: null });
    expect(effectKinds(t)).toContain('fire_routine');
  });

  it('Start now goes past the hold, stamps the question and records it, leaving it open', () => {
    const t = value(m.startAnyway(held(), ctx(dev)));
    expect(t.glob.status).toBe('implementing');
    expect(t.glob.questions?.[0]).toMatchObject({ startOverridden: { by: dev.email, at: NOW } });
    expect(t.glob.questions?.[0]?.answer).toBeUndefined();
    expect(t.events.find((e) => e.type === 'HoldOverridden')?.data).toEqual({ for: ['q1'], questions: ['q1'] });
    expect(m.allowedActions(held(), dev)).toContain('start_anyway');
    expect(m.allowedActions(held(), dev)).not.toContain('start');
  });

  it('picking the glob up by hand is past the start question too', () => {
    const t = value(m.pickUp(held(), ctx(dev), board, { takeOver: false }));
    expect(t.glob.questions?.[0]?.startOverridden).toBeDefined();
  });

  it('a Start waiting for an investigation goes back to waiting when a question was raised since', () => {
    const queued = glob({ type: 'same', status: 'planning', waiting: { since: NOW, investigation: { runId: 'run-0', by: dev.email } }, runs: [run({ id: 'run-0', purpose: 'investigate', state: 'active' })], questions: [stored()] });
    const t = value(m.investigationPushed(queued, 'run-0', ctx(null)));
    expect(t.glob.status).toBe('planning');
    expect(t.events.map((e) => e.type)).toContain('Waiting');
  });
});

describe('answering and dismissing (rows Q2 and Q3)', () => {
  const g = (patch: Partial<Glob> = {}): Glob => glob({ questions: [stored({ options: ['same', 'sub'] })], ...patch });

  it('records the answer, the option and who, and logs QuestionAnswered', () => {
    const t = value(m.answerQuestion(g(), { questionId: 'q1', answer: '', option: 'SAME' }, ctx(po)));
    expect(t.glob.questions?.[0]?.answer).toEqual({ text: 'same', option: 'same', by: po.email, at: NOW });
    expect(t.events.map((e) => [e.type, e.data])).toEqual([['QuestionAnswered', { id: 'q1', blocking: 'start', option: 'same' }]]);
    expect(value(m.answerQuestion(g(), { questionId: 'q1', answer: ' Prod is out ' }, ctx(dev))).glob.questions?.[0]?.answer?.text).toBe('Prod is out');
  });

  it('needs an answer, a real option and a question that exists', () => {
    expect(code(m.answerQuestion(g(), { questionId: 'q1', answer: '' }, ctx(dev)))).toBe('invalid_input');
    expect(code(m.answerQuestion(g(), { questionId: 'q1', answer: '', option: 'maybe' }, ctx(dev)))).toBe('invalid_input');
    expect(code(m.answerQuestion(g(), { questionId: 'q9', answer: 'x' }, ctx(dev)))).toBe('invalid_input');
  });

  it('is idempotent for the same answer and refuses a different one, or one after a dismissal', () => {
    const answered = value(m.answerQuestion(g(), { questionId: 'q1', answer: 'no' }, ctx(dev))).glob;
    expect(value(m.answerQuestion(answered, { questionId: 'q1', answer: 'no' }, ctx(dev))).changed).toBe(false);
    expect(code(m.answerQuestion(answered, { questionId: 'q1', answer: 'yes' }, ctx(dev)))).toBe('invalid_transition');
    const dismissed = value(m.dismissQuestion(g(), { questionId: 'q1' }, ctx(dev))).glob;
    expect(code(m.answerQuestion(dismissed, { questionId: 'q1', answer: 'yes' }, ctx(dev)))).toBe('invalid_transition');
    expect(code(m.dismissQuestion(answered, { questionId: 'q1' }, ctx(dev)))).toBe('invalid_transition');
  });

  it('dismissing records who and the note, and a second dismissal changes nothing', () => {
    const t = value(m.dismissQuestion(g(), { questionId: 'q1', note: ' fine ' }, ctx(dev)));
    expect(t.glob.questions?.[0]?.dismissed).toEqual({ by: dev.email, at: NOW, note: 'fine' });
    expect(t.events.map((e) => [e.type, e.data])).toEqual([['QuestionDismissed', { id: 'q1', blocking: 'start', note: 'fine' }]]);
    expect(value(m.dismissQuestion(t.glob, { questionId: 'q1' }, ctx(dev))).changed).toBe(false);
  });

  it('a run of this glob can neither answer nor dismiss', () => {
    const withRun = g({ runs: [run({ id: 'run-5' })] });
    expect(code(m.answerQuestion(withRun, { questionId: 'q1', answer: 'x', runId: 'run-5' }, ctx(dev)))).toBe('forbidden');
    expect(code(m.dismissQuestion(withRun, { questionId: 'q1', runId: 'run-5' }, ctx(dev)))).toBe('forbidden');
  });

  it('QA and PO members may answer', () => {
    expect(value(m.answerQuestion(g(), { questionId: 'q1', answer: 'x' }, ctx(po))).changed).toBe(true);
  });
});

describe('the merge gate and open merge questions', () => {
  const asked = [stored({ blocking: 'merge' })];

  it('Merge is refused with the question, and not offered', () => {
    const g = open({ questions: asked });
    const refused = m.requestMerge(g, ctx(dev), { continue: false });
    expect(code(refused)).toBe('invalid_transition');
    expect(message(refused)).toBe('Waiting for an answer: Does the scope include prod?');
    expect(m.allowedActions(g, dev)).not.toContain('merge');
    expect(m.allowedActions(open(), dev)).toContain('merge');
  });

  it('Retry merge is refused while it is open', () => {
    const failed = open({ status: 'failed', failure: { reason: 'GitHub had not decided', at: NOW, kind: 'merge' }, questions: asked });
    expect(code(m.retryMerge(failed, ctx(dev)))).toBe('invalid_transition');
    expect(value(m.retryMerge({ ...failed, questions: [] }, ctx(dev))).glob.status).toBe('merging');
  });

  it('an armed merge stays armed, holds with the question IDs once, and does not squash-merge', () => {
    const armed = open({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' }, questions: asked });
    const held = value(m.checksCompleted(armed, { sha: HEAD, passed: true }, ctx(null)));
    expect(held.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green', mergeHold: { sha: HEAD, for: [], questions: ['q1'] } });
    expect(effectKinds(held)).not.toContain('squash_merge');
    expect(held.events.filter((e) => e.type === 'MergeHeld').map((e) => e.data)).toEqual([{ for: [], sha: HEAD, questions: ['q1'] }]);
    expect(value(m.checksCompleted(held.glob, { sha: HEAD, passed: true }, ctx(null))).events.filter((e) => e.type === 'MergeHeld')).toEqual([]);
  });

  it('a sub whose gate passed stays in pr_open, held', () => {
    const sub = open({ type: 'sub', implementer: null, questions: asked });
    const held = value(m.subGateCompleted(sub, { sha: HEAD, passed: true, reason: null }, ctx(null)));
    expect(held.glob.status).toBe('pr_open');
    expect(held.glob.mergeHold).toMatchObject({ sha: HEAD, questions: ['q1'] });
    expect(effectKinds(held)).not.toContain('squash_merge');
  });

  it('gateReleased resumes after the answer, once', () => {
    const answered = [stored({ blocking: 'merge', answer: { text: 'ok', by: dev.email, at: NOW } })];
    const armed = open({ mergeMode: 'when_green', mergeHold: { since: NOW, sha: HEAD, for: [], questions: ['q1'] }, questions: asked });
    expect(value(m.gateReleased(armed, { relations: [], states: new Map() }, null, ctx(null))).changed).toBe(false);
    const resumed = value(m.gateReleased({ ...armed, questions: answered }, { relations: [], states: new Map() }, null, ctx(null)));
    expect(resumed.glob).toMatchObject({ status: 'merging', mergeMode: null, mergeHold: null });
    expect(resumed.effects).toEqual([{ kind: 'squash_merge', globId: armed.id, generation: armed.generation, sha: HEAD }]);
  });

  it('a start question does not hold a merge, and a merge question does not hold a start', () => {
    expect(m.allowedActions(open({ questions: [stored()] }), dev)).toContain('merge');
    const same = glob({ type: 'same', questions: [stored({ blocking: 'merge' })] });
    expect(m.allowedActions(same, dev)).toContain('start');
  });
});

describe('questionLine titles', () => {
  it('is the first sentence, without code spans, cut at a word', async () => {
    const { questionLine } = await import('../src/domain/questions.js');
    expect(questionLine({ text: 'Pre-merge check (review finding #4). Run `bash .reviews/s14b3-pool-trigger-check.sh <profile>` in the repo.' })).toBe('Pre-merge check (review finding #4).');
    expect(questionLine({ text: 'Run `x`.' })).toBe('Run `x`.'.replace(/`/g, ''));
    const long = questionLine({ text: `${'word '.repeat(40)}end` });
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith(' word…') || long.endsWith('word…')).toBe(true);
  });
});
