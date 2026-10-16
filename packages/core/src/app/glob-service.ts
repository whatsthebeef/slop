import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { canChooseType, CHOOSE_TYPE_REFUSAL } from './access.js';
import { isLearning } from '../domain/learning.js';
import { validateScopeEdit } from '../domain/attributes.js';
import type { ActionRecordKind } from '../domain/attributes.js';
import { groupFromTitle, normaliseGroup } from '../domain/group.js';
import { inGroup } from '../domain/group-view.js';
import { formatId, letterFor } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import { listOf } from '../domain/matrix.js';
import { HUMAN_STEP_BLOCKS, HUMAN_STEP_KINDS, PREDICTED_ROLLOUT_TITLE, defaultStepBlocks, environmentOf, humanSteps, isHumanStepDue, isMerged, openRolloutSteps, stateOf, storedBlockProgress, unknownEnvironmentText } from '../domain/human-steps.js';
import { maskSecrets, maskedNote } from '../domain/mask-secrets.js';
import { armView, rolloutWhen } from '../domain/rollout-stages.js';
import type { Arm } from '../domain/rollout-stages.js';
import { dueSinceFor, markStepsDue } from './step-due.js';
import { isCapabilityName } from '../domain/capabilities.js';
import type { Capabilities } from '../domain/capabilities.js';
import { ROLLOUT_NONE_LABEL, ROLLOUT_NONE_PREFIX, ROLLOUT_NOT_WRITTEN_TITLE, ROLLOUT_PATHS_ORIGIN, ROLLOUT_SCRIPT_KIND, ROLLOUT_SECTION_ORIGIN, matchStoredTitles, parseRollout, rolloutScriptLabel } from '../domain/rollout.js';
import type { RolloutAnswer, RolloutStep } from '../domain/rollout.js';
import type { HumanStep, HumanStepBlock, HumanStepKind, HumanStepScript, StoredHumanStep } from '../domain/human-steps.js';
import type { ActionFacts, Context, CreateInput, FieldChanges, LabelCommand, Transition } from '../domain/machine.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import type { Artifact, ArtifactSummary, Provenance } from '../domain/knowledge.js';
import { HANDOVER_LABEL, handoverMarkdown, mergedPickUpNotice } from '../domain/handover.js';
import type { Handover } from '../domain/handover.js';
import type { Actor, Board, Category, Escalation, Glob, ImpliedAfter, InferenceSource, LabelName, Relation, RelationGate, RelationUntil, SlopType, WorkKind } from '../domain/types.js';
import { parseWorkstreams, summariseWorkstreams } from '../domain/workstreams.js';
import type { WorkstreamsSummary } from '../domain/workstreams.js';
import { mergeImplied } from '../domain/exclusive-paths.js';
import type { DependencyInferenceService, InferredEdge } from './dependency-inference-service.js';
import { deleteObjectEffect, knowledgePageEffect, recheckOverlapsEffect, writeRolloutEffect } from '../domain/events.js';
import type { DomainEvent } from '../domain/events.js';
import type { PendingEffect } from '../domain/machine-steps.js';
import { areasMatching, defaultAreas, matchRiskAreas, splitEvidence, subSafe } from '../domain/risk-area.js';
import { doThisCommands, scriptPathOf } from '../domain/action-script.js';
import type { ActionScript, ScriptCheck } from '../domain/action-script.js';
import type { CodeView } from './code-view.js';
import { CodeViewUnavailable } from '../domain/code-view.js';
import { MAX_AFTER, MAX_RELATIONS, NO_RELATIONS, UNTIL_WORDS, defaultUntil, NO_WRITE, applyWrite, doneOf, draftOf, awaitedOf, checkRelation, checkRelationShape, hasMerged, holdingOf, isActive, verdictOf, isEmptyWrite, isExplicit, isMet, normaliseUntil, pickUpWarning, relationUniverse, startIds, OTHER_BOARD_GLOB, toState, wouldCycle } from '../domain/relations.js';
import type { AwaitedDependency, DoneRelation, ExternalGlob, HeldBack, Holding, NewRelation, RelationFacts, RelationsView, RelationWrite, Supersession, TitleInfo, ToState, WeakRelation } from '../domain/relations.js';
import { globIdsIn, idSentences, sentenceHash } from '../domain/relation-scan.js';
import type { AutomaticAdd, AutomaticRelations, AutomaticResult, MentionOrigin, RelationListExtras, RelationScanRow, RelationSuggestion } from '../domain/relation-scan.js';
import { suggestionIdOf } from '../domain/relation-scan.js';
import { appendClarification, planChangedQuestion, questionAwaits } from '../domain/questions.js';
import type { NewQuestion, OpenQuestion } from '../domain/questions.js';
import type { InboxItem } from '../domain/inbox.js';
import type { IntakeRecord, SnapshotSource } from '../domain/intake-learning.js';
import type { BranchFiles, Clock, Embedder, GlobFilter, Hint, IdGenerator, Notifier, RoutineDirectory, Store, Tx } from '../ports.js';
import { DECISIONS_LABEL, decisionsAttachment } from '../domain/decision-glob.js';
import { ACTION_PLAN_TEMPLATE, actionOf, actionState, preparationOf } from '../domain/action-glob.js';
import { defaultFix, isFromMention, defaultWorkKind, fixOf, isCodeGlob, isHumanCategory, storedCategory, workKindOf } from '../domain/types.js';
import { addArtifact, governingDecisions, handoverOf } from './artifact-service.js';
import { readMergePolicy } from './knowledge-service.js';
import { subGateCheckOf } from '../domain/merge-policy.js';
import { fileKeysOf } from './attachment-service.js';
import { DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import { AttachConflict, linkInboxItem } from './inbox-service.js';
import { findHolds } from './hold-service.js';
import { recordTypeCorrection } from './type-learning-service.js';
import type { DependencyLearningService } from './dependency-learning-service.js';
import type { RelationLearningService } from './relation-learning-service.js';
import { isWeak } from '../domain/relation-learning.js';
import type { ClassifyAtCreateInput, CreateDecision, CreatePrerequisite } from './relation-scan-service.js';
import { embedRequest, snapshotOf } from './intake-learning-service.js';
import { inferenceReasonOf } from './intake-service.js';
import { pickEnvironment } from '../domain/environment-pick.js';
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
  /** How readily slop creates gating relations on this board, learned from overrides, dismissals and collisions; absent: every source gates. */
  readonly relationLearning?: RelationLearningService;
  /** Infers a new glob's needs and overlaps from its plan and the open globs; without it a glob has only the edges it was given. */
  readonly inference?: Pick<DependencyInferenceService, 'infer'>;
  /** Reads a file on the board's base branch, for the script an action runs; without it no script is checked. */
  readonly codeView?: Pick<CodeView, 'read'>;
  /** Where a best-effort side task reports its failure (the server's error log). */
  readonly log?: (task: string, message: string) => void;
  /** The automatic relation pass: told what text a glob gained, so it can look for prerequisites in it (queued and debounced there). */
  readonly relationScan?: RelationScanTrigger;
}

/** What `GlobService` tells the automatic relation pass: a glob gained text that may name other globs (best effort, never throws into a write). */
export interface RelationScanTrigger {
  request(input: { readonly globId: string; readonly newText: string }): Promise<void> | void;
  /** The create-time path (`RelationScanService.classifyAtCreate`): the prerequisites a new glob's text states, decided before it is written. Never throws. */
  classifyAtCreate?(input: ClassifyAtCreateInput): Promise<{ readonly prerequisites: readonly CreatePrerequisite[]; readonly decided: readonly CreateDecision[] }>;
  /** Remembers what `classifyAtCreate` decided under the new glob's ID, so the pass the create queues does not ask again. Never throws. */
  remember?(globId: string, boardId: number, decided: readonly CreateDecision[]): Promise<void>;
}

/** The attachment that carries answers to questions (agents read it in `get_context`). */
export const CLARIFICATIONS_LABEL = 'Clarifications';

/** A question to raise: `blocking` and `source` are chosen by the caller; `runId` is the routine run raising it. */
export type RaiseQuestionInput = NewQuestion & { readonly runId?: string | null };

/** What raising a question did: the question (null when it was ignored or is not stored), and whether a start hold was downgraded to a notice. */
export interface RaisedQuestion {
  readonly glob: Glob;
  readonly question: OpenQuestion | null;
  readonly ignored: string | null;
  readonly downgraded: boolean;
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
  /** `rolled_out` is another way to write `merged` (a merged glob's open rollout steps keep the relation holding). */
  readonly until?: RelationUntil | 'rolled_out';
  readonly reason?: string | null;
  /** Set when the relation is one of a group-wide decision's (see `holdGroup`): the group it was set for. */
  readonly group?: string | null;
}

/** A glob the new one holds back: `gate` (default sign_off) can't pass until the new glob reaches `until` (default merged). A bare ID takes the defaults. */
export interface HoldInput {
  readonly id: string;
  readonly gate?: RelationGate;
  readonly until?: RelationUntil | 'rolled_out';
  readonly reason?: string | null;
}

/** A glob the new (or edited) one makes obsolete: the row lands on it, saying it is superseded. A bare ID has no reason. */
export interface SupersedeInput {
  readonly id: string;
  readonly reason?: string | null;
}

/** Whether a glob is already past a gate, so a relation on that gate holds nothing: started, merged or signed off. */
const pastGate = (glob: Glob, gate: RelationGate): boolean =>
  gate === 'start' ? glob.status !== 'planning' : gate === 'merge' ? hasMerged(glob) : glob.status === 'signed_off';

/** How long a script check is trusted when no push to the base branch arrives (webhooks are best effort). */
const SCRIPT_CACHE_MS = 5 * 60 * 1000;
/** A script not found is trusted only briefly: right after a push the local clone may not have fetched it yet. */
const SCRIPT_MISSING_CACHE_MS = 15 * 1000;

/** The facts the machine reads about an action's script. */
/** The label prefix of the attachment a failed action run is kept in (`Action run failed (round N)`): the next round reads it. */
export const ACTION_FAILURE_LABEL = 'Action run failed';

const scriptFacts = (check: ScriptCheck | null): { readonly script?: ActionScript; readonly baseBranch?: string } =>
  check === null ? {} : { script: check.script, baseBranch: check.baseBranch };

/** The longest reason a relation keeps. */
export const MAX_RELATION_REASON = 300;

/** How many relations beyond a board's own the cycle check reads across boards before it refuses. */

/** Who stated the relations of a request: the source they are recorded with. */
export type RelationsBy = 'person' | 'agent' | 'mention';

/** Whether relations stated by this source must carry a one-line reason (people are prompted in the web, never blocked). */
const needsReason = (by: RelationsBy): boolean => by === 'agent' || by === 'mention';

/** The refusal for an agent's relation without a reason. */
const reasonRefusal = (to: string): Result<never> =>
  invalidInput(
    `Relation to ${to} needs a one-line reason: name the file or symbol this glob uses from it, or why it must wait. Pass \`reason\` (shorthand for needs/after) or \`relations: [{to, reason}]\`.`,
  );

/** The name other boards' globs go by for a viewer who can't see them. */
export const OTHER_BOARD = 'another board';
const OTHER_BOARD_WAIT = 'Waits for a glob on another board';

/** Whether a relation (given only its gate and until) still holds back with the target in `state`: the one rule every drop site shares. */
const stillHolds = (n: Pick<NewRelation, 'gate' | 'until'>, state: ToState | undefined): boolean =>
  !isMet(draftOf(0, '', { to: '', gate: n.gate, until: n.until, reason: null, evidence: [], source: 'person' }), state ?? 'missing');

/** Why a start relation to a target in `state` was left out. */
const ignoredWhy = (id: string, state: ToState | undefined): string =>
  state === 'missing' || state === undefined ? `${id} no longer exists` : state === 'done' ? `${id} is done` : state === 'signed_off' ? `${id} is signed off` : state === 'decided' ? `${id} is decided` : `${id} is ${UNTIL_WORDS.merged}`;

/** What the create paths return: the glob, the start relations left out and why, and a note when the type changed. */
interface Created {
  readonly glob: Glob;
  readonly ignoredAfter: readonly { readonly id: string; readonly why: string }[];
  readonly typeNote: string | null;
}

/** The `until` a relation names (`rolled_out` is `merged`), else the default for what it points at. */
const untilFor = (given: RelationUntil | 'rolled_out' | undefined, target: Pick<Glob, 'category'>): Result<RelationUntil> => {
  if (given === undefined) return ok(defaultUntil(target));
  const until = normaliseUntil(given);
  return until === null ? invalidInput(`Unknown until ${given}: use merged (or rolled_out), decided, done or signed_off`) : ok(until);
};

/** What `createWithNotes` says beside the glob: what it left out, how holds went and why the type changed. */
export interface CreateNotes {
  /** Start relations not recorded because the target no longer holds anything (merged and rolled out, done, deleted). */
  readonly ignoredAfter: readonly { readonly id: string; readonly why: string }[];
  /** One per `holds` entry: whether the relation on the other glob was written. */
  readonly holds: readonly { readonly id: string; readonly ok: boolean; readonly why: string }[];
  /** One per `supersedes` entry, likewise. */
  readonly supersedes: readonly { readonly id: string; readonly ok: boolean; readonly why: string }[];
  /** Set when a non-admin's untyped create became a same. */
  readonly typeNote: string | null;
}

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
  /**
   * Actions: a routine prepares what the person runs (a script, a policy file, a document) before they do. The first preparation
   * round starts at creation, or when the start relations it waits for have merged.
   */
  readonly prepare?: boolean;
  /** Actions with `prepare`: where the record lives (default `branch`); chosen here, because the routine can't change it mid-run. */
  readonly record?: ActionRecordKind;
  readonly autoTrigger: boolean;
  /** Accepted for compatibility and ignored: a super always waits in Planning until a person picks it up to pair. */
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
  /** Who states the relations (wins over `relationsBy`): agents and slop's automatic pass must give a reason for each. */
  readonly by?: RelationsBy;
  /** One line applied to every ID in `after` (and as the reason of each start relation named there). */
  readonly afterReason?: string | null;
  /** Existing globs, on any board, that this one holds back (a fix or follow-up): the relation is written on them after the create commits. */
  readonly holds?: readonly (HoldInput | string)[];
  /** Existing globs this one makes obsolete: each carries a "superseded by" row, and its open steps are dismissed. */
  readonly supersedes?: readonly (SupersedeInput | string)[];
  /** Files intake guessed the work changes (advisory: with the plan, they decide whether exclusive paths hold it). */
  readonly files?: readonly string[];
  /** What intake saw and decided, for the glob's snapshot; absent when intake didn't run. */
  readonly intake?: IntakeRecord | null;
  /** Where the glob is created from, for the snapshot when intake didn't run (default: `api`). */
  readonly source?: SnapshotSource;
  /** An inbox item of the board to attach to the new glob in the same transaction; refused when it is another board's or discarded. */
  readonly inboxItem?: number;
  /** Doubts raised with the glob (intake's): a start-blocking one creates it held, with no run, whatever its type. */
  readonly questions?: readonly NewQuestion[];
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

/** The letter inputs of a code glob being created: the fix flag and work kind it was given, else its asked category's (before `feature` is stored as a task). */
const inferredOf = (
  input: Pick<CreateGlobInput, 'category' | 'fix' | 'workKind'>,
  type: SlopType,
): { actor: 'machine'; mode: SlopType; fix: boolean; workKind: WorkKind } => ({
  actor: 'machine',
  mode: type,
  fix: input.fix ?? defaultFix(input.category),
  // Read from the asked category: a `feature` is R&D even though it is stored as a task (the letter ignores the work kind).
  workKind: input.workKind ?? defaultWorkKind(input.category),
});

