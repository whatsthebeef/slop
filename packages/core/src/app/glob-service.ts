import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { canChooseType, CHOOSE_TYPE_REFUSAL } from './access.js';
import { isLearning } from '../domain/learning.js';
import { validateScopeEdit } from '../domain/attributes.js';
import { groupFromTitle, normaliseGroup } from '../domain/group.js';
import { inGroup } from '../domain/group-view.js';
import { formatId, letterFor } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import { listOf } from '../domain/matrix.js';
import { HUMAN_STEP_BLOCKS, HUMAN_STEP_KINDS, PREDICTED_ROLLOUT_TITLE, humanSteps, isHumanStepDue, isMerged, storedBlockProgress } from '../domain/human-steps.js';
import { isCapabilityName } from '../domain/capabilities.js';
import type { Capabilities } from '../domain/capabilities.js';
import { ROLLOUT_NONE_LABEL, ROLLOUT_NONE_PREFIX, ROLLOUT_NOT_WRITTEN_TITLE, ROLLOUT_PATHS_ORIGIN, ROLLOUT_SCRIPT_KIND, ROLLOUT_SECTION_ORIGIN, parseRollout, rolloutScriptLabel } from '../domain/rollout.js';
import type { RolloutAnswer } from '../domain/rollout.js';
import type { HumanStep, HumanStepBlock, HumanStepKind, HumanStepScript, StoredHumanStep } from '../domain/human-steps.js';
import type { ActionFacts, Context, CreateInput, FieldChanges, LabelCommand, Transition } from '../domain/machine.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import type { Artifact, ArtifactSummary, Provenance } from '../domain/knowledge.js';
import { HANDOVER_LABEL, handoverMarkdown } from '../domain/handover.js';
import type { Handover } from '../domain/handover.js';
import type { Actor, Board, Category, Escalation, Glob, ImpliedAfter, InferenceSource, LabelName, Relation, RelationGate, RelationUntil, SlopType, WorkKind } from '../domain/types.js';
import { parseWorkstreams, summariseWorkstreams } from '../domain/workstreams.js';
import type { WorkstreamsSummary } from '../domain/workstreams.js';
import { mergeImplied } from '../domain/exclusive-paths.js';
import type { DependencyInferenceService, InferredEdge } from './dependency-inference-service.js';
import { deleteObjectEffect, knowledgePageEffect, recheckOverlapsEffect, writeRolloutEffect } from '../domain/events.js';
import type { DomainEvent } from '../domain/events.js';
import type { PendingEffect } from '../domain/machine-steps.js';
import { defaultAreas, matchRiskAreas, splitEvidence } from '../domain/risk-area.js';
import { scriptPathOf } from '../domain/action-script.js';
import type { ActionScript, ScriptCheck } from '../domain/action-script.js';
import type { CodeView } from './code-view.js';
import { CodeViewUnavailable } from '../domain/code-view.js';
import { MAX_AFTER, MAX_RELATIONS, NO_RELATIONS, defaultUntil, NO_WRITE, applyWrite, doneOf, draftOf, awaitedOf, checkRelation, checkRelationShape, hasMerged, holdingOf, isActive, isEmptyWrite, isExplicit, isMet, pickUpWarning, startIds, toState } from '../domain/relations.js';
import type { AwaitedDependency, HeldBack, Holding, NewRelation, RelationFacts, RelationsView, RelationWrite, TitleInfo, ToState } from '../domain/relations.js';
import type { InboxItem } from '../domain/inbox.js';
import type { IntakeRecord, SnapshotSource } from '../domain/intake-learning.js';
import type { BranchFiles, Clock, Embedder, GlobFilter, Hint, IdGenerator, Notifier, RoutineDirectory, Store, Tx } from '../ports.js';
import { DECISIONS_LABEL, decisionsAttachment } from '../domain/decision-glob.js';
import { ACTION_PLAN_TEMPLATE } from '../domain/action-glob.js';
import { defaultFix, defaultWorkKind, fixOf, isCodeGlob, isHumanCategory, workKindOf } from '../domain/types.js';
import { addArtifact, governingDecisions, handoverOf } from './artifact-service.js';
import { readMergePolicy } from './knowledge-service.js';
import { subGateCheckOf } from '../domain/merge-policy.js';
import { fileKeysOf } from './attachment-service.js';
import { DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import { AttachConflict, linkInboxItem } from './inbox-service.js';
import { findHolds } from './hold-service.js';
import { recordTypeCorrection } from './type-learning-service.js';
import type { DependencyLearningService } from './dependency-learning-service.js';
import { embedRequest, snapshotOf } from './intake-learning-service.js';
import { inferenceReasonOf } from './intake-service.js';
import type { WorkInference } from './intake-service.js';
import { checkFrom } from './size-check-service.js';
import { hash } from './text-hash.js';
import type { SizeAssessor } from './size-check-service.js';
import { needsInvestigation, unresolved } from '../domain/size-check.js';
import type { SizeCheck } from '../domain/size-check.js';

export interface GlobServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly routines: RoutineDirectory;
  /** The files a branch changes, for the board's merge policy (exclusive paths); without it no glob is held for them. */
  readonly branchFiles?: BranchFiles;
  /** Embeds a new glob's request for its intake snapshot; without it (or when it fails) the snapshot's embedding is filled later. */
  readonly embedder?: Embedder;
  /** Judges a new glob's size; without it no size check is made and nothing is held for it. */
  readonly sizeCheck?: SizeAssessor;
  /** Which dependency edges are real on this board: predicts overlaps from its learned weights and learns needs from failures. */
  readonly dependencyLearning?: DependencyLearningService;
  /** Infers a new glob's needs and overlaps from its plan and the open globs; without it a glob has only the edges it was given. */
  readonly inference?: Pick<DependencyInferenceService, 'infer'>;
  /** Reads a file on the board's base branch, for the script an action runs; without it no script is checked. */
  readonly codeView?: Pick<CodeView, 'read'>;
  /** Where a best-effort side task reports its failure (the server's error log). */
  readonly log?: (task: string, message: string) => void;
}

/** plan.md v1 of a new glob: the caller's plan, else what intake was given, else the title. */
const planOf = (input: Pick<CreateGlobInput, 'plan' | 'title' | 'intake'>): string => {
  for (const text of [input.plan, input.intake?.request]) if (text !== undefined && text !== null && text.trim() !== '') return text;
  return input.title.trim();
};

/**
 * A relation as a person or an agent states it. `gate` defaults to `start`; `until` to `merged`, or `decided` when `to` is a
 * decision glob. `needs` and `after` stay as shorthand for start-until-merged.
 */
export interface RelationInput {
  readonly to: string;
  readonly gate?: RelationGate;
  readonly until?: RelationUntil;
  readonly reason?: string | null;
  /** Set when the relation is one of a group-wide decision's (see `holdGroup`): the group it was set for. */
  readonly group?: string | null;
}

/** Whether a glob is already past a gate, so a relation on that gate holds nothing: started, merged or signed off. */
const pastGate = (glob: Glob, gate: RelationGate): boolean =>
  gate === 'start' ? glob.status !== 'planning' : gate === 'merge' ? hasMerged(glob) : glob.status === 'signed_off';

/** How long a script check is trusted when no push to the base branch arrives (webhooks are best effort). */
const SCRIPT_CACHE_MS = 5 * 60 * 1000;
/** A script not found is trusted only briefly: right after a push the local clone may not have fetched it yet. */
const SCRIPT_MISSING_CACHE_MS = 15 * 1000;

/** The facts the machine reads about an action's script. */
const scriptFacts = (check: ScriptCheck | null): { readonly script?: ActionScript; readonly baseBranch?: string } =>
  check === null ? {} : { script: check.script, baseBranch: check.baseBranch };

/** The longest reason a relation keeps. */
export const MAX_RELATION_REASON = 300;

/** Who stated the relations of a request: the source they are recorded with. */
export type RelationsBy = 'person' | 'agent';

/** A code work create: the type is chosen. */
type CodeCreateInput = Omit<CreateGlobInput, 'type'> & { readonly type: SlopType };

export interface CreateGlobInput {
  readonly boardId: number;
  readonly title: string;
  /** Null for an action (human work has no type); code work needs one. */
  readonly type: SlopType | null;
  /**
   * False when the caller didn't choose the type (a default, or intake's proposal): a member who may only create sames then
   * gets a same. An explicit sub or super from them is refused (default true).
   */
  readonly typeChosen?: boolean;
  readonly category: Category;
  /** The fix flag and work kind with who set them (default: inferred from the category; intake and callers drive them). */
  readonly fix?: boolean;
  readonly fixSource?: InferenceSource;
  readonly workKind?: WorkKind;
  readonly workKindSource?: InferenceSource;
  readonly inferenceReason?: string | null;
  readonly group: string | null;
  readonly environment: string | null;
  /** Actions: who is meant to do it (default: anyone). */
  readonly assignee?: string | null;
  readonly autoTrigger: boolean;
  /** Super only: `false` parks it in Planning until a person picks it up to pair; otherwise it starts in Doing with its creator. */
  readonly start?: boolean;
  readonly idempotencyKey: string | null;
  /**
   * plan.md v1, stored verbatim with the glob: the caller passes `plan`, else the intake input, else the title. A glob
   * always has a plan.
   */
  readonly plan?: string | null;
  /** Who is creating it, for the plan's provenance (default: a person). */
  readonly planBy?: Provenance['by'];
  /** Globs on the board to start after (a sub waits in Planning until they merge); merged ones are ignored. Shorthand for start relations until merged. */
  readonly after?: readonly string[];
  /** Relations stated beside `after` (any gate); `relationsBy` says who states them (default: a person). */
  readonly relations?: readonly RelationInput[];
  readonly relationsBy?: RelationsBy;
  /** Files intake guessed the work changes (advisory: with the plan, they decide whether exclusive paths hold it). */
  readonly files?: readonly string[];
  /** What intake saw and decided, for the glob's snapshot; absent when intake didn't run. */
  readonly intake?: IntakeRecord | null;
  /** Where the glob is created from, for the snapshot when intake didn't run (default: `api`). */
  readonly source?: SnapshotSource;
  /** An inbox item of the board to attach to the new glob in the same transaction; refused when it is another board's or discarded. */
  readonly inboxItem?: number;
}

/** One part of a split. Part 0 is the original glob (it keeps its ID); the others become new globs in its group. */
export interface SplitPart {
  readonly title: string;
  /** This part's share of plan.md (Markdown). `{part:N}` stands for part N's glob ID. */
  readonly plan: string;
  /** Default: the original's category. */
  readonly category?: Category;
  /** Default: the original's type. */
  readonly type?: SlopType;
  /** Default: the original's fix flag and work kind (or the category's, when the part names another category). */
  readonly fix?: boolean;
  readonly workKind?: WorkKind;
  /** Indexes of earlier parts this one needs merged first (stored as ordinary needs); none, the default, leaves the parts independent. Part 0 has none. */
  readonly after?: readonly number[];
  /** Labels of the original's text attachments to copy to this part (link attachments always are). New parts only. */
  readonly attachments?: readonly string[];
}

export const MAX_SPLIT_PARTS = 10;

/** The letter inputs of a code glob being created: the fix flag and work kind it was given, else its category's. */
const inferredOf = (
  input: Pick<CreateGlobInput, 'category' | 'fix' | 'workKind'>,
  type: SlopType,
): { actor: 'machine'; mode: SlopType; fix: boolean; workKind: WorkKind } => ({
  actor: 'machine',
  mode: type,
  fix: input.fix ?? defaultFix(input.category),
  workKind: input.workKind ?? defaultWorkKind(input.category),
});

/** A split part's fix flag and work kind: its own, else the original's when the category stays, else the category's defaults. */
const partInference = (
  original: Glob,
  part: SplitPart,
): { actor: 'machine'; mode: SlopType; fix: boolean; workKind: WorkKind } => {
  const sameCategory = part.category === undefined || part.category === original.category;
  const category = part.category ?? original.category;
  return {
    actor: 'machine',
    mode: part.type ?? original.type ?? 'same',
    fix: part.fix ?? (sameCategory ? fixOf(original) : defaultFix(category)),
    workKind: part.workKind ?? (sameCategory ? workKindOf(original) : defaultWorkKind(category)),
  };
};

/** What a split decided about one part's escalation; `change` is null when the part had none before and has none now. */
interface PartEscalation {
  readonly type: SlopType;
  readonly escalation: Escalation | null;
  readonly change: { readonly kind: 'Escalated' | 'Deescalated'; readonly data: Record<string, string> } | null;
}

const escalatedAs = (escalation: Escalation, type: SlopType): PartEscalation => ({
  type,
  escalation,
  change: {
    kind: 'Escalated',
    data: { reason: escalation.reason, ...(escalation.criterion === undefined ? {} : { criterion: escalation.criterion }), evidence: escalation.evidence ?? '' },
  },
});

/**
 * Re-checks the escalation of every part of a split against the board's risk areas (the matcher intake uses), in part order.
 * A part that matches is a same with the matched areas as the reason and its own files as the evidence; one that doesn't
 * loses any escalation (its type stays what the proposal decided). If the original was escalated and no part matches, part
 * 0 keeps the original's escalation with a note, so the split never escalates less than the original did. Supers are left alone.
 */
export const splitEscalations = (
  original: Glob,
  parts: readonly { readonly plan: string; readonly type: SlopType }[],
  areas: Parameters<typeof matchRiskAreas>[0],
  actor: string,
  now: string,
): PartEscalation[] => {
  const escalated = original.escalation ?? null;
  const before = escalated;
  const matches = parts.map((p) => (p.type === 'super' ? null : matchRiskAreas(areas, p.plan)));
  const anyMatch = matches.some((m) => m !== null && m.areas.length > 0);
  return parts.map((part, index): PartEscalation => {
    const match = matches[index];
    const had = index === 0 ? escalated : null;
    if (match === null || match === undefined) {
      return { type: part.type, escalation: had, change: null };
    }
    if (match.areas.length > 0) {
      const reason = `Touches the board's risk areas: ${match.areas.map((a) => a.name).join(', ')}`;
      return escalatedAs({ reason, criterion: before?.criterion ?? 'risk_area', evidence: splitEvidence(original.id, match), by: actor, at: now }, 'same');
    }
    if (index === 0 && before !== null && !anyMatch) {
      const evidence = `carried from ${original.id}; no part matched on its own`;
      return escalatedAs({ reason: before.reason, ...(before.criterion === undefined ? {} : { criterion: before.criterion }), evidence, by: actor, at: now }, part.type);
    }
    return { type: part.type, escalation: null, change: had === null ? null : { kind: 'Deescalated', data: { reason: had.reason } } };
  });
};

/** The event on `from` for a relation that was added. */
const relationAdded = (r: Relation, actor: string | null, at: string): DomainEvent => ({
  type: 'RelationAdded',
  globId: r.from,
  actor,
  at,
  data: { to: r.to, gate: r.gate, until: r.until, source: r.source, reason: r.reason },
});

/**
 * The events a relation write logs on `from`: one per relation added (see `relationAdded`), dismissed (with its source, so
 * learning can tell an inferred one) or removed, and the notes of an inference.
 */
const relationEvents = (
  from: string,
  actor: string | null,
  at: string,
  before: readonly Relation[],
  write: RelationWrite,
  inserted: readonly Relation[],
): DomainEvent[] => {
  const known = (id: string): Relation | undefined => before.find((r) => r.id === id);
  const events: DomainEvent[] = [];
  for (const r of write.remove) {
    const gone = known(r);
    if (gone !== undefined) events.push({ type: 'RelationReleased', globId: from, actor, at, data: { to: gone.to, gate: gone.gate, reason: 'removed' } });
  }
  for (const r of inserted) events.push(relationAdded(r, actor, at));
  for (const u of write.update) {
    const was = known(u.id);
    if (was !== undefined && u.patch.dismissedAt != null) {
      events.push({ type: 'RelationDismissed', globId: from, actor, at, data: { to: was.to, edgeId: was.to, gate: was.gate, source: was.source, planHash: u.patch.dismissedPlanHash ?? null } });
    }
  }
  if (write.notes !== undefined && write.notes.lines.length > 0) {
    events.push({ type: 'EdgesInferred', globId: from, actor, at, data: { added: [], dropped: [], notes: [...write.notes.lines], planHash: write.notes.planHash } });
  }
  return events;
};

const escalationEvent = (globId: string, actor: string, at: string, change: NonNullable<PartEscalation['change']>) =>
  ({ type: change.kind, globId, actor, at, data: change.data }) as const;

/** Where a glob came from in a split: the glob that was cut, its own place and every part's ID in order. */
export interface SplitInfo {
  readonly source: string;
  readonly part: number;
  readonly parts: readonly string[];
}

/** A person taking a glob, or giving it back, for the activity log: who (null for slop) and when. */
export interface Handoff {
  readonly kind: 'picked_up' | 'took_over' | 'handed_back';
  readonly by: string | null;
  readonly at: string;
}

/** What a client may change on a glob: the fields, and the globs it starts after (a list that replaces the person-set ones). */
export type GlobChanges = Omit<FieldChanges, 'after' | 'impliedAfter'> & {
  readonly after?: readonly string[];
  /** Relations to add or change (any gate): additive, unlike `after`, which replaces the start list. Remove one with `dismissRelation`. */
  readonly relations?: readonly RelationInput[];
  readonly relationsBy?: RelationsBy;
};

/** Where a relation is added from: held back by `other` (the usual), or holding `other` back (a decision's "Holds back"). */
export type RelationDirection = 'held_by' | 'holds_back';

export interface SplitInput {
  readonly parts: readonly SplitPart[];
  readonly idempotencyKey: string | null;
  /** Who is splitting, for the new plans' provenance (default: a person). */
  readonly planBy?: Provenance['by'];
  /** The group every part shares when the original has none (default: named from its title); ignored when it has one. */
  readonly group?: string | null;
}

