import type { DecisionAttributes, DecisionScope } from '../domain/attributes.js';
import {
  broaderConflicts,
  decisionGlobTitle,
  decisionOf,
  defaultScope,
  kbItemKey,
} from '../domain/decision-glob.js';
import type { LearningAssessmentFacts } from '../domain/decision-glob.js';
import type { EffectCheck } from '../domain/effect-check.js';
import type { Result } from '../domain/errors.js';
import { parseId } from '../domain/ids.js';
import { KB_STEP_KIND, kbStepOf, stepEffects } from '../domain/kb.js';
import type {
  DraftPreview,
  ExtraEvidence,
  KbContradiction,
  KbDraft,
  KbItemSource,
  KbItemStatus,
  KbMergeNote,
  KbOutcome,
  KbStaleReason,
  KbTarget,
  LearningType,
  ProposedDocument,
} from '../domain/kb.js';
import { mergeNoteText, proposalText } from '../domain/kb-glob.js';
import type { ArtifactKind, Provenance } from '../domain/knowledge.js';
import {
  DOCUMENT_EVIDENCE_LABEL,
  EVIDENCE_PREFIX,
  MERGE_NOTE_LABEL,
  learningAssessmentFacts,
  learningDecision,
  learningDocument,
  learningDraft,
  learningEffectCheck,
  learningEvidence,
  learningExtraEvidence,
  learningFacts,
  learningLinks,
  learningMergeNote,
  learningOutcome,
  learningStatus,
  learningStatusFrom,
  learningStep,
  learningTarget,
} from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import * as machine from '../domain/machine.js';
import type { Transition } from '../domain/machine.js';
import type { KbSignal } from '../domain/signals.js';
import type { Actor, Glob, GlobLink } from '../domain/types.js';
import type { Clock, Hint, Tx } from '../ports.js';
import {
  applyDecisionStep,
  DECISION_SYSTEM_ACTOR,
  decisionContext,
  writeAssessment,
} from './decision-glob.js';
import { boardLearnings, readLearning } from './learning-reads.js';

/**
 * The writes to a learning's decision glob, as named operations: each applies the decision row it needs, changes the
 * glob's attributes and links and its artifacts, conditional on the glob's version, and queues the pipeline step the
 * change makes due in the same transaction. The rules every write shares (which step is due, the broader decisions a
 * learning conflicts with, when the assessment is rewritten) are the primitives below; the KB item adapter uses them too.
 */

/** What writes need: the time, and where to raise live hints (published after the caller's commit). */
export interface LearningWriteContext {
  readonly clock: Clock;
  readonly raise?: (hint: Hint) => void;
}

