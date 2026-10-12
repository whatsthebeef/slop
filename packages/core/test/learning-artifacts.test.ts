import { describe, expect, it } from 'vitest';
import { learningSeed } from '../src/testing/learning-seed.js';
import { writeLearningArtifacts } from '../src/app/learning-writes.js';
import type { LearningArtifactState } from '../src/app/learning-writes.js';
import { startEffectCheck } from '../src/domain/effect-check.js';
import type { KbMergeNote, KbTarget } from '../src/domain/kb.js';
import type { Glob } from '../src/domain/types.js';
import { TEST_KB_WRITES } from '../src/testing/kb-queue.js';
import type { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';
import { item, newStore } from './kb-fixtures.js';

/**
 * The rows `writeLearningArtifacts` inserts, for a new learning and for each kind of change: kind, label, content, time
 * and full provenance. The expected values are what the old KB item adapter wrote before s15t72 moved its writer here.
 */

const AT = '2026-10-05T13:00:00.000Z';
const DECIDED = '2026-10-05T12:30:00.000Z';
const SLOP = { by: 'sessionator', actor: 'slop', runId: null, agentSetVersion: null } as const;
const TARGET: KbTarget = {
  kind: 'doc',
  name: 'build_test_lint',
  section: 'Test',
  newDocument: null,
};
const NOTE: KbMergeNote = {
  by: 'intake',
  quote: 'a quote here',
  survivorQuote: 'b quote here',
  at: NOW,
};

const state = (patch: Partial<LearningArtifactState> = {}): LearningArtifactState => ({
  origin: {
    id: 's1k1',
    createdAt: NOW,
    submittedBy: 'dev@example.com',
    source: 'submitted',
    agentSetVersion: 3,
  },
  payload: 'Generated files live in src/gen/\n\n## Evidence\n\nA review finding',
  documentEvidence: null,
  draft: null,
  draftedAgainstVersion: null,
  rationale: null,
  target: null,
  outcome: null,
  decidedBy: null,
  decidedAt: null,
  effectCheck: null,
  extraEvidence: [],
  mergeNote: null,
  ...patch,
});

/** A store with learning s1k1's glob, and the rows a write inserts after it. */
const setup = async (): Promise<{ store: MemoryStore; glob: Glob }> => {
  const store = await newStore();
  await store.transaction((tx) => learningSeed(tx, TEST_KB_WRITES).insertSeeded(item()));
  const glob = await store.transaction((tx) => tx.getGlob('s1k1'));
  if (glob === null) throw new Error('missing s1k1');
  return { store, glob };
};
const rowsOf = async (before: LearningArtifactState | null, after: LearningArtifactState) => {
  const { store, glob } = await setup();
  const from = store.state.artifacts.length;
  const wrote = await store.transaction((tx) =>
    writeLearningArtifacts(tx, glob, before, after, AT),
  );
  const rows = store.state.artifacts
    .slice(from)
    .map((a) => ({
      globId: a.globId,
      kind: a.kind,
      label: a.label,
      content: a.content,
      link: a.link,
      commitSha: a.commitSha,
      createdAt: a.createdAt,
      provenance: a.provenance,
    }));
  return { wrote, rows };
};
const row = (
  kind: string,
  label: string,
  content: string,
  createdAt: string,
  provenance: object,
) => ({ globId: 's1k1', kind, label, content, link: null, commitSha: null, createdAt, provenance });

describe('writeLearningArtifacts', () => {
  it("writes a new statement's payload as the submitter, at its creation, with the agent-set version", async () => {
    expect(await rowsOf(null, state())).toEqual({
      wrote: true,
      rows: [
        row('plan', '', state().payload, NOW, {
          by: 'routine',
          actor: 'dev@example.com',
          runId: null,
          agentSetVersion: 3,
        }),
      ],
    });
    // A mined learning's payload is slop's.
    const mined = state({ origin: { ...state().origin, source: 'mined', agentSetVersion: null } });
    expect((await rowsOf(null, mined)).rows).toEqual([
      row('plan', '', state().payload, NOW, {
        by: 'sessionator',
        actor: 'dev@example.com',
        runId: null,
        agentSetVersion: null,
      }),
    ]);
  });

  it("writes a new document proposal's evidence beside its payload, and a seeded learning's every artifact", async () => {
    const proposal = state({ payload: '# Architecture\n', documentEvidence: 'Bootstrapped' });
    expect((await rowsOf(null, proposal)).rows).toEqual([
      row('plan', '', '# Architecture\n', NOW, {
        by: 'routine',
        actor: 'dev@example.com',
        runId: null,
        agentSetVersion: 3,
      }),
      row('attachment', 'evidence', 'Bootstrapped', NOW, {
        by: 'sessionator',
        actor: 'dev@example.com',
        runId: null,
        agentSetVersion: null,
      }),
    ]);
    const effectCheck = startEffectCheck(
      { key: 'finding:x', label: 'Findings' },
      { kind: 'time', since: DECIDED },
      5,
    );
    const seeded = state({
      draft: { section: 'Test', content: '## Test\n' },
      draftedAgainstVersion: 4,
      rationale: 'Why',
      target: TARGET,
      outcome: { kind: 'learning' },
      decidedBy: 'admin@example.com',
      decidedAt: DECIDED,
      effectCheck,
      extraEvidence: [
        {
          itemId: 's1k8',
          globIds: ['s1t3'],
          evidence: 'More',
          submittedBy: 'a@example.com',
          at: '2026-10-05T12:01:00.000Z',
        },
        {
          itemId: 's1k8',
          globIds: [],
          evidence: 'Again',
          submittedBy: 'b@example.com',
          at: '2026-10-05T12:02:00.000Z',
        },
      ],
      mergeNote: NOTE,
    });
    expect((await rowsOf(null, seeded)).rows).toEqual([
      row('plan', '', state().payload, NOW, {
        by: 'routine',
        actor: 'dev@example.com',
        runId: null,
        agentSetVersion: 3,
      }),
      row('draft', '', '## Test\n', AT, {
        ...SLOP,
        draft: { section: 'Test', targetVersion: 4, target: TARGET, rationale: 'Why' },
      }),
      row('outcome', '', JSON.stringify({ kind: 'learning' }), DECIDED, {
        by: 'human',
        actor: 'admin@example.com',
        runId: null,
        agentSetVersion: null,
        kbOutcome: { kind: 'learning' },
      }),
      row('effect_check', '', JSON.stringify(effectCheck), AT, { ...SLOP, effectCheck }),
      row('attachment', 'evidence:s1k8', 'More', '2026-10-05T12:01:00.000Z', {
        by: 'sessionator',
        actor: 'a@example.com',
        runId: null,
        agentSetVersion: null,
        evidence: { itemId: 's1k8', globIds: ['s1t3'] },
      }),
      row('attachment', 'evidence:s1k8#2', 'Again', '2026-10-05T12:02:00.000Z', {
        by: 'sessionator',
        actor: 'b@example.com',
        runId: null,
        agentSetVersion: null,
        evidence: { itemId: 's1k8', globIds: [] },
      }),
      row(
        'attachment',
        'merge_note',
        'Closed by intake at 2026-10-05T12:00:00.000Z: this learning says "a quote here"; the other says "b quote here".',
        AT,
        { ...SLOP, mergeNote: NOTE },
      ),
    ]);
  });

  it("writes nothing for no change, and only what changed otherwise, as slop at the write's time", async () => {
    expect(await rowsOf(state(), state())).toEqual({ wrote: false, rows: [] });
    // A new statement: a new payload, by slop (not the submitter), with no agent-set version.
    expect(
      (await rowsOf(state(), state({ payload: 'New\n\n## Evidence\n\nA review finding' }))).rows,
    ).toEqual([row('plan', '', 'New\n\n## Evidence\n\nA review finding', AT, SLOP)]);
    // New document evidence.
    const proposal = state({ payload: '# A\n', documentEvidence: 'Old' });
    expect((await rowsOf(proposal, { ...proposal, documentEvidence: 'New' })).rows).toEqual([
      row('attachment', 'evidence', 'New', AT, { ...SLOP, actor: 'dev@example.com' }),
    ]);
  });

  it('writes a draft with its target and version, and clears it with an empty version', async () => {
    const drafted = state({
      draft: { section: 'Test', content: '## Test\n' },
      draftedAgainstVersion: 2,
      rationale: 'Says how',
      target: TARGET,
    });
    expect((await rowsOf(state({ target: TARGET }), drafted)).rows).toEqual([
      row('draft', '', '## Test\n', AT, {
        ...SLOP,
        draft: { section: 'Test', targetVersion: 2, target: TARGET, rationale: 'Says how' },
      }),
    ]);
    expect(
      (
        await rowsOf(drafted, {
          ...drafted,
          draft: null,
          draftedAgainstVersion: null,
          rationale: null,
        })
      ).rows,
    ).toEqual([row('draft', '', '', AT, SLOP)]);
  });

  it("writes an outcome as the decider at the decision's time, and clears it as slop now", async () => {
    const outcome = { kind: 'rejected', via: 'agent' } as const;
    const decided = state({ outcome, decidedBy: 'admin@example.com', decidedAt: DECIDED });
    expect((await rowsOf(state(), decided)).rows).toEqual([
      row('outcome', '', JSON.stringify(outcome), DECIDED, {
        by: 'human',
        actor: 'admin@example.com',
        runId: null,
        agentSetVersion: null,
        kbOutcome: outcome,
      }),
    ]);
    expect((await rowsOf(decided, state())).rows).toEqual([
      row('outcome', '', '', AT, {
        by: 'human',
        actor: 'slop',
        runId: null,
        agentSetVersion: null,
      }),
    ]);
  });

  it('writes and clears an effect check and a merge note', async () => {
    const effectCheck = startEffectCheck(
      { key: 'finding:x', label: 'Findings' },
      { kind: 'time', since: DECIDED },
      5,
    );
    expect((await rowsOf(state(), state({ effectCheck }))).rows).toEqual([
      row('effect_check', '', JSON.stringify(effectCheck), AT, { ...SLOP, effectCheck }),
    ]);
    expect((await rowsOf(state({ effectCheck }), state())).rows).toEqual([
      row('effect_check', '', '', AT, SLOP),
    ]);
    expect((await rowsOf(state(), state({ mergeNote: NOTE }))).rows).toEqual([
      row(
        'attachment',
        'merge_note',
        'Closed by intake at 2026-10-05T12:00:00.000Z: this learning says "a quote here"; the other says "b quote here".',
        AT,
        { ...SLOP, mergeNote: NOTE },
      ),
    ]);
    expect((await rowsOf(state({ mergeNote: NOTE }), state())).rows).toEqual([
      row('attachment', 'merge_note', '', AT, SLOP),
    ]);
  });

  it('adds merged evidence after what is there, numbering repeats of one learning, and never takes any away', async () => {
    const first = {
      itemId: 's1k8',
      globIds: ['s1t3'],
      evidence: 'More',
      submittedBy: 'a@example.com',
      at: '2026-10-05T12:01:00.000Z',
    };
    const second = {
      itemId: 's1k8',
      globIds: [],
      evidence: 'Again',
      submittedBy: 'b@example.com',
      at: '2026-10-05T12:02:00.000Z',
    };
    expect(
      (await rowsOf(state({ extraEvidence: [first] }), state({ extraEvidence: [first, second] })))
        .rows,
    ).toEqual([
      row('attachment', 'evidence:s1k8#2', 'Again', '2026-10-05T12:02:00.000Z', {
        by: 'sessionator',
        actor: 'b@example.com',
        runId: null,
        agentSetVersion: null,
        evidence: { itemId: 's1k8', globIds: [] },
      }),
    ]);
    await expect(rowsOf(state({ extraEvidence: [first] }), state())).rejects.toThrow(
      /never taken away/,
    );
  });
});