/** A split part's fix flag and work kind: its own, else the original's when the category stays, else the category's defaults. */
const partInference = (
  original: Glob,
  part: SplitPart,
): { actor: 'machine'; mode: SlopType; fix: boolean; workKind: WorkKind } => {
  const sameCategory = part.category === undefined || storedCategory(part.category) === storedCategory(original.category);
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

const NO_IDS: ReadonlySet<string> = new Set();
/** Events are stored once and read by every member of the holder's board: a glob on another board is named by a stub there. */
const eventName = (id: string, external: ReadonlySet<string>): string => (external.has(id) ? OTHER_BOARD_GLOB : id);

/** The event on `from` for a relation that was added. */
const relationAdded = (r: Relation, actor: string | null, at: string, external: ReadonlySet<string> = NO_IDS, origin?: MentionOrigin): DomainEvent => {
  const to = eventName(r.to, external);
  return {
    type: 'RelationAdded',
    globId: r.from,
    actor,
    at,
    data: {
      to,
      gate: r.gate,
      until: r.until,
      source: r.source,
      reason: r.reason,
      ...(r.kind === 'may_relate' ? { weak: true } : {}),
      // A mention's row says where the sentence was read: "added relation to s15t246 from a mention in the plan".
      ...(origin === undefined || !isFromMention(r.source) ? {} : { from: origin, note: `added relation to ${to} from a mention in the ${origin}` }),
    },
  };
};

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
  external: ReadonlySet<string> = NO_IDS,
): DomainEvent[] => {
  const known = (id: string): Relation | undefined => before.find((r) => r.id === id);
  const events: DomainEvent[] = [];
  for (const r of write.remove) {
    const gone = known(r);
    if (gone !== undefined) events.push({ type: 'RelationReleased', globId: from, actor, at, data: { to: eventName(gone.to, external), gate: gone.gate, reason: 'removed' } });
  }
  for (const r of inserted) events.push(relationAdded(r, actor, at, external, write.origin));
  for (const u of write.update) {
    const was = known(u.id);
    if (was !== undefined && u.patch.dismissedAt != null) {
      events.push({ type: 'RelationDismissed', globId: from, actor, at, data: { to: eventName(was.to, external), edgeId: eventName(was.to, external), gate: was.gate, source: was.source, planHash: u.patch.dismissedPlanHash ?? null } });
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
  /** Who states the relations (wins over `relationsBy`). */
  readonly by?: RelationsBy;
  /** One line applied to every ID in `after`. */
  readonly afterReason?: string | null;
  /** Globs this one makes obsolete (applied after the change; a failure is returned as the error). */
  readonly supersedes?: readonly (SupersedeInput | string)[];
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

export interface GlobView extends RelationListExtras {
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
  /** Open rollout steps holding back sign-off (`openRolloutSteps`): the one count the views read, so none re-derives it from the steps. */
  readonly rolloutSteps?: number;
  /** The stage the "Arm system" label names (the first environment with an open rollout step), null when no step is open. */
  readonly arm: Arm | null;
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

/** One row of the board list: the glob, its artifact summaries, its relations and what holds it, plus who waits for it and open suggestions when there are any. */
export interface ListedGlobRow extends RelationListExtras {
  readonly glob: Glob;
  readonly artifacts: ArtifactSummary[];
  readonly relations: RelationFacts;
  readonly holding: Holding[];
}

// What a viewer sees of a relation to a glob on another board: a member of that board sees its name, anyone else a stub.
const holdingView = (h: Holding, e: ExternalGlob | undefined): Holding =>
  e === undefined ? h : e.hidden ? { ...h, to: OTHER_BOARD, toTitle: null, toIsDecision: false, toIsAction: false, state: 'open', external: e } : { ...h, external: e };
const awaitedView = (a: AwaitedDependency, e: ExternalGlob | undefined): AwaitedDependency =>
  e?.hidden === true ? { id: OTHER_BOARD, state: 'open', why: OTHER_BOARD_WAIT } : a;
const doneView = (d: DoneRelation, e: ExternalGlob | undefined): DoneRelation => (e?.hidden === true ? { ...d, to: OTHER_BOARD, toTitle: null } : d);
/** The relations as a viewer sees them: a hidden other-board `to` is the opaque name (rows that no longer hold are left out), its state `open`. */
const factsView = (facts: RelationFacts, external: ReadonlyMap<string, ExternalGlob>): RelationFacts => {
  if (![...external.values()].some((e) => e.hidden)) return facts;
  const states = new Map(facts.states);
  const relations = facts.relations.flatMap((r): Relation[] => {
    if (external.get(r.to)?.hidden !== true) return [r];
    if (isMet(r, facts.states.get(r.to) ?? 'missing')) return [];
    states.set(OTHER_BOARD, 'open');
    return [{ ...r, to: OTHER_BOARD }];
  });
  return { relations, states };
};

/** A stored open question as the card's suggestion: only a failed step asks one now (a mentioned glob becomes a relation instead). */
const suggestionView = (row: RelationScanRow): RelationSuggestion => ({
  id: suggestionIdOf(row),
  kind: 'step_failed',
  text: row.sentence,
  mentioned: null,
  ...(row.gate === null ? {} : { gate: row.gate }),
  stepId: row.mentionedId,
});

/** A dismissal key is opaque to the server; the web builds it from the situation (see `lib/dismissals.ts`). */
const DISMISSAL_KEY = /^[\w:.+@/-]{1,200}$/;

/** Artifacts in a stable order: by kind (plan first), then label. */
const byKind = (a: ArtifactSummary, b: ArtifactSummary): number =>
  ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label);

const stepFields = (s: Pick<StoredHumanStep, 'detail' | 'check' | 'script' | 'why' | 'permissions' | 'commands' | 'verify' | 'due' | 'blocks'>) =>
  [s.detail, s.check, s.script, s.why, s.permissions, s.commands, s.verify, s.due, s.blocks];

type Step = (glob: Glob, ctx: Context, board: Board, facts: ActionFacts) => Result<Transition>;

/** A work step as a person or agent writes it; what is left out gets the kind's defaults. */
export interface NewHumanStep {
  readonly title: string;
  readonly kind?: HumanStepKind;
  readonly detail?: string;
  readonly who?: string;
  readonly due?: string;
  /** A one-shot command inside the change (`due: 'once'`): it has no environment and is never reopened. */
  readonly once?: boolean;
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
  /** Read the work steps holding back sign-off into `facts.rollout`, and how many real rollout steps are open into `facts.rolloutSteps`. */
  readonly rollout?: boolean;
  /** Runs before the step: checks input against the store. */
  readonly prepare?: (tx: Tx, glob: Glob) => Promise<Result<null>>;
  /** A system step that starts a run on someone's behalf: the glob's creator triggers it. */
  readonly triggeredByCreator?: boolean;
  /**
   * Which globs the step applies to: work globs (the default), decision globs only, or either (pick-up, field edits). `prepared`:
   * work globs and prepared actions (the PR commands an action's branch record uses); a plain action or a decision is refused.
   */
  readonly applies?: 'work' | 'prepared' | 'decision' | 'action' | 'any';
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
export class GlobService implements AutomaticRelations {
  constructor(private readonly deps: GlobServiceDeps) {}

  /** Whether the base branch has an action's script, by board and path; see `scriptCheckFor`. */
  private readonly scriptCache = new Map<string, { readonly onBase: boolean | null; readonly at: number }>();

  // -------------------------------------------------------------------------
  // Reads

  async get(email: string, id: string): Promise<Result<GlobView>> {
    // Read before the transaction: it asks the code host.
    const check = await this.scriptCheckFor(id);
    const onBranch = await this.onceScriptsOnBranch(id);
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const artifacts = (await tx.listArtifactSummaries(glob.boardId, [glob.id])).sort(byKind);
      const relations = await this.relationFacts(tx, await tx.listRelationsFrom([glob.id]));
      const sizeCheck = await tx.getSizeCheck(glob.id);
      const stored = await tx.listHumanSteps(glob.boardId, [glob.id]);
      const rolloutSteps = openRolloutSteps(stored);
      const facts = { recordSha: machine.recordShaOf(artifacts), reviews: machine.reviewsOf(artifacts), relations, rolloutSteps, rollout: storedBlockProgress(stored, 'sign_off'), ...scriptFacts(check) };
      const board = await tx.getBoard(glob.boardId);
      const known = (board?.environments ?? []).map((e) => e.name);
      // A step that waits for an environment the board doesn't define can never fall due: flag it so the view offers to dismiss it.
      // A prepared action ready to run shows the plan's commands (and its stored script's name) in the step the person acts on.
      const readyAction = actionState(glob) === 'ready';
      const actionPlan = readyAction ? ((await tx.listArtifacts(glob.id, 'plan'))[0]?.content ?? null) : null;
      const actionArtifactLabel = readyAction ? ((await tx.listArtifacts(glob.id, ROLLOUT_SCRIPT_KIND))[0]?.label ?? null) : null;
      const steps = humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, facts), rolloutSteps, ...(onBranch === undefined ? {} : { scriptsOnBranch: onBranch }), ...(readyAction ? { actionPlan, actionArtifactLabel } : {}) }, stored).map((step) => {
        const environment = step.state === 'done' || step.state === 'dismissed' ? null : environmentOf(step.due);
        return environment !== null && board !== null && !known.includes(environment) ? { ...step, unknownEnvironment: environment } : step;
      });
      // What the viewer may see of globs on other boards: the others' ids and titles are left out for a non-member.
      const seen = await this.seeOthers(tx, email, glob.boardId, [...new Set(relations.relations.map((r) => r.to))]);
      const waited = await this.waitedOnBy(tx, glob.id, email);
      const groups = await this.relationGroupsOf(tx, glob, relations, email, seen);
      const suggestions = await this.suggestionsOf(tx, [glob.id]);
      return ok({
        glob,
        allowedActions: machine.allowedActions(glob, actor.value, facts),
        artifacts,
        relations: factsView(relations, seen.external).relations,
        waitingFor: awaitedOf({ relations: relations.relations, states: relations.states }).map((a) => awaitedView(a, seen.external.get(a.id))),
        waitedOnBy: waited.ids,
        holding: holdingOf({ relations: relations.relations, states: seen.reach.states }, titlesOf(seen.reach.globs)).map((h) => holdingView(h, seen.external.get(h.to))),
        relationGroups: waited.other > 0 ? { ...groups, waitedOnByOtherBoards: waited.other } : groups,
        ...((suggestions.get(glob.id)?.length ?? 0) > 0 ? { suggestions: suggestions.get(glob.id) } : {}),
        sizeCheck,
        humanSteps: steps,
        rolloutSteps,
        arm: board === null ? null : armView(steps, board),
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
      // A prepared action runs its own script from its branch or artifact: only a plain action waits for a script another glob builds.
      if (glob?.category !== 'action' || glob.status !== 'planning' || preparationOf(glob) !== null) return null;
      const board = await tx.getBoard(glob.boardId);
      return board === null ? null : { glob, baseBranch: board.baseBranch, plan: (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '' };
    });
    if (read === null) return null;
    return this.checkScript(read.glob.boardId, read.baseBranch, scriptPathOf(read.plan));
  }

  /**
   * The repo paths of the glob's open once steps' scripts that its branch has, for the steps' due-ness (a once step falls due when its
   * script is on the branch). Undefined when nothing was checked: no code host, a merged glob (the script is on the base branch), no
   * script to look for, or a code host that can't answer. A once step is then due, so a check slop could not make never holds a person up.
   */
  async onceScriptsOnBranch(id: string): Promise<ReadonlySet<string> | undefined> {
    const view = this.deps.codeView;
    if (view === undefined) return undefined;
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null || isMerged(glob) || glob.pr === null) return null;
      const paths = (await tx.listHumanSteps(glob.boardId, [id])).flatMap((s) => (s.state === 'open' && s.due === 'once' && s.script !== null && 'path' in s.script ? [s.script.path] : []));
      return paths.length === 0 ? null : { boardId: glob.boardId, ref: glob.id, paths };
    });
    if (read === null) return undefined;
    try {
      const found = await Promise.all(read.paths.map(async (path) => ((await view.read(read.boardId, read.ref, path)) === null ? null : path)));
      return new Set(found.filter((p): p is string => p !== null));
    } catch (e) {
      if (!(e instanceof CodeViewUnavailable)) this.deps.log?.('once step script check', e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  /** The script checks of a board's open actions, by glob. */
  async scriptChecksOf(boardId: number): Promise<Map<string, ScriptCheck>> {
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      const open = (await tx.listGlobs(boardId, { status: ['planning'], include: 'all' })).filter((g) => g.category === 'action' && preparationOf(g) === null);
      return { board, plans: await Promise.all(open.map(async (g) => ({ id: g.id, plan: (await tx.listArtifacts(g.id, 'plan'))[0]?.content ?? '' }))) };
    });
    const found = new Map<string, ScriptCheck>();
    if (read.board === null) return found;
    const baseBranch = read.board.baseBranch;
    const checks = await Promise.all(read.plans.map(async ({ id, plan }) => ({ id, check: await this.checkScript(boardId, baseBranch, scriptPathOf(plan)) })));
    for (const { id, check } of checks) if (check !== null) found.set(id, check);
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
      // Cached briefly too, so a down host costs one failing read per path, not one per list load.
      this.scriptCache.set(key, { onBase: null, at: now });
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
    const open = (await this.peekAll(boardId, { status: ['planning'], include: 'all' })).filter((g) => g.category === 'action' && preparationOf(g) === null);
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
   * alone). A rollout step defaults to falling due after the merge and holding back sign-off and dependants; one that
   * waits for a deploy (`after_deploy:<env>`) holds nothing back unless it says so.
   */
  async addHumanStep(email: string, id: string, version: number | null, input: NewHumanStep, origin = 'person'): Promise<Result<StoredHumanStep>> {
    const title = input.title.trim();
    if (title === '') return invalidInput('A step needs a title');
    const kind = input.kind ?? 'rollout';
    if (!HUMAN_STEP_KINDS.includes(kind)) return invalidInput(`Unknown step kind ${kind}`);
    const due = input.due ?? (input.once === true ? 'once' : kind === 'rollout' ? 'after_merge' : 'now');
    if (!isHumanStepDue(due)) return invalidInput(`Unknown due ${due}: use now, after_merge, once or after_deploy:<env>`);
    if (input.once === true && due !== 'once') return invalidInput('A once step has no environment and is not due after the merge or a deploy: leave `due` out, or use once');
    const blocks = input.blocks ?? (kind === 'rollout' ? defaultStepBlocks(due) : []);
    const unknown = blocks.find((b) => !HUMAN_STEP_BLOCKS.includes(b));
    if (unknown !== undefined) return invalidInput(`Unknown block ${unknown}: use ${HUMAN_STEP_BLOCKS.join(', ')}`);
    const who = (input.who ?? 'anyone').trim();
    if (who === '') return invalidInput('A step needs someone it is for (or anyone)');
    const superseded = { now: false };
    const result = await this.deps.store.transaction(async (tx): Promise<Result<StoredHumanStep>> => {
      superseded.now = false;
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (version !== null && glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      // A step that waits for a deploy must name one of the board's environments, or it can never fall due.
      const environment = environmentOf(due);
      if (environment !== null) {
        const known = ((await tx.getBoard(glob.boardId))?.environments ?? []).map((e) => e.name);
        if (!known.includes(environment)) return invalidInput(unknownEnvironmentText(environment, known));
      }
      const now = this.deps.clock.now();
      const dueSince = await dueSinceFor(tx, glob, due, await tx.listHumanSteps(glob.boardId, [id]), now);
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
        dueSince,
      };
      await tx.saveHumanSteps([step]);
      await tx.appendEvents([{ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind, title, change: 'added' } }]);
      // A step added to a superseded glob is dismissed at once: it has nothing to do.
      const closed = await this.dismissForSupersession(tx, glob, email);
      superseded.now = closed.length > 0;
      return ok(closed.find((c) => c.id === step.id) ?? step);
    });
    if (result.ok) {
      await this.rolloutStepsWritten(id);
      this.deps.notifier.publish({ kind: 'glob.changed', boardId: result.value.boardId, globId: id, version: version ?? 0 });
      if (superseded.now) await this.afterStepsChanged(id);
      await this.requestScan(id, [title, input.why, input.detail].filter((t): t is string => t !== undefined && t.trim() !== '').join('\n'));
    }
    return result;
  }

  /**
   * Rollout steps that hold back sign-off now exist for the glob: it is merged with Merge and continue, never by itself. A sub
   * becomes a same and an armed merge is disarmed (`machine.rolloutStepsAdded`); nothing happens without open steps.
   */
  private async rolloutStepsWritten(id: string): Promise<void> {
    const open = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob !== null && openRolloutSteps(await tx.listHumanSteps(glob.boardId, [id])) > 0;
    });
    if (open) await this.command(null, id, null, (glob, ctx) => machine.rolloutStepsAdded(glob, ctx));
  }

  /**
   * Ticks a work step (records who and when), then lets the glob move on if it was the last one holding it back. An optional
   * `note` (what was checked, or done by hand) is masked and kept in the step's event only.
   */
  completeHumanStep(email: string, id: string, stepId: string, version: number | null, note?: string): Promise<Result<StoredHumanStep>> {
    return this.closeHumanStep(email, id, stepId, version, 'done', null, note);
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
    note?: string,
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
      const kept = note === undefined ? '' : maskedNote(note);
      await tx.appendEvents([{ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind: step.kind, title: step.title, change: to, ...(kept === '' ? {} : { note: kept }) } }]);
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

  /**
   * A rollout step failed after the merge (a member says so, with the output or a note): the glob's next generation starts,
   * on a fresh branch from the base with a new run (or the person's, when one implements it). The note is masked and capped,
   * and kept with the step's title and commands as an attachment, `Rollout step failed (generation N)` (N is the generation
   * that failed), which the next run reads as in-scope feedback. A done step is reopened; it is due again after the next merge.
   */
  async failRolloutStep(email: string, id: string, stepId: string, note: string, version: number | null): Promise<Result<Glob>> {
    const masked = maskedNote(note);
    const found: { step: StoredHumanStep | null; mergeSha: string | null } = { step: null, mergeSha: null };
    const result = await this.command(
      email,
      id,
      version,
      (glob, ctx) => {
        const step = found.step;
        if (step === null) return notFound(`No step ${stepId} on ${id}`);
        return machine.rolloutStepFailed(glob, { stepId, title: step.title, stepState: step.state, mergeSha: found.mergeSha }, ctx);
      },
      {
        prepare: async (tx, glob) => {
          found.step = (await tx.listHumanSteps(glob.boardId, [id])).find((s) => s.id === stepId) ?? null;
          if (found.step === null) return notFound(`No step ${stepId} on ${id}`);
          if (found.step.kind !== 'rollout') return invalidInput('Only a rollout step can be marked failed');
          if (found.step.due === 'once') return invalidInput('A once step is done once and never reopened: it cannot start the next generation');
          const merges = await tx.listBoardEvents(glob.boardId, '1970-01-01T00:00:00.000Z', ['Merged'], [id]);
          const sha = merges.sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.data.sha;
          found.mergeSha = typeof sha === 'string' ? sha : null;
          return ok(null);
        },
        record: async (tx, before, next) => {
          const step = found.step;
          if (step === null) return;
          const now = this.deps.clock.now();
          if (step.state === 'done' && step.due !== 'once') await tx.saveHumanSteps([{ ...step, state: 'open', doneBy: null, doneAt: null }]);
          const commands = step.commands.map((c) => maskSecrets(c));
          await addArtifact(tx, this.deps.clock, next, email, {
            kind: 'attachment',
            label: `Rollout step failed (generation ${before.generation})`,
            content: [
              `# Rollout step failed: ${step.title}`,
              `Generation ${before.generation} merged${found.mergeSha === null ? '' : ` as ${found.mergeSha}`}; ${email} reported this step failing when run from the base branch. Generation ${next.generation} fixes it: change what is needed so the step passes, and do not repeat the failed attempt. The step is due again once that generation merges.`,
              '## What was reported',
              masked === '' ? '(no note)' : masked,
              ...(commands.length === 0 ? [] : ['## The step\'s commands', ...commands.map((c) => `    ${c}`)]),
            ].join('\n\n'),
            link: null,
            commitSha: null,
            runId: null,
            agentSetVersion: null,
            reviewStats: null,
          });
          await tx.appendEvents([{ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind: step.kind, title: step.title, change: 'failed' } }]);
        },
      },
    );
    if (result.ok) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId: id });
    return result;
  }

  /**
   * A person (or an agent) reports that a work step was done and failed (a rollout that did not provision). The one entry for both
   * kinds of failure: a rollout step of a merged glob that is open for its rollout (`reviewing`, PR merged) starts the glob's next
   * generation (`failRolloutStep`; the caller drains the outbox) and the step comes back reopened. Any other step stays open, the
   * glob logs `HumanStepFailed` (the note masked), and one open card suggestion asks "is there a fix glob?" (no model call).
   * Reporting the same step again while the suggestion is open adds nothing. Version-checked when a version is given.
   */
  async failHumanStep(email: string, id: string, stepId: string, note: string, version: number | null): Promise<Result<StoredHumanStep>> {
    const route = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      const step = glob === null ? undefined : (await tx.listHumanSteps(glob.boardId, [id])).find((s) => s.id === stepId);
      return glob !== null && step?.kind === 'rollout' && step.due !== 'once' && glob.status === 'reviewing' && glob.pr?.state === 'merged';
    });
    if (route) {
      const next = await this.failRolloutStep(email, id, stepId, note, version);
      // The route was read in its own transaction: a glob that stopped being a merged one open for its rollout in between is
      // refused by the machine, and then takes the suggestion path below, as it would have.
      if (!next.ok && next.error.code !== 'invalid_transition') return next;
      if (next.ok) {
        const reopened = (await this.deps.store.transaction((tx) => tx.listHumanSteps(next.value.boardId, [id]))).find((s) => s.id === stepId);
        return reopened === undefined ? notFound(`No step ${stepId} on ${id}`) : ok(reopened);
      }
    }
    const result = await this.deps.store.transaction(async (tx): Promise<Result<StoredHumanStep>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (version !== null && glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
      const step = (await tx.listHumanSteps(glob.boardId, [id])).find((s) => s.id === stepId);
      if (step === undefined) return notFound(`No step ${stepId} on ${id}`);
      if (step.state !== 'open') return invalidInput(`The step "${step.title}" is already ${step.state}`);
      const now = this.deps.clock.now();
      await tx.appendEvents([{ type: 'HumanStepFailed', globId: id, actor: email, at: now, data: { stepId, title: step.title, note: maskedNote(note) } }]);
      const asked = (await tx.listOpenSuggestions([id])).some((r) => r.kind === 'step_failed' && r.mentionedId === stepId);
      if (!asked) {
        await tx.upsertRelationScans([
          {
            globId: id,
            mentionedId: stepId,
            sentenceHash: hash(`${stepId}|${now}`),
            boardId: glob.boardId,
            kind: 'step_failed',
            decision: 'suggested',
            gate: 'sign_off',
            reason: null,
            sentence: `This step failed: is there a fix glob? ${step.title}`,
            relationId: null,
            state: 'open',
            model: null,
            createdAt: now,
            decidedAt: null,
          },
        ]);
      }
      return ok(step);
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'glob.changed', boardId: result.value.boardId, globId: id, version: version ?? 0 });
    return result;
  }

  /**
   * A person answers the open question of a failed step (the only card suggestion left: a mentioned glob becomes a relation by itself).
   * `accept` is "link a glob" (`body.glob`: this glob can't be signed off until it merges, reason "fixes the failed step <title>");
   * `dismiss` is remembered: it is never asked again. Returns the glob.
   */
  async resolveSuggestion(
    email: string,
    id: string,
    suggestionId: string,
    action: 'accept' | 'dismiss',
    body: { readonly glob?: string | null } = {},
  ): Promise<Result<Glob>> {
    const read = await this.deps.store.transaction(async (tx): Promise<Result<{ glob: Glob; row: RelationScanRow; title: string | null }>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const row = (await tx.listOpenSuggestions([id])).find((r) => r.kind === 'step_failed' && suggestionIdOf(r) === suggestionId);
      if (row === undefined) return notFound(`No open suggestion ${suggestionId} on ${id}`);
      const title = (await tx.listHumanSteps(glob.boardId, [id])).find((s) => s.id === row.mentionedId)?.title ?? null;
      return ok({ glob, row, title });
    });
    if (!read.ok) return read;
    const { glob, row, title } = read.value;
    const settle = (patch: { readonly state: 'done' | 'dismissed'; readonly decision?: 'added' | 'not_prerequisite' }): Promise<void> =>
      this.deps.store.transaction((tx) => tx.updateRelationScan(row.globId, row.mentionedId, row.sentenceHash, { ...patch, decidedAt: this.deps.clock.now() }));
    if (action === 'dismiss') {
      await settle({ state: 'dismissed' });
      this.publish(glob);
      return ok(glob);
    }
    const fix = (body.glob ?? '').trim();
    if (fix === '') return invalidInput('Name the glob that fixes the failed step');
    const result = await this.addRelation(email, id, null, { to: fix, gate: 'sign_off', until: 'merged', reason: `fixes the failed step ${title ?? row.mentionedId}` }, 'held_by', 'person');
    if (!result.ok) return result;
    await settle({ state: 'done', decision: 'added' });
    return result;
  }

  /**
   * The automatic pass's answer for a glob (`AutomaticRelations`): its relations come from what the glob's text says, each with the
   * quoted sentence as its reason, `source: auto`. One transaction under the relations lock: the plan's hash is read again inside it
   * and nothing is written when it changed (`stale`). Each add goes through the same checks as a person's (the other glob exists and
   * `actorEmail` may see it, shape, 20 per gate, no cycle across boards); `holds_back` writes on the other glob, which `actorEmail`
   * must be able to edit. An add is skipped (with why) when any relation already joins the pair (any gate, dismissed too), when a
   * start gate would hold a glob that already started, or when the other glob no longer holds anything. `actorEmail` is the glob's
   * creator; null is slop itself (no membership checks).
   */
  async applyAutomatic(globId: string, planHash: string, adds: readonly AutomaticAdd[], actorEmail: string | null): Promise<AutomaticResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.applyAutomaticOnce(globId, planHash, adds, actorEmail);
      } catch (e) {
        if (!(e instanceof RelationWriteLost) || attempt >= EVENT_RETRIES) throw e;
      }
    }
  }

  private async applyAutomaticOnce(globId: string, planHash: string, adds: readonly AutomaticAdd[], actorEmail: string | null): Promise<AutomaticResult> {
    const touched: Glob[] = [];
    const result = await this.deps.store.transaction(async (tx): Promise<AutomaticResult> => {
      touched.length = 0;
      await tx.lockRelations();
      const added: string[] = [];
      const skipped: { to: string; why: string }[] = [];
      const glob = await tx.getGlob(globId);
      if (glob === null) return { added, skipped: adds.map((a) => ({ to: a.to, why: `No glob ${globId}` })), stale: false };
      // The plan may have been saved (or a relation dismissed) while the model answered.
      if (hash((await tx.artifactVersions(globId, 'plan', '')).at(-1)?.content ?? '') !== planHash) return { added, skipped, stale: true };
      for (const add of adds) {
        const to = add.to.trim();
        const reason = add.reason.trim();
        const reverse = add.direction === 'holds_back';
        if (reason === '') {
          skipped.push({ to, why: 'a relation needs a reason' });
          continue;
        }
        const other = await tx.getGlob(to);
        if (other === null || !(await this.viewableTarget(tx, actorEmail, other))) {
          skipped.push({ to, why: `No glob ${to}` });
          continue;
        }
        const holder = reverse ? other : glob;
        const target = reverse ? glob : other;
        if ([...(await tx.listRelationsFrom([holder.id])), ...(await tx.listWeakRelationsFrom([holder.id]))].some((r) => r.to === target.id)) {
          skipped.push({ to, why: 'already related' });
          continue;
        }
        if (add.gate === 'start' && holder.status !== 'planning') {
          skipped.push({ to, why: `${holder.id} has already started` });
          continue;
        }
        if (!stillHolds({ gate: add.gate, until: add.until }, (await this.statesOf(tx, [target.id])).get(target.id))) {
          skipped.push({ to, why: `${target.id} is already ${UNTIL_WORDS[add.until]}` });
          continue;
        }
        const moved = await this.commandOnce(
          actorEmail,
          holder.id,
          null,
          (g) => ok({ glob: g, changed: false, events: [], effects: [] }),
          {
            applies: 'any',
            relationPlan: (t, g, board) => this.planRelations(t, g, board, [{ to: target.id, gate: add.gate, until: add.until, reason }], 'mention', actorEmail, add.from),
          },
          tx,
        );
        if (moved === 'retry') throw new RelationWriteLost();
        if (!moved.ok) {
          skipped.push({ to, why: moved.error.message });
          continue;
        }
        added.push(to);
        touched.push(moved.value);
        if (other.boardId !== glob.boardId) touched.push(reverse ? glob : other);
      }
      return { added, skipped, stale: false };
    });
    for (const g of touched) this.publish(g);
    return result;
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
          dueSince: null,
        },
      ]);
      return true;
    });
    if (added) this.deps.notifier.publish({ kind: 'glob.changed', boardId: glob.boardId, globId: id, version: glob.version });
  }

  /**
   * A rollout work step in the shape every system writer uses: after the merge (or after a deploy to `when.env`), holding
   * back what `when.blocks` says, else the default for its due. `dueSince` is the caller's to set (it needs the store).
   */
  private rolloutStep(
    glob: Glob,
    origin: string,
    createdBy: string,
    now: string,
    fields: Pick<StoredHumanStep, 'title' | 'detail' | 'check' | 'script' | 'why' | 'permissions' | 'commands' | 'verify'>,
    when: Pick<RolloutStep, 'env' | 'blocks'> & { readonly once?: boolean } = { env: null, blocks: null },
  ): StoredHumanStep {
    const { due, blocks } = rolloutWhen(when);
    return {
      id: `hs_${this.deps.ids.runId()}`,
      boardId: glob.boardId,
      globId: glob.id,
      kind: 'rollout',
      who: 'anyone',
      due,
      state: 'open',
      blocks,
      origin,
      createdBy,
      createdAt: now,
      doneBy: null,
      doneAt: null,
      dismissedReason: null,
      dueSince: null,
      ...fields,
    };
  }

  /**
   * An implementation record arrived: its `## Rollout` section becomes the glob's rollout steps. The steps this section
   * wrote before are matched by title, or by the title as the parser writes it now (`matchStoredTitles`: a step stored
   * as `**Do x**` before titles dropped their emphasis is `Do x`): a still-open one that is gone is dismissed, one that
   * is still there is updated in place, a done or dismissed one keeps its state and detail (only a changed title is
   * saved), and a new one is added. Real steps replace the investigator's placeholder. A script step's body is stored as a `rollout_script` artifact (one
   * label per step). Reading the same record again changes nothing.
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
      const environments = ((await tx.getBoard(glob.boardId))?.environments ?? []).map((e) => e.name);
      const events: DomainEvent[] = [];
      const save: StoredHumanStep[] = [];
      const note = (step: StoredHumanStep, change: string) =>
        events.push({ type: 'HumanStepChanged', globId: id, actor: email, at: now, data: { step: step.id, kind: step.kind, title: step.title, change } });
      let scripts = false;
      const matches = matchStoredTitles(
        parsed.map((p) => p.title),
        own.map((s) => s.title),
      );
      const matched = new Set<string>();
      const gained: string[] = [];
      const textOf = (step: { readonly title: string; readonly detail: string | null; readonly why: string | null }): string =>
        [step.title, step.why, step.detail].filter((t): t is string => t !== null && t.trim() !== '').join('\n');
      for (const [i, written] of parsed.entries()) {
        // An environment the board doesn't define can never fall due: the step is filed after the merge instead, and says why.
        const step =
          written.env === null || environments.includes(written.env)
            ? written
            : { ...written, env: null, detail: [unknownEnvironmentText(written.env, environments) + '; the step is filed after the merge. Dismiss it and add it again for one of the board\'s environments.', written.detail].filter((t) => t !== null).join('\n\n') };
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
        const existing = own[matches[i] ?? -1];
        const when = rolloutWhen(step);
        const fresh = { ...fields, ...when };
        if (existing === undefined) {
          const added = { ...this.rolloutStep(glob, ROLLOUT_SECTION_ORIGIN, email, now, fields, step), dueSince: await dueSinceFor(tx, glob, when.due, stored, now) };
          save.push(added);
          note(added, 'added');
          gained.push(textOf(step));
          continue;
        }
        matched.add(existing.id);
        const refresh = existing.state === 'open' && JSON.stringify(stepFields(existing)) !== JSON.stringify(stepFields(fresh));
        if (refresh || existing.title !== step.title) {
          // A changed environment is a different deploy to wait for; the same one keeps the moment it fell due.
          const dueSince = refresh && existing.due !== when.due ? await dueSinceFor(tx, glob, when.due, stored, now) : existing.dueSince;
          const updated = refresh ? { ...existing, ...fields, ...when, dueSince } : { ...existing, title: step.title };
          save.push(updated);
          note(updated, 'updated');
          if (refresh) gained.push(textOf(step));
        }
      }
      for (const step of own) {
        if (step.state !== 'open' || matched.has(step.id)) continue;
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
      // Steps of a superseded glob are dismissed as they arrive.
      const superseded = (await this.dismissForSupersession(tx, glob, email)).length > 0;
      return { steps: save.length > 0 || superseded, scripts, boardId: glob.boardId, gained };
    });
    if (changed === null) return;
    if (changed.scripts) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: changed.boardId, globId: id });
    if (changed.steps) {
      await this.rolloutStepsWritten(id);
      await this.afterStepsChanged(id);
    }
    if (changed.gained.length > 0) await this.requestScan(id, changed.gained.join('\n'));
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
          const fresh = this.rolloutStep(glob, ROLLOUT_PATHS_ORIGIN, 'slop', now, { title: written.title, detail: written.detail, check: written.check, script, why: written.why, permissions: written.permissions, commands: written.commands, verify: written.verify }, written);
          const step = { ...fresh, dueSince: await dueSinceFor(tx, glob, fresh.due, save, now) };
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
    if (changed.steps) {
      await this.rolloutStepsWritten(id);
      await this.afterStepsChanged(id);
    }
    this.deps.notifier.publish({ kind: 'glob.changed', boardId: changed.glob.boardId, globId: id, version: changed.glob.version });
    return true;
  }

  /**
   * Capabilities changed or were re-read: every open step whose `check` capability is on, and whose due-ness has arrived
   * (a merged glob's after-merge step; a step due now; an after-deploy step once its environment held the glob), is ticked by slop. Nothing is ticked before the merge, and a step
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
          (s) => isOn(s) && stateOf(glob, s) === 'due',
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

  /**
   * A person says the environment now runs the glob's merge, for boards that report no deploys: the glob's open
   * `after_deploy:<env>` steps fall due (once; a rollback later doesn't undo it). Members only. Logs
   * `EnvironmentMarkedDeployed`, not `Deployed` (ATF reads that), leaves `glob_environments` and the glob's version alone,
   * and refuses an environment the board doesn't list. Repeating it changes and logs nothing.
   */
  async markEnvironmentDeployed(email: string, id: string, environment: string): Promise<Result<{ readonly marked: number }>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ glob: Glob; marked: number }>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(glob.boardId);
      if (board === null || !board.environments.some((e) => e.name === environment)) return invalidInput(`Unknown environment ${environment}`);
      const now = this.deps.clock.now();
      const marked = await markStepsDue(tx, glob.boardId, [id], environment, now);
      const already = (await tx.listBoardEvents(glob.boardId, '1970-01-01T00:00:00.000Z', ['EnvironmentMarkedDeployed'], [id])).some((e) => e.data.environment === environment);
      if (marked.length > 0 || !already) {
        await tx.appendEvents([{ type: 'EnvironmentMarkedDeployed', globId: id, actor: email, at: now, data: { environment, steps: marked.length } }]);
      }
      return ok({ glob, marked: marked.length });
    });
    if (!result.ok) return result;
    if (result.value.marked > 0) this.deps.notifier.publish({ kind: 'glob.changed', boardId: result.value.glob.boardId, globId: id, version: result.value.glob.version });
    return ok({ marked: result.value.marked });
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
  ): Promise<Result<ListedGlobRow[]>> {
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
      const seen = await this.seeOthers(tx, email, boardId, [...new Set(globs.flatMap((g) => (ownBy.get(g.id) ?? []).map((r) => r.to)))]);
      const titles = titlesOf(seen.reach.globs);
      // Who waits for these globs (one read), redacted for a viewer outside the other glob's board; and the open suggestions.
      const heldBy = await this.holdsBackOf(tx, email, globs);
      const suggestions = await this.suggestionsOf(tx, globs.map((g) => g.id));
      return ok(
        globs.map((glob): ListedGlobRow => {
          const facts: RelationFacts = { relations: ownBy.get(glob.id) ?? [], states: seen.reach.states };
          const holdsBack = heldBy.get(glob.id) ?? [];
          const suggested = suggestions.get(glob.id) ?? [];
          return {
            glob,
            artifacts: (byGlob.get(glob.id) ?? []).sort(byKind),
            relations: factsView(facts, seen.external),
            holding: holdingOf(facts, titles).map((h) => holdingView(h, seen.external.get(h.to))),
            ...(holdsBack.length === 0 ? {} : { holdsBack }),
            ...(suggested.length === 0 ? {} : { suggestions: suggested }),
          };
        }),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Commands from people (each carries the version the client read)

  async create(email: string, given: CreateGlobInput): Promise<Result<Glob>> {
    const made = await this.createWithNotes(email, given);
    return made.ok ? ok(made.value.glob) : made;
  }

  /**
   * `create`, and what the caller should be told beside the glob: the start relations left out because their target holds nothing
   * any more (`ignoredAfter`), how each `holds` and `supersedes` entry went, and why a non-admin's untyped create became a same.
   * `holds` and `supersedes` are checked before anything is created (a bad one creates nothing) and written after the create
   * commits: a failure then is reported in the notes, not rolled back, and a retry with the same idempotency key adds nothing twice.
   */
  async createWithNotes(email: string, given: CreateGlobInput): Promise<Result<{ readonly glob: Glob; readonly notes: CreateNotes }>> {
    if (given.category === 'decision') return invalidInput('A decision glob is created from a knowledge proposal or an inbox item, not directly');
    if (given.category !== 'action' && given.type === null) return invalidInput(`A ${given.category} needs a type`);
    const links = await this.checkLinks(email, given);
    if (!links.ok) return links;
    const made = await this.createOne(email, given);
    if (!made.ok) return made;
    const by = given.by ?? given.relationsBy ?? 'person';
    let glob = made.value.glob;
    const holds: { id: string; ok: boolean; why: string }[] = [];
    for (const h of links.value.holds) {
      const added = await this.addRelation(email, glob.id, null, { to: h.id, gate: h.gate ?? 'sign_off', until: h.until ?? 'merged', reason: h.reason ?? null }, 'holds_back', by);
      if (added.ok) await this.closeFailedSteps(h.id);
      holds.push({ id: h.id, ok: added.ok, why: added.ok ? 'added' : added.error.message });
    }
    const supersedes: { id: string; ok: boolean; why: string }[] = [];
    for (const sup of links.value.supersedes) {
      const added = await this.addSupersession(email, glob.id, sup.id, { reason: sup.reason ?? null }, by);
      supersedes.push({ id: sup.id, ok: added.ok, why: added.ok ? 'added' : added.error.message });
    }
    // The caller's next write carries the version it gets back: the relations written on the new glob may have moved it.
    if (holds.length + supersedes.length > 0) glob = (await this.peek(glob.id)) ?? glob;
    return ok({ glob, notes: { ignoredAfter: made.value.ignoredAfter, holds, supersedes, typeNote: made.value.typeNote } });
  }

  /** Creates the glob of the right category: an action, or code work (in its group's decisions). */
  private async createOne(email: string, given: CreateGlobInput): Promise<Result<Created>> {
    if (given.category === 'action') return this.createAction(email, given);
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
   * Checks the globs a create is to hold back or supersede before it makes anything: each exists, is on a board the actor is a
   * member of (the same answer as no glob), makes a relation that makes sense, needs no reason it wasn't given and closes no cycle
   * with the relations the new glob is made with. Returns them normalised.
   */
  private async checkLinks(
    email: string,
    input: CreateGlobInput,
  ): Promise<Result<{ readonly holds: readonly HoldInput[]; readonly supersedes: readonly SupersedeInput[] }>> {
    const holds = (input.holds ?? []).map((h): HoldInput => (typeof h === 'string' ? { id: h.trim() } : { ...h, id: h.id.trim() })).filter((h) => h.id !== '');
    const supersedes = (input.supersedes ?? []).map((h): SupersedeInput => (typeof h === 'string' ? { id: h.trim() } : { ...h, id: h.id.trim() })).filter((h) => h.id !== '');
    if (holds.length + supersedes.length === 0) return ok({ holds, supersedes });
    const by = input.by ?? input.relationsBy ?? 'person';
    return this.deps.store.transaction(async (tx): Promise<Result<{ readonly holds: readonly HoldInput[]; readonly supersedes: readonly SupersedeInput[] }>> => {
      // The create answers for a board that is missing or not the actor's.
      if ((await tx.getMember(input.boardId, email)) === null) return ok({ holds, supersedes });
      const found = new Map((await tx.getGlobs([...holds.map((h) => h.id), ...supersedes.map((h) => h.id)])).map((g) => [g.id, g]));
      // What the new glob is made to wait for, so a hold can't close a cycle through it (the new glob has no ID yet).
      const NEW = '(new glob)';
      const waits: NewRelation[] = [
        ...(input.after ?? []).map((to): NewRelation => ({ to: to.trim(), gate: 'start', until: 'merged', reason: null, evidence: [], source: 'person' })),
        ...(input.relations ?? []).flatMap((r): NewRelation[] => {
          const until = normaliseUntil(r.until ?? 'merged');
          return until === null ? [] : [{ to: r.to.trim(), gate: r.gate ?? 'start', until, reason: null, evidence: [], source: 'person' }];
        }),
      ];
      const universe = await this.relationUniverse(tx, [], waits.map((w) => w.to));
      if (!universe.ok) return universe;
      const drafts = [...universe.value, ...waits.map((w) => draftOf(input.boardId, NEW, w))];
      for (const h of holds) {
        const other = found.get(h.id);
        if (!(await this.viewableTarget(tx, email, other)) || other === undefined) return invalidInput(`No glob ${h.id}`);
        const until = untilFor(h.until, { category: input.category });
        if (!until.ok) return until;
        const gate = h.gate ?? 'sign_off';
        const shape = checkRelationShape(other, { to: NEW, until: until.value, gate }, { category: input.category });
        if (!shape.ok) return shape;
        const reason = (h.reason ?? '').trim();
        if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
        if (needsReason(by) && reason === '') return reasonRefusal(h.id);
        if (wouldCycle(drafts, { from: h.id, to: NEW, gate, until: until.value })) {
          return invalidInput(`The new glob would wait for ${h.id}, which it is to hold back: that would be a cycle`);
        }
      }
      for (const sup of supersedes) {
        if (!(await this.viewableTarget(tx, email, found.get(sup.id)))) return invalidInput(`No glob ${sup.id}`);
        const reason = (sup.reason ?? '').trim();
        if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
        if (needsReason(by) && reason === '') return reasonRefusal(sup.id);
      }
      return ok({ holds, supersedes });
    });
  }

  /** A failed step's open suggestion is closed once a glob that holds the glob back (a fix) exists. */
  private async closeFailedSteps(globId: string): Promise<void> {
    await this.deps.store.transaction(async (tx) => {
      const now = this.deps.clock.now();
      for (const row of await tx.listOpenSuggestions([globId])) {
        if (row.kind === 'step_failed') await tx.updateRelationScan(row.globId, row.mentionedId, row.sentenceHash, { state: 'done', decidedAt: now });
      }
    });
  }

  /**
   * Only board admins choose sub or super (access.ts). A type nobody chose becomes a same for anyone else; a chosen one is
   * refused. Non-members and unknown boards fall through to the checks in the transaction.
   */
  private async resolveType(email: string, input: CodeCreateInput): Promise<Result<{ readonly input: CodeCreateInput; readonly note: string | null }>> {
    if (input.type === 'same') return ok({ input, note: null });
    const actor = await this.deps.store.transaction((tx) => this.actorFor(tx, email, input.boardId));
    if (!actor.ok || canChooseType(actor.value.role, input.type)) return ok({ input, note: null });
    if (input.typeChosen === false) {
      return ok({ input: { ...input, type: 'same' }, note: 'Created as a same: only board admins choose sub or super, and no type was chosen. Its relations are kept.' });
    }
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
  private async createAction(email: string, input: CreateGlobInput): Promise<Result<Created>> {
    if (input.type !== null) return invalidInput('An action has no type');
    if (input.environment !== null) return invalidInput('An action has no environment');
    // `files` is an agent's advisory guess for exclusive paths; an action has no paths. (`inboxItem` and `intake` come from the web
    // form's own flow, so they are not refused here: the MCP tool refuses `inboxItem` on its own.)
    if ((input.files ?? []).length > 0) return invalidInput('An action takes no files: put them in the plan or attach them afterwards');
    const plan = input.plan?.trim() ? input.plan : ACTION_PLAN_TEMPLATE.replace('<What a person needs to do>', input.title.trim());
    if (input.prepare !== true && input.record !== undefined) return invalidInput('An action has a record kind only when a routine prepares it: pass prepare: true');
    const preparation = input.prepare === true ? { record: input.record ?? 'branch', rounds: 0 } : undefined;
    let ignored: { id: string; why: string }[] = [];
    const crossBoard: Glob[] = [];
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Transition>> => {
      ignored = [];
      crossBoard.length = 0;
      const board = await tx.getBoard(input.boardId);
      if (board === null) return notFound(`No board ${input.boardId}`);
      const actor = await this.actorFor(tx, email, board.id);
      if (!actor.ok) return actor;
      if (input.idempotencyKey !== null) {
        const existing = await tx.findGlobByCreationKey(board.id, input.idempotencyKey);
        if (existing !== null) return ok({ glob: existing, changed: false, events: [], effects: [] });
      }
      // What it waits for: the globs named in `after` and `relations`, those that merged already left out. Nothing points at the new
      // action yet, so no cycle is possible.
      const by = input.by ?? input.relationsBy ?? 'person';
      const afterReason = (input.afterReason ?? '').trim() === '' ? null : (input.afterReason ?? '').trim();
      const wanted = [...(input.after ?? []).map((to): RelationInput => ({ to, reason: afterReason })), ...(input.relations ?? [])];
      const targets = new Map((await tx.getGlobs(wanted.map((w) => w.to.trim()))).map((g) => [g.id, g]));
      const states = await this.statesOf(tx, [...targets.keys()]);
      const open = wanted.filter((w) => {
        const target = targets.get(w.to.trim());
        const until = target === undefined ? null : untilFor(w.until, target);
        if (target === undefined || until === null || !until.ok || (w.gate ?? 'start') !== 'start') return true;
        // A target that no longer holds anything is left out (and reported); one merged with its rollout still open holds.
        if ((until.value === 'merged' || until.value === 'done') && !stillHolds({ gate: 'start', until: until.value }, states.get(target.id))) {
          ignored.push({ id: target.id, why: ignoredWhy(target.id, states.get(target.id)) });
          return false;
        }
        return true;
      });
      for (const w of open) {
        const target = targets.get(w.to.trim());
        if (target !== undefined && target.boardId !== board.id) crossBoard.push(target);
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
          attributes: { assignee: input.assignee ?? null, outcome: null, ...(preparation === undefined ? {} : { preparation }) },
          group: input.group,
          environment: null,
          autoTrigger: false,
          // A prepared action held by a start relation waits in Planning and starts preparing when it is released.
          waitingFor: open.filter((w) => (w.gate ?? 'start') === 'start').map((w) => w.to.trim()),
        },
        board,
        ctx,
      );
      if (!created.ok) return created;
      const glob = { ...created.value.glob, version: 1 };
      const planned = await this.planRelations(tx, glob, [], open, by, email);
      if (!planned.ok) return planned;
      if (planned.value.add.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
      const written = applyWrite([], planned.value, { boardId: board.id, from: glob.id, now: ctx.now, newId: () => this.relationId() });
      if (!(await tx.insertGlob(glob, input.idempotencyKey))) throw new Error(`Glob ID collision for ${glob.id}`);
      await tx.appendEvents(created.value.events);
      // A prepared action provisions its branch and fires its first preparation round: the outbox carries both.
      await tx.enqueueEffects(created.value.effects);
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
    if (result.value.changed) {
      this.publish(result.value.glob);
      for (const target of crossBoard) this.publish(target);
      await this.requestScan(result.value.glob.id, plan);
    }
    return ok({ glob: result.value.glob, ignoredAfter: ignored, typeNote: null });
  }

  /**
   * The deterministic risk signal for a glob whose type nobody chose: its plan text or files match one of the board's risk areas
   * (those not learned clean). Null when none matches or a type question is already raised. Never auto-applies an option: the
   * answer only records and releases, a person changes the type.
   */
  private async riskTypeQuestion(tx: Tx, boardId: number, input: CodeCreateInput, planText: string, now: string): Promise<NewQuestion | null> {
    if ((input.questions ?? []).some((q) => q.key === 'type' || q.key?.startsWith('intake:type') === true)) return null;
    const stored = await tx.listRiskAreas(boardId);
    const areas = (stored.length > 0 ? stored : defaultAreas(boardId, now)).filter((a) => !subSafe(a));
    const matched = new Map(matchRiskAreas(areas, planText).areas.map((a) => [a.name, a]));
    for (const a of areasMatching(areas, input.files ?? [])) matched.set(a.name, a);
    if (matched.size === 0) return null;
    const names = [...matched.keys()].join(', ');
    return {
      key: 'type',
      text: `This work matches the risk ${matched.size === 1 ? 'area' : 'areas'} ${names}, and no type was chosen. Create it as a sub (a routine implements and merges it) or as a same (a person reviews it)?`,
      options: ['same', 'sub'],
      blocking: 'start',
      source: 'create',
      raisedBy: { kind: 'system', actor: null },
    };
  }

  private async createWithItem(email: string, wanted: CodeCreateInput): Promise<Result<Created>> {
    const resolved = await this.resolveType(email, wanted);
    if (!resolved.ok) return resolved;
    const input = resolved.value.input;
    let ignored: { id: string; why: string }[] = [];
    const crossBoard: Glob[] = [];
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
    const [embedding, size, inferred, classified] = await Promise.all([
      embedRequest(this.deps.embedder, input.intake?.request ?? planText),
      this.deps.sizeCheck === undefined ? null : this.deps.sizeCheck.assess(input.boardId, planText, input.title),
      this.deps.inference === undefined || input.type === 'super'
        ? []
        : this.deps.inference.infer({ boardId: input.boardId, plan: planText, selfId: null, title: input.title, ...(input.files === undefined ? {} : { files: input.files }) }),
      this.classifyAtCreate(email, input, planText),
    ]);
    const autoNeeds = classified.prerequisites;
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Transition>> => {
      ignored = [];
      crossBoard.length = 0;
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
      const by = input.by ?? input.relationsBy ?? 'person';
      const afterReason = (input.afterReason ?? '').trim();
      if (afterReason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
      // Relations stated beside `after` (any gate): the last of one glob and gate wins, and a start one `after` already names is it.
      const stated = [...new Map((input.relations ?? []).map((r) => [`${r.to.trim()}|${r.gate ?? 'start'}`, { ...r, to: r.to.trim() }])).values()].filter(
        (r) => r.to !== '' && !((r.gate ?? 'start') === 'start' && wanted.includes(r.to)),
      );
      // Slop's inferred edges: a need (until merged) or an open decision (until decided); a person's statement of the same glob wins.
      const inferredNeeds = inferred.filter((i) => !wanted.includes(i.id) && !stated.some((r) => (r.gate ?? 'start') === 'start' && r.to === i.id));
      const known = new Map((await tx.getGlobs([...wanted, ...stated.map((r) => r.to), ...inferredNeeds.map((i) => i.id), ...autoNeeds.map((p) => p.id)])).map((g) => [g.id, g]));
      // Where every target stands, read once: a merged target whose rollout is still open holds its dependants, so it stays a relation.
      const states = await this.statesOf(tx, [...known.keys()]);
      for (const a of [...wanted, ...stated.map((r) => r.to)]) {
        if (a === id) return invalidInput('A glob cannot wait for itself');
        // A glob on another board counts when the actor is a member of it; any other answer is the one for a glob that doesn't exist.
        if (!(await this.viewableTarget(tx, email, known.get(a)))) return invalidInput(`No glob ${a}`);
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
        const resolvedUntil = untilFor(r.until, target);
        if (!resolvedUntil.ok) return resolvedUntil;
        const until = resolvedUntil.value;
        const shape = checkRelationShape({ id, category: input.category }, { to: r.to, until, gate: r.gate ?? 'start' }, target);
        if (!shape.ok) return shape;
        const reason = (r.reason ?? '').trim();
        if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
        explicit.push({ to: r.to, gate: r.gate ?? 'start', until, reason: reason === '' ? null : reason, evidence: [], source: by, group: r.group ?? null });
      }
      const needs: NewRelation[] = [
        ...wanted.map((to): NewRelation => ({ to, gate: 'start', until: wantedUntil.get(to) ?? 'merged', reason: afterReason === '' ? null : afterReason, evidence: [], source: by })),
        ...explicit,
        ...inferredNeeds.slice(0, Math.max(0, MAX_RELATIONS - wanted.length - explicit.filter((r) => r.gate === 'start').length)).map((i): NewRelation => ({ to: i.id, gate: 'start', until: i.kind === 'decision' ? 'decided' : 'merged', reason: i.reason, evidence: i.files, source: 'inferred' })),
      ].filter((r) => {
        const target = known.get(r.to);
        if (target === undefined) return false;
        // Slop's inferred edges stay on the board; a person's or an agent's may point at another board (checked above).
        if (r.source === 'inferred' && target.boardId !== board.id) return false;
        // An inferred edge must match what it points at: a decision for a decision glob, a need for work.
        if (r.source === 'inferred' && (target.category === 'action' || (r.until === 'decided') !== (target.category === 'decision'))) return false;
        // A start relation to a glob that no longer holds anything (merged and rolled out, an action done) is not recorded, and said so;
        // the other gates are kept. A glob merged with its rollout still open holds: its relation stays.
        if (r.gate === 'start' && (r.until === 'merged' || r.until === 'done') && !stillHolds(r, states.get(r.to))) {
          if (r.source !== 'inferred') ignored.push({ id: r.to, why: ignoredWhy(r.to, states.get(r.to)) });
          return false;
        }
        if (target.boardId !== board.id) crossBoard.push(target);
        return true;
      });
      // Prerequisites the plan states (create-time classification): they join as automatic rows with the quoted sentence, so a sub waits
      // before it starts. Each is skipped, never refused, when it fails the checks other relation writes make: a target the actor can't
      // view, a shape that makes no sense, nothing held any more, a pair already related, or a gate already at its limit.
      for (const p of autoNeeds) {
        const target = known.get(p.id);
        if (target === undefined || p.id === id || !(await this.viewableTarget(tx, email, target))) continue;
        const row: NewRelation = { to: p.id, gate: p.gate, until: p.until, reason: p.reason, evidence: [], source: 'mention' };
        if (!checkRelationShape({ id, category: input.category }, { to: p.id, until: p.until, gate: p.gate }, target).ok) continue;
        if (needs.some((r) => r.to === p.id && r.gate === p.gate)) continue;
        if (p.gate === 'start' && !stillHolds(row, states.get(p.id))) continue;
        if (needs.filter((r) => r.gate === p.gate).length >= MAX_RELATIONS) continue;
        if (target.boardId !== board.id) crossBoard.push(target);
        needs.push(row);
      }
      // An agent's or the automatic pass's relation says why (rows slop inferred, and a group's inherited ones, are not asked for one).
      if (needsReason(by)) {
        const bare = needs.find((r) => r.source === by && r.reason === null && (r.group ?? null) === null);
        if (bare !== undefined) return reasonRefusal(bare.to);
      }
      const perGate = (gate: RelationGate): number => needs.filter((r) => r.gate === gate).length;
      if (perGate('start') > MAX_RELATIONS || perGate('merge') > MAX_RELATIONS || perGate('sign_off') > MAX_RELATIONS) {
        return invalidInput(`A glob can have at most ${MAX_RELATIONS} relations for one gate`);
      }
      // A source this board has found too often wrong (mention, inferred) makes only weak links: stored, shown, holding nothing.
      const postures = await this.deps.relationLearning?.posturesIn(tx, board.id);
      const weakened = (r: NewRelation): boolean => r.kind === undefined && ((isFromMention(r.source) && isWeak(postures?.mention)) || (r.source === 'inferred' && isWeak(postures?.inferred)));
      const gating = needs.filter((r) => !weakened(r));
      const weakLinks = needs.filter(weakened).map((r): NewRelation => ({ ...r, kind: 'may_relate' }));
      const made = { boardId: board.id, from: id, now: this.deps.clock.now(), newId: () => this.relationId() };
      const created = applyWrite([], { add: gating, update: [], remove: [] }, made);
      const weakCreated = applyWrite([], { add: weakLinks, update: [], remove: [] }, made);
      const external = await this.externalIds(tx, board.id, created.relations.map((r) => r.to));
      const relations: RelationFacts = { relations: created.relations, states, ...(external.size === 0 ? {} : { external }) };
      // Predicted overlaps stay on the glob as internal data (the merge policy's holds); they are not shown and not an input.
      const implied = mergeImplied(holds, []);
      // No type was chosen and it resolved to a sub (auto-merges) although the work touches a risk area: ask instead of guessing.
      const typeAsk = input.typeChosen === false && input.type === 'sub' ? await this.riskTypeQuestion(tx, board.id, input, planText, this.deps.clock.now()) : null;
      const questions = typeAsk === null ? input.questions : [...(input.questions ?? []), typeAsk];
      let createInput: CreateInput = { ...input, id, impliedAfter: implied, ...(questions === undefined ? {} : { questions }) };
      // Nobody chose an environment: a code glob that will have a branch gets one no other open glob is using, when there is one.
      if (input.environment === null && !isHumanCategory(input.category) && input.type !== 'super') {
        const open = await tx.listGlobs(board.id, {});
        const picked = pickEnvironment(board.environments, open, open.length === 0 ? [] : await tx.latestDeploys(board.id, open.map((g) => g.id)));
        if (picked !== null) {
          const reason = [input.inferenceReason ?? null, `Environment ${picked.reason}`].filter((t) => t !== null).join('. ');
          createInput = { ...createInput, environment: picked.environment, inferenceReason: reason };
        }
      }
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
      await this.writeNew(tx, glob, [...created.inserted, ...weakCreated.inserted], ctx.actor?.email ?? null, ctx.now);
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
    const notes = { ignoredAfter: ignored, typeNote: resolved.value.note };
    if (result.value.changed) {
      this.publish(result.value.glob);
      for (const target of crossBoard) this.publish(target);
      if (classified.decided.length > 0) {
        try {
          await this.deps.relationScan?.remember?.(result.value.glob.id, input.boardId, classified.decided);
        } catch (e) {
          this.deps.log?.('relation scan remember', e instanceof Error ? e.message : String(e));
        }
      }
      if (input.inboxItem !== undefined) {
        this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: input.boardId, globId: result.value.glob.id });
        this.deps.notifier.publish({ kind: 'board.inbox', boardId: input.boardId });
      }
      // The forecast from the code and history is made in the background: creating a glob never waits on it.
      if (result.value.glob.status === 'planning') this.refreshSizeInBackground(result.value.glob.id);
      await this.requestScan(result.value.glob.id, planText);
      // The caller's first write carries the version it got back, so it must be the one after the automatic run.
      return ok({ glob: (await this.autoInvestigate(result.value.glob.id)) ?? result.value.glob, ...notes });
    }
    return ok({ glob: result.value.glob, ...notes });
  }

  /**
   * The create-time classification: the prerequisites the new glob's text states beyond what the caller stated itself. Asked only
   * when the text names a glob that `needs`/`after`/`relations`/`holds`/`supersedes` do not; an input-only create (intake ran) passes
   * intake's own answer, so no second model call is made. No usable answer (or no classifier) is no automatic relation: the pass
   * the create queues decides later. Never fails the create.
   */
  private async classifyAtCreate(email: string, input: CodeCreateInput, planText: string): Promise<{ readonly prerequisites: readonly CreatePrerequisite[]; readonly decided: readonly CreateDecision[] }> {
    const none = { prerequisites: [], decided: [] } as const;
    const scan = this.deps.relationScan;
    if (scan?.classifyAtCreate === undefined) return none;
    try {
      const answered = input.intake === undefined || input.intake === null ? undefined : (input.intake.prerequisites ?? []);
      // Intake's answer is about the request it read, so that is the text its sentences are checked against.
      const text = answered === undefined ? planText : input.intake?.request ?? planText;
      const stated = new Set(
        [...(input.after ?? []), ...(input.relations ?? []).map((r) => r.to), ...(input.holds ?? []).map((h) => (typeof h === 'string' ? h : h.id)), ...(input.supersedes ?? []).map((h) => (typeof h === 'string' ? h : h.id))].map((id) => id.trim()),
      );
      const named = idSentences(null, text).flatMap((sentence) => globIdsIn(sentence));
      if (!named.some((id) => !stated.has(id))) return none;
      return await scan.classifyAtCreate({
        boardId: input.boardId,
        planText: text,
        explicitIds: [...stated],
        actorEmail: email,
        title: input.title,
        ...(answered === undefined ? {} : { answered }),
      });
    } catch (e) {
      this.deps.log?.('relation scan classify', e instanceof Error ? e.message : String(e));
      return none;
    }
  }

  /** Tells the automatic relation pass a glob gained text (it prefilters, queues and debounces); best effort: never fails the write. */
  private async requestScan(globId: string, newText: string): Promise<void> {
    if (this.deps.relationScan === undefined || newText.trim() === '') return;
    try {
      await this.deps.relationScan.request({ globId, newText });
    } catch (e) {
      this.deps.log?.('relation scan request', e instanceof Error ? e.message : String(e));
    }
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
      await tx.lockRelations();
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
      const inheritedStates = await this.statesOf(tx, inheritedAll);
      // A target that merged with its rollout still open holds, so a part keeps waiting for it; merged and rolled out, it doesn't.
      const inherited = inheritedAll.filter((to) => {
        const target = inheritedFound.get(to);
        return target !== undefined && stillHolds({ gate: 'start', until: defaultUntil(target) }, inheritedStates.get(to));
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
        const partReason = (to: string): string | null => {
          const n = (part.after ?? []).find((m) => ids[m] === to);
          return n === undefined ? (ownRelations.find((r) => r.to === to && r.gate === 'start')?.reason ?? null) : `Part ${index + 1} of ${id}'s split needs part ${n + 1}`;
        };
        const startWrite: NewRelation[] = awaitedIds.map((to): NewRelation => ({ to, gate: 'start', until: untilOf(to), reason: partReason(to), evidence: [], source: earlier.includes(to) ? needsBy : 'person' }));
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
          { relations: startRelations.relations, states: await this.statesOf(tx, awaitedIds), external: await this.externalIds(tx, board.id, awaitedIds) },
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
    const { after: wanted, relations: statedHere, relationsBy, by: givenBy, afterReason, supersedes: supersedeList, ...fields } = changes;
    const by = givenBy ?? relationsBy ?? 'person';
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
              const planned = await this.planNeeds(tx, glob, board, wanted, by, (afterReason ?? '').trim() === '' ? null : (afterReason ?? '').trim(), email);
              if (!planned.ok) return planned;
              edit.value = planned.value.edit;
              write = planned.value.write;
            }
            if (stated === undefined || stated.length === 0) return ok(write);
            // The relations stated beside the list see the list's write: what it removes is gone, what it adds is there.
            const seen = [...board.filter((r) => !write.remove.includes(r.id)), ...write.add.map((n) => draftOf(glob.boardId, glob.id, n))];
            const more = await this.planRelations(tx, glob, seen, stated, by, email);
            return more.ok ? ok({ add: [...write.add, ...more.value.add], update: more.value.update, remove: [...write.remove, ...more.value.remove] }) : more;
          },
        }),
      },
    );
    if (result.ok && before.type !== null && before.type !== result.value.type) await this.recordRetype(result.value, before.type, email);
    if (!result.ok || supersedeList === undefined || supersedeList.length === 0) return result;
    // Superseding is written on the superseded globs after the change; the first one that fails is the answer.
    for (const sup of supersedeList) {
      const given = typeof sup === 'string' ? { id: sup.trim() } : { ...sup, id: sup.id.trim() };
      const added = await this.addSupersession(email, id, given.id, { reason: given.reason ?? null }, by);
      if (!added.ok) return added;
    }
    return ok((await this.peek(id)) ?? result.value);
  }

  /**
   * Whether a relation may point at `target`: it exists and the viewer is a member of its board (any role), so a glob the viewer
   * can't see answers exactly like one that doesn't exist. A system caller (no viewer) may point at any glob.
   */
  private async viewableTarget(tx: Tx, viewer: string | null, target: Glob | undefined): Promise<boolean> {
    if (target === undefined) return false;
    return viewer === null || (await tx.getMember(target.boardId, viewer)) !== null;
  }

  /**
   * The relations a cycle check must see: `base` (the glob's board) plus everything reachable forward from `targets`, across boards.
   * A cycle through a new edge needs a path from its `to` back to its `from`, and that path may run through other boards even when
   * the edge itself is local. Over `RELATION_UNIVERSE_CAP` rows beyond the base it refuses rather than guesses.
   */
  private async relationUniverse(tx: Tx, base: readonly Relation[], targets: readonly string[]): Promise<Result<Relation[]>> {
    return relationUniverse((ids) => tx.listRelationsFrom(ids), base, targets);
  }

  /**
   * What stating relations `wanted` on a glob does (any gate): each is checked (the other glob exists and the viewer may see it, on
   * any board; a shape that makes sense; within the limit; no cycle through the relations of the board and of everything the
   * new relations reach) and then added. An agent's or the automatic pass's relation needs a one-line reason, unless it is unchanged or
   * what it points at holds nothing any more. A relation a person or agent already set to the same glob and gate only changes its
   * `until` and reason; an inferred or learned one, or one that was dismissed or overridden, gives way to a fresh one. Nothing is
   * removed otherwise.
   */
  private async planRelations(
    tx: Tx,
    glob: Glob,
    board: readonly Relation[],
    wanted: readonly RelationInput[],
    by: RelationsBy,
    viewer: string | null,
    /** Where a `mention` relation's sentence was read from (goes in the log). */
    origin?: MentionOrigin,
  ): Promise<Result<RelationWrite>> {
    // The last statement of one glob and gate wins.
    const list = [...new Map(wanted.map((w) => [`${w.to.trim()}|${w.gate ?? 'start'}`, { ...w, to: w.to.trim() }])).values()].filter((w) => w.to !== '');
    const found = new Map((await tx.getGlobs([...new Set(list.map((w) => w.to))])).map((g) => [g.id, g]));
    const states = await this.statesOf(tx, [...found.keys()]);
    const universe = await this.relationUniverse(tx, board, list.map((w) => w.to));
    if (!universe.ok) return universe;
    const add: NewRelation[] = [];
    const update: { readonly id: string; readonly patch: { readonly until: RelationUntil; readonly reason: string | null; readonly group?: string } }[] = [];
    const remove: string[] = [];
    let growing: Relation[] = universe.value;
    const mentionWeak = isFromMention(by) && isWeak((await this.deps.relationLearning?.posturesIn(tx, glob.boardId))?.mention);
    for (const w of list) {
      const target = found.get(w.to);
      if (target === undefined || !(await this.viewableTarget(tx, viewer, target))) return invalidInput(`No glob ${w.to}`);
      const gate = w.gate ?? 'start';
      const resolved = untilFor(w.until, target);
      if (!resolved.ok) return resolved;
      const until = resolved.value;
      const shape = checkRelationShape(glob, { to: w.to, until, gate }, target);
      if (!shape.ok) return shape;
      const reason = (w.reason ?? '').trim();
      if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
      const mine = growing.find((r) => r.from === glob.id && r.to === w.to && r.gate === gate);
      const rest = growing.filter((r) => r.id !== mine?.id);
      const checked = checkRelation({ from: glob.id, to: w.to, gate, until }, glob.boardId, rest, (gid) => found.get(gid));
      if (!checked.ok) return checked;
      // A reason is asked of agents when something is written that still holds back (not for a row they didn't change).
      const asked = needsReason(by) && (w.group ?? null) === null && stillHolds({ gate, until }, states.get(w.to));
      if (mine !== undefined && isActive(mine) && isExplicit(mine)) {
        if (mine.until === until && (reason === '' || mine.reason === reason)) continue;
        const patch = { until, reason: reason === '' ? mine.reason : reason, ...(w.group === undefined || w.group === null ? {} : { group: w.group }) };
        if (asked && (patch.reason ?? '') === '') return reasonRefusal(w.to);
        update.push({ id: mine.id, patch });
        growing = [...rest, { ...mine, ...patch }];
        continue;
      }
      // An old row that gives way keeps its reason when the new statement has none.
      const carried = reason !== '' ? reason : (mine?.reason ?? '');
      if (asked && carried === '') return reasonRefusal(w.to);
      if (mine !== undefined) remove.push(mine.id);
      // A source this board has found too often wrong makes only a weak link: it is checked like a gate but holds nothing.
      const weak = mine === undefined && mentionWeak;
      const draft: NewRelation = { to: w.to, gate, until, reason: carried === '' ? null : carried, evidence: [], source: by, group: w.group ?? null, ...(weak ? { kind: 'may_relate' as const } : {}) };
      add.push(draft);
      growing = weak ? [...rest] : [...rest, draftOf(glob.boardId, glob.id, draft)];
    }
    return ok({ add, update, remove, ...(origin === undefined ? {} : { origin }) });
  }

  /**
   * What replacing a glob's start list (`needs`/`after`) with `wanted` does to its relations: the ones a person (or an old split) set
   * (not inferred, learned or automatic) are replaced, a recorded inferred or learned one to the same glob gives way to the new one,
   * targets that hold nothing any more are dropped (merged and rolled out; a merged one whose rollout is open stays), and every new
   * relation is checked (exists and viewable, not itself, no cycle, within the limit, a reason when an agent states it).
   */
  private async planNeeds(
    tx: Tx,
    glob: Glob,
    board: readonly Relation[],
    wanted: readonly string[],
    by: RelationsBy,
    reason: string | null,
    viewer: string | null,
  ): Promise<Result<{ readonly write: RelationWrite; readonly edit: { readonly from: string[]; readonly to: string[] } }>> {
    const list = [...new Set(wanted.map((a) => a.trim()).filter((a) => a !== ''))];
    if (list.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
    if ((reason ?? '').length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
    const found = new Map((await tx.getGlobs(list)).map((g) => [g.id, g]));
    for (const to of list) {
      if (to === glob.id) return invalidInput('A glob cannot wait for itself');
      if (!(await this.viewableTarget(tx, viewer, found.get(to)))) return invalidInput(`No glob ${to}`);
    }
    const states = await this.statesOf(tx, list);
    const kept = list.filter((to) => {
      const target = found.get(to);
      return target !== undefined && stillHolds({ gate: 'start', until: defaultUntil(target) }, states.get(to));
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
    const universe = await this.relationUniverse(tx, board, kept);
    if (!universe.ok) return universe;
    const growing: Relation[] = universe.value.filter((r) => !remove.includes(r.id));
    const adds: NewRelation[] = [];
    for (const to of add) {
      const target = found.get(to);
      const until = target === undefined ? 'merged' : defaultUntil(target);
      if (target !== undefined) {
        const shape = checkRelationShape(glob, { to, until }, target);
        if (!shape.ok) return shape;
      }
      if (needsReason(by) && reason === null) return reasonRefusal(to);
      const draft: NewRelation = { to, gate: 'start', until, reason, evidence: [], source: by };
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

  /** Start a glob that waits for others to merge, before they have. `reason` (optional) is logged with who did it. */
  async startAnyway(email: string, id: string, version: number, reason?: string) {
    const wrote = { value: false };
    const result = await this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAnyway(glob, ctx, facts.relations, reason), {
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
    // The relation that was dismissed, for what is remembered about an automatic one.
    const dismissed: { value: Relation | null; state: ToState } = { value: null, state: 'missing' };
    const result = await this.command(email, id, version, (glob) => ok({ glob, changed: false, events: [], effects: [] }), {
      applies: 'work',
      relationPlan: async (tx: Tx, glob: Glob, board: readonly Relation[], now: string): Promise<Result<RelationWrite>> => {
        dismissed.value = null;
        const found = board.find((r) => r.id === relationId && r.from === glob.id);
        const label = found === undefined ? (await tx.listSupersessions([glob.id])).find((r) => r.id === relationId) : undefined;
        const weak = found === undefined && label === undefined ? (await tx.listWeakRelationsFrom([glob.id])).find((r) => r.id === relationId) : undefined;
        const row = found ?? label ?? weak;
        if (row === undefined) return invalidInput(`${glob.id} has no relation ${relationId}`);
        if (row.dismissedAt !== null) return ok(NO_WRITE);
        const planHash = hash((await tx.artifactVersions(glob.id, 'plan', '')).at(-1)?.content ?? '');
        // A superseded label goes away; the steps it dismissed stay dismissed (that is history).
        if (found !== undefined || weak !== undefined) dismissed.value = found ?? weak ?? null;
        if (found !== undefined) dismissed.state = (await this.statesOf(tx, [found.to])).get(found.to) ?? 'missing';
        return ok({ add: [], update: [{ id: row.id, patch: { dismissedAt: now, dismissedPlanHash: planHash } }], remove: [] });
      },
      // A person's "no" to a relation slop added is remembered by the pair, so the automatic pass never asks about it again.
      record: async (tx, before) => {
        const r = dismissed.value;
        // Dismissing a relation that still held is a false positive for its source (a weak link held nothing, so it says nothing).
        if (r !== null && r.kind !== 'may_relate') await this.learn(() => this.deps.relationLearning?.dismissed(tx, r, dismissed.state));
        if (r === null || !isFromMention(r.source)) return;
        const now = this.deps.clock.now();
        const key = sentenceHash(r.reason ?? '');
        await tx.upsertRelationScans([
          { globId: r.from, mentionedId: r.to, sentenceHash: key, boardId: before.boardId, kind: 'mention', decision: 'not_prerequisite', gate: r.gate, reason: r.reason, sentence: r.reason ?? '', relationId: r.id, state: 'dismissed', model: null, createdAt: now, decidedAt: now },
        ]);
        await tx.updateRelationScan(r.from, r.to, key, { decision: 'not_prerequisite', state: 'dismissed', decidedAt: now });
      },
    });
    if (!result.ok) return result;
    // What waited only for it goes on: a held start, a held merge, a sign-off with approved labels.
    if (result.value.status === 'planning' && result.value.waiting != null) await this.release(id);
    const resumed = await this.gateReleased(id);
    return resumed.ok ? resumed : result;
  }

  /**
   * A person makes a weak link (`may_relate`, holding nothing) a gate: the relation keeps its source, reason and evidence and becomes
   * a `waits` row, after the checks every relation writer makes (nothing is waiting for it already, `to` still holds, a start gate
   * only before the glob started, no cycle, within the limit). The promotion tells the board's learning the weak link was right
   * (`tp_promoted`).
   */
  async promoteRelation(email: string, id: string, version: number | null, relationId: string): Promise<Result<Glob>> {
    const promoted: { value: Relation | null } = { value: null };
    const result = await this.command(email, id, version, (glob) => ok({ glob, changed: false, events: [], effects: [] }), {
      applies: 'work',
      relationPlan: async (tx: Tx, glob: Glob, board: readonly Relation[]): Promise<Result<RelationWrite>> => {
        promoted.value = null;
        const weak = (await tx.listWeakRelationsFrom([glob.id])).find((r) => r.id === relationId);
        if (weak === undefined) return invalidInput(`${glob.id} has no weak link ${relationId}`);
        if (weak.dismissedAt !== null) return invalidInput('That weak link was dismissed');
        if (weak.gate === 'start' && glob.status !== 'planning') return invalidInput(`${glob.id} has already started`);
        const target = await tx.getGlob(weak.to);
        const state = (await this.statesOf(tx, [weak.to])).get(weak.to);
        if (target === null || !stillHolds(weak, state)) return invalidInput(`${ignoredWhy(weak.to, state)}, so a gate would hold nothing`);
        if (board.some((r) => r.from === glob.id && r.to === weak.to && r.gate === weak.gate)) return invalidInput(`${glob.id} already has a ${weak.gate} relation to ${weak.to}`);
        const universe = await this.relationUniverse(tx, board, [weak.to]);
        if (!universe.ok) return universe;
        const checked = checkRelation({ from: glob.id, to: weak.to, gate: weak.gate, until: weak.until }, glob.boardId, universe.value, (gid) => (gid === target.id ? target : undefined));
        if (!checked.ok) return checked;
        promoted.value = weak;
        return ok({ add: [], update: [{ id: weak.id, patch: { kind: 'waits' } }], remove: [] });
      },
      record: async (tx, before, _next, actor) => {
        const weak = promoted.value;
        if (weak === null) return;
        const to = (await this.externalIds(tx, before.boardId, [weak.to])).has(weak.to) ? OTHER_BOARD_GLOB : weak.to;
        await tx.appendEvents([{ type: 'RelationAdded', globId: weak.from, actor: actor?.email ?? null, at: this.deps.clock.now(), data: { to, gate: weak.gate, until: weak.until, source: weak.source, reason: weak.reason, note: 'promoted from a weak link' } }]);
        await this.learn(() => this.deps.relationLearning?.promoted(tx, weak));
      },
    });
    if (!result.ok) return result;
    const held = await this.gateReleased(id);
    return held.ok ? held : result;
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
      relationPlan: (tx, glob, board) => this.planRelations(tx, glob, board, [{ ...input, to }], by, email),
    });
    if (!result.ok) return result;
    const held = await this.gateReleased(from);
    // The glob on the other end gets a live hint: the one a decision holds back, or a target on another board (its board shows who waits).
    const other = await this.peek(direction === 'holds_back' ? id : to.trim());
    if (other !== null && (direction === 'holds_back' || other.boardId !== result.value.boardId)) this.publish(other);
    return held.ok ? held : result;
  }

  /**
   * `superseder` supersedes `superseded`: the row lands on the superseded glob (B), saying it is superseded by A, so it is written
   * with B's version, lock and events, needs edit on B (membership) and view on A, and an agent must say why. Refused when B
   * already (transitively) supersedes A. Then every open step of B is dismissed "superseded by A", so its sign-off is no longer
   * blocked by them and what waited for its rollout is released. Adding it again changes nothing but a missing reason; a dismissed
   * label is written afresh. Returns B.
   */
  async addSupersession(
    email: string,
    superseder: string,
    superseded: string,
    input: { readonly reason?: string | null } = {},
    by: RelationsBy = 'person',
  ): Promise<Result<Glob>> {
    const reason = (input.reason ?? '').trim();
    const result = await this.command(email, superseded, null, (glob) => ok({ glob, changed: false, events: [], effects: [] }), {
      applies: 'any',
      relationPlan: (tx, glob) => this.planSupersession(tx, glob, superseder.trim(), reason, by, email),
    });
    if (!result.ok) return result;
    await this.applySupersession(superseded, email);
    const newer = await this.peek(superseder.trim());
    if (newer !== null) this.publish(newer);
    return ok((await this.peek(superseded)) ?? result.value);
  }

  /** Plans the "superseded by" row on `glob` (B) for `aId` (A): see `addSupersession`. */
  private async planSupersession(tx: Tx, glob: Glob, aId: string, reason: string, by: RelationsBy, viewer: string | null): Promise<Result<RelationWrite>> {
    if (aId === glob.id) return invalidInput('A glob cannot supersede itself');
    const a = await tx.getGlob(aId);
    if (a === null || !(await this.viewableTarget(tx, viewer, a))) return invalidInput(`No glob ${aId}`);
    if (reason.length > MAX_RELATION_REASON) return invalidInput(`A reason is limited to ${MAX_RELATION_REASON} characters`);
    // B (transitively) supersedes A already: A cannot be superseded by B too.
    const seen = new Set<string>();
    let frontier = [aId];
    while (frontier.length > 0) {
      const batch = frontier.filter((id) => !seen.has(id));
      for (const id of batch) seen.add(id);
      frontier = [];
      for (const r of (await tx.listSupersessions(batch)).filter(isActive)) {
        if (r.to === glob.id) return invalidInput(`${glob.id} already supersedes ${aId} (through ${r.from}): that would be a cycle`);
        frontier.push(r.to);
      }
    }
    const existing = (await tx.listSupersessions([glob.id])).find((r) => r.to === aId);
    if (existing !== undefined && isActive(existing)) {
      if (reason === '' || reason === existing.reason) return ok(NO_WRITE);
      return ok({ add: [], update: [{ id: existing.id, patch: { reason } }], remove: [] });
    }
    if (needsReason(by) && reason === '' && (existing?.reason ?? '') === '') return reasonRefusal(glob.id);
    const carried = reason !== '' ? reason : (existing?.reason ?? '');
    return ok({
      add: [{ to: aId, gate: 'sign_off', until: 'merged', reason: carried === '' ? null : carried, evidence: [], source: by, kind: 'superseded_by' }],
      update: [],
      remove: existing === undefined ? [] : [existing.id],
    });
  }

  /**
   * A glob that is superseded has none of its steps to do: every open one is dismissed "superseded by A" (done by slop, logged with a
   * link to A), then the glob moves on as when a step closes (sign-off, and the globs waiting for its rollout). A no-op for a glob that
   * is not superseded, and when nothing is open. Returns how many steps it dismissed.
   */
  async applySupersession(id: string, actor: string | null = null): Promise<number> {
    const closed = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob === null ? 0 : (await this.dismissForSupersession(tx, glob, actor)).length;
    });
    if (closed > 0) await this.afterStepsChanged(id);
    return closed;
  }

  /** Dismisses the open steps of a superseded glob inside a transaction; the steps as saved (none when it is not superseded). */
  private async dismissForSupersession(tx: Tx, glob: Glob, actor: string | null): Promise<StoredHumanStep[]> {
    const label = (await tx.listSupersessions([glob.id])).find(isActive);
    if (label === undefined) return [];
    // A label whose superseder is gone is inert (the superseder's deletion also removes it); one on another board is named by a stub.
    const superseder = await tx.getGlob(label.to);
    if (superseder === null) return [];
    const by = superseder.boardId === glob.boardId ? label.to : OTHER_BOARD_GLOB;
    const open = (await tx.listHumanSteps(glob.boardId, [glob.id])).filter((s) => s.state === 'open');
    if (open.length === 0) return [];
    const now = this.deps.clock.now();
    const closed = open.map((step): StoredHumanStep => ({ ...step, state: 'dismissed', dismissedReason: `superseded by ${by}`, doneBy: 'slop', doneAt: now }));
    await tx.saveHumanSteps(closed);
    await tx.appendEvents(closed.map((step): DomainEvent => ({ type: 'HumanStepChanged', globId: glob.id, actor, at: now, data: { step: step.id, kind: step.kind, title: step.title, change: 'dismissed', link: by } })));
    return closed;
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
        return machine.pickUp(glob, ctx, board, {
          takeOver,
          ...(environment === undefined ? {} : { environment }),
          ...(relations === undefined ? {} : { relations }),
          ...(facts.rolloutSteps === undefined ? {} : { rolloutSteps: facts.rolloutSteps }),
        });
      },
      { relations: true, rollout: true, applies: 'any', record: this.handoverRecorder(wrote) },
    );
    if (result.ok) this.publishHandover(wrote, result.value);
    if (result.ok) return ok({ glob: result.value, warning });
    // A merged glob can't be picked up: say what is left and how to follow up, not just that it merged.
    if (result.error.code === 'invalid_transition' && (result.error.status === 'reviewing' || result.error.status === 'signed_off')) {
      const view = await this.get(email, id);
      if (view.ok) return err({ ...result.error, message: mergedPickUpNotice(view.value.glob, view.value.humanSteps) });
    }
    return result;
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
    return this.command(email, id, version, (glob, ctx) => machine.retryAutofix(glob, ctx), { applies: 'prepared' });
  }

  /** Refused while prerequisites are unmerged, unless `anyway` (a person's choice). */
  retrigger(email: string, id: string, version: number, anyway = false) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.retrigger(glob, ctx, facts.relations, anyway), {
      relations: true,
    });
  }

  resolveConflict(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.resolveConflict(glob, ctx), { applies: 'prepared' });
  }

  startAgain(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAgain(glob, ctx, facts.relations), {
      relations: true,
    });
  }

  /**
   * Merge. A same with open rollout steps lands as a plain merge and slop keeps the glob open for the steps, so there is one
   * Merge for everyone; `continueAfter` (the `merge_continue` alias, or a super's Merge and continue, which needs the latest
   * implementation record at the head) is still accepted.
   */
  merge(email: string, id: string, version: number, continueAfter = false) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.requestMerge(glob, ctx, { continue: continueAfter, facts }),
      { facts: true, relations: true, rollout: true, applies: 'prepared' },
    );
  }

  /**
   * Merge anyway: the `merge` relations holding a ready PR are overridden (logged with who and why) and the merge goes the way
   * Merge would have taken it. A merge held while armed, or a sub's, resumes. Needs a reason. Unlike `merge` it keeps the default
   * `applies: 'work'` rather than `'prepared'`: actions are only held by start relations and never offer merge_anyway.
   */
  mergeAnyway(email: string, id: string, version: number, reason: string) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.mergeAnyway(glob, reason, ctx, { continue: false, facts }),
      { relations: true, rollout: true },
    );
  }

  /**
   * Records that a person's click went through (`machine.actionRequested`). `version` is the one the click's own result returned, so
   * a webhook that moved the glob since wins and nothing is written (a version conflict, which the caller ignores).
   */
  recordRequested(email: string, id: string, kind: machine.Action, version: number, runId?: string) {
    return this.command(email, id, version, (glob, ctx) => machine.actionRequested(glob, { kind, ...(runId === undefined ? {} : { runId }) }, ctx), { applies: 'any' });
  }

  /** Records a click the machine refused as the glob's last outcome (`machine.actionRefused`), on the glob as it is now. */
  recordRefusal(email: string, id: string, kind: machine.Action, reason: string) {
    return this.command(email, id, null, (glob, ctx) => machine.actionRefused(glob, { kind, reason }, ctx), { applies: 'any' });
  }

  /** An action click that records no pending action still clears the last outcome (`machine.outcomeCleared`); a stale version is ignored by the caller. */
  clearOutcome(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.outcomeCleared(glob, ctx), { applies: 'any' });
  }

  /** Cancel merge: disarms "merge when checks pass". */
  cancelMerge(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.cancelMerge(glob, ctx), { applies: 'prepared' });
  }

  /** Retry checks: re-runs the failed jobs of the head's checks (agent-set globs, or a failure the base explains). */
  retryChecks(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retryChecks(glob, ctx), { applies: 'prepared' });
  }

  /** Retry merge: a failed merge (not a conflict) goes back to merging at the head, which already passed. */
  retryMerge(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.retryMerge(glob, ctx, facts.relations), { relations: true, applies: 'prepared' });
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

  /**
   * Sign off anyway: the `sign_off` relations holding a merged glob (approved labels, rollout done) or an accepted decision are
   * overridden (logged with who and why) and it is signed off. Needs a reason.
   */
  signOffAnyway(email: string, id: string, version: number, reason: string) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.signOffAnyway(glob, reason, ctx, facts.rollout ?? null, facts.relations), {
      applies: 'any',
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
    return this.command(email, id, null, (glob, ctx) => machine.readyRequested(glob, runId, ctx), {
      applies: 'prepared',
      // An action whose record is not a branch is ready once what the person runs is stored: the script, or the document.
      prepare: async (tx, glob) => {
        const record = preparationOf(glob)?.record;
        if (record === undefined || record === 'branch') return ok(null);
        const stored = await tx.listArtifacts(glob.id);
        if (record === 'artifact' && !stored.some((a) => a.kind === ROLLOUT_SCRIPT_KIND)) {
          return invalidInput('Store the script first: put_artifact(kind: rollout_script, label: "action: <slug>") with the run ID, then mark ready');
        }
        if (record === 'attachment' && !stored.some((a) => a.kind === 'attachment' && !a.label.startsWith(ACTION_FAILURE_LABEL))) {
          return invalidInput('Attach the document first (attach), then mark ready');
        }
        return ok(null);
      },
    });
  }

  /**
   * Prepared actions: start the first preparation round, or retry a failed one. Refused while a start relation is unmet. The caller
   * drains the outbox (the branch is provisioned and the routine fired from there).
   */
  prepareAction(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.prepareAction(glob, ctx, facts.relations), {
      applies: 'action',
      relations: true,
    });
  }

  /**
   * Prepared actions: the person ran what was prepared and it failed. Another preparation round starts on the same branch and PR (no
   * new generation: nothing has merged). The output is masked and capped (`maskedNote`), and kept with the commands as the attachment
   * `Action run failed (round N)`, which the next round reads as in-scope feedback.
   */
  async failAction(email: string, id: string, note: string, version: number | null) {
    const masked = maskedNote(note);
    const result = await this.command(email, id, version, (glob, ctx) => machine.failAction(glob, ctx), {
      applies: 'action',
      record: async (tx, before, next) => {
        const round = actionOf(before)?.preparation?.rounds ?? 0;
        const plan = (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '';
        const commands = doThisCommands(plan).map((c) => maskSecrets(c));
        await addArtifact(tx, this.deps.clock, next, email, {
          kind: 'attachment',
          label: `${ACTION_FAILURE_LABEL} (round ${round})`,
          content: [
            `# The run failed: ${before.title}`,
            `${email} ran what round ${round} prepared and reported it failing. Round ${round + 1} starts on the same branch (or artifact): change what is needed so the run passes, and do not repeat the failed attempt. Nothing has merged.`,
            '## What was reported',
            masked === '' ? '(no note)' : masked,
            ...(commands.length === 0 ? [] : ["## The run's commands", ...commands.map((c) => `    ${c}`)]),
          ].join('\n\n'),
          link: null,
          commitSha: null,
          runId: null,
          agentSetVersion: null,
          reviewStats: null,
        });
      },
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId: id });
    return result;
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
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.deescalate(glob, ctx, facts), { rollout: true });
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
    { relations: true, applies: 'prepared' }).then(async (result) => {
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
        rows.filter((r) => r.from === from).map((r): DomainEvent => ({ type: 'RelationReleased', globId: from, actor: null, at, data: { to: eventName(r.to, gone.boardId === glob.boardId ? NO_IDS : new Set([r.to])), gate: r.gate, reason: `${eventName(gone.id, gone.boardId === glob.boardId ? NO_IDS : new Set([gone.id]))} was deleted` } })),
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
    // Webhooks and routines report on work globs and on a prepared action's branch (a plain action has no PR).
    return this.command(null, id, null, (glob, ctx, _board, facts) => step(glob, ctx, facts), { applies: 'prepared', ...(options.relations === true ? { relations: true } : {}) });
  }

  /**
   * A glob this one waited for merged (`release_waiting`): starts the globs in Planning that wait for it and for nothing
   * else that is unmerged. Each release is its own write and a no-op when already done, so a retry is safe.
   * Returns the IDs released.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the board no longer limits who is released (a relation may cross boards); callers still pass it
  async releaseDependents(mergedId: string, _boardId: number): Promise<string[]> {
    // The merge is also an outcome for the board's dependency rules (its overlaps went cleanly or not); it never blocks the release.
    // Human work (a decision or an action) has no overlaps to learn from.
    const source = await this.deps.store.transaction((tx) => tx.getGlob(mergedId));
    if (source === null || !isHumanCategory(source.category)) await this.deps.dependencyLearning?.onMerged(mergedId).catch((e: unknown) => this.deps.log?.('dependency learning', e instanceof Error ? e.message : String(e)));
    // Collisions between globs that had no relation (a conflict, a red main) are false negatives; best effort like the learning above.
    if (source === null || !isHumanCategory(source.category)) await this.deps.relationLearning?.onMerged(mergedId);
    const dependants = await this.deps.store.transaction(async (tx) => {
      // A merge on one board releases a holder on another (a relation may point across boards).
      const rows = (await tx.listRelationsTo([mergedId])).filter((r) => isActive(r));
      const from = [...new Set(rows.map((r) => r.from))];
      return from.length === 0 ? [] : await tx.getGlobs(from);
    });
    const released: string[] = [];
    for (const glob of dependants) {
      // A plain action has no start to release: its Done is offered again by what it reads, so the row is only told to reload.
      // A prepared action held in Planning starts its first preparation round once what it waited for is done.
      if (glob.category === 'action') {
        if (glob.status === 'planning' && glob.waiting != null && preparationOf(glob) !== null) {
          const result = await this.release(glob.id);
          if (result.ok && result.value.status !== 'planning') released.push(glob.id);
        } else this.publish(glob);
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
          const states = await this.statesOf(tx, fresh.map((e) => e.id));
          const remove = mine.filter(replaceable).map((r) => r.id);
          // The cycle check reads across boards too: a local edge can close a cycle through a cross-board one.
          const universe = await this.relationUniverse(tx, board, fresh.map((e) => e.id));
          if (!universe.ok) return ok({ add: [], update: [], remove: [], notes: { lines: [`Dropped every inferred relation: ${universe.error.message}`], planHash } });
          const growing: Relation[] = universe.value.filter((r) => !remove.includes(r.id));
          const add: NewRelation[] = [];
          const lines: string[] = [];
          // How readily inference creates gates on this board: a weak source writes `may_relate` links, which hold nothing.
          const inferredPosture = (await this.deps.relationLearning?.posturesIn(tx, glob.boardId))?.inferred;
          const weakNow = await tx.listWeakRelationsFrom([glob.id]);
          for (const edge of fresh) {
            // A person's, a learned or an overridden one to the same glob wins; a deleted or merged glob needs nothing, and a decision
            // that has been decided holds nothing either. The kind must match what it points at.
            const target = known.get(edge.id);
            if (target === undefined || target.boardId !== glob.boardId) continue;
            // Actions are never inferred: only a person or an agent relates to one.
            if (target.category === 'action') continue;
            const decision = edge.kind === 'decision';
            if (decision !== (target.category === 'decision')) continue;
            if (decision ? toState(target) !== 'planning' && toState(target) !== 'open' : !stillHolds({ gate: 'start', until: 'merged' }, states.get(edge.id))) continue;
            if (growing.some((r) => r.from === glob.id && r.to === edge.id && r.gate === 'start')) continue;
            // A module-overlap proposal (inference is bold here) is weak unless the source's measured precision earns it a gate (or an admin pinned gate).
            const gates = !isWeak(inferredPosture) && (edge.bold !== true || inferredPosture?.pinned === true || inferredPosture?.measured === true);
            // A weak link already stored for the pair (any gate) is left as it is: the unique key would refuse a second.
            if (!gates && weakNow.some((r) => r.to === edge.id)) continue;
            const draft: NewRelation = { to: edge.id, gate: 'start', until: decision ? 'decided' : 'merged', reason: edge.reason, evidence: edge.files, source: 'inferred', ...(gates ? {} : { kind: 'may_relate' as const }) };
            const checked = checkRelation(draftOf(glob.boardId, glob.id, draft), glob.boardId, growing, (gid) => known.get(gid));
            if (!checked.ok) {
              lines.push(`Dropped the ${decision ? 'decision' : 'need'} on ${edge.id}: ${checked.error.message}`);
              continue;
            }
            if (gates) growing.push(draftOf(glob.boardId, glob.id, draft));
            add.push(draft);
          }
          // The reason is the model's wording and changes between answers: a need to the same glob stays as it is.
          const kept = add.filter((a) => mine.some((r) => replaceable(r) && r.dismissedAt === null && r.to === a.to));
          const reAdded = new Set(kept.map((a) => a.to));
          const finalRemove = remove.filter((rid) => !reAdded.has(mine.find((r) => r.id === rid)?.to ?? ''));
          const finalAdd = add.filter((a) => !reAdded.has(a.to));
          // A weak link inference no longer proposes goes too (a dismissed one stays as the person's word).
          const staleWeak = weakNow.filter((r) => r.source === 'inferred' && r.dismissedAt === null && !fresh.some((e) => e.id === r.to)).map((r) => r.id);
          return ok({ add: finalAdd, update: [], remove: [...finalRemove, ...staleWeak], ...(lines.length === 0 ? {} : { notes: { lines, planHash } }) });
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
      applies: 'prepared',
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

  /** What a glob still waits for before it starts (its unmet start relations and open start questions), for the routine executor's last check before a session is spent. */
  async startHolds(id: string): Promise<AwaitedDependency[]> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return [...awaitedOf(await this.relationFacts(tx, await tx.listRelationsFrom([id]))), ...(glob === null ? [] : questionAwaits(glob))];
    });
  }

  // -------------------------------------------------------------------------
  // Open questions

  /**
   * Raises a question on a glob (see `domain/questions.ts`). `email` is null for slop itself. A `runId` that is not the glob's
   * current run is ignored (`ignored` says so), like a stale run's artifact. A repeated `key` changes nothing and returns the
   * question the key names. Retries on version races: a raise carries no client version.
   */
  async raiseQuestion(email: string | null, id: string, input: RaiseQuestionInput): Promise<Result<RaisedQuestion>> {
    const { runId, ...asked } = input;
    const seen: { ignored: string | null; before: number } = { ignored: null, before: 0 };
    const result = await this.command(
      email,
      id,
      null,
      (glob, ctx) => {
        seen.ignored = null;
        seen.before = (glob.questions ?? []).length;
        if (runId !== undefined && runId !== null) {
          const run = machine.currentRun(glob);
          if (run === null || run.id !== runId || run.state === 'ended') {
            seen.ignored = `Run ${runId} is not the glob's current run`;
            return ok({ glob, changed: false, events: [], effects: [] });
          }
        }
        return machine.raiseQuestion(glob, asked, ctx);
      },
      { applies: 'work' },
    );
    if (!result.ok) return result;
    const after = result.value.questions ?? [];
    const question =
      seen.ignored !== null ? null : after.length > seen.before ? (after.at(-1) ?? null) : asked.key === undefined ? null : (after.find((q) => q.key === asked.key) ?? null);
    return ok({ glob: result.value, question, ignored: seen.ignored, downgraded: question !== null && question.blocking !== asked.blocking });
  }

  /**
   * A person answers a question. The question and answer are appended to the glob's Clarifications attachment in the same
   * transaction (a new version, so agents and `get_context` read it), then what the question held is released: a held glob
   * starts (a sub gets its run), a held merge resumes. Answering twice with the same text changes nothing.
   */
  async answerQuestion(
    email: string,
    id: string,
    questionId: string,
    input: { readonly answer: string; readonly option?: string | null; readonly runId?: string | null },
  ): Promise<Result<Glob>> {
    return this.closeQuestion(email, id, questionId, (glob, ctx) => machine.answerQuestion(glob, { questionId, ...input }, ctx));
  }

  /** A person dismisses a question: go ahead as is. The one-line decision is recorded in Clarifications too. */
  async dismissQuestion(email: string, id: string, questionId: string, input: { readonly note?: string | null; readonly runId?: string | null }): Promise<Result<Glob>> {
    return this.closeQuestion(email, id, questionId, (glob, ctx) => machine.dismissQuestion(glob, { questionId, ...input }, ctx));
  }

  private async closeQuestion(email: string, id: string, questionId: string, step: (glob: Glob, ctx: Context) => Result<Transition>): Promise<Result<Glob>> {
    const wrote = { value: false };
    const closed: { value: OpenQuestion | null } = { value: null };
    const result = await this.command(email, id, null, step, {
      applies: 'work',
      record: async (tx, _before, next, actor) => {
        wrote.value = false;
        closed.value = null;
        const q = (next.questions ?? []).find((e) => e.id === questionId);
        if (q === undefined || actor === null) return;
        await this.writeClarification(tx, next, actor.email, q);
        closed.value = q;
        wrote.value = true;
      },
    });
    if (!result.ok) return result;
    if (wrote.value) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId: id });
    const held = closed.value;
    // Release what the question held; each is idempotent and a no-op while something else still holds.
    if (held !== null && held.blocking === 'start') await this.release(id);
    if (held !== null && held.blocking === 'merge') await this.gateReleased(id);
    return ok((await this.peek(id)) ?? result.value);
  }

  /** Appends the question's entry to the glob's Clarifications attachment (an existing label of any case is kept), under the artifact lock. */
  private async writeClarification(tx: Tx, glob: Glob, email: string, q: OpenQuestion): Promise<void> {
    await tx.lockGlobArtifacts(glob.id);
    const existing = (await tx.listArtifacts(glob.id, 'attachment')).find((a) => a.label.trim().toLowerCase() === 'clarifications');
    await addArtifact(tx, this.deps.clock, glob, email, {
      kind: 'attachment',
      label: existing?.label ?? CLARIFICATIONS_LABEL,
      content: appendClarification(existing?.content ?? '', q),
      link: null,
      commitSha: null,
      runId: null,
      agentSetVersion: null,
      reviewStats: null,
      by: 'human',
    });
  }

  /**
   * A plan.md version was saved during (or after, before the merge) a run: raises the `merge` question, when it still applies.
   * Idempotent by the question's key; null when nothing is to be raised (the glob merged, or the plan is not newer than the run).
   */
  async raisePlanChanged(id: string, version: number): Promise<Result<RaisedQuestion> | null> {
    const asked = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return null;
      return planChangedQuestion(glob, await tx.artifactVersions(id, 'plan', ''), version);
    });
    return asked === null ? null : this.raiseQuestion(null, id, asked);
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

  /**
   * Which side of a cross-board relation a board is for this viewer: undefined for the glob's own board, else its name (a member of
   * both boards sees it; anyone else gets a hidden stub with no name). A system caller (no viewer) sees everything.
   */
  private sideOf(tx: Tx, viewer: string | null, ownBoardId: number): (boardId: number) => Promise<ExternalGlob | undefined> {
    const known = new Map<number, ExternalGlob>();
    return async (boardId) => {
      if (boardId === ownBoardId) return undefined;
      const cached = known.get(boardId);
      if (cached !== undefined) return cached;
      const member = viewer === null || (await tx.getMember(boardId, viewer)) !== null;
      const found: ExternalGlob = { boardId, boardName: member ? ((await tx.getBoard(boardId))?.name ?? null) : null, hidden: !member };
      known.set(boardId, found);
      return found;
    };
  }

  /** The globs `ids` point at with their states, and which of them sit on another board (by ID), as the viewer may see them. */
  private async seeOthers(
    tx: Tx,
    viewer: string | null,
    ownBoardId: number,
    ids: readonly string[],
  ): Promise<{ readonly reach: { readonly globs: Map<string, Glob>; readonly states: Map<string, ToState> }; readonly external: Map<string, ExternalGlob> }> {
    const reach = await this.reachOf(tx, ids);
    const side = this.sideOf(tx, viewer, ownBoardId);
    const external = new Map<string, ExternalGlob>();
    for (const [id, g] of reach.globs) {
      const found = await side(g.boardId);
      if (found !== undefined) external.set(id, found);
    }
    return { reach, external };
  }

  /** A relation of another glob that waits for this one, as the viewer sees it. */
  private heldBackView(r: Relation, other: Glob | undefined, e: ExternalGlob | undefined): HeldBack {
    const base = { relationId: r.id, gate: r.gate, until: r.until, reason: r.reason, source: r.source, ...verdictOf(r) };
    if (e?.hidden === true) return { ...base, from: OTHER_BOARD, fromTitle: null, external: e };
    return { ...base, from: r.from, fromTitle: other?.title ?? null, ...(e === undefined ? {} : { external: e }) };
  }

  /** The glob's relations in groups: what holds it back, what it holds back, and what no longer holds. */
  private async relationGroupsOf(
    tx: Tx,
    glob: Glob,
    facts: RelationFacts,
    viewer: string | null,
    seen: Awaited<ReturnType<GlobService['seeOthers']>>,
  ): Promise<RelationsView> {
    const withStates: RelationFacts = { relations: facts.relations, states: seen.reach.states };
    const titles = titlesOf(seen.reach.globs);
    const incoming = await tx.listRelationsTo([glob.id]);
    const mine = toState(glob, await this.heldDependants(tx, glob.boardId));
    const open = incoming.filter((r) => isActive(r) && !isMet(r, mine));
    const others = new Map((open.length === 0 ? [] : await tx.getGlobs([...new Set(open.map((r) => r.from))])).map((g) => [g.id, g]));
    const side = this.sideOf(tx, viewer, glob.boardId);
    const holdsBack: HeldBack[] = [];
    for (const r of open) {
      const other = others.get(r.from);
      holdsBack.push(this.heldBackView(r, other, other === undefined ? undefined : await side(other.boardId)));
    }
    const supersessions = await this.supersessionsOf(tx, viewer, glob);
    const weak = await this.weakOf(tx, viewer, glob);
    return {
      holding: holdingOf(withStates, titles).map((h) => holdingView(h, seen.external.get(h.to))),
      holdsBack,
      done: doneOf(withStates, titles).map((d) => doneView(d, seen.external.get(d.to))),
      ...(weak.length === 0 ? {} : { weak }),
      ...supersessions,
    };
  }

  /** The glob's weak links ("may relate", not dismissed): they hold nothing, so they come from their own read and never touch the gate facts. */
  private async weakOf(tx: Tx, viewer: string | null, glob: Glob): Promise<WeakRelation[]> {
    const rows = (await tx.listWeakRelationsFrom([glob.id])).filter(isActive);
    if (rows.length === 0) return [];
    const reach = await this.reachOf(tx, rows.map((r) => r.to));
    const side = this.sideOf(tx, viewer, glob.boardId);
    const out: WeakRelation[] = [];
    for (const r of rows) {
      const to = reach.globs.get(r.to);
      const e = to === undefined ? undefined : await side(to.boardId);
      const base = { relationId: r.id, gate: r.gate, until: r.until, reason: r.reason, source: r.source, state: reach.states.get(r.to) ?? ('missing' as const) };
      if (e?.hidden === true) out.push({ ...base, to: OTHER_BOARD, toTitle: null, state: 'open', external: e });
      else out.push({ ...base, to: r.to, toTitle: to?.title ?? null, ...(e === undefined ? {} : { external: e }) });
    }
    return out;
  }

  /** `supersededBy` on a glob that was superseded, `supersedes` on the one that supersedes others (each only when there is one). */
  private async supersessionsOf(tx: Tx, viewer: string | null, glob: Glob): Promise<{ supersededBy?: Supersession; supersedes?: Supersession[] }> {
    const by = (await tx.listSupersessions([glob.id])).filter(isActive);
    const over = (await tx.listSupersededBy([glob.id])).filter(isActive);
    if (by.length === 0 && over.length === 0) return {};
    const others = new Map((await tx.getGlobs([...new Set([...by.map((r) => r.to), ...over.map((r) => r.from)])])).map((g) => [g.id, g]));
    const side = this.sideOf(tx, viewer, glob.boardId);
    const view = async (r: Relation, otherId: string): Promise<Supersession | null> => {
      const other = others.get(otherId);
      if (other === undefined) return null;
      const e = await side(other.boardId);
      const base = { reason: r.reason, source: r.source, relationId: r.id };
      return e?.hidden === true ? { ...base, id: OTHER_BOARD, title: null, hidden: true, external: e } : { ...base, id: other.id, title: other.title, ...(e === undefined ? {} : { external: e }) };
    };
    const first = by[0];
    const supersededBy = first === undefined ? null : await view(first, first.to);
    const supersedes: Supersession[] = [];
    for (const r of over) {
      const v = await view(r, r.from);
      if (v !== null) supersedes.push(v);
    }
    return { ...(supersededBy === null ? {} : { supersededBy }), ...(supersedes.length === 0 ? {} : { supersedes }) };
  }

  /** Who waits for each of these globs of one board (their unmet relations, any board), redacted for the viewer: one read of the rows. */
  private async holdsBackOf(tx: Tx, viewer: string | null, globs: readonly Glob[]): Promise<Map<string, HeldBack[]>> {
    const found = new Map<string, HeldBack[]>();
    const first = globs[0];
    if (first === undefined) return found;
    const byId = new Map(globs.map((g) => [g.id, g]));
    const held = await this.heldDependants(tx, first.boardId);
    const open = (await tx.listRelationsTo(globs.map((g) => g.id))).filter((r) => isActive(r) && !isMet(r, toState(byId.get(r.to), held)));
    if (open.length === 0) return found;
    const holders = new Map((await tx.getGlobs([...new Set(open.map((r) => r.from))])).map((g) => [g.id, g]));
    const side = this.sideOf(tx, viewer, first.boardId);
    for (const r of open) {
      const other = holders.get(r.from);
      found.set(r.to, [...(found.get(r.to) ?? []), this.heldBackView(r, other, other === undefined ? undefined : await side(other.boardId))]);
    }
    return found;
  }

  /** The open card suggestions of these globs, by glob: a failed step's "is there a fix glob?" (old open mention rows are not shown). */
  private async suggestionsOf(tx: Tx, globIds: readonly string[]): Promise<Map<string, RelationSuggestion[]>> {
    const found = new Map<string, RelationSuggestion[]>();
    const rows = globIds.length === 0 ? [] : await tx.listOpenSuggestions(globIds);
    for (const row of rows) {
      if (row.kind !== 'step_failed') continue;
      found.set(row.globId, [...(found.get(row.globId) ?? []), suggestionView(row)]);
    }
    return found;
  }

  /** A glob's relations with the state of each glob they point at. */
  private async relationFacts(tx: Tx, relations: readonly Relation[]): Promise<RelationFacts> {
    const ids = [...new Set(relations.map((r) => r.to))];
    const reach = await this.reachOf(tx, ids);
    const external = new Set(relations.filter((r) => {
      const board = reach.globs.get(r.to)?.boardId;
      return board !== undefined && board !== r.boardId;
    }).map((r) => r.to));
    return { relations, states: reach.states, ...(external.size === 0 ? {} : { external }) };
  }

  /** The ids among `ids` of globs on a board other than `boardId`: what stored or machine text names by a stub. */
  private async externalIds(tx: Tx, boardId: number, ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    return new Set((await tx.getGlobs(unique)).filter((g) => g.boardId !== boardId).map((g) => g.id));
  }

  /** The globs in Planning that wait for `id` before they start; those on a board the viewer can't see are only counted. */
  private async waitedOnBy(tx: Tx, id: string, viewer: string | null): Promise<{ readonly ids: string[]; readonly other: number }> {
    const from = [...new Set((await tx.listRelationsTo([id])).filter((r) => r.gate === 'start' && isActive(r)).map((r) => r.from))];
    const waiting = from.length === 0 ? [] : (await tx.getGlobs(from)).filter((g) => g.status === 'planning');
    const own = await tx.getGlob(id);
    const side = this.sideOf(tx, viewer, own?.boardId ?? -1);
    const ids: string[] = [];
    let other = 0;
    for (const g of waiting) {
      if ((await side(g.boardId))?.hidden === true) other++;
      else ids.push(g.id);
    }
    return { ids, other };
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
    /** Run inside this transaction (several commands in one), instead of opening one. */
    within?: Tx,
  ): Promise<Result<Glob> | 'retry'> {
    const run = async (tx: Tx): Promise<Result<Glob> | 'retry'> => {
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
      const refused =
        applies === 'any'
          ? false
          : applies === 'work'
            ? isHumanCategory(glob.category)
            : applies === 'prepared'
              ? isHumanCategory(glob.category) && preparationOf(glob) === null
              : glob.category !== applies;
      if (refused) {
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
        // One lock for the whole instance: a relation may cross boards, so two boards' writers must not check their cycles at once.
        await tx.lockRelations();
        const board = await tx.listRelations(glob.boardId);
        const planned = await options.relationPlan(tx, glob, board, this.deps.clock.now());
        if (!planned.ok) return planned;
        write = planned.value;
        const applied = applyWrite(board.filter((r) => r.from === glob.id), write, { boardId: glob.boardId, from: glob.id, now: this.deps.clock.now(), newId: () => this.relationId() });
        // A weak link is stored with the others but is not a fact the machine reads: it holds nothing.
        rows = applied.relations.filter((r) => r.kind !== 'may_relate');
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
      const storedSteps = options.rollout === true ? await tx.listHumanSteps(glob.boardId, [glob.id]) : [];
      const rollout =
        options.rollout === true
          ? { rollout: storedBlockProgress(storedSteps, 'sign_off'), rolloutSteps: openRolloutSteps(storedSteps) }
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
        for (const e of edits) {
          await tx.updateRelation(e.id, { overriddenAt: e.overriddenAt });
          // Going ahead of a relation that still held is a false positive for its source; learning never fails the write.
          const held = before.find((r) => r.id === e.id);
          if (held !== undefined) await this.learn(() => this.deps.relationLearning?.overridden(tx, held));
        }
        if (inserted.length > 0) {
          const weakBefore = await tx.listWeakRelationsFrom([glob.id]);
          // A person's relation that slop had not made (no row of any kind to that glob) is a false negative for slop's sources.
          if (this.deps.relationLearning !== undefined) {
            for (const r of inserted) await this.learn(() => this.deps.relationLearning?.personAdded(tx, glob, r, [...before, ...weakBefore]));
          }
          // A gate for a pair makes a weak link to the same glob redundant.
          const gated = new Set(inserted.filter((r) => (r.kind ?? 'waits') === 'waits').map((r) => r.to));
          for (const weak of weakBefore) if (gated.has(weak.to)) await tx.deleteRelation(weak.id);
        }
        const external = await this.externalIds(tx, glob.boardId, [...before, ...inserted].map((r) => r.to));
        const logged = relationEvents(glob.id, ctx.actor?.email ?? null, ctx.now, before, write, inserted, external);
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
    };
    return within === undefined ? this.deps.store.transaction(run) : run(within);
  }

  /** Runs a learning write that never fails the transition it rides on. */
  private async learn(run: () => Promise<void> | undefined): Promise<void> {
    try {
      await run();
    } catch (e) {
      this.deps.log?.('relation learning', e instanceof Error ? e.message : String(e));
    }
  }

  private relationId(): string {
    return `rel_${this.deps.ids.runId()}`;
  }

  /** Inserts the relations of a glob created in this transaction, with an event each. */
  private async writeNew(tx: Tx, glob: Glob, inserted: readonly Relation[], actor: string | null, at: string): Promise<void> {
    for (const r of inserted) {
      if (!(await tx.insertRelation(r))) throw new Error(`Relation from ${glob.id} to ${r.to} already exists`);
    }
    if (inserted.length > 0) {
      const external = await this.externalIds(tx, glob.boardId, inserted.map((r) => r.to));
      // The create-time classifier reads the plan only.
      await tx.appendEvents(inserted.map((r) => relationAdded(r, actor, at, external, 'plan')));
    }
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
