import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { relationQuestion } from '../src/domain/questions.js';
import type { NewQuestion } from '../src/domain/questions.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const HEAD = 'a2a88c8aaaa';

const ask = (patch: Partial<NewQuestion> = {}): NewQuestion => ({
  text: 'Does the scope include prod?',
  options: ['Yes, prod is in scope', 'No, staging only'],
  blocking: 'start',
  source: 'create',
  raisedBy: { kind: 'intake', actor: null },
  ...patch,
});

describe('open questions through the services', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;
  let now: string;

  const clock = { now: () => now };
  const create = async (patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'Plan v1', ...patch }));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const effectKinds = (): string[] => store.state.outbox.map((e) => e.kind);
  const attachment = async (id: string, label: string) => (await store.transaction((tx) => tx.listArtifacts(id, 'attachment'))).find((a) => a.label.toLowerCase() === label.toLowerCase());
  const setGlob = (g: Glob): void => {
    store.state.globs.set(g.id, { glob: g, creationKey: null });
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    now = '2026-10-05T12:00:00.000Z';
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService({ store, notifier, clock });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('a sub created with a start question is held with no run; answering releases it, starts it and writes Clarifications', async () => {
    const held = await create({ questions: [ask()] });
    expect(held).toMatchObject({ status: 'planning', type: 'sub', waiting: { since: now }, provisioning: 'none' });
    expect(held.runs).toEqual([]);
    expect(effectKinds()).not.toContain('fire_routine');
    expect(unwrap(await globs.get(ADMIN, held.id)).allowedActions).toEqual(expect.arrayContaining(['start_anyway']));

    const answered = unwrap(await globs.answerQuestion(DEV, held.id, 'q1', { answer: '', option: 'No, staging only' }));
    expect(answered.status).toBe('implementing');
    expect(answered.waiting ?? null).toBeNull();
    expect(answered.runs.map((r) => r.state)).toEqual(['queued']);
    expect(effectKinds()).toEqual(expect.arrayContaining(['provision', 'fire_routine']));
    expect(answered.questions?.[0]?.answer).toEqual({ text: 'No, staging only', option: 'No, staging only', by: DEV, at: now });

    const clarifications = await attachment(held.id, 'Clarifications');
    expect(clarifications).toMatchObject({ label: 'Clarifications', version: 1, provenance: { by: 'human', actor: DEV } });
    expect(clarifications?.content).toContain('Does the scope include prod?');
    expect(clarifications?.content).toContain('**Answer (dev@example.com, 2026-10-05):** No, staging only');
    const events = store.state.events.filter((e) => e.globId === held.id).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['QuestionRaised', 'QuestionAnswered', 'Released']));
  });

  it('appends to an existing Clarifications attachment, keeping its label, as a new version', async () => {
    const held = await create({ questions: [ask()] });
    unwrap(await artifacts.attach(DEV, held.id, { label: 'clarifications', text: 'Earlier: use the new API.', link: null }));
    unwrap(await globs.answerQuestion(DEV, held.id, 'q1', { answer: 'Staging only' }));
    const latest = await attachment(held.id, 'clarifications');
    expect(latest).toMatchObject({ label: 'clarifications', version: 2 });
    expect(latest?.content.startsWith('Earlier: use the new API.\n\n### Q (q1, create, raised by intake')).toBe(true);
    expect((await store.transaction((tx) => tx.listArtifacts(held.id, 'attachment'))).filter((a) => a.label.toLowerCase() === 'clarifications')).toHaveLength(1);
  });

  it('answering the same text twice changes nothing and writes no second entry', async () => {
    const held = await create({ questions: [ask()] });
    unwrap(await globs.answerQuestion(DEV, held.id, 'q1', { answer: 'Staging only' }));
    const version = (await current(held.id)).version;
    unwrap(await globs.answerQuestion(DEV, held.id, 'q1', { answer: 'Staging only' }));
    expect((await current(held.id)).version).toBe(version);
    expect((await attachment(held.id, 'Clarifications'))?.version).toBe(1);
    expect(code(await globs.answerQuestion(DEV, held.id, 'q1', { answer: 'Something else' }))).toBe('invalid_transition');
  });

  it('dismissing releases the hold and records the note, in the question and in Clarifications', async () => {
    const held = await create({ questions: [ask()] });
    const released = unwrap(await globs.dismissQuestion(DEV, held.id, 'q1', { note: 'Prod is not in scope.' }));
    expect(released.status).toBe('implementing');
    expect(released.questions?.[0]?.dismissed).toEqual({ by: DEV, at: now, note: 'Prod is not in scope.' });
    const text = (await attachment(held.id, 'Clarifications'))?.content ?? '';
    expect(text).toContain('**Dismissed (dev@example.com, 2026-10-05):** go ahead as is. Prod is not in scope.');
    expect(store.state.events.some((e) => e.globId === held.id && e.type === 'QuestionDismissed')).toBe(true);
  });

  it('a held same stays in Planning when answered (nothing to start), but Start works again', async () => {
    const held = await create({ type: 'same', questions: [ask()] });
    expect(unwrap(await globs.get(ADMIN, held.id)).allowedActions).not.toContain('start');
    const answered = unwrap(await globs.answerQuestion(DEV, held.id, 'q1', { answer: 'Staging only' }));
    expect(answered.status).toBe('planning');
    expect(unwrap(await globs.get(ADMIN, held.id)).allowedActions).toContain('start');
  });

  it('raising the same key twice is one question', async () => {
    const g = await create({ questions: [] });
    const first = unwrap(await globs.raiseQuestion(null, g.id, { ...ask({ blocking: 'merge', key: 'plan:v2' }) }));
    const second = unwrap(await globs.raiseQuestion(null, g.id, { ...ask({ blocking: 'merge', key: 'plan:v2' }) }));
    expect(first.question?.id).toBe('q1');
    expect(second.question?.id).toBe('q1');
    expect((await current(g.id)).questions).toHaveLength(1);
  });

  it('a start question on a glob that has started is stored as a notice and says so', async () => {
    const g = await create();
    const raised = unwrap(await globs.raiseQuestion(DEV, g.id, ask({ raisedBy: { kind: 'agent', actor: DEV } })));
    expect(raised).toMatchObject({ downgraded: true, ignored: null, question: { blocking: 'none' } });
  });

  describe('a routine run', () => {
    it('can raise a question with its current run ID, and a stale or ended run ID is ignored', async () => {
      const g = await create();
      const runId = (await current(g.id)).runs[0]?.id ?? '';
      const raised = unwrap(await globs.raiseQuestion(DEV, g.id, { ...ask({ blocking: 'merge', source: 'run', raisedBy: { kind: 'routine', actor: DEV, runId } }), runId }));
      expect(raised.question).toMatchObject({ blocking: 'merge', raisedBy: { kind: 'routine', actor: DEV, runId } });
      const stale = unwrap(await globs.raiseQuestion(DEV, g.id, { ...ask({ blocking: 'merge', raisedBy: { kind: 'routine', actor: DEV, runId: 'run-old' } }), runId: 'run-old' }));
      expect(stale).toMatchObject({ ignored: expect.stringContaining('run-old') as string, question: null });
      expect((await current(g.id)).questions).toHaveLength(1);
    });

    it('cannot answer or dismiss a question of its own glob', async () => {
      const g = await create();
      const runId = (await current(g.id)).runs[0]?.id ?? '';
      unwrap(await globs.raiseQuestion(DEV, g.id, { ...ask({ blocking: 'merge', raisedBy: { kind: 'routine', actor: DEV, runId } }), runId }));
      expect(code(await globs.answerQuestion(DEV, g.id, 'q1', { answer: 'go on', runId }))).toBe('forbidden');
      expect(code(await globs.dismissQuestion(DEV, g.id, 'q1', { runId }))).toBe('forbidden');
      expect((await current(g.id)).questions?.[0]?.answer).toBeUndefined();
      expect(await attachment(g.id, 'Clarifications')).toBeUndefined();
    });
  });

  it('non-members cannot raise, answer or dismiss', async () => {
    const held = await create({ questions: [ask()] });
    await store.transaction((tx) => tx.upsertUser({ email: 'out@example.com', name: 'out', active: true }));
    expect(code(await globs.answerQuestion('out@example.com', held.id, 'q1', { answer: 'x' }))).toBe('forbidden');
    expect(code(await globs.dismissQuestion('out@example.com', held.id, 'q1', {}))).toBe('forbidden');
    expect(code(await globs.raiseQuestion('out@example.com', held.id, ask()))).toBe('forbidden');
  });

  it('startHolds (the routine executor\'s last check) includes an open start question', async () => {
    const held = await create({ questions: [ask()] });
    expect((await globs.startHolds(held.id)).map((h) => [h.id, h.state])).toEqual([['q1', 'question']]);
    unwrap(await globs.dismissQuestion(DEV, held.id, 'q1', {}));
    expect(await globs.startHolds(held.id)).toEqual([]);
  });

  describe('plan.md changed during the run', () => {
    /** A same with a ready PR whose checks passed, working since 12:00. */
    const working = async (patch: Partial<Glob> = {}): Promise<Glob> => {
      const g = await create({ type: 'same', autoTrigger: true });
      const next = { ...(await current(g.id)), status: 'pr_open' as const, provisioning: 'ok' as const, pr: { number: 7, state: 'ready' as const, headSha: HEAD }, implementer: null, ...patch };
      setGlob(next);
      return next;
    };

    it('queues the effect in the save, raises a merge question once, and merge when green waits for the answer', async () => {
      const g = await working({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
      now = '2026-10-05T13:00:00.000Z';
      unwrap(await artifacts.putPlan(DEV, g.id, 'Plan v2', 1));
      expect(store.state.outbox.filter((e) => e.kind === 'plan_changed_question')).toHaveLength(1);
      expect(store.state.outbox.find((e) => e.kind === 'plan_changed_question')).toEqual({ kind: 'plan_changed_question', globId: g.id, version: 2 });

      // The executor's call, twice (a retry): one question.
      expect((await globs.raisePlanChanged(g.id, 2))?.ok).toBe(true);
      await globs.raisePlanChanged(g.id, 2);
      const raised = await current(g.id);
      expect(raised.questions).toHaveLength(1);
      expect(raised.questions?.[0]).toMatchObject({
        key: 'plan:v2',
        blocking: 'merge',
        source: 'plan_save',
        text: 'plan.md changed to v2 during the run; the run used v1. Re-run, accept as is, or follow up?',
      });

      // The checks pass: the armed merge holds instead of merging.
      unwrap(await globs.applyEvent(g.id, (x, c, f) => machine.checksCompleted(x, { sha: HEAD, passed: true }, c, f.relations), { relations: true }));
      expect(await current(g.id)).toMatchObject({ status: 'pr_open', mergeMode: 'when_green', mergeHold: { sha: HEAD, questions: ['q1'] } });
      expect(effectKinds()).not.toContain('squash_merge');
      expect(code(await globs.merge(DEV, g.id, (await current(g.id)).version))).toBe('invalid_transition');

      // The answer resumes it, once.
      const resumed = unwrap(await globs.answerQuestion(DEV, g.id, 'q1', { answer: '', option: 'Accept as is' }));
      expect(resumed.status).toBe('merging');
      expect(effectKinds().filter((k) => k === 'squash_merge')).toHaveLength(1);
      expect((await attachment(g.id, 'Clarifications'))?.content).toContain('**Answer (dev@example.com, 2026-10-05):** Accept as is');
    });

    it('queues nothing for the first plan before a run, or once the glob has merged', async () => {
      const planning = await create({ type: 'same' });
      unwrap(await artifacts.putPlan(DEV, planning.id, 'Plan v2', 1));
      expect(store.state.outbox.filter((e) => e.kind === 'plan_changed_question')).toHaveLength(0);
      const g = await working({ status: 'reviewing' });
      now = '2026-10-05T13:00:00.000Z';
      unwrap(await artifacts.putPlan(DEV, g.id, 'Plan v2', 1));
      expect(store.state.outbox.filter((e) => e.kind === 'plan_changed_question')).toHaveLength(0);
      expect(await globs.raisePlanChanged(g.id, 2)).toBeNull();
    });
  });

  it('get_context shows open and answered questions', async () => {
    const g = await create();
    unwrap(await globs.raiseQuestion(DEV, g.id, ask({ blocking: 'merge', raisedBy: { kind: 'agent', actor: DEV } })));
    unwrap(await globs.raiseQuestion(DEV, g.id, ask({ text: 'Second?', blocking: 'none', raisedBy: { kind: 'agent', actor: DEV } })));
    unwrap(await globs.answerQuestion(DEV, g.id, 'q1', { answer: 'Staging only' }));
    const context = unwrap(await artifacts.context(DEV, g.id));
    expect(context.questions.open.map((q) => q.id)).toEqual(['q2']);
    expect(context.questions.answered.map((q) => [q.id, q.answer?.text])).toEqual([['q1', 'Staging only']]);
    expect(context.attachments.find((a) => a.label === 'Clarifications')?.content).toContain('Staging only');
  });

  describe('the risk-signal question for a type nobody chose', () => {
    it('holds a sub whose plan names a risk area path, with a type question and no run', async () => {
      const held = await create({ typeChosen: false, plan: 'Change src/auth/login.ts to rotate tokens.' });
      expect(held).toMatchObject({ type: 'sub', status: 'planning', waiting: { since: now }, provisioning: 'none' });
      expect(held.questions).toMatchObject([{ key: 'type', blocking: 'start', source: 'create', options: ['same', 'sub'], raisedBy: { kind: 'system' } }]);
      expect(held.questions?.[0]?.text).toMatch(/Auth and security/);
      expect(effectKinds()).not.toContain('fire_routine');
    });

    it('matches the files intake guessed too, and keeps the questions the caller passed', async () => {
      const held = await create({ typeChosen: false, files: ['infra/stack.yaml'], questions: [ask({ key: 'intake:scope:1' })] });
      expect(held.questions?.map((q) => q.key)).toEqual(['intake:scope:1', 'type']);
    });

    it('does not ask when the type was chosen, the plan touches no area, or the glob is a same', async () => {
      expect((await create({ plan: 'Change src/auth/login.ts' })).questions).toBeUndefined();
      expect((await create({ typeChosen: false, plan: 'Fix a typo in src/ui/button.ts' })).questions).toBeUndefined();
      expect((await create({ typeChosen: false, type: 'same', plan: 'Change src/auth/login.ts' })).questions).toBeUndefined();
    });

    it('a non-admin\'s unchosen type becomes a same and asks nothing', async () => {
      const made = unwrap(await globs.create(DEV, { boardId, title: 'Work', type: 'sub', typeChosen: false, category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'Change src/auth/login.ts' }));
      expect(made.type).toBe('same');
      expect(made.questions).toBeUndefined();
    });

    it('answering releases it and starts the run; it never changes the type by itself', async () => {
      const held = await create({ typeChosen: false, plan: 'Change src/auth/login.ts' });
      const answered = unwrap(await globs.answerQuestion(ADMIN, held.id, 'q1', { answer: 'sub is fine', option: 'sub' }));
      expect(answered.type).toBe('sub');
      expect((await current(held.id)).waiting).toBeNull();
      expect(effectKinds()).toContain('fire_routine');
    });
  });

  it('a relation question carries the add-relation options and dedupes by target', async () => {
    const g = await create();
    const q = relationQuestion('s1t9', 'The request says to wait for it.', { kind: 'intake', actor: null });
    expect(q).toMatchObject({ key: 'relation:s1t9', blocking: 'none', source: 'relation', options: ['add relation', 'not a prerequisite'] });
    unwrap(await globs.raiseQuestion(null, g.id, q));
    const again = unwrap(await globs.raiseQuestion(null, g.id, q));
    expect((await current(g.id)).questions).toHaveLength(1);
    expect(again.question?.key).toBe('relation:s1t9');
    unwrap(await globs.answerQuestion(ADMIN, g.id, 'q1', { answer: 'not a prerequisite', option: 'not a prerequisite' }));
  });
});