/** Part N's glob ID wherever a plan or summary writes `{part:N}`. */
export const fillPartIds = (text: string, ids: readonly string[]): string =>
  text.replace(/\{part:(\d+)\}/g, (match, n: string) => ids[Number(n)] ?? match);

export interface GlobView {
  readonly glob: Glob;
  readonly allowedActions: readonly machine.Action[];
  /** The latest version of each artifact, without content. */
  readonly artifacts: readonly ArtifactSummary[];
  /** The glob's own relations, every gate and state (the views show them as edges until the relation views replace them). */
  readonly relations: readonly Relation[];
  /** What the glob still waits for before it starts (its unmet start relations), with the reason for each. */
  readonly waitingFor: readonly AwaitedDependency[];
  /** Globs in Planning that wait for this one. */
  readonly waitedOnBy: readonly string[];
  /** Every unmet relation of the glob (any gate), with the title of what it points at: what holds it back right now. */
  readonly holding: readonly Holding[];
  /** The glob's relations in groups: holding it back, held back by it, and no longer holding. */
  readonly relationGroups: RelationsView;
  /** The size check (flag, estimate, suggested cut); null when none was made. */
  readonly sizeCheck: SizeCheck | null;
  /** Everything a person must do on the glob: steps the machine implies and stored work steps, most pressing first. */
  readonly humanSteps: readonly HumanStep[];
  /** Why a person is needed on the glob and what to do first; null when nothing is wrong. */
  readonly handover: Handover | null;
  /** The status messages the reader dismissed on this glob (their keys); other people's are never shown. */
  readonly dismissedKeys: readonly string[];
  /** An open action's script and whether the base branch has it (null onBase: could not check); null when it names none. */
  readonly script?: ActionScript | null;
}

/** The title of each glob and whether it is a decision or an action, for the holdings that name them. */
const titlesOf = (globs: ReadonlyMap<string, Glob>): Map<string, TitleInfo> =>
  new Map([...globs].map(([id, g]) => [id, { title: g.title, decision: g.category === 'decision', action: g.category === 'action' }]));

/** A dismissal key is opaque to the server; the web builds it from the situation (see `lib/dismissals.ts`). */
const DISMISSAL_KEY = /^[\w:.+@/-]{1,200}$/;

/** Artifacts in a stable order: by kind (plan first), then label. */
const byKind = (a: ArtifactSummary, b: ArtifactSummary): number =>
  ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label);

const stepFields = (s: Pick<StoredHumanStep, 'detail' | 'check' | 'script' | 'why' | 'permissions' | 'commands' | 'verify'>) =>
  [s.detail, s.check, s.script, s.why, s.permissions, s.commands, s.verify];

type Step = (glob: Glob, ctx: Context, board: Board, facts: ActionFacts) => Result<Transition>;

/** A work step as a person or agent writes it; what is left out gets the kind's defaults. */
export interface NewHumanStep {
  readonly title: string;
  readonly kind?: HumanStepKind;
  readonly detail?: string;
  readonly who?: string;
  readonly due?: string;
  readonly blocks?: readonly HumanStepBlock[];
  readonly check?: string;
  readonly script?: HumanStepScript;
  readonly why?: string;
  readonly permissions?: string;
  readonly commands?: readonly string[];
  readonly verify?: string;
}

interface CommandOptions {
  /** Read the facts some actions depend on (the latest implementation record); other steps get none. */
  readonly facts?: boolean;
  /** Read the glob's relations and the state of what they point at into `facts.relations`. */
  readonly relations?: boolean;
  /**
   * Plans changes to the glob's relations. Runs under the board's relation lock with the board's relations (so a cycle check
   * can't race), before the step; the step sees the relations as they will be. The rows and their events are written only
   * when the step succeeds, in the same transaction, and the glob's version moves even when the step changed nothing else.
   */
  readonly relationPlan?: (tx: Tx, glob: Glob, board: readonly Relation[], now: string) => Promise<Result<RelationWrite>>;
  /** Read the work steps holding back sign-off into `facts.rollout`. */
  readonly rollout?: boolean;
  /** Runs before the step: checks input against the store. */
  readonly prepare?: (tx: Tx, glob: Glob) => Promise<Result<null>>;
  /** A system step that starts a run on someone's behalf: the glob's creator triggers it. */
  readonly triggeredByCreator?: boolean;
  /** Which globs the step applies to: work globs (the default), decision globs only, or either (pick-up, field edits). */
  readonly applies?: 'work' | 'decision' | 'action' | 'any';
  /** Runs in the transaction after the glob was updated, only when the step changed it: `before` is the glob as it was. */
  readonly record?: (tx: Tx, before: Glob, next: Glob, actor: Actor | null) => Promise<void>;
}

/** Integration events retry a few times on concurrent writes; they carry no client version. */
const EVENT_RETRIES = 5;

/** `command` lost its version race after writing relation rows: thrown so the transaction rolls them back. */
class RelationWriteLost extends Error {}

/** A glob that waited for the one being deleted was written meanwhile: thrown so the delete rolls back and runs again. */
class DependantMoved extends Error {}

/**
 * Application service for globs. Every entry point (REST, MCP, webhooks, jobs) calls these
 * methods, so every change goes through the same authorisation, state machine and outbox.
 */
export class GlobService {
  constructor(private readonly deps: GlobServiceDeps) {}

  /** Whether the base branch has an action's script, by board and path; see `scriptCheckFor`. */
  private readonly scriptCache = new Map<string, { readonly onBase: boolean; readonly at: number }>();

  // -------------------------------------------------------------------------
  // Reads