type MutableAttributes = { -readonly [K in keyof DecisionAttributes]: DecisionAttributes[K] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A new artifact version on a learning's glob, by slop unless `extra` says who. */
export const putLearningArtifact = async (
  tx: Tx,
  glob: Glob,
  kind: ArtifactKind,
  label: string,
  content: string,
  at: string,
  extra: Partial<Provenance> = {},
): Promise<void> => {
  const provenance: Provenance = {
    by: 'sessionator',
    actor: DECISION_SYSTEM_ACTOR,
    runId: null,
    agentSetVersion: null,
    ...extra,
  };
  await tx.insertArtifact({
    globId: glob.id,
    kind,
    label,
    content,
    link: null,
    commitSha: null,
    provenance,
    createdAt: at,
  });
};

/** The broader decisions an open learning contradicts (by scope rank); none once it isn't open. */
export const learningConflicts = async (
  tx: Tx,
  scope: DecisionScope,
  status: KbItemStatus,
  contradicts: readonly KbContradiction[],
): Promise<string[]> => {
  if (status !== 'open') return [];
  const others = new Map<string, Glob>();
  for (const c of contradicts) {
    if (c.kind !== 'item') continue;
    const other = await tx.getGlob(c.ref);
    if (other !== null) others.set(c.ref, other);
  }
  return broaderConflicts(scope, { contradicts }, (id) => others.get(id));
};

/** After an approval, the open learnings that contradict it may now conflict with a broader decision. */
const refreshContradicting = async (
  tx: Tx,
  ctx: LearningWriteContext,
  approvedId: string,
  boardId: number,
): Promise<void> => {
  for (const other of await boardLearnings(tx, boardId)) {
    const { contradicts } = learningLinks(other.glob);
    if (
      learningStatus(other.glob, other.artifacts) !== 'open' ||
      !contradicts.some((c) => c.kind === 'item' && c.ref === approvedId)
    )
      continue;
    const glob = await tx.getGlob(other.glob.id);
    const attributes = glob === null ? null : decisionOf(glob);
    if (glob === null || attributes === null) continue;
    const ids = await learningConflicts(tx, attributes.scope, 'open', contradicts);
    const result = await applyDecisionStep(tx, glob.id, (g) =>
      machine.decisionConflicts(g, ids, decisionContext(ctx.clock, null)),
    );
    if (result.ok && result.value.changed)
      ctx.raise?.({
        kind: 'glob.changed',
        boardId: glob.boardId,
        globId: glob.id,
        version: result.value.glob.version,
      });
  }
};

/** Writes the assessment of an open learning when `due`: at creation, when its draft or conflict flags move, when it reopens. */
export const assessLearning = async (
  tx: Tx,
  ctx: LearningWriteContext,
  glob: Glob,
  facts: LearningAssessmentFacts,
  preview: DraftPreview | null,
  due: boolean,
): Promise<void> => {
  if (facts.status !== 'open' || !due) return;
  if (await writeAssessment(tx, { clock: ctx.clock }, glob, facts, preview))
    ctx.raise?.({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
};

/** Who submitted a learning and when: what its first payload version records. */
export interface LearningOrigin {
  readonly id: string;
  readonly createdAt: string;
  readonly submittedBy: string;
  readonly source: KbItemSource;
  readonly agentSetVersion: number | null;
}

/** What a learning's artifacts hold, as a write compares it before and after (a KB item's fields of the same names). */
export interface LearningArtifactState {
  readonly origin: LearningOrigin;
  /** The plan.md payload (`proposalText`). */
  readonly payload: string;
  /** A document proposal's submission evidence; null for a statement (its evidence is in the payload). */
  readonly documentEvidence: string | null;
  readonly draft: KbDraft | null;
  readonly draftedAgainstVersion: number | null;
  readonly rationale: string | null;
  /** The target a draft is recorded against. */
  readonly target: KbTarget | null;
  readonly outcome: KbOutcome | null;
  /** Who decided and when: the outcome artifact's actor and time. */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly effectCheck: EffectCheck | null;
  readonly extraEvidence: readonly ExtraEvidence[];
  readonly mergeNote: KbMergeNote | null;
}

/** A learning's artifact state as read. */
const learningArtifactState = ({ glob, artifacts }: LearningRead): LearningArtifactState => {
  const facts = learningFacts(glob);
  const document = learningDocument(glob, artifacts);
  const evidence = learningEvidence(glob, artifacts);
  const drafted = learningDraft(artifacts);
  const decision = learningDecision(glob, artifacts);
  return {
    origin: {
      id: glob.id,
      createdAt: glob.createdAt,
      submittedBy: glob.creator,
      source: facts.source,
      agentSetVersion: facts.agentSetVersion,
    },
    payload: proposalText({ statement: glob.summary, evidence, document }),
    documentEvidence: document === null ? null : evidence,
    draft: drafted?.draft ?? null,
    draftedAgainstVersion: drafted?.targetVersion ?? null,
    rationale: drafted?.rationale ?? null,
    target: learningTarget(glob).routed,
    outcome: learningOutcome(artifacts),
    decidedBy: decision.by,
    decidedAt: decision.at,
    effectCheck: learningEffectCheck(artifacts),
    extraEvidence: learningExtraEvidence(artifacts),
    mergeNote: learningMergeNote(artifacts),
  };
};

/**
 * Writes the artifact versions a change needs (`before` null: the learning is new): only what changed, with empty
 * content where a value was cleared. Evidence merged in is never taken away. Returns whether it wrote any.
 */
export const writeLearningArtifacts = async (
  tx: Tx,
  glob: Glob,
  before: LearningArtifactState | null,
  after: LearningArtifactState,
  at: string,
): Promise<boolean> => {
  const { origin } = after;
  let wrote = false;
  if (before === null || before.payload !== after.payload) {
    await putLearningArtifact(
      tx,
      glob,
      'plan',
      '',
      after.payload,
      before === null ? origin.createdAt : at,
      {
        by:
          before === null ? (origin.source === 'mined' ? 'sessionator' : 'routine') : 'sessionator',
        actor: before === null ? origin.submittedBy : DECISION_SYSTEM_ACTOR,
        agentSetVersion: before === null ? origin.agentSetVersion : null,
      },
    );
    wrote = true;
  }
  if (
    after.documentEvidence !== null &&
    (before === null || before.documentEvidence !== after.documentEvidence)
  ) {
    await putLearningArtifact(
      tx,
      glob,
      'attachment',
      DOCUMENT_EVIDENCE_LABEL,
      after.documentEvidence,
      before === null ? origin.createdAt : at,
      {
        actor: origin.submittedBy,
      },
    );
    wrote = true;
  }
  const draftOf = (state: LearningArtifactState | null) =>
    state === null ? null : [state.draft, state.rationale, state.draftedAgainstVersion];
  if (!(before === null && after.draft === null) && !same(draftOf(before), draftOf(after))) {
    await putLearningArtifact(tx, glob, 'draft', '', after.draft?.content ?? '', at, {
      ...(after.draft === null
        ? {}
        : {
            draft: {
              section: after.draft.section,
              targetVersion: after.draftedAgainstVersion,
              target: after.target,
              rationale: after.rationale,
            },
          }),
    });
    wrote = true;
  }
  if (
    !(before === null && after.outcome === null) &&
    !same(before?.outcome ?? null, after.outcome)
  ) {
    await putLearningArtifact(
      tx,
      glob,
      'outcome',
      '',
      after.outcome === null ? '' : JSON.stringify(after.outcome),
      after.decidedAt ?? at,
      {
        by: 'human',
        actor: after.decidedBy ?? DECISION_SYSTEM_ACTOR,
        ...(after.outcome === null ? {} : { kbOutcome: after.outcome }),
      },
    );
    wrote = true;
  }
  if (
    !(before === null && after.effectCheck === null) &&
    !same(before?.effectCheck ?? null, after.effectCheck)
  ) {
    await putLearningArtifact(
      tx,
      glob,
      'effect_check',
      '',
      after.effectCheck === null ? '' : JSON.stringify(after.effectCheck),
      at,
      {
        ...(after.effectCheck === null ? {} : { effectCheck: after.effectCheck }),
      },
    );
    wrote = true;
  }
  const had = before?.extraEvidence ?? [];
  if (
    after.extraEvidence.length < had.length ||
    !same(after.extraEvidence.slice(0, had.length), had)
  ) {
    throw new Error(`${origin.id}: evidence merged into a learning is never taken away`);
  }
  const labels = new Set(had.map((e) => `${EVIDENCE_PREFIX}${e.itemId}`));
  for (const e of after.extraEvidence.slice(had.length)) {
    let label = `${EVIDENCE_PREFIX}${e.itemId}`;
    for (let n = 2; labels.has(label); n++) label = `${EVIDENCE_PREFIX}${e.itemId}#${String(n)}`;
    labels.add(label);
    await putLearningArtifact(tx, glob, 'attachment', label, e.evidence, e.at, {
      actor: e.submittedBy,
      evidence: { itemId: e.itemId, globIds: e.globIds },
    });
    wrote = true;
  }
  if (
    !(before === null && after.mergeNote === null) &&
    !same(before?.mergeNote ?? null, after.mergeNote)
  ) {
    await putLearningArtifact(
      tx,
      glob,
      'attachment',
      MERGE_NOTE_LABEL,
      after.mergeNote === null ? '' : mergeNoteText(after.mergeNote),
      at,
      {
        ...(after.mergeNote === null ? {} : { mergeNote: after.mergeNote }),
      },
    );
    wrote = true;
  }
  return wrote;
};

/** What a write changed that decides whether the assessment is rewritten. */
export interface AssessmentChange {
  readonly statusBefore: KbItemStatus;
  readonly statusAfter: KbItemStatus;
  readonly draftBefore: KbDraft | null;
  readonly draftAfter: KbDraft | null;
  readonly conflictsBefore: readonly string[];
  readonly conflictsAfter: readonly string[];
}

/**
 * Whether a write makes an open learning's assessment due: its draft changed, its conflict flags moved, or it is open
 * again (a reopen). Written at creation regardless.
 */
export const assessmentDue = (change: AssessmentChange): boolean =>
  change.statusAfter === 'open' &&
  (!same(change.draftBefore, change.draftAfter) ||
    !same(change.conflictsBefore, change.conflictsAfter) ||
    change.statusBefore !== 'open');

/** A write that approves a learning refreshes the conflict flags of the open learnings that contradict it. */
export const refreshOnApproval = async (
  tx: Tx,
  ctx: LearningWriteContext,
  learning: { readonly id: string; readonly boardId: number },
  statusBefore: KbItemStatus,
  statusAfter: KbItemStatus,
): Promise<void> => {
  if (statusAfter === 'approved' && statusBefore !== 'approved')
    await refreshContradicting(tx, ctx, learning.id, learning.boardId);
};

/** A submitted learning, as `submit_learning` records it. */
export interface NewLearningGlob {
  readonly id: string;
  readonly boardId: number;
  readonly type: LearningType;
  readonly statement: string;
  readonly evidence: string;
  readonly suggestedTarget: string | null;
  readonly sourceGlobIds: readonly string[];
  readonly agentSetVersion: number | null;
  readonly submittedBy: string;
  readonly createdAt: string;
  /** A whole document proposed (`/kb-bootstrap`), which is its own draft. */
  readonly document: ProposedDocument | null;
  /** Set for a document proposal (its document); a statement is routed by the pipeline. */
  readonly target: KbTarget | null;
}

/**
 * Creates a submitted learning as an open decision glob (row D1) with its payload, and queues routing (a document
 * proposal names its target and is its own draft, so nothing is queued); false if the ID is taken.
 */
export const createLearning = async (
  tx: Tx,
  ctx: LearningWriteContext,
  input: NewLearningGlob,
): Promise<boolean> => {
  const { id, boardId, statement, document, target } = input;
  const board = await tx.getBoard(boardId);
  const parsed = parseId(id);
  if (board === null || parsed?.letter !== 'k' || parsed.boardId !== boardId)
    throw new Error(`${id} is not a KB item ID on board ${String(boardId)}`);
  const attributes: DecisionAttributes = {
    scope: defaultScope(input.type),
    origin: { kind: 'submitted' },
    channel: 'agent',
    outcome: null,
    kind: input.type,
    sourceGlobs: input.sourceGlobIds,
    target: { suggested: input.suggestedTarget, routed: target },
    evidenceCount: 1,
    ...(input.agentSetVersion === null ? {} : { agentSetVersion: input.agentSetVersion }),
    ...(document === null
      ? {}
      : {
          document: {
            name: document.name,
            area: document.area,
            audience: document.audience,
            description: document.description,
          },
        }),
  };
  const created = machine.create(
    {
      id,
      boardId,
      title: decisionGlobTitle(statement),
      summary: statement,
      type: 'same',
      category: 'decision',
      attributes,
      group: null,
      environment: null,
      autoTrigger: false,
    },
    board,
    decisionContext({ now: () => input.createdAt }, { email: input.submittedBy, role: 'dev' }),
  );
  if (!created.ok) throw new Error(`${id}: ${created.error.message}`);
  const glob: Glob = { ...created.value.glob, links: [], version: 1 };
  if (!(await tx.insertGlob(glob, kbItemKey(id)))) return false;
  await tx.appendEvents(created.value.events);
  const evidence = input.evidence;
  await writeLearningArtifacts(
    tx,
    glob,
    null,
    {
      origin: {
        id,
        createdAt: input.createdAt,
        submittedBy: input.submittedBy,
        source: 'submitted',
        agentSetVersion: input.agentSetVersion,
      },
      payload: proposalText({ statement, evidence, document }),
      documentEvidence: document === null ? null : evidence,
      draft: null,
      draftedAgainstVersion: null,
      rationale: null,
      target,
      outcome: null,
      decidedBy: null,
      decidedAt: null,
      effectCheck: null,
      extraEvidence: [],
      mergeNote: null,
    },
    ctx.clock.now(),
  );
  await tx.enqueueEffects(
    stepEffects(id, null, {
      step: kbStepOf({ status: 'open', document, target, draft: null }),
      target,
    }),
  );
  const read = await readLearning(tx, id);
  if (read !== null) await assessLearning(tx, ctx, glob, learningAssessmentFacts(read), null, true);
  ctx.raise?.({ kind: 'glob.changed', boardId, globId: id, version: glob.version });
  return true;
};

/** One write to a learning, as the named operations below describe it. */
interface LearningEdit {
  /** The decision row a status change needs, at the edit's time. */
  readonly row?: (glob: Glob, at: string) => Result<Transition>;
  /** When the edit happens (a decision's time); now when absent. */
  readonly at?: string;
  /** The attributes after the edit; the row's own keys and `conflictsWith` are worked out around it. */
  readonly attributes?: (attributes: DecisionAttributes) => DecisionAttributes;
  readonly links?: (links: readonly GlobLink[]) => GlobLink[];
  /** A new statement: the glob's summary, title and payload follow it. */
  readonly statement?: string;
  /** Back to drafting: the draft is cleared (a document proposal is its own draft, and keeps it). */
  readonly requeue?: true;
  readonly clearMergeNote?: true;
  /** The verified quotes a closure rests on (a merge's note). */
  readonly mergeNote?: KbMergeNote;
  /** Evidence merged in from near-duplicates, after what it has. */
  readonly addEvidence?: readonly ExtraEvidence[];
  /** The outcome artifact (null clears it), by whom (slop when absent) and when (the edit's time when absent). */
  readonly outcome?: {
    readonly value: KbOutcome | null;
    readonly by?: string;
    readonly at?: string;
  };
  readonly effectCheck?: EffectCheck | null;
}

/**
 * Applies `edit` to learning `id` if its glob is still at `expectedVersion` (it moves to the next version); false
 * otherwise. Writes only the artifacts that change, queues the step the change makes due, rewrites the assessment when
 * due and refreshes the conflicts of learnings contradicting one just approved. Throws when the row refuses: callers
 * check what may happen before they write.
 */
const editLearning = async (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
  edit: LearningEdit,
): Promise<boolean> => {
  const now = ctx.clock.now();
  const before = await readLearning(tx, id);
  if (before?.glob.version !== expectedVersion) return false;
  const { glob, artifacts } = before;
  const statusBefore = learningStatus(glob, artifacts);
  const step = edit.row?.(glob, edit.at ?? now);
  if (step !== undefined && !step.ok) throw new Error(`${id}: ${step.error.message}`);
  const moved = step?.value.glob ?? glob;
  const base = decisionOf(moved);
  if (base === null) throw new Error(`${id} is not a decision glob`);
  const changed: MutableAttributes = { ...(edit.attributes?.(base) ?? base) };
  const links = edit.links?.(moved.links ?? []) ?? [...(moved.links ?? [])];
  const status = learningStatusFrom(
    changed,
    edit.outcome === undefined ? learningOutcome(artifacts) : edit.outcome.value,
  );
  const conflicts = await learningConflicts(
    tx,
    changed.scope,
    status,
    learningLinks({ ...moved, attributes: changed, links }).contradicts,
  );
  if (conflicts.length === 0) delete changed.conflictsWith;
  else changed.conflictsWith = conflicts;
  const statement = edit.statement ?? glob.summary;
  const next: Glob = {
    ...moved,
    // A person may have retitled the decision: only a new statement gives it a new title.
    title: statement === glob.summary ? moved.title : decisionGlobTitle(statement),
    summary: statement,
    attributes: changed,
    links,
    version: expectedVersion + 1,
  };
  // A write that changes nothing still writes the row: it holds the lock a dedupe check relies on.
  if (!(await tx.updateGlob(next, expectedVersion))) return false;
  await tx.appendEvents(step?.value.events ?? []);

  const document = learningDocument(glob, artifacts);
  const clearsDraft = edit.requeue === true && document === null;
  const stateBefore = learningArtifactState(before);
  const outcome = edit.outcome;
  const stateAfter: LearningArtifactState = {
    ...stateBefore,
    payload: proposalText({ statement, evidence: learningEvidence(glob, artifacts), document }),
    ...(clearsDraft ? { draft: null, draftedAgainstVersion: null, rationale: null } : {}),
    ...(outcome === undefined
      ? {}
      : { outcome: outcome.value, decidedBy: outcome.by ?? null, decidedAt: outcome.at ?? null }),
    ...(edit.effectCheck === undefined ? {} : { effectCheck: edit.effectCheck }),
    ...(edit.clearMergeNote === true ? { mergeNote: null } : {}),
    ...(edit.mergeNote === undefined ? {} : { mergeNote: edit.mergeNote }),
    ...(edit.addEvidence === undefined
      ? {}
      : { extraEvidence: [...stateBefore.extraEvidence, ...edit.addEvidence] }),
  };
  const wrote = await writeLearningArtifacts(tx, next, stateBefore, stateAfter, now);
  await refreshOnApproval(tx, ctx, { id, boardId: glob.boardId }, statusBefore, status);
  const target = learningTarget(next).routed;
  const stepAfter = kbStepOf({
    status,
    document,
    target,
    draft: stateAfter.draft,
  });
  await tx.enqueueEffects([
    ...(step?.value.effects ?? []),
    ...stepEffects(
      id,
      { step: learningStep(glob, artifacts), target: learningTarget(glob).routed },
      { step: stepAfter, target },
    ),
  ]);
  const due = assessmentDue({
    statusBefore,
    statusAfter: status,
    draftBefore: stateBefore.draft,
    draftAfter: stateAfter.draft,
    conflictsBefore: decisionOf(glob)?.conflictsWith ?? [],
    conflictsAfter: changed.conflictsWith ?? [],
  });
  if (due) {
    // Read back with the step just queued, so the assessment sees the pipeline state the write left.
    const after = await readLearning(tx, id);
    if (after !== null)
      await assessLearning(tx, ctx, next, learningAssessmentFacts(after), null, true);
  }
  ctx.raise?.({ kind: 'glob.changed', boardId: glob.boardId, globId: id, version: next.version });
  if (wrote) ctx.raise?.({ kind: 'glob.artifacts', boardId: glob.boardId, globId: id });
  return true;
};

/**
 * Sends an open learning back to be drafted again (its target moved, an admin chose another target, or its draft is
 * stale): the draft is cleared and drafting is queued; routing isn't repeated. `target` replaces its target.
 */
export const requeueLearningDraft = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
  target?: KbTarget,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    requeue: true,
    ...(target === undefined
      ? {}
      : {
          attributes: (a: DecisionAttributes) => ({
            ...a,
            target: { suggested: a.target?.suggested ?? null, routed: target },
          }),
        }),
  });

/**
 * An admin's Retry of a learning the pipeline gave up on: the glob's version moves (a Knowledge page tab holding the
 * failed learning gets a conflict and refetches), and its step gets a fresh job with its attempts unspent.
 */
export const retryLearningStep = async (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
): Promise<boolean> => {
  if (!(await editLearning(tx, ctx, id, expectedVersion, {}))) return false;
  const read = await readLearning(tx, id);
  const step = read === null ? null : learningStep(read.glob, read.artifacts);
  if (step !== null) await tx.enqueueEffects([{ kind: KB_STEP_KIND[step], globId: id }]);
  return true;
};

/**
 * Row D12: an admin reopens a learning the pipeline closed. It goes back to drafting against its target (a document
 * proposal is its own draft), without the merge note; a reopened merge keeps the pair apart (the row's link).
 */
export const reopenClosedLearning = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  actor: Actor,
  expectedVersion: number,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    row: (glob, at) => machine.reopenClosedDecision(glob, decisionContext(ctx.clock, actor, at)),
    requeue: true,
    clearMergeNote: true,
  });

