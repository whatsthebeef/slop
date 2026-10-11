import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { IntakeService } from '../src/app/intake-service.js';
import type { LlmRequest } from '../src/app/intake-service.js';
import { TypeLearningService } from '../src/app/type-learning-service.js';
import type { Result } from '../src/domain/errors.js';
import { defaultAreas } from '../src/domain/risk-area.js';
import {
  TYPE_DEFAULTS,
  TYPE_EXAMPLES_MAX,
  extractTypeSignals,
  typeCorrectionLine,
  typeLearningBlock,
} from '../src/domain/type-learning.js';
import type { TypeCorrection } from '../src/domain/type-learning.js';
import type { Glob } from '../src/domain/types.js';
import type { Tx } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PO = 'po@example.com';
const NOW = '2026-10-11T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const AREAS = defaultAreas(1, NOW);
const OPEN_PLAN = [
  '## Goal',
  'Pick where the data lives.',
  '',
  '## Open questions',
  '- Which store holds it?',
  '- Who owns the schema?',
  '',
  'Discuss with the team before building. Touches apps/server/src/auth/session.ts.',
].join('\n');
const SETTLED_PLAN = [
  '## Tasks',
  '- [ ] Rename the label',
  '- [ ] Update the test',
  '',
  'Done when: the label reads Start.',
].join('\n');

describe('extractTypeSignals', () => {
  it('reads open questions, decision wording, risk-area files and the task count from the plan', () => {
    expect(extractTypeSignals(OPEN_PLAN, AREAS)).toEqual({
      openQuestions: 2,
      decisionWording: true,
      riskAreaFiles: ['apps/server/src/auth/session.ts'],
      sizeTasks: null,
    });
  });

  it('a settled plan has no questions, no decision wording and counts its tasks', () => {
    expect(extractTypeSignals(SETTLED_PLAN, AREAS)).toEqual({
      openQuestions: 0,
      decisionWording: false,
      riskAreaFiles: [],
      sizeTasks: 2,
    });
  });

  it('counts undecided lines outside a questions section, and a decisions heading as decision wording', () => {
    const signals = extractTypeSignals('## Decisions\nThe storage is TBD.\n', AREAS);
    expect(signals).toMatchObject({ openQuestions: 1, decisionWording: true });
  });

  it('an empty plan gives empty signals, and only the board areas decide the risk-area files', () => {
    expect(extractTypeSignals('', AREAS)).toEqual({
      openQuestions: 0,
      decisionWording: false,
      riskAreaFiles: [],
      sizeTasks: null,
    });
    expect(extractTypeSignals(OPEN_PLAN, []).riskAreaFiles).toEqual([]);
  });
});

describe('typeLearningBlock', () => {
  const correction = (id: number, patch: Partial<TypeCorrection> = {}): TypeCorrection => ({
    id,
    boardId: 1,
    globId: `s1f${id}`,
    fromType: 'same',
    toType: 'super',
    actor: DEV,
    at: NOW,
    signals: { openQuestions: 2, decisionWording: false, riskAreaFiles: [], sizeTasks: null },
    resetAt: null,
    ...patch,
  });

  it('describes a correction with its signals', () => {
    expect(typeCorrectionLine(correction(1))).toBe(
      'Changed from same to super: 2 open questions, no tasks',
    );
  });

  it('falls back to the catalog defaults without corrections', () => {
    const block = typeLearningBlock([]);
    for (const d of TYPE_DEFAULTS) expect(block).toContain(`${d.when}: "${d.type}"`);
  });

  it('is bounded: at most the latest few corrections, each line clipped', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      correction(i, {
        signals: {
          openQuestions: 1,
          decisionWording: true,
          riskAreaFiles: Array.from(
            { length: 5 },
            (_, j) => `apps/server/src/auth/${'x'.repeat(60)}${j}.ts`,
          ),
          sizeTasks: 3,
        },
      }),
    );
    const lines = typeLearningBlock(many).split('\n');
    expect(lines).toHaveLength(1 + TYPE_EXAMPLES_MAX);
    expect(lines.every((l) => l.length <= 260)).toBe(true);
  });
});

/** A store whose type-correction writes can be made to fail, to show recording never fails the change. */
class FlakyStore extends MemoryStore {
  failRecording = false;
  override transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return super.transaction((tx) =>
      work(
        this.failRecording
          ? { ...tx, insertTypeCorrection: () => Promise.reject(new Error('recording down')) }
          : tx,
      ),
    );
  }
}