  async get(email: string, id: string): Promise<Result<GlobView>> {
    // Read before the transaction: it asks the code host.
    const check = await this.scriptCheckFor(id);
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const artifacts = (await tx.listArtifactSummaries(glob.boardId, [glob.id])).sort(byKind);
      const relations = await this.relationFacts(tx, await tx.listRelationsFrom([glob.id]));
      const sizeCheck = await tx.getSizeCheck(glob.id);
      const facts = { recordSha: machine.recordShaOf(artifacts), reviews: machine.reviewsOf(artifacts), relations, ...scriptFacts(check) };
      const stored = await tx.listHumanSteps(glob.boardId, [glob.id]);
      return ok({
        glob,
        allowedActions: machine.allowedActions(glob, actor.value, facts),
        artifacts,
        relations: relations.relations,
        waitingFor: awaitedOf(relations),
        waitedOnBy: await this.waitedOnBy(tx, glob.id),
        holding: await this.holdingFor(tx, relations),
        relationGroups: await this.relationGroupsOf(tx, glob, relations),
        sizeCheck,
        humanSteps: humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, facts) }, stored),
        handover: await handoverOf(tx, this.deps.clock, glob),
        dismissedKeys: (await tx.listStatusDismissals(email, glob.boardId)).filter((d) => d.globId === glob.id).map((d) => d.key),
        script: check?.script ?? null,
      });
    });
  }

  /**
   * The script an open action runs (a `script: <repo path>` line in its plan) and whether the board's base branch has it. Null for
   * anything else. A code host that can't answer leaves `onBase` null (not checked, so nothing is blocked). Answers are cached per
   * board and path until the base branch moves (`baseMoved`), and for a few minutes at most because webhooks are best effort.
   */
  async scriptCheckFor(id: string): Promise<ScriptCheck | null> {
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob?.category !== 'action' || glob.status !== 'planning') return null;
      const board = await tx.getBoard(glob.boardId);
      return board === null ? null : { glob, baseBranch: board.baseBranch, plan: (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '' };
    });
    if (read === null) return null;
    return this.checkScript(read.glob.boardId, read.baseBranch, scriptPathOf(read.plan));
  }

  /** The script checks of a board's open actions, by glob. */
  async scriptChecksOf(boardId: number): Promise<Map<string, ScriptCheck>> {
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      const open = (await tx.listGlobs(boardId, { status: ['planning'], include: 'all' })).filter((g) => g.category === 'action');
      return { board, plans: await Promise.all(open.map(async (g) => ({ id: g.id, plan: (await tx.listArtifacts(g.id, 'plan'))[0]?.content ?? '' }))) };
    });
    const found = new Map<string, ScriptCheck>();
    if (read.board === null) return found;
    for (const { id, plan } of read.plans) {
      const check = await this.checkScript(boardId, read.board.baseBranch, scriptPathOf(plan));
      if (check !== null) found.set(id, check);
    }
    return found;
  }

  private async checkScript(boardId: number, baseBranch: string, path: string | null): Promise<ScriptCheck | null> {
    if (path === null) return null;
    const view = this.deps.codeView;
    if (view === undefined) return { script: { path, onBase: null }, baseBranch };
    const key = `${String(boardId)}|${path}`;
    const now = Date.parse(this.deps.clock.now());
    const cached = this.scriptCache.get(key);
    if (cached !== undefined && now - cached.at < (cached.onBase ? SCRIPT_CACHE_MS : SCRIPT_MISSING_CACHE_MS)) return { script: { path, onBase: cached.onBase }, baseBranch };
    try {
      const onBase = (await view.read(boardId, null, path)) !== null;
      this.scriptCache.set(key, { onBase, at: now });
      return { script: { path, onBase }, baseBranch };
    } catch (e) {
      // Fails open: an unreachable code host doesn't stop a person from finishing their work.
      if (!(e instanceof CodeViewUnavailable)) this.deps.log?.('action script check', e instanceof Error ? e.message : String(e));
      return { script: { path, onBase: null }, baseBranch };
    }
  }

  /**
   * The board's base branch received a push: forget what was read from it, and tell the board about the open actions whose script
   * was not there (or not known) so their Done button is offered again when it is.
   */
  async baseMoved(boardId: number): Promise<void> {
    const prefix = `${String(boardId)}|`;
    const before = new Map([...this.scriptCache].filter(([k]) => k.startsWith(prefix)));
    for (const key of before.keys()) this.scriptCache.delete(key);
    const open = (await this.peekAll(boardId, { status: ['planning'], include: 'all' })).filter((g) => g.category === 'action');
    for (const glob of open) {
      const path = scriptPathOf(await this.peekPlan(glob.id));
      if (path !== null && before.get(`${prefix}${path}`)?.onBase !== true) this.publish(glob);
    }
  }

  /** The check a sub on the board waits for (its merge policy's `subGateCheck`, `checks` by default), for the card's stuck hint. */
  async gateCheckOf(boardId: number): Promise<string> {
    return subGateCheckOf(await this.deps.store.transaction((tx) => readMergePolicy(tx, boardId)));
  }

  /** The viewer's dismissed message keys on each of the board's globs, for the board list. */
  async dismissedKeysOf(email: string, boardId: number): Promise<Map<string, string[]>> {
    const rows = await this.deps.store.transaction((tx) => tx.listStatusDismissals(email, boardId));
    const byGlob = new Map<string, string[]>();
    for (const { globId, key } of rows) byGlob.set(globId, [...(byGlob.get(globId) ?? []), key]);
    return byGlob;
  }

  /**
   * The viewer says they have read a status message on the glob (its key names the situation). Per person; a glob's own
   * state and version are left alone, and `dismiss: false` undoes it ("Show again").
   */
  async setStatusDismissed(email: string, id: string, key: string, dismiss: boolean): Promise<Result<{ globId: string }>> {
    if (!DISMISSAL_KEY.test(key)) return invalidInput('A message key is 1 to 200 letters, digits or : . + @ / - _');
    return this.deps.store.transaction(async (tx): Promise<Result<{ globId: string }>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (dismiss) await tx.addStatusDismissal(email, id, key, this.deps.clock.now());
      else await tx.removeStatusDismissal(email, id, key);
      return ok({ globId: id });
    });
  }

  /**
   * Records the brief for the glob as it was before a hand-over (a pick-up may clear the very failure it explains) as a
   * "Handover" attachment; nothing when there is none. Sets `wrote` so the caller can publish `glob.artifacts`.
   */
  private handoverRecorder(wrote: { value: boolean }): NonNullable<CommandOptions['record']> {
    return async (tx, before, _next, actor) => {
      // A retried attempt starts over.
      wrote.value = false;
      if (actor === null) return;
      const brief = await handoverOf(tx, this.deps.clock, before);
      if (brief === null) return;
      await addArtifact(tx, this.deps.clock, before, actor.email, {
        kind: 'attachment',
        label: HANDOVER_LABEL,
        content: handoverMarkdown(brief),
        link: null,
        commitSha: before.pr?.headSha ?? null,
        runId: null,
        agentSetVersion: null,
        reviewStats: null,
      });
      wrote.value = true;
    };
  }

  private publishHandover(wrote: { value: boolean }, glob: Glob): void {
    if (wrote.value) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
  }

  /** The splits on a board, by glob ID, for the card's "part 2 of 3" links (a glob split again shows its latest). */
  async splitsOf(boardId: number): Promise<Map<string, SplitInfo>> {
    const events = await this.deps.store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['GlobSplit']));
    const found = new Map<string, SplitInfo>();
    for (const e of events) {
      const { source, part, parts } = e.data;
      if (typeof source !== 'string' || typeof part !== 'number' || !Array.isArray(parts)) continue;
      found.set(e.globId, { source, part, parts: parts.filter((p): p is string => typeof p === 'string') });
    }
    return found;
  }

  /**
   * The latest recorded workstreams block of each fanned-out glob on a board, in its compact form, for the card's workstream states.
   * A glob whose work was not fanned out, or whose block did not parse, has none.
   */
  async workstreamsOf(boardId: number): Promise<Map<string, WorkstreamsSummary>> {
    const events = await this.deps.store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['WorkstreamsRecorded']));
    const latest = new Map<string, WorkstreamsSummary | null>();
    // Oldest first, so the last write of a glob wins (including one that no longer parses or is not fanned out).
    for (const e of events) {
      const parsed = parseWorkstreams(`## Workstreams\n\n\`\`\`workstreams\n${JSON.stringify(e.data)}\n\`\`\``);
      latest.set(e.globId, parsed.kind === 'ok' && parsed.block.fannedOut ? summariseWorkstreams(parsed.block) : null);
    }
    const found = new Map<string, WorkstreamsSummary>();
    for (const [id, summary] of latest) if (summary !== null) found.set(id, summary);
    return found;
  }

  /** Who picked the glob up, took it over or handed it back to the machine, and when, oldest first, for the glob view's activity log. */
  async handoffsOf(boardId: number, globId: string): Promise<Handoff[]> {
    const events = await this.deps.store.transaction((tx) =>
      tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['PickedUp', 'HandedToMachine'], [globId]),
    );
    return events.map((e) => ({
      kind: e.type === 'HandedToMachine' ? 'handed_back' : e.data.takeOver === true ? 'took_over' : 'picked_up',
      by: e.actor,
      at: e.at,
    }));
  }

  /**
   * The pending recommendation job of each picked-up decision glob, as the machine-step facts the status reads (a job waiting
   * to run or running is "getting a recommendation"). Only the globs with one are in the map.
   */
  async recommendationEffectsOf(globs: readonly Glob[]): Promise<Map<string, PendingEffect[]>> {
    const ids = globs.filter((g) => g.category === 'decision' && g.status === 'in_progress').map((g) => g.id);
    const byGlob = new Map<string, PendingEffect[]>();
    if (ids.length === 0) return byGlob;
    const jobs = await this.deps.store.transaction((tx) => tx.latestOutboxJobs(ids, ['suggest_decision']));
    for (const job of jobs) if (job.state === 'pending') byGlob.set(job.globId, [{ kind: job.kind, state: 'running', since: job.runAfter }]);
    return byGlob;
  }

  /** A board's open work steps by glob ID, for the board list's human-step summaries. */
  async humanStepsOf(boardId: number): Promise<Map<string, StoredHumanStep[]>> {
    const steps = await this.deps.store.transaction((tx) => tx.listOpenHumanSteps(boardId));
    const byGlob = new Map<string, StoredHumanStep[]>();
    for (const step of steps) byGlob.set(step.globId, [...(byGlob.get(step.globId) ?? []), step]);
    return byGlob;
  }

  /** What holds each of these globs back (its unmet relations), by glob ID: one read of the board's relations, for callers without a viewer. */
  async holdingsOf(boardId: number, globs: readonly Glob[]): Promise<Map<string, Holding[]>> {
    return this.deps.store.transaction(async (tx) => {
      const own = new Set(globs.map((g) => g.id));
      const ownBy = new Map<string, Relation[]>();
      for (const r of await tx.listRelations(boardId)) if (own.has(r.from)) ownBy.set(r.from, [...(ownBy.get(r.from) ?? []), r]);
      const reach = await this.reachOf(tx, [...new Set([...ownBy.values()].flatMap((rs) => rs.map((r) => r.to)))]);
      const titles = titlesOf(reach.globs);
      return new Map(globs.map((g) => [g.id, holdingOf({ relations: ownBy.get(g.id) ?? [], states: reach.states }, titles)]));
    });
  }

  /**
   * Adds a work step to a glob (members only; version-checked when a version is given, and the glob's version is left
   * alone). A rollout step defaults to falling due after the merge and holding back sign-off and dependants.
   */
  async addHumanStep(email: string, id: string, version: number | null, input: NewHumanStep, origin = 'person'): Promise<Result<StoredHumanStep>> {
    const title = input.title.trim();
    if (title === '') return invalidInput('A step needs a title');
    const kind = input.kind ?? 'rollout';
    if (!HUMAN_STEP_KINDS.includes(kind)) return invalidInput(`Unknown step kind ${kind}`);
    const due = input.due ?? (kind === 'rollout' ? 'after_merge' : 'now');
    if (!isHumanStepDue(due)) return invalidInput(`Unknown due ${due}: use now, after_merge or after_deploy:<env>`);
    const blocks = input.blocks ?? (kind === 'rollout' ? ['sign_off', 'dependants'] : []);
    const unknown = blocks.find((b) => !HUMAN_STEP_BLOCKS.includes(b));
    if (unknown !== undefined) return invalidInput(`Unknown block ${unknown}: use ${HUMAN_STEP_BLOCKS.join(', ')}`);
    const who = (input.who ?? 'anyone').trim();
    if (who === '') return invalidInput('A step needs someone it is for (or anyone)');
    const result = await this.deps.store.transaction(async (tx): Promise<Result<StoredHumanStep>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (version !== null && glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      const now = this.deps.clock.now();
      const step: StoredHumanStep = {
        id: `hs_${this.deps.ids.runId()}`,
        boardId: glob.boardId,
        globId: id,
        kind,
        title,
        detail: input.detail?.trim() || null,
        who,
        due,
        state: 'open',
        blocks: [...new Set(blocks)],
        check: input.check ?? null,
        script: input.script ?? null,
        why: input.why?.trim() || null,
        permissions: input.permissions?.trim() || null,
        commands: (input.commands ?? []).map((c) => c.trim()).filter((c) => c !== ''),
        verify: input.verify?.trim() || null,
        origin,
        createdBy: email,
        createdAt: now,
        doneBy: null,
        doneAt: null,
        dismissedReason: null,
      };
      await tx.saveHumanSteps([step]);
      await tx.appendEvents([{ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind, title, change: 'added' } }]);
      return ok(step);
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'glob.changed', boardId: result.value.boardId, globId: id, version: version ?? 0 });
    return result;
  }

  /** Ticks a work step (records who and when), then lets the glob move on if it was the last one holding it back. */
  completeHumanStep(email: string, id: string, stepId: string, version: number | null): Promise<Result<StoredHumanStep>> {
    return this.closeHumanStep(email, id, stepId, version, 'done', null);
  }

  /** Dismisses a wrong step with the reason; the glob moves on if nothing else holds it back. */
  dismissHumanStep(email: string, id: string, stepId: string, reason: string, version: number | null): Promise<Result<StoredHumanStep>> {
    if (reason.trim() === '') return Promise.resolve(invalidInput('Dismissing a step needs a reason'));
    return this.closeHumanStep(email, id, stepId, version, 'dismissed', reason.trim());
  }

  private async closeHumanStep(
    email: string,
    id: string,
    stepId: string,
    version: number | null,
    to: 'done' | 'dismissed',
    reason: string | null,
  ): Promise<Result<StoredHumanStep>> {
    const closed = await this.deps.store.transaction(async (tx): Promise<Result<StoredHumanStep>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (version !== null && glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      const found = (await tx.listHumanSteps(glob.boardId, [id])).find((s) => s.id === stepId);
      if (found === undefined) return notFound(`No step ${stepId} on ${id}`);
      if (found.state !== 'open') return ok(found);
      const now = this.deps.clock.now();
      const step: StoredHumanStep = to === 'done' ? { ...found, state: 'done', doneBy: email, doneAt: now } : { ...found, state: 'dismissed', dismissedReason: reason, doneBy: email, doneAt: now };
      await tx.saveHumanSteps([step]);
      await tx.appendEvents([{ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind: step.kind, title: step.title, change: to } }]);
      return ok(step);
    });
    if (!closed.ok) return closed;
    await this.afterStepsChanged(id);
    return closed;
  }

  /**
   * Steps changed: a merged glob whose last sign-off blocker cleared and whose labels are approved moves to Signed off,
   * and the globs waiting for its rollout are released. Both are no-ops while a step is still open.
   */
  private async afterStepsChanged(id: string): Promise<void> {
    const settled = await this.command(null, id, null, (glob, ctx, _board, facts) => machine.rolloutSettled(glob, facts.rollout ?? { open: 0, total: 0 }, ctx, facts.relations), { rollout: true, relations: true });
    const glob = settled.ok ? settled.value : await this.deps.store.transaction((tx) => tx.getGlob(id));
    if (glob === null) return;
    this.deps.notifier.publish({ kind: 'glob.changed', boardId: glob.boardId, globId: id, version: glob.version });
    if (listOf(glob.status) === 'reviewing' || listOf(glob.status) === 'signed_off') await this.releaseDependents(id, glob.boardId);
  }

  /** The investigator predicted a rollout: adds the placeholder step once (a person's dismissal of it stands). */
  async predictRollout(id: string): Promise<void> {
    const glob = await this.deps.store.transaction((tx) => tx.getGlob(id));
    if (glob === null) return;
    const added = await this.deps.store.transaction(async (tx) => {
      const steps = await tx.listHumanSteps(glob.boardId, [id]);
      if (steps.some((s) => s.origin === 'investigation' || (s.kind === 'rollout' && s.state === 'open'))) return false;
      await tx.saveHumanSteps([
        {
          id: `hs_${this.deps.ids.runId()}`,
          boardId: glob.boardId,
          globId: id,
          kind: 'rollout',
          title: PREDICTED_ROLLOUT_TITLE,
          detail: null,
          who: 'anyone',
          due: 'after_merge',
          state: 'open',
          blocks: ['sign_off', 'dependants'],
          check: null,
          script: null,
          why: null,
          permissions: null,
          commands: [],
          verify: null,
          origin: 'investigation',
          createdBy: 'investigation',
          createdAt: this.deps.clock.now(),
          doneBy: null,
          doneAt: null,
          dismissedReason: null,
        },
      ]);
      return true;
    });
    if (added) this.deps.notifier.publish({ kind: 'glob.changed', boardId: glob.boardId, globId: id, version: glob.version });
  }

  /** A rollout work step in the shape every system writer uses: after the merge, holding back sign-off and dependants. */
  private rolloutStep(glob: Glob, origin: string, createdBy: string, now: string, fields: Pick<StoredHumanStep, 'title' | 'detail' | 'check' | 'script' | 'why' | 'permissions' | 'commands' | 'verify'>): StoredHumanStep {
    return {
      id: `hs_${this.deps.ids.runId()}`,
      boardId: glob.boardId,
      globId: glob.id,
      kind: 'rollout',
      who: 'anyone',
      due: 'after_merge',
      state: 'open',
      blocks: ['sign_off', 'dependants'],
      origin,
      createdBy,
      createdAt: now,
      doneBy: null,
      doneAt: null,
      dismissedReason: null,
      ...fields,
    };
  }

  /**
   * An implementation record arrived: its `## Rollout` section becomes the glob's rollout steps. The steps this section
   * wrote before are matched by title: a still-open one that is gone is dismissed, one that is still there is updated in
   * place, a done or dismissed one stays as it is, and a new one is added. Real steps replace the investigator's
   * placeholder. A script step's body is stored as a `rollout_script` artifact (one label per step). Reading the same
   * record again changes nothing.
   */
  async reconcileRollout(
    email: string,
    id: string,
    record: string,
    source: { readonly commitSha: string | null; readonly runId: string | null; readonly agentSetVersion: number | null },
  ): Promise<void> {
    const parsed = parseRollout(record);
    const changed = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return null;
      const now = this.deps.clock.now();
      const stored = await tx.listHumanSteps(glob.boardId, [id]);
      const own = stored.filter((s) => s.origin === ROLLOUT_SECTION_ORIGIN);
      const events: DomainEvent[] = [];
      const save: StoredHumanStep[] = [];
      const note = (step: StoredHumanStep, change: string) =>
        events.push({ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind: step.kind, title: step.title, change } });
      let scripts = false;
      for (const step of parsed) {
        let script: HumanStepScript | null = null;
        if (step.scriptPath !== null) {
          script = { path: step.scriptPath };
        } else if (step.script !== null && step.script.trim() !== '') {
          const label = rolloutScriptLabel(step.title);
          script = { artifact: label };
          const latest = (await tx.artifactVersions(id, ROLLOUT_SCRIPT_KIND, label)).at(-1);
          if (latest?.content !== step.script) {
            await addArtifact(tx, this.deps.clock, glob, email, { kind: ROLLOUT_SCRIPT_KIND, label, content: step.script, link: null, commitSha: source.commitSha, runId: source.runId, agentSetVersion: source.agentSetVersion, reviewStats: null });
            scripts = true;
          }
        }
        const fields = { title: step.title, detail: step.detail, check: step.check, script, why: step.why, permissions: step.permissions, commands: step.commands, verify: step.verify };
        const existing = own.find((s) => s.title === step.title);
        if (existing === undefined) {
          const added = this.rolloutStep(glob, ROLLOUT_SECTION_ORIGIN, email, now, fields);
          save.push(added);
          note(added, 'added');
        } else if (existing.state === 'open' && JSON.stringify(stepFields(existing)) !== JSON.stringify(stepFields(fields))) {
          const updated = { ...existing, ...fields };
          save.push(updated);
          note(updated, 'updated');
        }
      }
      for (const step of own) {
        if (step.state !== 'open' || parsed.some((p) => p.title === step.title)) continue;
        const dismissed: StoredHumanStep = { ...step, state: 'dismissed', dismissedReason: 'No longer in the implementation record', doneBy: 'slop', doneAt: now };
        save.push(dismissed);
        note(dismissed, 'dismissed');
      }
      for (const step of stored) {
        const placeholder = step.origin === 'investigation' && step.title === PREDICTED_ROLLOUT_TITLE;
        if (step.state !== 'open') continue;
        // A record pushed for a commit that has no rollout ends the prediction; the record started in Phase 2 (no commit yet) doesn't.
        const noRollout = placeholder && parsed.length === 0 && source.commitSha !== null;
        if (!(parsed.length > 0 && (placeholder || step.origin === ROLLOUT_PATHS_ORIGIN)) && !noRollout) continue;
        const dismissed: StoredHumanStep = {
          ...step,
          state: 'dismissed',
          dismissedReason: noRollout ? 'The implementation record needs no rollout' : 'Replaced by the steps in the implementation record',
        };
        save.push(dismissed);
        note(dismissed, 'dismissed');
      }
      if (save.length > 0) await tx.saveHumanSteps(save);
      if (events.length > 0) await tx.appendEvents(events);
      return { steps: save.length > 0, scripts, boardId: glob.boardId };
    });
    if (changed === null) return;
    if (changed.scripts) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: changed.boardId, globId: id });
    if (changed.steps) await this.afterStepsChanged(id);
  }

  /**
   * Whether a merged glob's rollout still has to be written: no step from the record or the rollout check (except the
   * old "Rollout steps not written" placeholder, which the check replaces), no `## Rollout` in the record, and no
   * "No rollout needed" note. The check runs once; a backfill and a repeated job find it done.
   */
  async rolloutUnwritten(id: string): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob !== null && (await this.rolloutOpen(tx, glob));
    });
  }

  /** Queues the rollout job for a merge that touched the rollout paths, unless the rollout is already written. */
  async queueRolloutWrite(id: string, sha: string): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null || !(await this.rolloutOpen(tx, glob))) return false;
      await tx.enqueueEffects([writeRolloutEffect(id, sha)]);
      return true;
    });
  }

  private async rolloutOpen(tx: Tx, glob: Glob): Promise<boolean> {
    const steps = await tx.listHumanSteps(glob.boardId, [glob.id]);
    if (steps.some((s) => s.origin === ROLLOUT_SECTION_ORIGIN || (s.origin === ROLLOUT_PATHS_ORIGIN && s.title !== ROLLOUT_NOT_WRITTEN_TITLE))) return false;
    if ((await tx.artifactVersions(glob.id, 'attachment', ROLLOUT_NONE_LABEL)).length > 0) return false;
    const record = (await tx.listArtifacts(glob.id, 'implementation_plan')).find((a) => a.label === '');
    return record === undefined || parseRollout(record.content).length === 0;
  }

  /** The merged globs on a board that still show the old "Rollout steps not written" step, with their merge commit: the backfill's worklist. */
  async unwrittenRolloutSteps(boardId: number): Promise<{ readonly globId: string; readonly sha: string }[]> {
    return this.deps.store.transaction(async (tx) => {
      const open = (await tx.listOpenHumanSteps(boardId)).filter((s) => s.origin === ROLLOUT_PATHS_ORIGIN && s.title === ROLLOUT_NOT_WRITTEN_TITLE);
      const globIds = [...new Set(open.map((s) => s.globId))];
      if (globIds.length === 0) return [];
      const merges = await tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['Merged'], globIds);
      const found: { globId: string; sha: string }[] = [];
      for (const globId of globIds) {
        const sha = merges.filter((e) => e.globId === globId).sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.data.sha;
        if (typeof sha === 'string') found.push({ globId, sha });
      }
      return found;
    });
  }

  /**
   * The rollout job's answer for a merged glob. Steps are stored as the record's own would be (script bodies as
   * artifacts); "none" is recorded as a "Rollout check" attachment and adds nothing for a person; a question becomes
   * the one step. The old "Rollout steps not written" step is dismissed as replaced. Returns false when it was already
   * written (nothing changes).
   */
  async applyRolloutAnswer(id: string, answer: RolloutAnswer, model: string): Promise<boolean> {
    const changed = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null || !(await this.rolloutOpen(tx, glob))) return null;
      const now = this.deps.clock.now();
      const events: DomainEvent[] = [];
      const save: StoredHumanStep[] = [];
      const note = (step: StoredHumanStep, change: string) =>
        events.push({ type: 'HumanStepChanged', globId: id, actor: null, at: now, data: { step: step.id, kind: step.kind, title: step.title, change } });
      let artifacts = false;
      if (answer.decision === 'none') {
        await addArtifact(tx, this.deps.clock, glob, 'slop', {
          kind: 'attachment',
          label: ROLLOUT_NONE_LABEL,
          content: `${ROLLOUT_NONE_PREFIX}${answer.reason}\n\n(Written by slop's rollout check, ${model}.)`,
          link: null,
          commitSha: null,
          runId: null,
          agentSetVersion: null,
          reviewStats: null,
        });
        artifacts = true;
      } else if (answer.decision === 'ask') {
        const step = this.rolloutStep(glob, ROLLOUT_PATHS_ORIGIN, 'slop', now, { title: answer.question, detail: null, check: null, script: null, why: null, permissions: null, commands: [], verify: null });
        save.push(step);
        note(step, 'added');
      } else {
        for (const written of answer.steps) {
          let script: HumanStepScript | null = null;
          if (written.scriptPath !== null) {
            script = { path: written.scriptPath };
          } else if (written.script !== null && written.script.trim() !== '') {
            const label = rolloutScriptLabel(written.title);
            script = { artifact: label };
            await addArtifact(tx, this.deps.clock, glob, 'slop', { kind: ROLLOUT_SCRIPT_KIND, label, content: written.script, link: null, commitSha: null, runId: null, agentSetVersion: null, reviewStats: null });
            artifacts = true;
          }
          const step = this.rolloutStep(glob, ROLLOUT_PATHS_ORIGIN, 'slop', now, { title: written.title, detail: written.detail, check: written.check, script, why: written.why, permissions: written.permissions, commands: written.commands, verify: written.verify });
          save.push(step);
          note(step, 'added');
        }
      }
      for (const old of await tx.listHumanSteps(glob.boardId, [id])) {
        if (old.origin !== ROLLOUT_PATHS_ORIGIN || old.title !== ROLLOUT_NOT_WRITTEN_TITLE || old.state !== 'open') continue;
        save.push({ ...old, state: 'dismissed', dismissedReason: 'Replaced by the rollout check' });
        note(old, 'dismissed');
      }
      if (save.length > 0) await tx.saveHumanSteps(save);
      if (events.length > 0) await tx.appendEvents(events);
      return { glob, artifacts, steps: save.length > 0 };
    });
    if (changed === null) return false;
    if (changed.artifacts) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: changed.glob.boardId, globId: id });
    if (changed.steps) await this.afterStepsChanged(id);
    this.deps.notifier.publish({ kind: 'glob.changed', boardId: changed.glob.boardId, globId: id, version: changed.glob.version });
    return true;
  }

  /**
   * Capabilities changed or were re-read: every open step whose `check` capability is on, and whose due-ness has arrived
   * (a merged glob's after-merge step; a step due now), is ticked by slop. Nothing is ticked before the merge, and a step
   * already done or dismissed is left alone, so running it again changes nothing. Returns how many steps it ticked.
   */
  async tickCapabilitySteps(boardId: number, capabilities: Capabilities): Promise<number> {
    const isOn = (s: StoredHumanStep): boolean => s.check !== null && isCapabilityName(s.check) && capabilities[s.check] === true;
    const candidates = (await this.deps.store.transaction((tx) => tx.listOpenHumanSteps(boardId))).filter(isOn);
    let ticked = 0;
    for (const globId of new Set(candidates.map((s) => s.globId))) {
      const done = await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(globId);
        if (glob === null) return 0;
        const now = this.deps.clock.now();
        const ready = (await tx.listHumanSteps(boardId, [globId])).filter(
          (s) => s.state === 'open' && isOn(s) && (s.due === 'now' || (s.due === 'after_merge' && isMerged(glob))),
        );
        if (ready.length === 0) return 0;
        await tx.saveHumanSteps(ready.map((s): StoredHumanStep => ({ ...s, state: 'done', doneBy: 'slop', doneAt: now })));
        await tx.appendEvents(
          ready.map((s): DomainEvent => ({ type: 'HumanStepChanged', globId, actor: null, at: now, data: { step: s.id, kind: s.kind, title: s.title, change: 'done', checked: true, check: s.check } })),
        );
        return ready.length;
      });
      if (done > 0) await this.afterStepsChanged(globId);
      ticked += done;
    }
    return ticked;
  }

  /** The globs on a board whose oversized flag nobody has answered yet, for the card's chip. */
  async oversizedOf(boardId: number): Promise<Set<string>> {
    const [checks, planning] = await this.deps.store.transaction(async (tx) => [await tx.listSizeChecks(boardId), await tx.listGlobs(boardId, { status: ['planning'] })] as const);
    const open = new Set(planning.map((g) => g.id));
    return new Set(checks.filter((c) => unresolved(c) && open.has(c.globId)).map((c) => c.globId));
  }

  /** Integrations' read of one glob, with no signed-in person. */
  async peek(id: string): Promise<Glob | null> {
    return this.deps.store.transaction((tx) => tx.getGlob(id));
  }

  /** The relations that start at these globs (any gate), by glob, for a reply that shows them after a write. */
  async peekRelations(ids: readonly string[]): Promise<Map<string, Relation[]>> {
    const rows = await this.deps.store.transaction((tx) => tx.listRelationsFrom(ids));
    const byGlob = new Map<string, Relation[]>();
    for (const r of rows) byGlob.set(r.from, [...(byGlob.get(r.from) ?? []), r]);
    return byGlob;
  }

  /** Integrations' read of a glob's plan.md (its latest version), with no signed-in person; empty when it has none. */
  async peekPlan(id: string): Promise<string> {
    return this.deps.store.transaction(async (tx) => (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '');
  }

  /** Integrations' read of a board's globs, with no signed-in person. */
  async peekAll(boardId: number, filter: GlobFilter): Promise<Glob[]> {
    return this.deps.store.transaction((tx) => tx.listGlobs(boardId, filter));
  }

  async list(email: string, boardId: number, filter: GlobFilter): Promise<Result<Glob[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await this.actorFor(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listGlobs(boardId, filter));
    });
  }

  /**
   * The board's globs with their artifact summaries (read from the artifacts, not stored on the
   * glob). `shown` drops globs before their summaries are read (e.g. signed off long ago).
   */
  async listWithArtifacts(
    email: string,
    boardId: number,
    filter: GlobFilter,
    shown: (glob: Glob) => boolean = () => true,
  ): Promise<Result<{ glob: Glob; artifacts: ArtifactSummary[]; relations: RelationFacts; holding: Holding[] }[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await this.actorFor(tx, email, boardId);
      if (!actor.ok) return actor;
      // Sequential: a transaction holds a single connection.
      const globs = (await tx.listGlobs(boardId, filter)).filter(shown);
      const summaries = await tx.listArtifactSummaries(
        boardId,
        globs.map((g) => g.id),
      );
      const byGlob = new Map<string, ArtifactSummary[]>();
      for (const summary of summaries) byGlob.set(summary.globId, [...(byGlob.get(summary.globId) ?? []), summary]);
      // One read of the board's relations and of the globs they point at (the list carries only the latest signed-off globs, so a
      // `to` that is old is read here), so the list's allowed actions and holdings agree with a single read. Nothing is walked on
      // the web side: an old merged `to` there would read as deleted and show a false hold.
      const all = await tx.listRelations(boardId);
      const ownBy = new Map<string, Relation[]>();
      for (const r of all) ownBy.set(r.from, [...(ownBy.get(r.from) ?? []), r]);
      const reach = await this.reachOf(tx, [...new Set(globs.flatMap((g) => (ownBy.get(g.id) ?? []).map((r) => r.to)))]);
      const titles = titlesOf(reach.globs);
      return ok(
        globs.map((glob) => {
          const facts: RelationFacts = { relations: ownBy.get(glob.id) ?? [], states: reach.states };
          return { glob, artifacts: (byGlob.get(glob.id) ?? []).sort(byKind), relations: facts, holding: holdingOf(facts, titles) };
        }),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Commands from people (each carries the version the client read)

  async create(email: string, given: CreateGlobInput): Promise<Result<Glob>> {
    if (given.category === 'action') return this.createAction(email, given);
    if (given.category === 'decision') return invalidInput('A decision glob is created from a knowledge proposal or an inbox item, not directly');
    if (given.type === null) return invalidInput(`A ${given.category} needs a type`);
    const wanted: CodeCreateInput = { ...given, type: given.type };
    // A glob created in a group gets the group-wide decisions still open on it, so a sub can't start before they are decided.
    const inherited = wanted.group === null ? [] : await this.groupRelationsFor(wanted.boardId, wanted.group);
    const input = inherited.length === 0 ? wanted : { ...wanted, relations: [...inherited, ...(wanted.relations ?? [])] };
    try {
      return await this.createWithItem(email, input);
    } catch (e) {
      if (e instanceof AttachConflict) return invalidInput('The inbox item changed: try again');
      throw e;
    }
  }

  /**
   * Only board admins choose sub or super (access.ts). A type nobody chose becomes a same for anyone else; a chosen one is
   * refused. Non-members and unknown boards fall through to the checks in the transaction.
   */
  private async resolveType(email: string, input: CodeCreateInput): Promise<Result<CodeCreateInput>> {
    if (input.type === 'same') return ok(input);
    const actor = await this.deps.store.transaction((tx) => this.actorFor(tx, email, input.boardId));
    if (!actor.ok || canChooseType(actor.value.role, input.type)) return ok(input);
    if (input.typeChosen === false) return ok({ ...input, type: 'same' });
    return forbidden(CHOOSE_TYPE_REFUSAL);
  }

  /** A person changing a glob to sub or super must be an admin (access.ts); null when allowed or when other checks will answer. */
  private async refuseTypeChoice(email: string, id: string, to: SlopType): Promise<Result<never> | null> {
    if (to === 'same') return null;
    const actor = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob === null || glob.type === to ? null : this.actorFor(tx, email, glob.boardId);
    });
    return actor === null || !actor.ok || canChooseType(actor.value.role, to) ? null : forbidden(CHOOSE_TYPE_REFUSAL);
  }

  /** A person changing a glob's work kind must be a board admin; null when allowed or when other checks will answer. */
  private async refuseWorkKindChange(email: string, id: string): Promise<Result<never> | null> {
    const actor = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob === null ? null : this.actorFor(tx, email, glob.boardId);
    });
    return actor === null || !actor.ok || actor.value.role === 'admin' ? null : forbidden('Only board admins can change the work kind');
  }

  /**
   * An action glob: something a person does, then marks done. No type, intake, size check or branch; plan.md v1 is the caller's,
   * else the action template. It may wait for globs (a start relation, e.g. the glob that builds its script): it can't be done
   * until they have merged.
   */
  private async createAction(email: string, input: CreateGlobInput): Promise<Result<Glob>> {
    if (input.type !== null) return invalidInput('An action has no type');
    if (input.environment !== null) return invalidInput('An action has no environment');
    // `files` is an agent's advisory guess for exclusive paths; an action has no paths. (`inboxItem` and `intake` come from the web
    // form's own flow, so they are not refused here: the MCP tool refuses `inboxItem` on its own.)
    if ((input.files ?? []).length > 0) return invalidInput('An action takes no files: put them in the plan or attach them afterwards');
    const plan = input.plan?.trim() ? input.plan : ACTION_PLAN_TEMPLATE.replace('<What a person needs to do>', input.title.trim());
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Transition>> => {
      const board = await tx.getBoard(input.boardId);
      if (board === null) return notFound(`No board ${input.boardId}`);
      const actor = await this.actorFor(tx, email, board.id);
      if (!actor.ok) return actor;
      if (input.idempotencyKey !== null) {
        const existing = await tx.findGlobByCreationKey(board.id, input.idempotencyKey);
        if (existing !== null) return ok({ glob: existing, changed: false, events: [], effects: [] });
      }
      const letter = letterFor({ actor: 'human', mode: 'action', fix: false, workKind: 'maintenance' });
      const n = await tx.nextNumber(board.id, letter);
      const ctx = await this.context(actor.value, board);
      const created = machine.create(
        {
          id: formatId(board.id, letter, n),
          boardId: board.id,
          title: input.title,
          type: null,
          category: 'action',
          attributes: { assignee: input.assignee ?? null, outcome: null },
          group: input.group,
          environment: null,
          autoTrigger: false,
        },
        board,
        ctx,
      );
      if (!created.ok) return created;
      const glob = { ...created.value.glob, version: 1 };
      // What it waits for: the globs named in `after` and `relations`, those that merged already left out. Nothing points at the new
      // action yet, so no cycle is possible.
      const wanted = [...(input.after ?? []).map((to): RelationInput => ({ to })), ...(input.relations ?? [])];
      const targets = new Map((await tx.getGlobs(wanted.map((w) => w.to.trim()))).map((g) => [g.id, g]));
      const open = wanted.filter((w) => {
        const target = targets.get(w.to.trim());
        if (target === undefined || (w.gate ?? 'start') !== 'start') return true;
        const until = w.until ?? defaultUntil(target);
        return !((until === 'merged' && hasMerged(target)) || (until === 'done' && toState(target) === 'done'));
      });
      const planned = await this.planRelations(tx, glob, [], open, input.relationsBy ?? 'person');
      if (!planned.ok) return planned;
      if (planned.value.add.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
      const written = applyWrite([], planned.value, { boardId: board.id, from: glob.id, now: ctx.now, newId: () => this.relationId() });
      if (!(await tx.insertGlob(glob, input.idempotencyKey))) throw new Error(`Glob ID collision for ${glob.id}`);
      await tx.appendEvents(created.value.events);
      await this.writeNew(tx, glob, written.inserted, email, ctx.now);
      const artifact = await tx.insertArtifact({
        globId: glob.id,
        kind: 'plan',
        label: '',
        content: plan,
        link: null,
        commitSha: null,
        provenance: { by: input.planBy ?? 'human', actor: email, runId: null, agentSetVersion: null },
        createdAt: ctx.now,
      });
      await tx.appendEvents([
        {
          type: 'ArtifactAdded',
          globId: glob.id,
          actor: email,
          at: ctx.now,
          data: { kind: 'plan', label: '', version: artifact.version, commitSha: null, runId: null, agentSetVersion: null },
        },
      ]);
      return ok({ ...created.value, glob, changed: true });
    });
    if (!result.ok) return result;
    if (result.value.changed) this.publish(result.value.glob);
    return ok(result.value.glob);
  }

  private async createWithItem(email: string, wanted: CodeCreateInput): Promise<Result<Glob>> {
    const resolved = await this.resolveType(email, wanted);
    if (!resolved.ok) return resolved;
    const input = resolved.value;
    // A glob about to start waits for open globs that may change the same exclusive paths (read before the transaction:
    // it asks the code host).
    let holds: readonly ImpliedAfter[] = [];
    if ((input.type === 'sub' || (input.type === 'same' && input.autoTrigger)) && this.deps.branchFiles !== undefined) {
      const board = await this.deps.store.transaction((tx) => tx.getBoard(input.boardId));
      if (board !== null) {
        const candidate = { id: null, plan: planOf(input), ...(input.files === undefined ? {} : { files: input.files }) };
        holds = await findHolds(this.deps.store, this.deps.branchFiles, board, candidate, new Set([...(input.after ?? []), ...(input.relations ?? []).map((r) => r.to)]), await this.deps.dependencyLearning?.prediction(board.id));
      }
    }
    // Three model-bound reads that don't depend on each other, made at once so the request waits for the slowest (each has its
    // own deadline) rather than their sum. The snapshot's embedding; the size check, where a failing model leaves the text
    // estimate; and the dependency tree: needs and overlaps against the open globs, with a reason each (a person's edges win).
    const planText = planOf(input);
    const [embedding, size, inferred] = await Promise.all([
      embedRequest(this.deps.embedder, input.intake?.request ?? planText),
      this.deps.sizeCheck === undefined ? null : this.deps.sizeCheck.assess(input.boardId, planText, input.title),
      this.deps.inference === undefined || input.type === 'super'
        ? []
        : this.deps.inference.infer({ boardId: input.boardId, plan: planText, selfId: null, title: input.title, ...(input.files === undefined ? {} : { files: input.files }) }),
    ]);
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Transition>> => {
      const board = await tx.getBoard(input.boardId);
      if (board === null) return notFound(`No board ${input.boardId}`);
      const actor = await this.actorFor(tx, email, board.id);
      if (!actor.ok) return actor;
      if (input.idempotencyKey !== null) {
        const existing = await tx.findGlobByCreationKey(board.id, input.idempotencyKey);
        if (existing !== null) return ok({ glob: existing, changed: false, events: [], effects: [] });
      }
      // Checked before anything is written, so a bad item creates nothing.
      let item: InboxItem | null = null;
      if (input.inboxItem !== undefined) {
        item = await tx.getInboxItem(board.id, input.inboxItem);
        if (item === null) return notFound(`No inbox item ${String(input.inboxItem)} on board ${String(board.id)}`);
        if (item.status === 'discarded') return invalidInput('A discarded item cannot be attached');
      }
      const letter = letterFor(inferredOf(input, input.type));
      const n = await tx.nextNumber(board.id, letter);
      const id = formatId(board.id, letter, n);
      // The person's needs come first, then slop's inferred needs (a person's win): a glob that went away since is dropped,
      // and so is one that already merged. The new glob has nothing pointing at it yet, so it can't close a cycle.
      const wanted = [...new Set((input.after ?? []).map((a) => a.trim()).filter((a) => a !== ''))];
      const by = input.relationsBy ?? 'person';
      // Relations stated beside `after` (any gate): the last of one glob and gate wins, and a start one `after` already names is it.
      const stated = [...new Map((input.relations ?? []).map((r) => [`${r.to.trim()}|${r.gate ?? 'start'}`, { ...r, to: r.to.trim() }])).values()].filter(
        (r) => r.to !== '' && !((r.gate ?? 'start') === 'start' && wanted.includes(r.to)),
      );
      // Slop's inferred edges: a need (until merged) or an open decision (until decided); a person's statement of the same glob wins.
      const inferredNeeds = inferred.filter((i) => !wanted.includes(i.id) && !stated.some((r) => (r.gate ?? 'start') === 'start' && r.to === i.id));
      const known = new Map((await tx.getGlobs([...wanted, ...stated.map((r) => r.to), ...inferredNeeds.map((i) => i.id)])).map((g) => [g.id, g]));
      for (const a of [...wanted, ...stated.map((r) => r.to)]) {
        if (a === id) return invalidInput('A glob cannot wait for itself');
        if (known.get(a)?.boardId !== board.id) return invalidInput(`No glob ${a} on this board`);
      }
      if (wanted.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
      // A need waits for what its target ends in: a merge, a decision's outcome or an action being done or dismissed.
      const wantedUntil = new Map<string, RelationUntil>();
      for (const to of wanted) {
        const target = known.get(to);
        if (target === undefined) continue;
        const until = defaultUntil(target);
        const shape = checkRelationShape({ id, category: input.category }, { to, until }, target);
        if (!shape.ok) return shape;
        wantedUntil.set(to, until);
      }
      const explicit: NewRelation[] = [];
      for (const r of stated) {
        const target = known.get(r.to);
        if (target === undefined) continue;
        const until = r.until ?? (defaultUntil(target));
        const shape = checkRelationShape({ id, category: input.category }, { to: r.to, until, gate: r.gate ?? 'start' }, target);
        if (!shape.ok) return shape;
        const reason = (r.reason ?? '').trim();
        if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
        explicit.push({ to: r.to, gate: r.gate ?? 'start', until, reason: reason === '' ? null : reason, evidence: [], source: by, group: r.group ?? null });
      }
      const needs: NewRelation[] = [
        ...wanted.map((to): NewRelation => ({ to, gate: 'start', until: wantedUntil.get(to) ?? 'merged', reason: null, evidence: [], source: by })),
        ...explicit,
        ...inferredNeeds.slice(0, Math.max(0, MAX_RELATIONS - wanted.length - explicit.filter((r) => r.gate === 'start').length)).map((i): NewRelation => ({ to: i.id, gate: 'start', until: i.kind === 'decision' ? 'decided' : 'merged', reason: i.reason, evidence: i.files, source: 'inferred' })),
      ].filter((r) => {
        const target = known.get(r.to);
        if (target === undefined || target.boardId !== board.id) return false;
        // An inferred edge must match what it points at: a decision for a decision glob, a need for work.
        if (r.source === 'inferred' && (target.category === 'action' || (r.until === 'decided') !== (target.category === 'decision'))) return false;
        // A start relation to a glob that merged already holds nothing and is not recorded; the other gates are kept.
        // (An action that is done or dismissed already is the same: its gate is open.)
        return !(r.gate === 'start' && ((r.until === 'merged' && hasMerged(target)) || (r.until === 'done' && toState(target) === 'done')));
      });
      const perGate = (gate: RelationGate): number => needs.filter((r) => r.gate === gate).length;
      if (perGate('start') > MAX_RELATIONS || perGate('merge') > MAX_RELATIONS || perGate('sign_off') > MAX_RELATIONS) {
        return invalidInput(`A glob can have at most ${MAX_RELATIONS} relations for one gate`);
      }
      const created = applyWrite([], { add: needs, update: [], remove: [] }, { boardId: board.id, from: id, now: this.deps.clock.now(), newId: () => this.relationId() });
      const relations: RelationFacts = { relations: created.relations, states: await this.statesOf(tx, created.relations.map((r) => r.to)) };
      // Predicted overlaps stay on the glob as internal data (the merge policy's holds); they are not shown and not an input.
      const implied = mergeImplied(holds, []);
      const createInput: CreateInput = { ...input, id, impliedAfter: implied };
      const ctx = await this.context(actor.value, board);
      const created0 = machine.create(createInput, board, ctx, relations);
      if (!created0.ok) return created0;
      // The size check is advice for the run (`get_context.size`): it never changes the type the glob was created with.
      const transition: Result<Transition> = created0;
      const glob = { ...transition.value.glob, version: 1 };
      if (!(await tx.insertGlob(glob, input.idempotencyKey))) {
        throw new Error(`Glob ID collision for ${glob.id}`);
      }
      await tx.appendEvents(transition.value.events);
      await this.writeNew(tx, glob, created.inserted, ctx.actor?.email ?? null, ctx.now);
      await tx.enqueueEffects(transition.value.effects);
      // The frozen record of what intake saw and decided (spec, Intake): written with the glob, never edited.
      if (isCodeGlob(glob)) await tx.insertIntakeSnapshot(snapshotOf(glob, planText, input.intake ?? null, input.source ?? 'api'), embedding);
      if (size !== null) await tx.upsertSizeCheck(checkFrom(glob.id, board.id, size, null, this.deps.clock.now()));
      const artifact = await tx.insertArtifact({
        globId: glob.id,
        kind: 'plan',
        label: '',
        content: planText,
        link: null,
        commitSha: null,
        provenance: { by: input.planBy ?? 'human', actor: email, runId: null, agentSetVersion: null },
        createdAt: this.deps.clock.now(),
      });
      await tx.appendEvents([
        {
          type: 'ArtifactAdded',
          globId: glob.id,
          actor: email,
          at: this.deps.clock.now(),
          data: { kind: 'plan', label: '', version: artifact.version, commitSha: null, runId: null, agentSetVersion: null },
        },
      ]);
      // Accepted decisions that govern the new glob travel with it as one attachment (IDs and one-line statements, not inline).
      const governing = await governingDecisions(tx, glob);
      if (governing.length > 0) {
        await addArtifact(tx, this.deps.clock, glob, DECISION_SYSTEM_ACTOR, {
          kind: 'attachment',
          label: DECISIONS_LABEL,
          content: decisionsAttachment(governing),
          link: null,
          commitSha: null,
          runId: null,
          agentSetVersion: null,
          reviewStats: null,
          by: 'sessionator',
        });
      }
      // Attached last, so the item is in the glob's context from the start; a racing write throws and rolls the glob back too.
      if (item !== null) await linkInboxItem(tx, this.deps.clock, email, board.id, item, [glob]);
      return ok({ ...transition.value, glob, changed: true });
    });
    if (!result.ok) return result;
    if (result.value.changed) {
      this.publish(result.value.glob);
      if (input.inboxItem !== undefined) {
        this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: input.boardId, globId: result.value.glob.id });
        this.deps.notifier.publish({ kind: 'board.inbox', boardId: input.boardId });
      }
      // The forecast from the code and history is made in the background: creating a glob never waits on it.
      if (result.value.glob.status === 'planning') this.refreshSizeInBackground(result.value.glob.id);
      // The caller's first write carries the version it got back, so it must be the one after the automatic run.
      return ok((await this.autoInvestigate(result.value.glob.id)) ?? result.value.glob);
    }
    return ok(result.value.glob);
  }

  /**
   * A glob in Planning that intake flagged big (or whose size estimate is a guess) gets one investigate-only run, when the
   * board allows it (`autoInvestigate`). Once per glob: a person's Investigate or an earlier automatic run counts. Best
   * effort: it never fails the write that prompted it.
   */
  async autoInvestigate(id: string): Promise<Glob | null> {
    try {
      const wanted = await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(id);
        if (glob === null || !machine.canInvestigate(glob) || glob.runs.some((r) => r.purpose === 'investigate')) return false;
        const board = await tx.getBoard(glob.boardId);
        return board !== null && board.autoInvestigate && needsInvestigation(await tx.getSizeCheck(id));
      });
      if (!wanted) return null;
      const result = await this.command(null, id, null, (glob, ctx) => machine.investigate(glob, ctx, true));
      return result.ok ? result.value : null;
    } catch (e) {
      this.deps.log?.('auto investigate', e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /**
   * Cuts the scope of a glob in Planning into independent globs in one transaction: the original keeps part 0 (its ID,
   * history and decisions; a new plan.md version, title and summary), the others are created in its group with their share of
   * the plan and copies of its link attachments. A scope cut makes no gates: no sign-off relation from the original, nothing
   * between the parts, no auto-start; only the needs a part names in `after` become ordinary relations. Refused once the
   * glob has started. With an idempotency key a retry returns the same parts, whatever the version.
   */
  async split(email: string, id: string, version: number, input: SplitInput): Promise<Result<Glob[]>> {
    const wanted = input.parts;
    if (wanted.length < 2) return invalidInput('A split needs at least 2 parts');
    if (wanted.length > MAX_SPLIT_PARTS) return invalidInput(`A split has at most ${MAX_SPLIT_PARTS} parts`);
    for (const [index, part] of wanted.entries()) {
      if (part.title.trim() === '') return invalidInput(`Part ${index} needs a title`);
      if (part.plan.trim() === '') return invalidInput(`Part ${index} needs a plan`);
      for (const n of part.after ?? []) {
        if (!Number.isInteger(n) || n < 0 || n >= index) return invalidInput(`Part ${index} can only start after earlier parts, not ${n}`);
      }
      if (part.category !== undefined && isHumanCategory(part.category)) return invalidInput('A split makes code work: decisions and actions are created on their own');
      if (index === 0 && (part.after ?? []).length > 0) return invalidInput('Part 0 is the original glob and starts after nothing new');
    }
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ globs: Glob[]; added: readonly string[]; fresh: boolean }>> => {
      const original = await tx.getGlob(id);
      if (original === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, original.boardId);
      if (!actor.ok) return actor;
      const key = (index: number): string | null => (input.idempotencyKey === null ? null : `split:${input.idempotencyKey}:${id}:${index}`);
      const firstKey = key(1);
      if (firstKey !== null) {
        const found: Glob[] = [original];
        for (let index = 1; index < wanted.length; index++) {
          const existing = await tx.findGlobByCreationKey(original.boardId, key(index) ?? '');
          if (existing === null) break;
          found.push(existing);
        }
        if (found.length === wanted.length) return ok({ globs: found, added: [], fresh: false });
        if (found.length > 1) throw new Error(`Split ${input.idempotencyKey ?? ''} of ${id} is only partly recorded`);
      }
      if (original.version !== version) {
        return err({ code: 'version_conflict', message: 'The glob has changed', current: original });
      }
      if (original.type === null) return invalidInput(`${id} is ${original.category === 'action' ? 'an action' : 'a decision'}: human work is not split`);
      // Only the current generation counts: Discard & back to Planning starts a new one, so earlier runs and PRs are history.
      const startedBy: string[] = [];
      if (original.status !== 'planning') startedBy.push(`it is ${original.status}`);
      if (original.provisioning !== 'none') startedBy.push('its branch exists');
      if (original.pr !== null) startedBy.push(`PR #${original.pr.number} is open`);
      for (const run of original.runs) {
        if (run.generation === original.generation && run.purpose !== 'investigate') startedBy.push(`run ${run.id} started`);
      }
      if (startedBy.length > 0) {
        return invalidInput(
          `${id} has started (${startedBy.join('; ')}), so it can no longer be split: finish it and create the rest as follow-ups`,
        );
      }
      const board = await tx.getBoard(original.boardId);
      if (board === null) return notFound(`No board ${original.boardId}`);
      const ctx = await this.context(actor.value, board);
      // The parts' relations are written below, under the board's lock, with the cycle check over everything the board has.
      await tx.lockBoardRelations(board.id);
      const boardRelations = await tx.listRelations(board.id);
      const ownRelations = boardRelations.filter((r) => r.from === id);

      // IDs first, so every plan can name the others.
      const ids: string[] = [original.id];
      for (const part of wanted.slice(1)) {
        const letter = letterFor(partInference(original, part));
        ids.push(formatId(board.id, letter, await tx.nextNumber(board.id, letter)));
      }
      const date = ctx.now.slice(0, 10);
      const planOf = (index: number): string => {
        const part = wanted[index];
        const note =
          index === 0
            ? `Split into ${ids.slice(1).join(', ')} on ${date}; this is part 1 of ${wanted.length}.`
            : `Split from ${id} on ${date}; this is part ${index + 1} of ${wanted.length} (parts: ${ids.join(', ')}).`;
        return `${fillPartIds(part?.plan ?? '', ids).trimEnd()}\n\n---\n${note}\n`;
      };

      // Each part's own risk: the board's risk areas against that part's plan, not the whole feature's.
      const areas = await tx.listRiskAreas(board.id);
      const splitDefaultType: SlopType = original.type;
      const escalations = splitEscalations(
        original,
        wanted.map((part) => ({ plan: fillPartIds(part.plan, ids), type: part.type ?? splitDefaultType })),
        areas.length > 0 ? areas : defaultAreas(board.id, ctx.now),
        email,
        ctx.now,
      );

      // Part 0: the original keeps its ID and gets the new fields.
      const first = wanted[0];
      if (first === undefined) return invalidInput('A split needs at least 2 parts');
      const firstEscalation = escalations[0];
      const firstType = firstEscalation?.type ?? first.type;
      // Every part shares one group: the original's, else the one asked for, else one named from its title (an existing group of
      // that name is reused as is).
      const existingGroups = [...new Set((await tx.listGlobs(board.id, {})).flatMap((g) => (g.group === null ? [] : [g.group])))];
      const asked = input.group?.trim() ?? '';
      const group =
        original.group ??
        (asked === ''
          ? groupFromTitle(original.title, existingGroups)
          : (existingGroups.find((g) => normaliseGroup(g) === normaliseGroup(asked)) ?? asked));
      const changes: FieldChanges = {
        title: first.title,
        ...(group === original.group ? {} : { group }),
        ...(first.category === undefined ? {} : { category: first.category }),
        ...(first.fix === undefined ? {} : { fix: first.fix }),
        ...(first.workKind === undefined ? {} : { workKind: first.workKind }),
        ...(firstType === undefined || (first.type === undefined && firstType === original.type) ? {} : { type: firstType }),
      };
      const changed = machine.changeFields(original, changes, board, ctx, await this.relationFacts(tx, ownRelations));
      if (!changed.ok) return changed;
      const escalationChanged = firstEscalation?.change != null;
      const moved = escalationChanged ? { ...changed.value.glob, escalation: firstEscalation.escalation } : changed.value.glob;
      const updated = { ...moved, updatedAt: ctx.now, version: original.version + 1 };
      if (!(await tx.updateGlob(updated, original.version))) {
        const current = await tx.getGlob(id);
        return current === null ? notFound(`No glob ${id}`) : err({ code: 'version_conflict', message: 'The glob has changed', current });
      }
      await tx.appendEvents(changed.value.events);
      await tx.enqueueEffects(changed.value.effects);
      if (firstEscalation?.change != null) await tx.appendEvents([escalationEvent(id, email, ctx.now, firstEscalation.change)]);

      const attachments = await tx.listArtifacts(original.id, 'attachment');
      // What the original waits for before it starts (a person's) goes to every part; one that merged since holds nothing.
      const inheritedAll = ownRelations.filter((r) => r.gate === 'start' && r.source === 'person' && isActive(r)).map((r) => r.to);
      const inheritedFound = new Map((await tx.getGlobs(inheritedAll)).map((g) => [g.id, g]));
      const inherited = inheritedAll.filter((to) => {
        const target = inheritedFound.get(to);
        return target !== undefined && !hasMerged(target);
      });
      // What a part waits for: the sibling parts merge, an inherited action is done (defaultUntil of what each points at).
      const untilOf = (to: string): RelationUntil => {
        const target = inheritedFound.get(to);
        return target === undefined ? 'merged' : defaultUntil(target);
      };
      const globs: Glob[] = [updated];
      const needsBy = input.planBy === 'human' || input.planBy === undefined ? 'person' : 'agent';
      const withArtifacts = [original.id];
      for (const [index, part] of wanted.entries()) {
        if (index === 0) continue;
        const partId = ids[index];
        if (partId === undefined) throw new Error(`No ID for part ${index}`);
        const earlier = [...new Set((part.after ?? []).map((n) => ids[n] ?? ''))];
        const awaitedIds = [...new Set([...inherited, ...earlier])];
        if (awaitedIds.length > MAX_AFTER) return invalidInput(`Part ${index} would wait for more than ${MAX_AFTER} globs`);
        // A need the part names is an ordinary relation (a person's or an agent's); what the original waited for stays a person's.
        const startWrite: NewRelation[] = awaitedIds.map((to): NewRelation => ({ to, gate: 'start', until: untilOf(to), reason: null, evidence: [], source: earlier.includes(to) ? needsBy : 'person' }));
        const startRelations = applyWrite([], { add: startWrite, update: [], remove: [] }, { boardId: board.id, from: partId, now: ctx.now, newId: () => this.relationId() });
        const created = machine.create(
          {
            id: partId,
            boardId: board.id,
            title: part.title,
            type: escalations[index]?.type ?? part.type ?? original.type,
            category: part.category ?? original.category,
            fix: partInference(original, part).fix,
            workKind: partInference(original, part).workKind,
            ...(part.category === undefined || part.category === original.category
              ? { fixSource: original.fixSource ?? 'inferred', workKindSource: original.workKindSource ?? 'inferred', inferenceReason: original.inferenceReason ?? null }
              : {}),
            group,
            environment: original.environment,
            autoTrigger: false,
          },
          board,
          ctx,
          { relations: startRelations.relations, states: await this.statesOf(tx, awaitedIds) },
        );
        if (!created.ok) return created;
        const partEscalation = escalations[index];
        const glob = { ...created.value.glob, version: 1, ...(partEscalation?.escalation == null ? {} : { escalation: partEscalation.escalation }) };
        if (!(await tx.insertGlob(glob, key(index)))) throw new Error(`Glob ID collision for ${glob.id}`);
        await tx.appendEvents(created.value.events);
        if (partEscalation?.change != null) await tx.appendEvents([escalationEvent(partId, email, ctx.now, partEscalation.change)]);
        await tx.enqueueEffects(created.value.effects);
        await this.writeNew(tx, glob, startRelations.inserted, email, ctx.now);
        globs.push(glob);
        withArtifacts.push(glob.id);
      }

      const provenance: Provenance = { by: input.planBy ?? 'human', actor: email, runId: null, agentSetVersion: null };
      const at = ctx.now;
      const addArtifact = async (globId: string, artifact: Omit<Artifact, 'id' | 'version' | 'globId' | 'provenance' | 'createdAt'>) => {
        const stored = await tx.insertArtifact({ ...artifact, globId, provenance, createdAt: at });
        await tx.appendEvents([
          {
            type: 'ArtifactAdded',
            globId,
            actor: email,
            at,
            data: { kind: artifact.kind, label: artifact.label, version: stored.version, commitSha: null, runId: null, agentSetVersion: null },
          },
        ]);
      };
      const sized = await tx.getSizeCheck(original.id);
      if (sized !== null && sized.decision === null) {
        await tx.upsertSizeCheck({ ...sized, decision: 'split', decidedBy: email, decidedAt: at, updatedAt: at });
      }
      for (const [index, globId] of ids.entries()) {
        await addArtifact(globId, { kind: 'plan', label: '', content: planOf(index), link: null, commitSha: null });
        if (index > 0) {
          const copy = new Set(wanted[index]?.attachments ?? []);
          // The new part is new work: the decisions that govern it travel with it like they do with a created glob.
          const part = globs.find((g) => g.id === globId);
          const governing = part === undefined || copy.has(DECISIONS_LABEL) ? [] : await governingDecisions(tx, part);
          if (governing.length > 0) {
            await addArtifact(globId, { kind: 'attachment', label: DECISIONS_LABEL, content: decisionsAttachment(governing), link: null, commitSha: null });
          }
          for (const attachment of attachments) {
            if (attachment.link !== null || copy.has(attachment.label)) {
              await addArtifact(globId, { kind: 'attachment', label: attachment.label, content: attachment.content, link: attachment.link, commitSha: null });
            }
          }
        }
        await tx.appendEvents([
          { type: 'GlobSplit', globId, actor: email, at, data: { source: id, part: index, parts: ids } },
        ]);
      }
      return ok({ globs, added: withArtifacts, fresh: true });
    });
    if (!result.ok) return result;
    if (result.value.fresh) {
      for (const glob of result.value.globs) this.publish(glob);
      for (const globId of result.value.added) {
        const glob = result.value.globs.find((g) => g.id === globId);
        if (glob !== undefined) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: glob.boardId, globId });
      }
    }
    return ok(result.value.globs);
  }

  /**
   * `changes.after` (the globs to start after) is checked here, under the board's relation lock: IDs exist on the board, no
   * cycle, merged ones dropped. It replaces the relations a person (or split) set and leaves inferred and learned ones; the
   * relation rows change with the glob, in the same transaction.
   */
  async update(email: string, id: string, version: number, changes: GlobChanges) {
    // A scope on one glob must name a work glob of the board (the pure step cannot look it up; it reports other faults itself).
    if (changes.attributes !== undefined) {
      const checked = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
        const decision = await tx.getGlob(id);
        const scope = decision === null ? null : validateScopeEdit(decision.category, changes.attributes);
        if (decision === null || scope === null || !scope.ok || scope.value.kind !== 'glob') return ok(null);
        const governed = await tx.getGlob(scope.value.ref);
        return governed?.boardId !== decision.boardId || isHumanCategory(governed.category)
          ? invalidInput(`No work glob ${scope.value.ref} on board ${String(decision.boardId)}`)
          : ok(null);
      });
      if (!checked.ok) return checked;
    }
    const { after: wanted, relations: statedHere, relationsBy, ...fields } = changes;
    // A glob joining a group gets the group-wide decisions still open on it, in the same write that moves it.
    let stated = statedHere;
    if (changes.group !== undefined && changes.group !== null) {
      const now = await this.peek(id);
      if (now !== null && !isHumanCategory(now.category) && !inGroup(now, changes.group)) {
        const inherited = await this.groupRelationsFor(now.boardId, changes.group, now);
        if (inherited.length > 0) stated = [...inherited, ...(statedHere ?? [])];
      }
    }
    if (changes.type !== undefined) {
      const refused = await this.refuseTypeChoice(email, id, changes.type);
      if (refused !== null) return refused;
    }
    // The work kind feeds the time report: only a board admin corrects it (the fix flag is anyone's to flip).
    if (changes.workKind !== undefined) {
      const refused = await this.refuseWorkKindChange(email, id);
      if (refused !== null) return refused;
    }
    // A same becoming a sub is about to start: the merge policy may hold it.
    const holds = changes.type === 'sub' ? await this.holdsFor(id) : [];
    const edit: { value: { readonly from: string[]; readonly to: string[] } | undefined } = { value: undefined };
    const before: { type: SlopType | null } = { type: null };
    const result = await this.command(
      email,
      id,
      version,
      (glob, ctx, board, facts) => {
        before.type = glob.type;
        return machine.changeFields(
          glob,
          { ...fields, ...(edit.value === undefined ? {} : { after: edit.value }), ...(holds.length === 0 ? {} : { impliedAfter: holds }) },
          board,
          ctx,
          facts.relations,
        );
      },
      {
        applies: 'any',
        relations: true,
        ...((wanted !== undefined || (stated?.length ?? 0) > 0) && {
          relationPlan: async (tx: Tx, glob: Glob, board: readonly Relation[]): Promise<Result<RelationWrite>> => {
            let write: RelationWrite = NO_WRITE;
            if (wanted !== undefined) {
              const planned = await this.planNeeds(tx, glob, board, wanted);
              if (!planned.ok) return planned;
              edit.value = planned.value.edit;
              write = planned.value.write;
            }
            if (stated === undefined || stated.length === 0) return ok(write);
            // The relations stated beside the list see the list's write: what it removes is gone, what it adds is there.
            const seen = [...board.filter((r) => !write.remove.includes(r.id)), ...write.add.map((n) => draftOf(glob.boardId, glob.id, n))];
            const more = await this.planRelations(tx, glob, seen, stated, relationsBy ?? 'person');
            return more.ok ? ok({ add: [...write.add, ...more.value.add], update: more.value.update, remove: [...write.remove, ...more.value.remove] }) : more;
          },
        }),
      },
    );
    if (result.ok && before.type !== null && before.type !== result.value.type) await this.recordRetype(result.value, before.type, email);
    return result;
  }

  /**
   * What stating relations `wanted` on a glob does (any gate): each is checked (the other glob is on the board and not this one,
   * a shape that makes sense, within the limit, no cycle) and then added. A relation a person or agent already set to the same
   * glob and gate only changes its `until` and reason; an inferred or learned one, or one that was dismissed or overridden,
   * gives way to a fresh one. Nothing is removed otherwise.
   */
  private async planRelations(
    tx: Tx,
    glob: Glob,
    board: readonly Relation[],
    wanted: readonly RelationInput[],
    by: RelationsBy,
  ): Promise<Result<RelationWrite>> {
    // The last statement of one glob and gate wins.
    const list = [...new Map(wanted.map((w) => [`${w.to.trim()}|${w.gate ?? 'start'}`, { ...w, to: w.to.trim() }])).values()].filter((w) => w.to !== '');
    const found = new Map((await tx.getGlobs([...new Set(list.map((w) => w.to))])).map((g) => [g.id, g]));
    const add: NewRelation[] = [];
    const update: { readonly id: string; readonly patch: { readonly until: RelationUntil; readonly reason: string | null; readonly group?: string } }[] = [];
    const remove: string[] = [];
    let growing: Relation[] = [...board];
    for (const w of list) {
      const target = found.get(w.to);
      if (target?.boardId !== glob.boardId) return invalidInput(`No glob ${w.to} on this board`);
      const gate = w.gate ?? 'start';
      const until = w.until ?? (defaultUntil(target));
      const shape = checkRelationShape(glob, { to: w.to, until, gate }, target);
      if (!shape.ok) return shape;
      const reason = (w.reason ?? '').trim();
      if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
      const mine = growing.find((r) => r.from === glob.id && r.to === w.to && r.gate === gate);
      const rest = growing.filter((r) => r.id !== mine?.id);
      const checked = checkRelation({ from: glob.id, to: w.to, gate, until }, glob.boardId, rest, (gid) => found.get(gid));
      if (!checked.ok) return checked;
      if (mine !== undefined && isActive(mine) && isExplicit(mine)) {
        if (mine.until === until && (reason === '' || mine.reason === reason)) continue;
        const patch = { until, reason: reason === '' ? mine.reason : reason, ...(w.group === undefined || w.group === null ? {} : { group: w.group }) };
        update.push({ id: mine.id, patch });
        growing = [...rest, { ...mine, ...patch }];
        continue;
      }
      if (mine !== undefined) remove.push(mine.id);
      const draft: NewRelation = { to: w.to, gate, until, reason: reason === '' ? null : reason, evidence: [], source: by, group: w.group ?? null };
      add.push(draft);
      growing = [...rest, draftOf(glob.boardId, glob.id, draft)];
    }
    return ok({ add, update, remove });
  }

  /**
   * What replacing a glob's start list (`needs`/`after`) with `wanted` does to its relations: the ones a person (or an old split) set
   * (not inferred or learned) are replaced, a recorded inferred or learned one to the same glob gives way to the person's, merged
   * globs are dropped, and every new relation is checked (on the board, not itself, no cycle, within the limit).
   */
  private async planNeeds(
    tx: Tx,
    glob: Glob,
    board: readonly Relation[],
    wanted: readonly string[],
  ): Promise<Result<{ readonly write: RelationWrite; readonly edit: { readonly from: string[]; readonly to: string[] } }>> {
    const list = [...new Set(wanted.map((a) => a.trim()).filter((a) => a !== ''))];
    if (list.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
    const found = new Map((await tx.getGlobs(list)).map((g) => [g.id, g]));
    for (const to of list) {
      if (to === glob.id) return invalidInput('A glob cannot wait for itself');
      if (found.get(to)?.boardId !== glob.boardId) return invalidInput(`No glob ${to} on this board`);
    }
    const kept = list.filter((to) => {
      const target = found.get(to);
      return target !== undefined && !hasMerged(target);
    });
    const mine = board.filter((r) => r.from === glob.id && r.gate === 'start');
    const explicit = mine.filter((r) => isExplicit(r) && isActive(r));
    const fromIds = explicit.map((r) => r.to);
    const add = kept.filter((to) => !fromIds.includes(to));
    const remove = [
      ...explicit.filter((r) => !kept.includes(r.to)).map((r) => r.id),
      // An inferred or learned relation to a glob the person now names gives way to theirs, and so does a dismissed one of their own.
      ...mine.filter((r) => (!isExplicit(r) || !isActive(r)) && add.includes(r.to)).map((r) => r.id),
    ];
    const growing: Relation[] = board.filter((r) => !remove.includes(r.id));
    const adds: NewRelation[] = [];
    for (const to of add) {
      const target = found.get(to);
      const until = target === undefined ? 'merged' : defaultUntil(target);
      if (target !== undefined) {
        const shape = checkRelationShape(glob, { to, until }, target);
        if (!shape.ok) return shape;
      }
      const draft: NewRelation = { to, gate: 'start', until, reason: null, evidence: [], source: 'person' };
      const checked = checkRelation(draftOf(glob.boardId, glob.id, draft), glob.boardId, growing, (gid) => found.get(gid));
      if (!checked.ok) return checked;
      growing.push(draftOf(glob.boardId, glob.id, draft));
      adds.push(draft);
    }
    return ok({ write: { add: adds, update: [], remove }, edit: { from: fromIds, to: kept } });
  }

  /** A person's retype teaches the board's intake (spec, Intake); recording never fails the change. */
  private recordRetype(glob: Glob, from: SlopType, actor: string): Promise<void> {
    if (glob.type === null) return Promise.resolve();
    return recordTypeCorrection(this.deps.store, this.deps.clock, { boardId: glob.boardId, globId: glob.id, from, to: glob.type, actor }, this.deps.log);
  }

  async start(email: string, id: string, version: number) {
    const holds = await this.holdsFor(id);
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.start(glob, ctx, facts.relations, holds), {
      relations: true,
    });
  }

  /** Start a glob that waits for others to merge, before they have. */
  async startAnyway(email: string, id: string, version: number) {
    const wrote = { value: false };
    const result = await this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAnyway(glob, ctx, facts.relations), {
      relations: true,
      record: this.handoverRecorder(wrote),
    });
    if (result.ok) this.publishHandover(wrote, result.value);
    return result;
  }

  /**
   * A person says a recorded relation is not a dependency (the ✕ on a Related row). The plan's hash is kept with it so a
   * changed plan may infer it again. A held glob that waited only for that relation starts, as when its last dependency
   * merges, and a merge or sign-off held for it goes on.
   */
  async dismissRelation(email: string, id: string, version: number | null, relationId: string) {
    const result = await this.command(email, id, version, (glob) => ok({ glob, changed: false, events: [], effects: [] }), {
      applies: 'work',
      relationPlan: async (tx: Tx, glob: Glob, board: readonly Relation[], now: string): Promise<Result<RelationWrite>> => {
        const found = board.find((r) => r.id === relationId && r.from === glob.id);
        if (found === undefined) return invalidInput(`${glob.id} has no relation ${relationId}`);
        if (found.dismissedAt !== null) return ok(NO_WRITE);
        const planHash = hash((await tx.artifactVersions(glob.id, 'plan', '')).at(-1)?.content ?? '');
        return ok({ add: [], update: [{ id: found.id, patch: { dismissedAt: now, dismissedPlanHash: planHash } }], remove: [] });
      },
    });
    if (!result.ok) return result;
    // What waited only for it goes on: a held start, a held merge, a sign-off with approved labels.
    if (result.value.status === 'planning' && result.value.waiting != null) await this.release(id);
    const resumed = await this.gateReleased(id);
    return resumed.ok ? resumed : result;
  }

  /**
   * The group-wide relations still open on a group, one per decision (or glob) and gate, as relations a glob joining the group
   * should get: the ones set for the group that are active and whose `to` has not reached `until`.
   */
  private async groupRelationsFor(boardId: number, group: string, joiner: Glob | null = null): Promise<RelationInput[]> {
    return this.deps.store.transaction(async (tx) => {
      // A glob that joins keeps its own relation state: any row it already has to the same glob and gate (dismissed ones too) stands.
      const own = joiner === null ? [] : await tx.listRelationsFrom([joiner.id]);
      const open = (await tx.listRelations(boardId)).filter((r) => r.group !== null && isActive(r) && normaliseGroup(r.group) === normaliseGroup(group));
      const targets = new Map((await tx.getGlobs([...new Set(open.map((r) => r.to))])).map((g) => [g.id, g]));
      const wanted = new Map<string, RelationInput>();
      for (const r of open) {
        const target = targets.get(r.to);
        if (target === undefined || isMet(r, toState(target)) || wanted.has(`${r.to}|${r.gate}`)) continue;
        if (joiner !== null && (r.to === joiner.id || own.some((o) => o.to === r.to && o.gate === r.gate) || pastGate(joiner, r.gate))) continue;
        wanted.set(`${r.to}|${r.gate}`, { to: r.to, gate: r.gate, until: r.until, reason: r.reason, group });
      }
      return [...wanted.values()];
    });
  }

  /**
   * Group-wide relation: every work glob in `group` can't pass `gate` until `id` (usually a decision) reaches `until`. One
   * relation per glob (the usual rows, each marked with the group), so the decision's `holdsBack` lists them as usual; a glob
   * that joins the group later gets it too while it is open. Globs already past the gate, decisions and `id` itself are
   * left out. Returns the globs now held and those that failed with why (an error when none could be held). The per-glob rows are
   * the only record: if none was written (every member past the gate), globs joining later get nothing.
   */
  async holdGroup(
    email: string,
    id: string,
    group: string,
    input: Omit<RelationInput, 'to' | 'group'>,
    by: RelationsBy = 'person',
  ): Promise<Result<{ readonly held: readonly string[]; readonly failed: readonly { readonly id: string; readonly message: string }[] }>> {
    const source = await this.peek(id);
    if (source === null) return notFound(`No glob ${id}`);
    const actor = await this.deps.store.transaction((tx) => this.actorFor(tx, email, source.boardId));
    if (!actor.ok) return actor;
    const members = (await this.peekAll(source.boardId, {})).filter((g) => inGroup(g, group) && !isHumanCategory(g.category) && g.id !== id);
    if (members.length === 0) return notFound(`No group ${group} on board ${source.boardId}`);
    const gate = input.gate ?? 'start';
    const name = members[0]?.group ?? group;
    const held: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const glob of members) {
      if (pastGate(glob, gate)) continue;
      const added = await this.addRelation(email, id, null, { ...input, to: glob.id, group: name, reason: input.reason ?? `Group ${name} waits for this decision` }, 'holds_back', by);
      if (added.ok) held.push(glob.id);
      else failed.push({ id: glob.id, message: added.error.message });
    }
    // Nothing held because every attempt failed: say why instead of reporting success.
    if (held.length === 0 && failed.length > 0) return invalidInput(`No glob of ${name} could be held: ${failed[0]?.id ?? ''}: ${failed[0]?.message ?? ''}`);
    return ok({ held, failed });
  }

  /**
   * Adds one relation. `held_by` (the usual): `id` can't pass `gate` until `other` reaches `until`; `version` is `id`'s.
   * `holds_back`: `other` can't pass `gate` until `id` reaches `until` (a decision's "Holds back"); `other` is the glob that is
   * written, so `version` isn't checked (the page doesn't hold `other`'s) and the glob `id` only gets a live hint.
   */
  async addRelation(
    email: string,
    id: string,
    version: number | null,
    input: RelationInput,
    direction: RelationDirection = 'held_by',
    by: RelationsBy = 'person',
  ): Promise<Result<Glob>> {
    const from = direction === 'held_by' ? id : input.to;
    const to = direction === 'held_by' ? input.to : id;
    const result = await this.command(email, from, direction === 'held_by' ? version : null, (glob) => ok({ glob, changed: false, events: [], effects: [] }), {
      applies: 'any',
      relationPlan: (tx, glob, board) => this.planRelations(tx, glob, board, [{ ...input, to }], by),
    });
    if (!result.ok) return result;
    const held = await this.gateReleased(from);
    if (direction === 'holds_back') {
      const target = await this.peek(id);
      if (target !== null) this.publish(target);
    }
    return held.ok ? held : result;
  }

  /** `environment` (optional) is chosen at pick-up; leaving it out keeps the glob's environment. */
  pickUp(email: string, id: string, version: number, takeOver: boolean, environment?: string | null) {
    return this.pickUpWithWarning(email, id, version, takeOver, environment).then((r) => (r.ok ? ok(r.value.glob) : r));
  }

  /** Pick up, and say what the glob was still waiting for (null when nothing): the person may go ahead, with a warning. */
  async pickUpWithWarning(
    email: string,
    id: string,
    version: number,
    takeOver: boolean,
    environment?: string | null,
  ): Promise<Result<{ glob: Glob; warning: string | null }>> {
    let warning: string | null = null;
    const wrote = { value: false };
    const result = await this.command(
      email,
      id,
      version,
      (glob, ctx, board, facts) => {
        const relations = facts.relations;
        const held = glob.status === 'planning' && relations !== undefined ? pickUpWarning(awaitedOf(relations)) : null;
        const investigating = machine.investigationRunning(glob);
        const note =
          investigating === null
            ? null
            : `An investigation has been running since ${investigating.since}${investigating.sessionUrl === null ? '' : ` (${investigating.sessionUrl})`}; the local session waits for it and reuses its result`;
        warning = [held, note].filter((w) => w !== null).join('. ') || null;
        return machine.pickUp(glob, ctx, board, { takeOver, ...(environment === undefined ? {} : { environment }), ...(relations === undefined ? {} : { relations }) });
      },
      { relations: true, applies: 'any', record: this.handoverRecorder(wrote) },
    );
    if (result.ok) this.publishHandover(wrote, result.value);
    return result.ok ? ok({ glob: result.value, warning }) : result;
  }

  /** Review now: queues a fresh independent review of a glob with a PR in Doing or Reviewing (any board member; no version needed). */
  reviewNow(email: string, id: string) {
    return this.command(email, id, null, (glob, ctx, _board, facts) => machine.reviewNow(glob, ctx, facts), { facts: true });
  }

  /** Investigate: an investigate-only routine run on a glob in Planning (refused while any run is live). */
  investigate(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.investigate(glob, ctx));
  }

  retryAutofix(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retryAutofix(glob, ctx));
  }

  /** Refused while prerequisites are unmerged, unless `anyway` (a person's choice). */
  retrigger(email: string, id: string, version: number, anyway = false) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.retrigger(glob, ctx, facts.relations, anyway), {
      relations: true,
    });
  }

  resolveConflict(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.resolveConflict(glob, ctx));
  }

  startAgain(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAgain(glob, ctx, facts.relations), {
      relations: true,
    });
  }

  /** Merge, or (`continueAfter`, supers) Merge and continue, which needs the latest implementation record at the head. */
  merge(email: string, id: string, version: number, continueAfter = false) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.requestMerge(glob, ctx, { continue: continueAfter, facts }),
      { facts: continueAfter, relations: true },
    );
  }

  /** Cancel merge: disarms "merge when checks pass". */
  cancelMerge(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.cancelMerge(glob, ctx));
  }

  /** Retry merge: a failed merge (not a conflict) goes back to merging at the head, which already passed. */
  retryMerge(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.retryMerge(glob, ctx, facts.relations), { relations: true });
  }

  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel(email: string, id: string, version: number, name: LabelName, command: LabelCommand) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.reviewLabel(glob, name, command, ctx, facts.rollout ?? null, facts.relations), {
      rollout: true,
      relations: true,
    });
  }

  /** Decision globs: sign off an accepted decision (Reviewing to Signed off). */
  signOffDecision(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.signOffDecision(glob, ctx, facts.rollout ?? null, facts.relations), {
      applies: 'decision',
      rollout: true,
      relations: true,
    });
  }

  /** Decision globs: take an accepted decision back to Doing, its outcome cleared. */
  reopenDecision(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.reopenDecision(glob, ctx), { applies: 'decision' });
  }

  /** Action globs: a person did the work (optionally noting what they checked); what waited for it is released. */
  async completeAction(email: string, id: string, version: number | null, note?: string) {
    // Not done while a glob that builds its script hasn't merged, or while the script isn't on the base branch.
    const check = await this.scriptCheckFor(id);
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.completeAction(glob, note === undefined ? {} : { note }, ctx, { ...facts, ...scriptFacts(check) }),
      { applies: 'action', relations: true },
    );
  }

  /** Action globs: the work is not needed; the reason is required, and what waited for it is released. */
  dismissAction(email: string, id: string, version: number | null, reason: string) {
    return this.command(email, id, version, (glob, ctx) => machine.dismissAction(glob, { reason }, ctx), { applies: 'action' });
  }

  /** `mark_ready`: ask slop to mark the glob's draft PR ready for review. */
  requestReady(email: string, id: string, runId: string | null) {
    return this.command(email, id, null, (glob, ctx) => machine.readyRequested(glob, runId, ctx));
  }

  /** The board's Ready for review on a super: allowed once the latest implementation record is at the PR head. */
  requestReadyFromBoard(email: string, id: string, version: number) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.readyRequested(glob, null, ctx, { from: 'board', facts }),
      { facts: true },
    );
  }

  /** `escalate_to_same`: a routine run (with its run ID) or a person flags a running sub as needing a human. */
  escalateToSame(email: string, id: string, input: { reason: string; evidence?: string | null; criterion?: string | null; runId?: string | null }) {
    return this.command(email, id, null, (glob, ctx) => machine.escalateToSame(glob, input, ctx));
  }

  /**
   * Risk-area cleanup: de-escalates the globs in Planning that were escalated only for the dropped areas. Returns how many
   * became subs again.
   */
  async liftRiskAreaEscalations(boardId: number, dropped: readonly string[]): Promise<number> {
    const candidates = await this.deps.store.transaction((tx) => tx.listGlobs(boardId, {}));
    let lifted = 0;
    for (const glob of candidates) {
      if (glob.type !== 'same' || glob.status !== 'planning' || glob.escalation?.criterion !== 'risk_area') continue;
      const result = await this.command(
        null,
        glob.id,
        null,
        (g, ctx, _board, facts) => machine.liftRiskAreaEscalation(g, ctx, facts.relations, dropped),
        { relations: true },
      );
      if (result.ok && result.value.type === 'sub') lifted++;
    }
    return lifted;
  }

  /** A person makes an escalated glob a sub again. */
  async deescalate(email: string, id: string, version: number) {
    const refused = await this.refuseTypeChoice(email, id, 'sub');
    if (refused !== null) return refused;
    return this.command(email, id, version, (glob, ctx) => machine.deescalate(glob, ctx));
  }

  /** Make it a super: a person takes over a failed sub or same whose routine asked for pairing. Counts as a type correction. */
  async makeSuper(email: string, id: string, version: number) {
    const refused = await this.refuseTypeChoice(email, id, 'super');
    if (refused !== null) return refused;
    const before: { type: SlopType | null } = { type: null };
    const result = await this.command(email, id, version, (glob, ctx) => {
      before.type = glob.type;
      return machine.makeSuper(glob, ctx);
    });
    if (result.ok && before.type !== null && before.type !== result.value.type) await this.recordRetype(result.value, before.type, email);
    return result;
  }

  /** `report_failure` from a person's interactive session (no run ID); `kind: 'needs_pairing'` says a person must decide something. */
  reportFailure(
    email: string,
    id: string,
    reason: string,
    runId: string | null,
    agentSetVersion: number | null = null,
    pairing?: { readonly kind: 'needs_pairing'; readonly decision?: string | null },
  ) {
    return this.command(email, id, null, (glob, ctx, _board, facts) =>
      machine.reportFailure(glob, { reason, runId, agentSetVersion, ...(pairing === undefined ? {} : pairing) }, ctx, facts.relations),
    { relations: true }).then(async (result) => {
      // A run that failed for unmerged prerequisites teaches the board a need; the report itself never fails on it.
      if (result.ok) await this.deps.dependencyLearning?.onFailed(id, reason).catch((e: unknown) => this.deps.log?.('dependency learning', e instanceof Error ? e.message : String(e)));
      return result;
    });
  }

  async delete(email: string, id: string, version: number): Promise<Result<null>> {
    const released: Glob[] = [];
    // A dependant written by someone else meanwhile rolls the delete back: try again against what is there now.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deleteOnce(email, id, version, released);
      } catch (e) {
        if (!(e instanceof DependantMoved) || attempt >= EVENT_RETRIES) throw e;
      }
    }
  }

  private async deleteOnce(email: string, id: string, version: number, released: Glob[]): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Glob>> => {
      released.length = 0;
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (glob.version !== version) {
        return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      }
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      const transition = machine.remove(glob, await this.context(actor.value, board));
      if (!transition.ok) return transition;
      // A learning an agent submitted or slop mined is a KB item: deleting it would lose the learning (and a rejected one
      // suppresses repeats), so it is rejected instead. Decisions people made (inbox, extracted, manual) can go.
      if (isLearning(glob)) return invalidInput('This decision is a knowledge item an agent submitted or slop mined; reject it instead of deleting it');
      const fileKeys = await fileKeysOf(tx, glob.id);
      // What waited on it is released (the rows stay, so the glob can say it was deleted): each gets a note and a new version.
      const dependants = await this.releasedBy(tx, glob, this.deps.clock.now());
      released.push(...dependants);
      await tx.deleteEvents(glob.id);
      await tx.deleteGlob(glob.id);
      // The deletion itself is logged without a glob, so reports lose the glob's time.
      // The files' objects go through the outbox, written with the delete, so a crash or a storage error can't leave them behind.
      await tx.enqueueEffects([...transition.value.effects, recheckOverlapsEffect(glob.boardId), ...fileKeys.map((key) => deleteObjectEffect(glob.id, key))]);
      return ok(glob);
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({
      kind: 'glob.deleted',
      boardId: result.value.boardId,
      globId: result.value.id,
      version: result.value.version + 1,
    });
    // A glob held only by the deleted one starts now, as when it merges.
    for (const dependant of released) {
      this.publish(dependant);
      if (dependant.status === 'planning' && dependant.waiting != null) await this.release(dependant.id);
      // A merge held for it resumes and a sign-off held for it completes.
      else await this.gateReleased(dependant.id);
    }
    return ok(null);
  }

  /**
   * The globs that waited for `gone` (an active start relation to it) before it is deleted: each logs that the gate was
   * released because it was deleted and moves to a new version. Returns them as written.
   */
  private async releasedBy(tx: Tx, gone: Glob, at: string): Promise<Glob[]> {
    const rows = (await tx.listRelationsTo([gone.id])).filter((r) => isActive(r));
    const out: Glob[] = [];
    for (const from of [...new Set(rows.map((r) => r.from))]) {
      const glob = await tx.getGlob(from);
      if (glob === null) continue;
      const touched = machine.relationsChanged(glob, { actor: null, now: at, newRunId: () => this.deps.ids.runId(), routineOwnerFor: () => '' });
      if (!touched.ok) continue;
      const next = { ...touched.value.glob, version: glob.version + 1 };
      if (!(await tx.updateGlob(next, glob.version))) throw new DependantMoved(`${glob.id} changed while ${gone.id} was deleted`);
      await tx.appendEvents(
        rows.filter((r) => r.from === from).map((r): DomainEvent => ({ type: 'RelationReleased', globId: from, actor: null, at, data: { to: r.to, gate: r.gate, reason: `${gone.id} was deleted` } })),
      );
      out.push(next);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Events from integrations and routines (applied against the current version)

  applyEvent(
    id: string,
    step: (glob: Glob, ctx: Context, facts: ActionFacts) => Result<Transition>,
    /** `relations`: read the glob's relations into the step's facts (checks and the sub gate wait for `merge` relations). */
    options: { readonly relations?: boolean } = {},
  ) {
    return this.command(null, id, null, (glob, ctx, _board, facts) => step(glob, ctx, facts), options.relations === true ? { relations: true } : {});
  }

  /**
   * A glob this one waited for merged (`release_waiting`): starts the globs in Planning that wait for it and for nothing
   * else that is unmerged. Each release is its own write and a no-op when already done, so a retry is safe.
   * Returns the IDs released.
   */
  async releaseDependents(mergedId: string, boardId: number): Promise<string[]> {
    // The merge is also an outcome for the board's dependency rules (its overlaps went cleanly or not); it never blocks the release.
    // Human work (a decision or an action) has no overlaps to learn from.
    const source = await this.deps.store.transaction((tx) => tx.getGlob(mergedId));
    if (source === null || !isHumanCategory(source.category)) await this.deps.dependencyLearning?.onMerged(mergedId).catch((e: unknown) => this.deps.log?.('dependency learning', e instanceof Error ? e.message : String(e)));
    const dependants = await this.deps.store.transaction(async (tx) => {
      const rows = (await tx.listRelationsTo([mergedId])).filter((r) => isActive(r) && r.boardId === boardId);
      const from = [...new Set(rows.map((r) => r.from))];
      return from.length === 0 ? [] : await tx.getGlobs(from);
    });
    const released: string[] = [];
    for (const glob of dependants) {
      // An action has no start to release: its Done is offered again by what it reads, so the row is only told to reload.
      if (glob.category === 'action') {
        this.publish(glob);
        continue;
      }
      // A start relation: a glob held in Planning starts once everything it waits for has merged.
      if (glob.status === 'planning' && glob.waiting != null) {
        const result = await this.release(glob.id);
        if (result.ok && result.value.status !== 'planning') released.push(glob.id);
      }
      // A merge or sign-off relation: a held merge resumes, a glob with approved labels moves to Signed off. Idempotent.
      await this.gateReleased(glob.id);
    }
    return released;
  }

  /**
   * A relation of this glob's was met, dismissed or went away (`to` merged, was decided, signed off or was deleted): a merge
   * held for it resumes, and a Reviewing glob with approved labels and nothing else holding it moves to Signed off. A no-op
   * otherwise and when already done, so every release path may call it.
   */
  async gateReleased(id: string): Promise<Result<Glob>> {
    return this.command(null, id, null, (glob, ctx, _board, facts) => machine.gateReleased(glob, facts.relations ?? NO_RELATIONS, facts.rollout ?? null, ctx), {
      relations: true,
      rollout: true,
      applies: 'any',
    });
  }

  /** The background size refresh: never awaited, and a rejection (or a throw) is logged, never unhandled. */
  private refreshSizeInBackground(id: string): void {
    const check = this.deps.sizeCheck;
    if (check === undefined) return;
    void Promise.resolve()
      .then(() => check.refresh(id))
      .catch((e: unknown) => this.deps.log?.('size check refresh', e instanceof Error ? e.message : String(e)));
  }

  /**
   * After a size check was re-judged (its plan was saved): a glob that now looks big is investigated. The flag only advises:
   * it never holds, releases or escalates a glob.
   */
  async reconcileSizeCheck(id: string): Promise<void> {
    await this.autoInvestigate(id);
  }

  /**
   * The open work globs on the board whose branch changes `path` right now (a hotspot refactor waits for them). A glob in
   * Planning has no branch; one whose branch can't be read is left out, as for every hold.
   */
  async openGlobsTouching(boardId: number, path: string): Promise<string[]> {
    const branchFiles = this.deps.branchFiles;
    if (branchFiles === undefined) return [];
    const read = await this.deps.store.transaction(async (tx) => ({ board: await tx.getBoard(boardId), globs: await tx.listGlobs(boardId, {}) }));
    const { board } = read;
    if (board === null) return [];
    const open = read.globs.filter((g) => listOf(g.status) === 'doing' && g.type !== 'super' && g.provisioning !== 'none');
    const files = await Promise.all(open.map((g) => branchFiles.filesOf(board, g).catch(() => null)));
    return open.filter((_, i) => files[i]?.includes(path) === true).map((g) => g.id);
  }

  /**
   * Recomputes the predicted overlap edges of every open glob (Planning or Doing) on the board and replaces the stale
   * ones (`recheck_overlaps`). An edge to a glob that went back to Planning, failed without a branch, was deleted, merged
   * or no longer changes an exclusive path drops off; a new one is added when a branch or plan now shows it. Explicit
   * edges, learned ones and ones a person overrode are kept. Each glob is its own version-checked write and a no-op when
   * its edges are unchanged, so a repeat changes nothing. Returns the IDs whose edges changed.
   */
  async recheckOverlaps(boardId: number): Promise<string[]> {
    const branchFiles = this.deps.branchFiles;
    if (branchFiles === undefined) return [];
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return null;
      const globs = await tx.listGlobs(boardId, {});
      const plans = new Map<string, string>();
      for (const glob of globs) plans.set(glob.id, (await tx.listArtifacts(glob.id, 'plan'))[0]?.content ?? '');
      return { board, globs, plans, relations: await tx.listRelations(boardId) };
    });
    if (read === null) return [];
    // One read of each branch per recheck, whoever asks: keyed by glob and head.
    const cache = new Map<string, Promise<readonly string[] | null>>();
    const cached: BranchFiles = {
      filesOf: (board, glob) => {
        const key = `${glob.id}@${glob.pr?.headSha ?? ''}`;
        const found = cache.get(key) ?? branchFiles.filesOf(board, glob);
        cache.set(key, found);
        return found;
      },
    };
    const prediction = await this.deps.dependencyLearning?.prediction(read.board.id);
    const byId = new Map(read.globs.map((g) => [g.id, g]));
    const changed: string[] = [];
    for (const glob of read.globs) {
      const open = listOf(glob.status) === 'planning' || listOf(glob.status) === 'doing';
      if (!open || glob.type === 'super') continue;
      const mine = glob.impliedAfter ?? [];
      // Edges nobody may replace are not looked for again.
      const needs = startIds(read.relations.filter((r) => r.from === glob.id));
      const skip = new Set([...needs, ...mine.filter((i) => !machine.isReplaceableOverlap(i)).map((i) => i.id)]);
      // An overlap is recorded on the later glob (it is the one that rebases), as at start: a newer glob adds none here.
      for (const other of read.globs) {
        if (other.id !== glob.id && !mine.some((i) => i.id === other.id) && (other.createdAt > glob.createdAt || (other.createdAt === glob.createdAt && other.id > glob.id))) skip.add(other.id);
      }
      const files = glob.provisioning === 'none' ? undefined : ((await cached.filesOf(read.board, glob)) ?? undefined);
      const found = await findHolds(
        this.deps.store,
        cached,
        read.board,
        { id: glob.id, plan: read.plans.get(glob.id) ?? '', ...(files === undefined ? {} : { files }) },
        skip,
        prediction,
      );
      const dropReasons = new Map<string, string>();
      for (const edge of mine.filter(machine.isReplaceableOverlap)) {
        const other = byId.get(edge.id);
        dropReasons.set(
          edge.id,
          other === undefined
            ? `${edge.id} was deleted`
            : hasMerged(other)
              ? `${edge.id} merged`
              : other.status === 'planning'
                ? `${edge.id} is back in Planning`
                : other.status === 'failed'
                  ? `${edge.id} failed`
                  : `${edge.id} no longer changes ${edge.paths.slice(0, 3).join(', ')}`,
        );
      }
      const result = await this.command(null, glob.id, null, (g, ctx) => machine.overlapsRechecked(g, { edges: found, dropReasons }, ctx, needs));
      if (result.ok && result.value.version !== glob.version) changed.push(glob.id);
    }
    return changed;
  }

  /**
   * Infers the glob's fix flag and work kind again after its plan changed. `infer` is the model-with-rules judgement
   * (`IntakeService.inferWork`; any function that never throws for the model being down). It is silent: no notification, only
   * the recorded field change, and the reason is refreshed. A value a person set (source `person`) is never overwritten, and a
   * plan saved while the model answered wins (the answer is dropped). Only code globs that can still carry the flag are
   * touched: a fix is never a super, so a super's answer says "not a fix" and stays so.
   */
  async reinferWork(id: string, infer: (input: { readonly title: string; readonly plan: string }) => Promise<WorkInference>): Promise<void> {
    const before = await this.peek(id);
    if (before === null || !isCodeGlob(before)) return;
    const plan = await this.deps.store.transaction(async (tx) => (await tx.artifactVersions(id, 'plan', '')).at(-1)?.content ?? '');
    // Skip the model when a person already decided both: nothing could change.
    if (before.fixSource === 'person' && before.workKindSource === 'person') return;
    const found = await infer({ title: before.title, plan });
    const planHash = hash(plan);
    const fix = before.type === 'super' ? false : found.fix;
    await this.command(
      null,
      id,
      null,
      (g, ctx) => machine.workReinferred(g, { fix, workKind: found.workKind, reason: inferenceReasonOf(found) }, ctx),
      {
        applies: 'any',
        prepare: async (tx) => {
          const latest = hash((await tx.artifactVersions(id, 'plan', '')).at(-1)?.content ?? '');
          return latest === planHash ? ok(null) : invalidInput('The plan changed while it was being read');
        },
      },
    );
  }

  /**
   * Writes the edges slop inferred for a glob (from its plan and investigation, `refresh` of the inference service). A need
   * of a glob in Planning becomes a start relation (source `inferred`): the ones that would make a cycle are dropped and said so
   * in the log, the rest replace the glob's earlier inferred relations (a person's, a learned one, one Start now overrode and
   * one dismissed for this plan stay as they are). An edge is a need (start until merged) or an open decision (start until
   * decided); a glob that already started holds nothing, so nothing is written. A held glob that waited only for a relation now gone starts. A no-op when nothing changed.
   */
  async applyInferred(id: string, edges: readonly InferredEdge[], planHash: string): Promise<void> {
    const before = await this.peek(id);
    if (before === null) return;
    const needs: string[] = [];
    let stale = false;
    // Read inside the command's transaction: a plan saved or an edge dismissed while the model answered must not be overwritten,
    // and two globs inferring needs on each other must see each other's relations (the board's lock).
    const result = await this.command(
      null,
      id,
      null,
      (g, ctx) => (stale ? ok({ glob: g, changed: false, events: [], effects: [] }) : machine.edgesInferred(g, { edges: [], notes: [], planHash }, ctx, needs)),
      {
        relations: true,
        relationPlan: async (tx: Tx, glob: Glob, board: readonly Relation[]): Promise<Result<RelationWrite>> => {
          needs.length = 0;
          stale = hash((await tx.artifactVersions(glob.id, 'plan', '')).at(-1)?.content ?? '') !== planHash;
          if (stale) return ok(NO_WRITE);
          const started = glob.status !== 'planning';
          const mine = board.filter((r) => r.from === glob.id && r.gate === 'start');
          // An inferred relation is replaced by the next inference unless Start now overrode it or it was dismissed for this plan.
          const replaceable = (r: Relation): boolean => r.source === 'inferred' && r.overriddenAt === null && !(r.dismissedAt !== null && r.dismissedPlanHash === planHash);
          // What stands (a person's, a learned one, one that was overridden or dismissed) wins over an inferred edge to the same glob.
          needs.push(...mine.filter((r) => !replaceable(r)).map((r) => r.to));
          const fresh = edges.filter((e) => e.id !== id);
          // A glob that has started holds nothing now, so there is nothing to hold it with.
          if (started || glob.type === 'super') return ok(NO_WRITE);
          const known = new Map((await tx.getGlobs(fresh.map((e) => e.id))).map((g) => [g.id, g]));
          const remove = mine.filter(replaceable).map((r) => r.id);
          const growing: Relation[] = board.filter((r) => !remove.includes(r.id));
          const add: NewRelation[] = [];
          const lines: string[] = [];
          for (const edge of fresh) {
            // A person's, a learned or an overridden one to the same glob wins; a deleted or merged glob needs nothing, and a decision
            // that has been decided holds nothing either. The kind must match what it points at.
            const target = known.get(edge.id);
            if (target === undefined || target.boardId !== glob.boardId) continue;
            // Actions are never inferred: only a person or an agent relates to one.
            if (target.category === 'action') continue;
            const decision = edge.kind === 'decision';
            if (decision !== (target.category === 'decision')) continue;
            if (decision ? toState(target) !== 'planning' && toState(target) !== 'open' : hasMerged(target)) continue;
            if (growing.some((r) => r.from === glob.id && r.to === edge.id && r.gate === 'start')) continue;
            const draft: NewRelation = { to: edge.id, gate: 'start', until: decision ? 'decided' : 'merged', reason: edge.reason, evidence: edge.files, source: 'inferred' };
            const checked = checkRelation(draftOf(glob.boardId, glob.id, draft), glob.boardId, growing, (gid) => known.get(gid));
            if (!checked.ok) {
              lines.push(`Dropped the ${decision ? 'decision' : 'need'} on ${edge.id}: ${checked.error.message}`);
              continue;
            }
            growing.push(draftOf(glob.boardId, glob.id, draft));
            add.push(draft);
          }
          // The reason is the model's wording and changes between answers: a need to the same glob stays as it is.
          const kept = add.filter((a) => mine.some((r) => replaceable(r) && r.dismissedAt === null && r.to === a.to));
          const reAdded = new Set(kept.map((a) => a.to));
          const finalRemove = remove.filter((rid) => !reAdded.has(mine.find((r) => r.id === rid)?.to ?? ''));
          const finalAdd = add.filter((a) => !reAdded.has(a.to));
          return ok({ add: finalAdd, update: [], remove: finalRemove, ...(lines.length === 0 ? {} : { notes: { lines, planHash } }) });
        },
      },
    );
    if (!result.ok || result.value.version === before.version) return;
    // A relation that went away may have been all a held glob waited for.
    if (result.value.status === 'planning' && result.value.waiting != null) await this.release(id);
  }

  /** Starts one held glob if everything it waits for has merged and the merge policy still lets it. */
  async release(id: string) {
    const holds = await this.holdsFor(id, true);
    return this.command(null, id, null, (glob, ctx, _board, facts) => machine.released(glob, ctx, facts.relations, holds), {
      relations: true,
      triggeredByCreator: true,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The holds the board's merge policy puts on a glob in Planning that is about to start: open globs that may change
   * the same exclusive paths. None without a branch reader, while the glob still waits for something else (it is
   * checked again when released), or, with `heldOnly`, for a glob nobody asked to start.
   */
  private async holdsFor(id: string, heldOnly = false): Promise<ImpliedAfter[]> {
    const branchFiles = this.deps.branchFiles;
    if (branchFiles === undefined) return [];
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null || glob.status !== 'planning' || glob.type === 'super' || (heldOnly && glob.waiting == null)) return null;
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return null;
      const relations = await this.relationFacts(tx, await tx.listRelationsFrom([id]));
      if (awaitedOf(relations).length > 0) return null;
      const plan = (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '';
      return { glob, board, plan, needs: startIds(relations.relations) };
    });
    if (read === null) return [];
    // Overlaps already recorded, and globs already waited for, are not predicted again.
    const skip = new Set([...read.needs, ...(read.glob.impliedAfter ?? []).map((i) => i.id)]);
    return findHolds(this.deps.store, branchFiles, read.board, { id, plan: read.plan }, skip, await this.deps.dependencyLearning?.prediction(read.board.id));
  }

  /** What a glob still waits for before it starts (its unmet start relations), for the routine executor's last check before a session is spent. */
  async startHolds(id: string): Promise<AwaitedDependency[]> {
    return this.deps.store.transaction(async (tx) => awaitedOf(await this.relationFacts(tx, await tx.listRelationsFrom([id]))));
  }

  /** The globs in `ids` that still exist, and the state of each (a glob that no longer exists is `missing`). */
  private async reachOf(tx: Tx, ids: readonly string[]): Promise<{ readonly globs: Map<string, Glob>; readonly states: Map<string, ToState> }> {
    const found = ids.length === 0 ? [] : await tx.getGlobs(ids);
    const byId = new Map(found.map((g) => [g.id, g]));
    const held = new Set<string>();
    for (const boardId of new Set(found.map((g) => g.boardId))) for (const id of await this.heldDependants(tx, boardId)) held.add(id);
    return { globs: byId, states: new Map(ids.map((id) => [id, toState(byId.get(id), held)])) };
  }

  /** The state of each glob in `ids` (a glob that no longer exists is `missing`). */
  private async statesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, ToState>> {
    return (await this.reachOf(tx, ids)).states;
  }

  /** The glob's relations in groups: what holds it back, what it holds back, and what no longer holds. */
  private async relationGroupsOf(tx: Tx, glob: Glob, facts: RelationFacts): Promise<RelationsView> {
    const reach = await this.reachOf(tx, [...new Set(facts.relations.map((r) => r.to))]);
    const withStates: RelationFacts = { relations: facts.relations, states: reach.states };
    const titles = titlesOf(reach.globs);
    const incoming = await tx.listRelationsTo([glob.id]);
    const mine = toState(glob, await this.heldDependants(tx, glob.boardId));
    const open = incoming.filter((r) => isActive(r) && !isMet(r, mine));
    const others = open.length === 0 ? [] : await tx.getGlobs([...new Set(open.map((r) => r.from))]);
    const named = new Map(others.map((g) => [g.id, g.title]));
    const holdsBack: HeldBack[] = open.map((r) => ({ relationId: r.id, from: r.from, fromTitle: named.get(r.from) ?? null, gate: r.gate, until: r.until, reason: r.reason, source: r.source }));
    return { holding: holdingOf(withStates, titles), holdsBack, done: doneOf(withStates, titles) };
  }

  /** What holds the glob back: its unmet relations, with the title of what each points at. */
  private async holdingFor(tx: Tx, facts: RelationFacts): Promise<Holding[]> {
    const reach = await this.reachOf(tx, [...new Set(facts.relations.map((r) => r.to))]);
    return holdingOf({ relations: facts.relations, states: reach.states }, titlesOf(reach.globs));
  }

  /** A glob's relations with the state of each glob they point at. */
  private async relationFacts(tx: Tx, relations: readonly Relation[]): Promise<RelationFacts> {
    return { relations, states: await this.statesOf(tx, [...new Set(relations.map((r) => r.to))]) };
  }

  /** The globs in Planning that wait for `id` before they start. */
  private async waitedOnBy(tx: Tx, id: string): Promise<string[]> {
    const from = [...new Set((await tx.listRelationsTo([id])).filter((r) => r.gate === 'start' && isActive(r)).map((r) => r.from))];
    return from.length === 0 ? [] : (await tx.getGlobs(from)).filter((g) => g.status === 'planning').map((g) => g.id);
  }

  /** The globs on a board whose open work steps hold back their dependants (a rollout): merged, but still awaited. */
  private async heldDependants(tx: Tx, boardId: number): Promise<Set<string>> {
    const open = await tx.listOpenHumanSteps(boardId);
    return new Set(open.filter((s) => s.blocks.includes('dependants')).map((s) => s.globId));
  }

  private async command(
    email: string | null,
    id: string,
    expectedVersion: number | null,
    step: Step,
    options: CommandOptions = {},
  ): Promise<Result<Glob>> {
    for (let attempt = 0; ; attempt++) {
      let result: Result<Glob> | 'retry';
      try {
        result = await this.commandOnce(email, id, expectedVersion, step, options);
      } catch (e) {
        if (!(e instanceof RelationWriteLost)) throw e;
        // The relation rows written before the lost race were rolled back with the transaction.
        if (expectedVersion === null) result = 'retry';
        else {
          const current = await this.deps.store.transaction((tx) => tx.getGlob(id));
          result = current === null ? notFound(`No glob ${id}`) : err({ code: 'version_conflict', message: 'The glob has changed', current });
        }
      }
      if (result === 'retry') {
        if (attempt < EVENT_RETRIES) continue;
        throw new Error(`Could not apply event to ${id} after ${EVENT_RETRIES} retries`);
      }
      if (result.ok) this.publish(result.value);
      return result;
    }
  }

  private async commandOnce(
    email: string | null,
    id: string,
    expectedVersion: number | null,
    step: Step,
    options: CommandOptions,
  ): Promise<Result<Glob> | 'retry'> {
    return this.deps.store.transaction(async (tx): Promise<Result<Glob> | 'retry'> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      let actor: Actor | null = null;
      if (email !== null) {
        const found = await this.actorFor(tx, email, glob.boardId);
        if (!found.ok) return found;
        actor = found.value;
      }
      if (expectedVersion !== null && glob.version !== expectedVersion) {
        return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      }
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      // No work command (start, merge, labels, retrigger...) may run on human work, and no decision or action step on anything else.
      const applies = options.applies ?? 'work';
      if (applies !== 'any' && (applies === 'work' ? isHumanCategory(glob.category) : glob.category !== applies)) {
        return err({
          code: 'invalid_transition',
          message: isHumanCategory(glob.category)
            ? `${glob.category === 'action' ? 'An action' : 'A decision'} glob has no such action`
            : `Only ${applies === 'action' ? 'an action' : 'a decision'} glob can do this`,
          status: glob.status,
          allowedActions: actor === null ? [] : machine.allowedActions(glob, actor),
        });
      }
      if (options.prepare !== undefined) {
        const prepared = await options.prepare(tx, glob);
        if (!prepared.ok) return prepared;
      }
      // Relation changes are planned under the board's lock, with every relation of the board in view, before the step runs.
      let write: RelationWrite = NO_WRITE;
      let rows: readonly Relation[] | null = null;
      let inserted: readonly Relation[] = [];
      if (options.relationPlan !== undefined) {
        await tx.lockBoardRelations(glob.boardId);
        const board = await tx.listRelations(glob.boardId);
        const planned = await options.relationPlan(tx, glob, board, this.deps.clock.now());
        if (!planned.ok) return planned;
        write = planned.value;
        const applied = applyWrite(board.filter((r) => r.from === glob.id), write, { boardId: glob.boardId, from: glob.id, now: this.deps.clock.now(), newId: () => this.relationId() });
        rows = applied.relations;
        inserted = applied.inserted;
      }
      const summaries = options.facts === true ? await tx.listArtifactSummaries(glob.boardId, [glob.id]) : [];
      const record = options.facts === true
        ? { recordSha: machine.recordShaOf(summaries), reviews: machine.reviewsOf(summaries) }
        : {};
      const relations =
        options.relations === true
          ? { relations: await this.relationFacts(tx, rows ?? (await tx.listRelationsFrom([glob.id]))) }
          : {};
      const rollout =
        options.rollout === true
          ? { rollout: storedBlockProgress(await tx.listHumanSteps(glob.boardId, [glob.id]), 'sign_off') }
          : {};
      const facts: ActionFacts = { ...record, ...relations, ...rollout };
      const ctx = await this.context(actor, board, options.triggeredByCreator === true ? glob.creator : undefined);
      const stepped = step(glob, ctx, board, facts);
      if (!stepped.ok) return stepped;
      // The relation rows are written only now that the step accepted: an error Result commits what was written before it.
      const edits = stepped.value.relationEdits ?? [];
      const written = !isEmptyWrite(write) || edits.length > 0;
      let transition: Result<Transition> = stepped;
      if (written) {
        const before = await tx.listRelationsFrom([glob.id]);
        // Removals first: a person's relation replacing an inferred one to the same glob would otherwise find the row taken.
        for (const rid of write.remove) await tx.deleteRelation(rid);
        for (const u of write.update) await tx.updateRelation(u.id, u.patch);
        for (const r of inserted) {
          if (!(await tx.insertRelation(r))) throw new Error(`Relation from ${glob.id} to ${r.to} already exists`);
        }
        for (const e of edits) await tx.updateRelation(e.id, { overriddenAt: e.overriddenAt });
        const logged = relationEvents(glob.id, ctx.actor?.email ?? null, ctx.now, before, write, inserted);
        // A change to the relations alone still moves the glob's version, so live updates and stale forms see it.
        const touched = machine.relationsChanged(stepped.value.glob, ctx);
        transition = stepped.value.changed || !touched.ok ? stepped : ok({ ...stepped.value, glob: touched.value.glob, changed: true });
        if (transition.ok) transition = ok({ ...transition.value, events: [...transition.value.events, ...logged] });
      }
      if (!transition.ok) return transition;
      const { changed, events } = transition.value;
      // A status change, a push or a merge may change which open globs overlap: queue the board's recheck (coalesced).
      const moved =
        changed && (transition.value.glob.status !== glob.status || events.some((e) => e.type === 'CommitPushed' || e.type === 'Merged'));
      // A work glob signed off is a recent change on the board's knowledge page (decisions queue their own).
      const signedOff = changed && !isHumanCategory(glob.category) && glob.status !== 'signed_off' && transition.value.glob.status === 'signed_off';
      const effects = [...transition.value.effects, ...(moved ? [recheckOverlapsEffect(glob.boardId)] : []), ...(signedOff ? [knowledgePageEffect(glob.boardId)] : [])];
      if (!changed) {
        await tx.appendEvents(events);
        await tx.enqueueEffects(effects);
        return ok(glob);
      }
      const next = { ...transition.value.glob, version: glob.version + 1 };
      if (!(await tx.updateGlob(next, glob.version))) {
        // Relation rows already written would commit with an error Result: throw to roll them back.
        if (written) throw new RelationWriteLost();
        if (expectedVersion !== null) {
          const current = await tx.getGlob(id);
          return current === null
            ? notFound(`No glob ${id}`)
            : err({ code: 'version_conflict', message: 'The glob has changed', current });
        }
        return 'retry';
      }
      await tx.appendEvents(events);
      await tx.enqueueEffects(effects);
      if (options.record !== undefined) await options.record(tx, glob, next, actor);
      return ok(next);
    });
  }

  private relationId(): string {
    return `rel_${this.deps.ids.runId()}`;
  }

  /** Inserts the relations of a glob created in this transaction, with an event each. */
  private async writeNew(tx: Tx, glob: Glob, inserted: readonly Relation[], actor: string | null, at: string): Promise<void> {
    for (const r of inserted) {
      if (!(await tx.insertRelation(r))) throw new Error(`Relation from ${glob.id} to ${r.to} already exists`);
    }
    if (inserted.length > 0) await tx.appendEvents(inserted.map((r) => relationAdded(r, actor, at)));
  }

  private publish(glob: Glob): void {
    const hint: Hint = { kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: glob.version };
    this.deps.notifier.publish(hint);
  }

  private async actorFor(tx: Tx, email: string, boardId: number): Promise<Result<Actor>> {
    const user = await tx.getUser(email);
    if (user === null || !user.active) return forbidden('Your account is not active in slop');
    const member = await tx.getMember(boardId, email);
    if (member === null) return forbidden(`You are not a member of board ${boardId}`);
    return ok({ email, role: member.role });
  }

  private async context(actor: Actor | null, board: Board, triggeredBy?: string): Promise<Context> {
    const now = this.deps.clock.now();
    // Only the actor (or, for a system step that starts a run for someone, that person) triggers a run, so resolve
    // their routine owner up front.
    const who = actor?.email ?? triggeredBy ?? null;
    let owner = who ?? board.defaultRoutineOwner ?? '';
    if (who !== null && !(await this.deps.routines.hasRoutine(who, board.id))) {
      owner = board.defaultRoutineOwner ?? who;
    }
    return {
      actor,
      now,
      newRunId: () => this.deps.ids.runId(),
      routineOwnerFor: () => owner,
    };
  }
}