/** The other side of a reopened merge: kept apart from `otherId`, so consolidation never merges the pair again. */
export const keepLearningApart = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  otherId: string,
  expectedVersion: number,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    links: (links) =>
      links.some((l) => l.kind === 'kept_apart_from' && l.id === otherId)
        ? [...links]
        : [...links, { id: otherId, kind: 'kept_apart_from', source: 'explicit' }],
  });

/**
 * An agent's decision reopened: the learning is open again with no outcome or effect check, and goes back to drafting
 * (a document proposal is its own draft). Reverting what an approval wrote is the caller's.
 */
export const reopenDecidedLearning = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    row: (glob, at) => machine.decisionReopened(glob, decisionContext(ctx.clock, null, at)),
    outcome: { value: null },
    effectCheck: null,
    requeue: true,
  });

/** An admin keeps a learning consolidation flagged stale: the flag clears, and `at` holds it off for a while. */
export const dismissLearningStale = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
  at: string,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    attributes: (a) => ({ ...a, stale: { since: null, reason: null, dismissedAt: at } }),
  });

/** `attributes` with its stale flag set (or removed once nothing is flagged or dismissed); an admin's Keep stays. */
const withStale = (
  attributes: DecisionAttributes,
  since: string | null,
  reason: KbStaleReason | null,
): DecisionAttributes => {
  const dismissedAt = attributes.stale?.dismissedAt ?? null;
  const next: MutableAttributes = { ...attributes };
  delete next.stale;
  return since === null && reason === null && dismissedAt === null
    ? next
    : { ...next, stale: { since, reason, dismissedAt } };
};

