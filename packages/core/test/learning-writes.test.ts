import { describe, expect, it } from 'vitest';
import { learningSeed } from '../src/testing/learning-seed.js';
import type { KbWriteOptions } from '../src/testing/learning-seed.js';
import {
  createLearning,
  dismissLearningStale,
  keepLearningApart,
  recordLearningDecision,
  reopenClosedLearning,
  reopenDecidedLearning,
  requeueLearningDraft,
  retryLearningStep,
} from '../src/app/learning-writes.js';
import type { LearningWriteContext, NewLearningGlob } from '../src/app/learning-writes.js';
import { startEffectCheck } from '../src/domain/effect-check.js';
import { KB_STEP_KIND, kbStepOf } from '../src/domain/kb.js';
import type { LearningWire, KbOutcome, KbTarget } from '../src/domain/kb.js';
import type { Actor } from '../src/domain/types.js';
import type { Hint, Tx } from '../src/ports.js';
import { TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import type { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';
import { document, drafted, item, newStore, OTHER, routed, signal } from './kb-fixtures.js';

/**
 * Each named write against the KB item adapter's write of the same change (as the knowledge service made it before
 * s15t72): run on twin stores seeded alike, they must leave the same globs, artifacts, outbox jobs, events and hints.
 */

const LATER = '2026-10-05T13:00:00.000Z';
const ADMIN: Actor = { email: 'admin@example.com', role: 'admin' };

interface Twin {
  readonly store: MemoryStore;
  readonly hints: Hint[];
  readonly ctx: LearningWriteContext;
}

const twin = async (seed: readonly LearningWire[]): Promise<Twin> => {
  const store = await newStore();
  await store.transaction(async (tx) => {
    for (const i of seed)
      if (!(await learningSeed(tx, TEST_KB_WRITES).insertSeeded(i)))
        throw new Error(`${i.id} not seeded`);
  });
  const hints: Hint[] = [];
  return { store, hints, ctx: { clock: { now: () => LATER }, raise: (hint) => hints.push(hint) } };
};

const snapshot = ({ store, hints }: Twin) => ({
  globs: [...store.state.globs.values()].map((g) => g.glob),
  artifacts: store.state.artifacts,
  jobs: store.state.outboxJobs.map((j) => [j.id, j.kind, j.globId, j.state]),
  events: store.state.events,
  hints,
});

/** The item as the adapter reads it now. */
const current = async (tx: Tx, id: string): Promise<LearningWire> => {
  const read = await learningSeed(tx).readSeeded(id);
  if (read === null) throw new Error(`missing ${id}`);
  return read;
};

/** The adapter's write of `change(current)` at the next version, as the service made it. */
const adapterWrite = (
  t: Twin,
  id: string,
  change: (i: LearningWire) => LearningWire,
  options: KbWriteOptions = {},
) =>
  t.store.transaction(async (tx) => {
    const before = await current(tx, id);
    return learningSeed(tx, t.ctx).updateSeeded(
      { ...change(before), version: before.version + 1 },
      before.version,
      options,
    );
  });

/** The item with its draft cleared, back in the queue to be drafted again (the service's `needsDraft`, which s15t72 removed). */
const needsDraft = (i: LearningWire, target: KbTarget | null = i.target): LearningWire => ({
  ...i,
  target,
  processing: 'routed',
  processingError: null,
  processingAttempts: 0,
  processAfter: null,
  draft: null,
  draftedAgainstVersion: null,
  rationale: null,
});

const versionOf = async (t: Twin, id: string): Promise<number> => {
  const glob = await t.store.transaction((tx) => tx.getGlob(id));
  if (glob === null) throw new Error(`missing ${id}`);
  return glob.version;
};

/** Runs the old write on one twin and the new on the other, and compares what they left. */
const parity = async (
  seed: readonly LearningWire[],
  old: (t: Twin) => Promise<unknown>,
  next: (t: Twin, tx: Tx) => Promise<boolean>,
  prepare?: (t: Twin) => void,
) => {
  const a = await twin(seed);
  const b = await twin(seed);
  prepare?.(a);
  prepare?.(b);
  await old(a);
  expect(await b.store.transaction((tx) => next(b, tx))).toBe(true);
  expect(snapshot(b)).toEqual(snapshot(a));
  return { a, b };
};

describe('the learning writes, against the adapter', () => {
  it('create a submitted statement and a document proposal as the adapter inserts them', async () => {
    const input = (patch: Partial<NewLearningGlob> = {}): NewLearningGlob => ({
      id: 's1k1',
      boardId: 1,
      type: 'gotcha',
      statement: 'Generated files live in src/gen/',
      evidence: 'A review finding',
      suggestedTarget: 'build doc',
      sourceGlobIds: ['s1t1'],
      agentSetVersion: 3,
      submittedBy: 'dev@example.com',
      createdAt: NOW,
      document: null,
      target: null,
      ...patch,
    });
    const target: KbTarget = {
      kind: 'doc',
      name: 'architecture',
      section: null,
      newDocument: { area: 'architecture', audience: [], description: 'Layout' },
    };
    for (const [old, created] of [
      [item({ suggestedTarget: 'build doc', agentSetVersion: 3 }), input()],
      [
        routed({
          document,
          target,
          processing: 'drafted',
          suggestedTarget: 'build doc',
          agentSetVersion: 3,
        }),
        input({ document, target }),
      ],
    ] as const) {
      const a = await twin([]);
      const b = await twin([]);
      await a.store.transaction((tx) => learningSeed(tx, a.ctx).insertSeeded(old));
      expect(await b.store.transaction((tx) => createLearning(tx, b.ctx, created))).toBe(true);
      expect(snapshot(b)).toEqual(snapshot(a));
      // The ID is taken now.
      expect(await b.store.transaction((tx) => createLearning(tx, b.ctx, created))).toBe(false);
    }
  });

  it('requeue a drafted learning against a new target, clearing its draft and queueing drafting', async () => {
    await parity(
      [drafted({ draftedAgainstVersion: 2, rationale: 'Why' })],
      (t) => adapterWrite(t, 's1k1', (i) => needsDraft(i, OTHER)),
      async (t, tx) => requeueLearningDraft(tx, t.ctx, 's1k1', await versionOf(t, 's1k1'), OTHER),
    );
  });

  it('requeue against the same target while drafting waits (or failed): nothing new is queued', async () => {
    await parity(
      [routed()],
      (t) => adapterWrite(t, 's1k1', (i) => needsDraft(i)),
      async (t, tx) => requeueLearningDraft(tx, t.ctx, 's1k1', await versionOf(t, 's1k1')),
    );
    const failDraft = (t: Twin) => {
      t.store.state.outboxJobs = t.store.state.outboxJobs.map((j) =>
        j.kind === 'kb_draft'
          ? { ...j, state: 'failed', attempts: 3, lastError: 'Opus is down' }
          : j,
      );
    };
    await parity(
      [routed()],
      (t) => adapterWrite(t, 's1k1', (i) => needsDraft(i)),
      async (t, tx) => requeueLearningDraft(tx, t.ctx, 's1k1', await versionOf(t, 's1k1')),
      failDraft,
    );
  });

  it('retry a failed step: the version moves and the step gets a fresh job', async () => {
    const failRoute = (t: Twin) => {
      t.store.state.outboxJobs = t.store.state.outboxJobs.map((j) => ({
        ...j,
        state: 'failed',
        attempts: 3,
        lastError: 'Opus is down',
      }));
    };
    await parity(
      [item()],
      async (t) => {
        await adapterWrite(t, 's1k1', (i) => i);
        // The adapter's retryStep, which s15t72 removed.
        await t.store.transaction(async (tx) => {
          const step = kbStepOf(await current(tx, 's1k1'));
          if (step !== null)
            await tx.enqueueEffects([{ kind: KB_STEP_KIND[step], globId: 's1k1' }]);
        });
      },
      async (t, tx) => retryLearningStep(tx, t.ctx, 's1k1', await versionOf(t, 's1k1')),
      failRoute,
    );
  });

  it('reopen a merge (row D12): back to drafting without its merge note, the pair kept apart on both sides', async () => {
    const merged = drafted({
      status: 'merged',
      duplicateOf: 's1k2',
      mergeNote: { by: 'intake', quote: 'a quote', survivorQuote: 'b quote', at: NOW },
    });
    await parity(
      [drafted({ id: 's1k2' }), merged],
      async (t) => {
        await adapterWrite(
          t,
          's1k1',
          (i) =>
            needsDraft({
              ...i,
              status: 'open',
              duplicateOf: null,
              suppressedBy: null,
              coveredBy: null,
              mergeNote: null,
              keptApartFrom: ['s1k2'],
            }),
          { actor: ADMIN },
        );
        await adapterWrite(t, 's1k2', (i) => ({ ...i, keptApartFrom: ['s1k1'] }));
      },
      async (t, tx) =>
        (await reopenClosedLearning(tx, t.ctx, 's1k1', ADMIN, await versionOf(t, 's1k1'))) &&
        keepLearningApart(tx, t.ctx, 's1k2', 's1k1', await versionOf(t, 's1k2')),
    );
  });

  it('reopen a document proposal covered by another learning: it keeps its own draft', async () => {
    const target: KbTarget = {
      kind: 'doc',
      name: 'architecture',
      section: null,
      newDocument: null,
    };
    const covered = routed({
      document,
      target,
      status: 'covered',
      coveredBy: { kind: 'item', id: 's1k2' },
      processing: 'none',
    });
    await parity(
      [drafted({ id: 's1k2' }), covered],
      (t) =>
        adapterWrite(
          t,
          's1k1',
          (i) => ({
            ...i,
            status: 'open',
            duplicateOf: null,
            suppressedBy: null,
            coveredBy: null,
            mergeNote: null,
          }),
          { actor: ADMIN },
        ),
      async (t, tx) => reopenClosedLearning(tx, t.ctx, 's1k1', ADMIN, await versionOf(t, 's1k1')),
    );
  });

  it("reopen an agent's approval and an agent's rejection: no outcome or effect check, back to drafting", async () => {
    const effectCheck = startEffectCheck(
      { key: signal.key, label: signal.label },
      { kind: 'time', since: LATER },
      5,
    );
    const decided = { decidedBy: 'admin@example.com', decidedAt: LATER, decisionReason: 'Fine' };
    for (const seed of [
      drafted({
        status: 'approved',
        outcome: { kind: 'learning', via: 'agent' },
        signal,
        effectCheck,
        ...decided,
      }),
      drafted({ status: 'rejected', outcome: { kind: 'rejected', via: 'agent' }, ...decided }),
    ]) {
      await parity(
        [seed],
        (t) =>
          adapterWrite(t, 's1k1', (i) =>
            needsDraft({
              ...i,
              status: 'open',
              decidedBy: null,
              decidedAt: null,
              decisionReason: null,
              outcome: null,
              effectCheck: null,
            }),
          ),
        async (t, tx) => reopenDecidedLearning(tx, t.ctx, 's1k1', await versionOf(t, 's1k1')),
      );
    }
  });

  it('keep a stale learning: the flag clears and the dismissal is recorded', async () => {
    await parity(
      [routed({ staleSince: NOW, staleReason: 'no_recent_evidence' })],
      (t) =>
        adapterWrite(t, 's1k1', (i) => ({
          ...i,
          staleSince: null,
          staleReason: null,
          staleDismissedAt: LATER,
        })),
      async (t, tx) => dismissLearningStale(tx, t.ctx, 's1k1', await versionOf(t, 's1k1'), LATER),
    );
  });

  it('approve with an edited statement and draft, a watched signal and its effect check', async () => {
    const outcome: KbOutcome = {
      kind: 'applied',
      target: 'doc',
      name: 'build_test_lint',
      version: 2,
      via: 'agent',
    };
    const effectCheck = startEffectCheck(
      { key: signal.key, label: signal.label },
      { kind: 'time', since: LATER },
      5,
    );
    await parity(
      [drafted()],
      (t) =>
        adapterWrite(
          t,
          's1k1',
          (i) => ({
            ...i,
            status: 'approved',
            decidedBy: 'admin@example.com',
            decidedAt: LATER,
            statement: 'Generated files live in gen/',
            outcome,
            signal,
            effectCheck,
          }),
          {
            edited: true,
          },
        ),
      async (t, tx) =>
        recordLearningDecision(tx, t.ctx, 's1k1', await versionOf(t, 's1k1'), {
          kind: 'approved',
          by: 'admin@example.com',
          at: LATER,
          statement: 'Generated files live in gen/',
          reason: null,
          outcome,
          signal,
          effectCheck,
          edited: true,
        }),
    );
  });

  it('approve a decision a narrower learning contradicts: that learning now conflicts with it', async () => {
    // The contradicting learning first, so it has no conflict until the decision is approved.
    const contradicting = routed({
      id: 's1k2',
      contradicts: [{ kind: 'item', ref: 's1k1', note: 'Says otherwise' }],
    });
    const { b } = await parity(
      [contradicting, drafted({ type: 'pattern', statement: 'Use cursors' })],
      (t) =>
        adapterWrite(t, 's1k1', (i) => ({
          ...i,
          status: 'approved',
          decidedBy: 'admin@example.com',
          decidedAt: LATER,
          outcome: { kind: 'learning' },
          decisionReason: 'Agreed',
        })),
      async (t, tx) =>
        recordLearningDecision(tx, t.ctx, 's1k1', await versionOf(t, 's1k1'), {
          kind: 'approved',
          by: 'admin@example.com',
          at: LATER,
          statement: 'Use cursors',
          reason: 'Agreed',
          outcome: { kind: 'learning' },
          signal: null,
          effectCheck: null,
          edited: false,
        }),
      (t) => {
        // The approved learning governs the whole project, a broader scope than the contradicting one's.
        const entry = t.store.state.globs.get('s1k1');
        if (entry !== undefined) entry.glob = { ...entry.glob, attributes: { ...entry.glob.attributes, scope: { kind: 'project', ref: null } } } as typeof entry.glob;
      },
    );
    expect(b.store.state.globs.get('s1k2')?.glob.attributes).toMatchObject({
      conflictsWith: ['s1k1'],
    });
  });

  it('reject, by a person (no outcome) and by an agent (a rejected outcome)', async () => {
    for (const outcome of [null, { kind: 'rejected', via: 'agent' } as const]) {
      await parity(
        [routed()],
        (t) =>
          adapterWrite(t, 's1k1', (i) => ({
            ...i,
            status: 'rejected',
            decidedBy: 'admin@example.com',
            decidedAt: LATER,
            decisionReason: 'Not a rule',
            outcome,
          })),
        async (t, tx) =>
          recordLearningDecision(tx, t.ctx, 's1k1', await versionOf(t, 's1k1'), {
            kind: 'rejected',
            by: 'admin@example.com',
            at: LATER,
            reason: 'Not a rule',
            outcome,
          }),
      );
    }
  });

  it('write nothing at a stale version', async () => {
    const t = await twin([routed()]);
    const before = snapshot(t);
    expect(
      await t.store.transaction((tx) => requeueLearningDraft(tx, t.ctx, 's1k1', 7, OTHER)),
    ).toBe(false);
    expect(
      await t.store.transaction((tx) => dismissLearningStale(tx, t.ctx, 's1k1', 7, LATER)),
    ).toBe(false);
    expect(snapshot(t)).toEqual(before);
  });
});
