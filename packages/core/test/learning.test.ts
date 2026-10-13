import { describe, expect, it } from 'vitest';
import { learningSeed } from '../src/testing/learning-seed.js';
import { readLearning } from '../src/app/learning-reads.js';
import { startEffectCheck } from '../src/domain/effect-check.js';
import { evidenceCount, lastEvidenceAt } from '../src/domain/kb.js';
import type { LearningWire } from '../src/domain/kb.js';
import {
  learningAssessmentFacts,
  learningCatalog,
  learningDecision,
  learningDocument,
  learningDraft,
  learningEffectCheck,
  learningEvidence,
  learningEvidenceSummary,
  learningExtraEvidence,
  learningFacts,
  learningLinks,
  learningMergeNote,
  learningOutcome,
  learningStaleness,
  learningStatement,
  learningStatus,
  learningTarget,
  pipelineState,
} from '../src/domain/learning.js';
import type { LearningRead } from '../src/domain/learning.js';
import { learningWire, learningWireView } from '../src/domain/learning-wire.js';
import { seedLearning, TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import type { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';
import { document, drafted, full, item, newStore, routed } from './kb-fixtures.js';

const LATER = '2026-10-05T13:00:00.000Z';

const insert = (store: MemoryStore, ...items: LearningWire[]) =>
  store.transaction(async (tx) => {
    for (const i of items)
      if (!(await learningSeed(tx, TEST_KB_WRITES).insertSeeded(i)))
        throw new Error(`${i.id} not inserted`);
  });
const update = (store: MemoryStore, next: LearningWire) =>
  store.transaction(async (tx) => {
    if (!(await learningSeed(tx, TEST_KB_WRITES).updateSeeded(next, next.version - 1)))
      throw new Error(`${next.id} not written`);
  });
const read = async (store: MemoryStore, id = 's1k1'): Promise<LearningRead> => {
  const learning = await store.transaction((tx) => readLearning(tx, id));
  if (learning === null) throw new Error(`missing ${id}`);
  return learning;
};
const adapter = (store: MemoryStore, id = 's1k1') =>
  store.transaction((tx) => learningSeed(tx).readSeeded(id));

/** Every helper's value (and the glob's own columns), under the name of the item field it must equal. */
const helpersOf = ({ glob, artifacts, jobs }: LearningRead) => {
  const facts = learningFacts(glob);
  const decision = learningDecision(glob, artifacts);
  const target = learningTarget(glob);
  const catalog = learningCatalog(glob);
  const links = learningLinks(glob);
  const drafted = learningDraft(artifacts);
  const stale = learningStaleness(glob);
  const pipeline = pipelineState(glob, artifacts, jobs);
  return {
    id: glob.id,
    boardId: glob.boardId,
    statement: learningStatement(glob, artifacts),
    submittedBy: glob.creator,
    createdAt: glob.createdAt,
    version: glob.version,
    status: learningStatus(glob, artifacts),
    type: facts.kind,
    evidence: learningEvidence(glob, artifacts),
    suggestedTarget: target.suggested,
    sourceGlobIds: facts.sourceGlobIds,
    source: facts.source,
    signal: facts.signal,
    agentSetVersion: facts.agentSetVersion,
    decidedBy: decision.by,
    decidedAt: decision.at,
    decisionReason: decision.reason,
    document: learningDocument(glob, artifacts),
    outcome: learningOutcome(artifacts),
    processing: pipeline.processing,
    processingError: pipeline.error,
    processingAttempts: pipeline.attempts,
    processAfter: pipeline.runAfter,
    target: target.routed,
    catalogCandidate: catalog.candidate,
    catalogReason: catalog.reason,
    occurrenceCount: facts.occurrenceCount,
    extraEvidence: learningExtraEvidence(artifacts),
    duplicateOf: links.duplicateOf,
    suppressedBy: links.suppressedBy,
    coveredBy: links.coveredBy,
    possiblyCoveredBy: links.possiblyCoveredBy,
    contradicts: links.contradicts,
    draft: drafted?.draft ?? null,
    draftedAgainstVersion: drafted?.targetVersion ?? null,
    rationale: drafted?.rationale ?? null,
    staleSince: stale.since,
    staleReason: stale.reason,
    staleDismissedAt: stale.dismissedAt,
    keptApartFrom: links.keptApartFrom,
    mergeNote: learningMergeNote(artifacts),
    effectCheck: learningEffectCheck(artifacts),
  };
};

/** Asserts each helper equals what the item says, and the wire is the item, key order included. */
const expectLearning = async (store: MemoryStore, expected: LearningWire) => {
  const learning = await read(store, expected.id);
  expect(helpersOf(learning)).toEqual(expected);
  const wire = learningWire(learning);
  expect(wire).toEqual(expected);
  expect(Object.keys(wire)).toEqual(Object.keys(expected));
  // The adapter reads the same.
  expect(JSON.stringify(await adapter(store, expected.id))).toBe(JSON.stringify(wire));
};

describe('the learning helpers', () => {
  it('read back every field the adapter wrote: links of each kind, contradictions in order, merged evidence, the draft', async () => {
    const store = await newStore();
    const written = full();
    await insert(store, written);
    await expectLearning(store, written);
    const learning = await read(store);
    expect(learningEvidenceSummary(learning.glob, learning.artifacts)).toEqual({
      count: evidenceCount(written),
      lastAt: lastEvidenceAt(written),
    });
    expect(learningWireView(learning, null)).toEqual({
      ...written,
      preview: null,
      evidenceCount: 3,
      lastEvidenceAt: '2026-10-05T12:02:00.000Z',
    });
    expect(learningAssessmentFacts(learning)).toEqual({
      status: 'open',
      coveredBy: null,
      possiblyCoveredBy: written.possiblyCoveredBy,
      contradicts: written.contradicts,
      catalogCandidate: true,
      staleSince: NOW,
      processing: 'drafted',
      document: null,
      target: written.target,
      draft: written.draft,
      occurrenceCount: 3,
      sourceGlobIds: ['s1t1', 's1t2'],
    });
  });

  it('read each status, and who decided, from the decision rows', async () => {
    const store = await newStore();
    const decided = {
      decidedBy: 'admin@example.com',
      decidedAt: LATER,
      processing: 'none' as const,
    };
    const items = [
      drafted({
        id: 's1k1',
        status: 'approved',
        outcome: { kind: 'learning' },
        decisionReason: 'Good',
        ...decided,
      }),
      drafted({ id: 's1k2', status: 'rejected', decisionReason: 'No', ...decided }),
      drafted({
        id: 's1k3',
        status: 'rejected',
        decisionReason: 'Not a rule',
        outcome: { kind: 'rejected', via: 'agent' },
        ...decided,
      }),
      drafted({
        id: 's1k4',
        status: 'merged',
        processing: 'none',
        duplicateOf: 's1k1',
        mergeNote: { by: 'intake', quote: 'a', survivorQuote: 'b', at: NOW },
      }),
      drafted({
        id: 's1k5',
        status: 'covered',
        processing: 'none',
        coveredBy: {
          kind: 'knowledge',
          knowledgeKind: 'doc',
          name: 'build_test_lint',
          section: null,
        },
      }),
      drafted({
        id: 's1k6',
        status: 'covered',
        processing: 'none',
        coveredBy: { kind: 'item', id: 's1k1' },
      }),
      drafted({ id: 's1k7', status: 'suppressed', processing: 'none', suppressedBy: 's1k2' }),
    ];
    await insert(store, ...items);
    for (const i of items)
      await expectLearning(store, { ...i, version: (await read(store, i.id)).glob.version });
  });

  it('read an approval whose decision was reopened to choose again as approved, from its outcome artifact', async () => {
    const store = await newStore();
    await insert(
      store,
      drafted({
        status: 'approved',
        outcome: { kind: 'learning' },
        decisionReason: 'Good',
        decidedBy: 'admin@example.com',
        decidedAt: LATER,
      }),
    );
    // Row D9: the decision goes back to Doing with no outcome; the approval's outcome artifact stays.
    const glob = (await read(store)).glob;
    await store.transaction((tx) =>
      tx.updateGlob(
        {
          ...glob,
          status: 'in_progress',
          attributes: {
            scope: { kind: 'future_work', ref: null },
            origin: { kind: 'submitted' },
            channel: 'agent',
            outcome: null,
            kind: 'gotcha',
            sourceGlobs: ['s1t1'],
            target: { suggested: null, routed: drafted().target },
            evidenceCount: 1,
          },
          version: glob.version + 1,
        },
        glob.version,
      ),
    );
    const learning = await read(store);
    expect(learningStatus(learning.glob, learning.artifacts)).toBe('approved');
    // Who and when come from the outcome artifact; the reason was the decision's.
    expect(learningDecision(learning.glob, learning.artifacts)).toEqual({
      by: 'admin@example.com',
      at: LATER,
      reason: null,
    });
    expect(learningWire(learning)).toMatchObject({
      status: 'approved',
      decidedBy: 'admin@example.com',
      decidedAt: LATER,
      decisionReason: null,
      processing: 'none',
    });
  });

  it('read a document proposal: its body from the payload, its evidence from the attachment, and no step to wait for', async () => {
    const store = await newStore();
    const proposal = routed({
      document,
      evidence: 'Bootstrapped',
      processing: 'drafted',
      target: {
        kind: 'doc',
        name: 'architecture',
        section: null,
        newDocument: { area: 'architecture', audience: [], description: 'Layout' },
      },
    });
    await insert(store, proposal);
    await expectLearning(store, proposal);
  });

  it('read cleared artifacts as none: the draft, the outcome, the effect check and the merge note', async () => {
    const store = await newStore();
    const effectCheck = startEffectCheck(
      { key: 'finding:x', label: 'Findings' },
      { kind: 'time', since: LATER },
      5,
    );
    const approved = drafted({
      status: 'approved',
      outcome: { kind: 'learning' },
      effectCheck,
      decidedBy: 'admin@example.com',
      decidedAt: LATER,
      processing: 'none',
    });
    const merged = drafted({
      id: 's1k2',
      status: 'merged',
      duplicateOf: 's1k3',
      mergeNote: { by: 'consolidation', quote: 'a', survivorQuote: 'b', at: NOW },
      processing: 'none',
    });
    await insert(store, approved, merged, drafted({ id: 's1k3' }));
    await expectLearning(store, approved);
    await update(store, { ...approved, outcome: null, effectCheck: null, version: 2 });
    await update(store, { ...merged, mergeNote: null, version: 2 });
    const cleared = drafted({ id: 's1k3', draft: null, processing: 'routed', version: 2 });
    await update(store, cleared);
    const decision = (await read(store, 's1k1')).artifacts;
    expect([learningOutcome(decision), learningEffectCheck(decision)]).toEqual([null, null]);
    expect(learningMergeNote((await read(store, 's1k2')).artifacts)).toBeNull();
    expect(learningDraft((await read(store, 's1k3')).artifacts)).toBeNull();
    // Each was written as an empty version, not removed.
    expect(
      store.state.artifacts.filter((a) => a.content === '').map((a) => [a.globId, a.kind, a.label]),
    ).toEqual([
      ['s1k1', 'outcome', ''],
      ['s1k1', 'effect_check', ''],
      ['s1k2', 'attachment', 'merge_note'],
      ['s1k3', 'draft', ''],
    ]);
    await expectLearning(store, cleared);
  });

  it("read the pipeline state from the step's newest job", async () => {
    const store = await newStore();
    const cases: [LearningWire, ReturnType<typeof pipelineState>][] = [
      [item({ id: 's1k1' }), { processing: 'pending', error: null, attempts: 0, runAfter: null }],
      [routed({ id: 's1k2' }), { processing: 'routed', error: null, attempts: 0, runAfter: null }],
      [
        drafted({ id: 's1k3' }),
        { processing: 'drafted', error: null, attempts: 0, runAfter: null },
      ],
      [
        routed({
          id: 's1k4',
          processing: 'failed',
          processingError: 'Opus is down',
          processingAttempts: 3,
        }),
        { processing: 'failed', error: 'Opus is down', attempts: 3, runAfter: null },
      ],
      [
        item({
          id: 's1k5',
          processingError: 'Bedrock is busy',
          processingAttempts: 1,
          processAfter: LATER,
        }),
        { processing: 'pending', error: 'Bedrock is busy', attempts: 1, runAfter: LATER },
      ],
      [
        drafted({
          id: 's1k6',
          status: 'approved',
          outcome: { kind: 'learning' },
          decidedBy: 'admin@example.com',
          decidedAt: LATER,
        }),
        { processing: 'none', error: null, attempts: 0, runAfter: null },
      ],
    ];
    for (const [seed, expected] of cases) {
      const seeded = await seedLearning(store, seed);
      const learning = await read(store, seed.id);
      expect(pipelineState(learning.glob, learning.artifacts, learning.jobs), seed.id).toEqual(
        expected,
      );
      expect(learningWire(learning)).toEqual(seeded);
    }
    // A finished or dropped job whose step is still due reads as waiting, with nothing spent.
    for (const state of ['done', 'dropped'] as const) {
      store.state.outboxJobs = store.state.outboxJobs.map((j) =>
        j.globId === 's1k4' ? { ...j, state } : j,
      );
      const learning = await read(store, 's1k4');
      expect(pipelineState(learning.glob, learning.artifacts, learning.jobs)).toEqual({
        processing: 'routed',
        error: null,
        attempts: 0,
        runAfter: null,
      });
    }
  });
});