/** Weekly consolidation's flag on an open learning: stale since `since` for `reason`, or cleared (both null). */
export const flagLearningStale = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
  since: string | null,
  reason: KbStaleReason | null,
): Promise<boolean> =>
  editLearning(tx, ctx, id, expectedVersion, {
    attributes: (a) => withStale(a, since, reason),
  });

/**
 * Merges `loser` into `survivor` (both as read in this transaction), each write conditional on the version read:
 * the survivor gains the loser's evidence, source globs, count and kept-apart links, and its signal when it has
 * none (new evidence clears its stale flag); the loser is closed as merged into the survivor (row D10′, a
 * `duplicate_of` link) with the verified quotes. False when either changed, and the caller must roll the
 * transaction back (the first write may have landed).
 */
export const mergeLearnings = async (
  tx: Tx,
  ctx: LearningWriteContext,
  survivor: LearningRead,
  loser: LearningRead,
  note: KbMergeNote,
): Promise<boolean> => {
  const into = learningFacts(survivor.glob);
  const from = learningFacts(loser.glob);
  const fromLinks = learningLinks(loser.glob);
  const added: ExtraEvidence = {
    itemId: loser.glob.id,
    globIds: from.sourceGlobIds,
    evidence: learningEvidence(loser.glob, loser.artifacts),
    submittedBy: loser.glob.creator,
    at: loser.glob.createdAt,
  };
  const signal = into.signal === null ? from.signal : null;
  const keptApart = fromLinks.keptApartFrom.filter(
    (other) => other !== survivor.glob.id && !learningLinks(survivor.glob).keptApartFrom.includes(other),
  );
  const took = await editLearning(tx, ctx, survivor.glob.id, survivor.glob.version, {
    // The loser's own evidence comes first, then what was merged into it.
    addEvidence: [added, ...learningExtraEvidence(loser.artifacts)],
    attributes: (a) =>
      withStale(
        {
          ...a,
          evidenceCount: into.occurrenceCount + from.occurrenceCount,
          sourceGlobs: [...new Set([...into.sourceGlobIds, ...from.sourceGlobIds])],
          ...(signal === null ? {} : { signal }),
        },
        null,
        null,
      ),
    links: (links) => [
      ...links,
      ...[...new Set(keptApart)].map(
        (id): GlobLink => ({ id, kind: 'kept_apart_from', source: 'explicit' }),
      ),
    ],
  });
  if (!took) return false;
  return editLearning(tx, ctx, loser.glob.id, loser.glob.version, {
    row: (glob, at) =>
      machine.closeDecision(
        glob,
        'merged',
        { id: survivor.glob.id, kind: 'duplicate_of', source: 'pipeline' },
        decisionContext(ctx.clock, null, at),
      ),
    // A closed learning isn't flagged; reopened, the next run flags it again if the rule still holds.
    attributes: (a) => withStale(a, null, null),
    mergeNote: note,
  });
};