describe('type corrections', () => {
  let store: FlakyStore;
  let logged: string[];
  let globs: GlobService;
  let intake: IntakeService;
  let learning: TypeLearningService;
  let boardId: number;
  let prompts: LlmRequest[];
  let now: string;

  beforeEach(async () => {
    store = new FlakyStore();
    logged = [];
    prompts = [];
    now = NOW;
    const notifier = new RecordingNotifier();
    for (const email of [ADMIN, DEV, PO])
      await store.transaction((tx) => tx.upsertUser({ email, name: email, active: true }));
    boardId = unwrap(
      await new BoardService({ store, notifier }).create(ADMIN, {
        name: 'b',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    await store.transaction(async (tx) => {
      await tx.upsertMember({ boardId, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId, email: PO, role: 'po' });
    });
    const clock = { now: () => now };
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'r' },
      routines: { hasRoutine: () => Promise.resolve(true) },
      log: (task, message) => logged.push(`${task}: ${message}`),
    });
    intake = new IntakeService({
      store,
      llm: {
        complete: (request) => {
          prompts.push(request);
          return Promise.resolve('{"title":"T","summary":"S","type":"sub","category":"feature"}');
        },
      },
    });
    learning = new TypeLearningService({ store, clock });
  });

  const create = async (
    type: Glob['type'],
    plan: string,
    category: Glob['category'] = 'feature',
  ): Promise<Glob> =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'x',
        summary: '',
        type,
        category,
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan,
      }),
    );

  const propose = async () => {
    unwrap(await intake.propose(DEV, boardId, { text: 'some work', explicit: {} }));
    const prompt = prompts.at(-1)?.prompt;
    if (prompt === undefined) throw new Error('No prompt');
    return prompt;
  };

  const history = () => store.transaction((tx) => tx.listTypeCorrections(boardId, { all: true }));

  it('records a person retype with the plan signals, for each direction', async () => {
    const same = await create('same', OPEN_PLAN);
    unwrap(await globs.update(DEV, same.id, same.version, { type: 'super' }));
    const [recorded] = await history();
    expect(recorded).toMatchObject({
      globId: same.id,
      fromType: 'same',
      toType: 'super',
      actor: DEV,
      at: NOW,
      resetAt: null,
      signals: {
        openQuestions: 2,
        decisionWording: true,
        riskAreaFiles: ['apps/server/src/auth/session.ts'],
        sizeTasks: null,
      },
    });
    const sub = await create('sub', SETTLED_PLAN);
    unwrap(await globs.update(DEV, sub.id, sub.version, { type: 'same' }));
    expect((await history())[0]).toMatchObject({
      globId: sub.id,
      fromType: 'sub',
      toType: 'same',
      signals: { sizeTasks: 2 },
    });
  });

  it('records nothing for a change that leaves the type alone, or one that fails', async () => {
    const same = await create('same', OPEN_PLAN);
    unwrap(await globs.update(DEV, same.id, same.version, { title: 'New title' }));
    expect(await history()).toHaveLength(0);
    const refused = await globs.update(PO, same.id, same.version + 1, { type: 'super' });
    expect(refused.ok).toBe(false);
    expect(await history()).toHaveLength(0);
  });

  it('never fails the change when recording fails, and logs it', async () => {
    const same = await create('same', OPEN_PLAN);
    store.failRecording = true;
    const result = await globs.update(DEV, same.id, same.version, { type: 'super' });
    expect(result.ok && result.value.type).toBe('super');
    expect(logged).toEqual(['type learning: recording down']);
    store.failRecording = false;
    expect(await history()).toHaveLength(0);
  });

  it('feeds the corrections into the next intake prompt; a new board gets the defaults', async () => {
    expect(await propose()).toContain('Type defaults (this board has not corrected a type yet)');
    const same = await create('same', OPEN_PLAN);
    unwrap(await globs.update(DEV, same.id, same.version, { type: 'super' }));
    const prompt = await propose();
    expect(prompt).toContain(
      'Changed from same to super: 2 open questions, decision wording, risk-area files (apps/server/src/auth/session.ts), no tasks',
    );
    expect(prompt).not.toContain('Type defaults');
    const other = unwrap(
      await new BoardService({ store, notifier: new RecordingNotifier() }).create(ADMIN, {
        name: 'b2',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    );
    unwrap(await intake.propose(ADMIN, other.id, { text: 'some work', explicit: {} }));
    expect(prompts.at(-1)?.prompt).toContain('Type defaults');
  });

  it('keeps only the latest corrections in the prompt', async () => {
    for (let i = 0; i < TYPE_EXAMPLES_MAX + 3; i++) {
      now = new Date(Date.parse(NOW) + i * 1000).toISOString();
      const sub = await create('sub', `Plan ${String(i)}`);
      unwrap(await globs.update(DEV, sub.id, sub.version, { type: 'same' }));
    }
    const prompt = await propose();
    expect(prompt.match(/Changed from sub to same/g)).toHaveLength(TYPE_EXAMPLES_MAX);
  });

  it('shows learned vs default to members and resets for admins only; a reset removes them from the prompt and keeps the history', async () => {
    const view = async (email = DEV) => unwrap(await learning.view(email, boardId));
    expect(await view()).toMatchObject({
      learned: false,
      corrections: [],
      defaults: TYPE_DEFAULTS,
    });
    const same = await create('same', OPEN_PLAN);
    unwrap(await globs.update(DEV, same.id, same.version, { type: 'super' }));
    expect(await view()).toMatchObject({ learned: true, corrections: [{ globId: same.id }] });

    const refused = await learning.reset(DEV, boardId);
    expect(refused.ok ? null : refused.error.code).toBe('forbidden');
    expect((await view()).learned).toBe(true);

    now = '2026-10-12T00:00:00.000Z';
    expect(unwrap(await learning.reset(ADMIN, boardId))).toMatchObject({
      learned: false,
      corrections: [],
    });
    expect(await propose()).toContain('Type defaults');
    expect(await history()).toEqual([
      expect.objectContaining({ globId: same.id, resetAt: '2026-10-12T00:00:00.000Z' }),
    ]);

    // A later retype teaches again; the reset one stays history.
    const sub = await create('sub', SETTLED_PLAN);
    unwrap(await globs.update(DEV, sub.id, sub.version, { type: 'same' }));
    expect((await view()).corrections).toHaveLength(1);
    expect(await history()).toHaveLength(2);
  });

  describe('needs_pairing', () => {
    const failPairing = async (type: 'sub' | 'same') => {
      // A same needs Start to run; a sub starts at once.
      let glob = await create(type, OPEN_PLAN);
      if (type === 'same') glob = unwrap(await globs.start(DEV, glob.id, glob.version));
      expect(glob.runs.at(-1)?.id).toBe('r');
      return unwrap(
        await globs.reportFailure(ADMIN, glob.id, 'The storage design is open', 'r', null, {
          kind: 'needs_pairing',
          decision: 'Which store?',
        }),
      );
    };

    it('is not retried, is offered to a developer only and, accepted, makes a super in progress and records a correction', async () => {
      const failed = await failPairing('sub');
      expect(failed).toMatchObject({
        status: 'failed',
        failure: { kind: 'needs_pairing', decision: 'Which store?' },
      });
      expect(failed.runs).toHaveLength(1);

      const asDev = unwrap(await globs.get(DEV, failed.id));
      expect(asDev.allowedActions).toContain('make_super');
      expect(asDev.allowedActions).toContain('pick_up');
      expect(unwrap(await globs.get(PO, failed.id)).allowedActions).not.toContain('make_super');
      expect((await globs.makeSuper(PO, failed.id, failed.version)).ok).toBe(false);

      const made = unwrap(await globs.makeSuper(DEV, failed.id, failed.version));
      expect(made).toMatchObject({
        type: 'super',
        status: 'in_progress',
        implementer: DEV,
        failure: null,
      });
      expect(await history()).toEqual([
        expect.objectContaining({
          globId: failed.id,
          fromType: 'sub',
          toType: 'super',
          actor: DEV,
          signals: {
            openQuestions: 2,
            decisionWording: true,
            riskAreaFiles: ['apps/server/src/auth/session.ts'],
            sizeTasks: null,
          },
        }),
      ]);
      expect(unwrap(await globs.get(DEV, failed.id)).allowedActions).not.toContain('make_super');
    });

    it('works on a same, and a plain failure does not offer it', async () => {
      const failed = await failPairing('same');
      const made = unwrap(await globs.makeSuper(DEV, failed.id, failed.version));
      expect(made.type).toBe('super');
      expect((await history())[0]).toMatchObject({ fromType: 'same', toType: 'super' });

      const plain = await create('sub', SETTLED_PLAN);
      const failedPlain = unwrap(await globs.reportFailure(ADMIN, plain.id, 'stuck', 'r'));
      expect(unwrap(await globs.get(DEV, plain.id)).allowedActions).not.toContain('make_super');
      expect(failedPlain.failure?.kind).toBeUndefined();
    });
  });
});