/** A decision on an open learning, by `by` at `at`. */
export type LearningDecisionRecord =
  | {
      readonly kind: 'approved';
      readonly by: string;
      readonly at: string;
      /** The statement as approved (an admin may edit it). */
      readonly statement: string;
      readonly reason: string | null;
      /** What the approval did. */
      readonly outcome: KbOutcome;
      /** The signal its effect check watches, if any (a mined learning's own, or one an admin chose). */
      readonly signal: KbSignal | null;
      readonly effectCheck: EffectCheck | null;
      /** The draft was edited before it was applied: the decision is `accept_with_edits`. */
      readonly edited: boolean;
    }
  | {
      readonly kind: 'rejected';
      readonly by: string;
      readonly at: string;
      readonly reason: string;
      /** An agent's rejection is recorded as an outcome; a person's leaves none. */
      readonly outcome: KbOutcome | null;
    };

/** Records a decision on an open learning: its decision row (the glob is accepted, or rejected and signed off) and what it did. */
export const recordLearningDecision = (
  tx: Tx,
  ctx: LearningWriteContext,
  id: string,
  expectedVersion: number,
  decision: LearningDecisionRecord,
): Promise<boolean> => {
  const outcome = { value: decision.outcome, by: decision.by, at: decision.at };
  if (decision.kind === 'rejected') {
    return editLearning(tx, ctx, id, expectedVersion, {
      row: (glob, at) =>
        machine.decisionRejected(
          glob,
          { by: decision.by, reason: decision.reason },
          decisionContext(ctx.clock, null, at),
        ),
      at: decision.at,
      outcome,
    });
  }
  const { signal } = decision;
  return editLearning(tx, ctx, id, expectedVersion, {
    row: (glob, at) =>
      machine.decisionApproved(
        glob,
        {
          by: decision.by,
          kind: decision.edited ? 'accept_with_edits' : 'accept',
          reason: decision.reason,
        },
        decisionContext(ctx.clock, null, at),
      ),
    at: decision.at,
    statement: decision.statement,
    ...(signal === null ? {} : { attributes: (a: DecisionAttributes) => ({ ...a, signal }) }),
    outcome,
    effectCheck: decision.effectCheck,
  });
};
