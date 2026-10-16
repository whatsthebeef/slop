import type { GlobAttributes } from './attributes.js';
import type { JsonValue } from './events.js';
import type { OpenQuestion } from './questions.js';
import type { ReviewBoardSettings } from './review-settings.js';

/** What an admin's agent may approve through `decide_kb_item`: documentation items only, or agent-set files and contradicting items too. */
export const AGENT_KB_APPROVALS = ['docs', 'docs_and_agent_files'] as const;
export type AgentKbApproval = (typeof AGENT_KB_APPROVALS)[number];
export const AGENT_KB_APPROVAL_DEFAULT: AgentKbApproval = 'docs';

export const SLOP_TYPES = ['sub', 'same', 'super'] as const;
export type SlopType = (typeof SLOP_TYPES)[number];

/** What a person or intake may create through the work form; `decision` globs come from KB items, the inbox and the backfill only. */
export const WORK_CATEGORIES = ['feature', 'task', 'bug'] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];
/** Human work: a choice (decision) or something a person does (action). It has no type and never runs, branches or merges. */
export const HUMAN_CATEGORIES = ['decision', 'action'] as const;
export type HumanCategory = (typeof HUMAN_CATEGORIES)[number];
export const CATEGORIES = [...WORK_CATEGORIES, ...HUMAN_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

export const isHumanCategory = (category: Category): category is HumanCategory => category === 'decision' || category === 'action';

/** Who does the work (named WorkActor because `Actor` is the signed-in person): a machine (agents, with or without a person reviewing or pairing) or a human. */
export type WorkActor = 'machine' | 'human';
/** How the actor works: a machine's type (sub, same, super) or a human's kind of work (decision, action). */
export type Mode = SlopType | HumanCategory;

/** What the time report counts a glob as. */
export const WORK_KINDS = ['rnd', 'maintenance'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Who set `fix` or `workKind`: slop's inference, or a person (which inference never overwrites). */
export type InferenceSource = 'inferred' | 'person';

/** Human iff the category is human work. */
export const actorOf = (g: { readonly category: Category }): WorkActor => (isHumanCategory(g.category) ? 'human' : 'machine');

/**
 * A machine glob's type, a human glob's category. A machine glob without a type cannot exist after migration 0075; if a
 * malformed record has none it reads as `same` (a person reviews it), the safe middle.
 */
export const modeOf = (g: { readonly category: Category; readonly type: SlopType | null }): Mode =>
  isHumanCategory(g.category) ? g.category : (g.type ?? 'same');

/** The fix flag of a glob without one stored (a record from before it existed): bugs fix something. */
export const defaultFix = (category: Category): boolean => category === 'bug';
/**
 * The category a new or changed glob is stored under: `feature` is still accepted as input (and read on old globs) but nobody
 * sees or chooses it, so it is stored as `task`. The R&D work kind it implies must be read from the asked category first.
 */
export const storedCategory = <C extends Category>(category: C): Exclude<C, 'feature'> | 'task' =>
  (category === 'feature' ? 'task' : category) as Exclude<C, 'feature'> | 'task';

/** The work kind of a glob without one stored: features (old globs, or an asked `feature`) are R&D, everything else is maintenance. */
export const defaultWorkKind = (category: Category): WorkKind => (category === 'feature' ? 'rnd' : 'maintenance');

/** The fix flag, reading a legacy record by its category. Human work is never a fix. */
export const fixOf = (g: { readonly category: Category; readonly fix?: boolean | undefined }): boolean =>
  isHumanCategory(g.category) ? false : (g.fix ?? defaultFix(g.category));
/** The work kind, reading a legacy record by its category. */
export const workKindOf = (g: { readonly category: Category; readonly workKind?: WorkKind | undefined }): WorkKind =>
  g.workKind ?? defaultWorkKind(g.category);

export const STATUSES = [
  'planning',
  'implementing',
  'in_progress',
  'failed',
  'pr_open',
  'merging',
  'reviewing',
  'signed_off',
] as const;
export type Status = (typeof STATUSES)[number];

export const LISTS = ['planning', 'doing', 'reviewing', 'signed_off'] as const;
export type List = (typeof LISTS)[number];

export const LABEL_NAMES = ['FR', 'CR', 'QA'] as const;
export type LabelName = (typeof LABEL_NAMES)[number];
/**
 * required: waiting for the reviewer (initially, and whenever the developer resubmits);
 * added: the reviewer added checklist items for the developer to work through;
 * approved: the reviewer is satisfied, with or without items.
 */
export const LABEL_STATES = ['required', 'added', 'approved'] as const;
export type LabelState = (typeof LABEL_STATES)[number];
export type Labels = Partial<Record<LabelName, LabelState>>;

/** One thing a reviewer asked for on a sign-off label; kept across the label's states. */
export interface ChecklistItem {
  /** Unique within its label. */
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly addedBy: string;
  readonly addedAt: string;
  /** Who last ticked the item, and when; null while unticked. */
  readonly doneBy: string | null;
  readonly doneAt: string | null;
  /** True while the reviewer has saved the item but not sent it (label `required`); absent on sent items. */
  readonly draft?: boolean;
}
export type Checklists = Partial<Record<LabelName, readonly ChecklistItem[]>>;

export const ROLES = ['admin', 'dev', 'qa', 'po'] as const;
export type Role = (typeof ROLES)[number];

export type RunState = 'queued' | 'active' | 'watching' | 'ended';
export type RunOutcome = 'completed' | 'failed' | 'superseded';

export interface Run {
  readonly id: string;
  readonly state: RunState;
  readonly outcome: RunOutcome | null;
  readonly generation: number;
  readonly triggeredBy: string;
  readonly routineOwner: string;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly lastProgressAt: string | null;
  readonly endedAt: string | null;
  readonly failureReason: string | null;
  /** The cloud session started by the fire request, for Open in Claude and Continue locally. */
  readonly sessionId: string | null;
  readonly sessionUrl: string | null;
  /** Set on the run slop queued by itself after a watching run gave up: the one automatic retry. */
  readonly autoRetry?: true;
  /**
   * `investigate`: an investigate-only run on a glob in Planning (orchestrator Phases 1–2, no branch, no commits). It ends
   * when its investigation is pushed. `resolve_conflict`: a run on an open PR that merges the base branch in and pushes.
   * Absent on every implementing run.
   */
  readonly purpose?: RunPurpose;
}

export const RUN_PURPOSES = ['investigate', 'resolve_conflict'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

export type PrState = 'draft' | 'ready' | 'closed' | 'merged';

export interface PullRequest {
  readonly number: number;
  readonly state: PrState;
  readonly headSha: string | null;
}

/** A PR a super landed with Merge and continue; the glob kept going on the same branch. */
export interface MergedPr {
  readonly number: number;
  /** The squash commit on the base branch. */
  readonly mergeSha: string;
  readonly mergedAt: string;
}

/**
 * `continue`: the merge in progress is a super's Merge and continue, so the glob stays in Doing.
 * `when_green`: Merge was pressed before the head's checks passed: slop merges the moment they do (the glob stays in
 * pr_open meanwhile), and disarms if they fail, the PR conflicts or a person cancels.
 */
export type MergeMode = 'continue' | 'when_green';

/** Result of the required checks on the PR's current head commit. */
export interface HeadChecks {
  readonly sha: string;
  readonly state: 'pending' | 'passed' | 'failed';
  /** When the checks were first seen failed on this head; absent on results recorded before it was kept. */
  readonly at?: string;
  /** What failed, from the failing check run's log (state `failed` only; absent when the log couldn't be read). */
  readonly failure?: CheckFailure;
  /** Set when the base branch fails the same check with the same first error: not this glob's change. */
  readonly inheritedFrom?: InheritedFailure;
}

/** The failing check on a commit, short enough for a card: the step and the first error lines of its log. */
export interface CheckFailure {
  /** The check run's name, e.g. `Type check`. */
  readonly name: string;
  /** The step that failed, when the run reports one. */
  readonly step: string | null;
  /** The first error lines from the end of the job log, a few lines at most. */
  readonly lines: readonly string[];
  /** Link to the run on the code host. */
  readonly url: string | null;
}

/** A glob's failed checks that the base branch fails too. `since` is the glob whose merge turned the base red. */
export interface InheritedFailure {
  readonly base: string;
  readonly since: string | null;
}

/** The latest check result for the head of a board's base branch. */
export interface BaseChecks {
  readonly sha: string;
  readonly state: 'passed' | 'failed';
  readonly failure?: CheckFailure;
  /** The first commit seen red in this red run (`sha` is the latest head, which may be a later commit that stays red). */
  readonly redSha?: string;
  /**
   * The glob whose squash commit is `redSha` (from its `<id>: <title>`), only when that commit's parent was green; null when the
   * cause is unclear (the base was already red, the parent's checks are unknown, or no glob merged it) or the base is green.
   */
  readonly since: string | null;
  /** When the base was first seen red, kept across new commits that stay red. */
  readonly redAt?: string;
  readonly checkedAt: string;
}

/** `none` until the glob first enters Doing: branches and draft PRs are created when work starts. */
export type ProvisioningState = 'none' | 'pending' | 'ok' | 'failed';

/** A running sub an agent (or a person) flagged as needing a human, which made it a same; cleared when it is made a sub again. */
export interface Escalation {
  readonly reason: string;
  /** Which of the board's escalation criteria it was for (`ESCALATION_CRITERIA`); the outcome learning moves that criterion. */
  readonly criterion?: string;
  /** What showed it: files, findings, the unsettled choice. */
  readonly evidence?: string;
  /** Who escalated: the person's email, or the routine owner for a run. */
  readonly by: string;
  readonly at: string;
  /** Set when a routine run escalated. */
  readonly runId?: string;
}

export interface Failure {
  readonly reason: string;
  readonly at: string;
  /** Failure reports: the agent-set version the session or run used, when it said. */
  readonly agentSetVersion?: number;
  /** Set when slop's merge failed on a conflict with the base branch (`files`: those both sides changed, when known). */
  readonly conflict?: MergeConflict;
  /** Set when slop's own merge attempt failed: a later push to the branch recovers the glob (row 16a). */
  readonly kind?: 'merge' | 'reverted' | 'provisioning' | 'needs_pairing';
  /** `needs_pairing`: the decision the routine would have had to guess, for the person who takes it over as a super. */
  readonly decision?: string;
  /** A merge queue removal for failed checks: the failing check on the queue's combined result. */
  readonly checks?: CheckFailure;
}

/** Where a merging PR is in the code host's merge queue. */
export interface MergeQueueState {
  /** When slop saw it enqueued. */
  readonly since: string;
  /** The PR head that was enqueued. */
  readonly sha: string;
  /** The queue's 1-based position (the PRs ahead are `position - 1`); null when unknown. */
  readonly position: number | null;
  readonly state: 'queued' | 'merging';
  /** The merge group commit whose checks failed, when a check run on it said so (the dequeue's failure lines come from it). */
  readonly failedSha?: string;
}

export interface MergeConflict {
  readonly base: string;
  readonly files: readonly string[];
}

/** A conflict between an open PR and the base branch, found after a merge or when a merge failed on one. */
export interface OpenConflict extends MergeConflict {
  /** The glob whose merge caused it; null when not known (a failed merge). */
  readonly since: string | null;
  readonly at: string;
}

/** How far a glob's branch is behind the base branch, read from the code host before any conflict exists. */
export interface BehindBase {
  readonly base: string;
  /** Commits on the base the branch lacks (a merge each, under squash merging). */
  readonly behindBy: number;
  /** Files changed on both sides since they diverged: where a conflict can be. */
  readonly files: readonly string[];
  readonly at: string;
  /** The PR head the distance was read for. A record for another head than the glob's current one is out of date. */
  readonly headSha?: string | null;
}

/** What an edge between two globs means: `needs` (the code must be on main; blocks start) or `overlaps` (same files; orders merges only). */
export type EdgeKind = 'needs' | 'overlaps';
/**
 * Who set an edge: a person or a split (`explicit`), path prediction (`implied`), slop's learning from outcomes (`learned`),
 * or inference from the plan and the other globs (`inferred`, the reason in `evidence`).
 */
export type EdgeSource = 'explicit' | 'implied' | 'learned' | 'inferred';

/**
 * An edge slop recorded beside `after` (the explicit needs): the board's merge policy predicted that both globs may change
 * `paths` (an overlap), or slop learned the glob needs `id` from a run that failed without it (a need).
 */
export interface ImpliedAfter {
  readonly id: string;
  readonly paths: readonly string[];
  /** Absent means `overlaps`: predictions never block a start. Only a learned `needs` does. */
  readonly kind?: EdgeKind;
  /** Absent means `implied`. */
  readonly source?: EdgeSource;
  /** The run or event that set it, for learned edges. */
  readonly evidence?: string;
  /** Set when a person chose Start now: kept for display, no longer holds. */
  readonly overridden?: true;
  /** Set with `overridden` when a person said it is not a dependency: the hash of the plan then, so a changed plan may infer it again. */
  readonly dismissedPlanHash?: string;
}

/** What `from` cannot do yet while a relation is unmet: start, merge, or be signed off. */
export const RELATION_GATES = ['start', 'merge', 'sign_off'] as const;
export type RelationGate = (typeof RELATION_GATES)[number];
/** What `to` must reach for the gate to open: merged, decided (a decision glob's outcome), done (an action glob's outcome) or signed off. */
export const RELATION_UNTILS = ['merged', 'decided', 'done', 'signed_off'] as const;
export type RelationUntil = (typeof RELATION_UNTILS)[number];
/**
 * Who set a relation: a person, slop's inference, slop's learning from outcomes, an agent, or (old rows only; nothing creates it now) a split.
 * `auto`: slop's automatic pass read the glob's text and added it (shown "added automatically", dismissible); reason rules treat it like `agent`.
 */
export const RELATION_SOURCES = ['person', 'inferred', 'learned', 'split', 'agent', 'auto'] as const;
export type RelationSource = (typeof RELATION_SOURCES)[number];
/**
 * What a relation row means. `waits`: `from` can't pass `gate` until `to` reaches `until`. `superseded_by`: `from` is superseded by
 * `to` (gate and until are inert placeholders). The list methods the gate code reads return only `waits` rows.
 */
export const RELATION_KINDS = ['waits', 'superseded_by'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * One glob held back by another: `from` can't pass `gate` until `to` reaches `until`. Stored in the `relations` table, not on
 * the glob. A relation no longer holds once it is dismissed, overridden (Start now) or its `to` was deleted.
 */
export interface Relation {
  readonly id: string;
  readonly boardId: number;
  /** The glob held back. */
  readonly from: string;
  /** The glob (or decision glob) it waits on. It has no foreign key: a deleted `to` leaves the row, so the view can say so. */
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  /** One line: why it waits. */
  readonly reason: string | null;
  /** Files or symbols that show it. */
  readonly evidence: readonly string[];
  readonly source: RelationSource;
  /** `waits` (the default; absent on a row written before supersedes) or `superseded_by`. */
  readonly kind?: RelationKind;
  /** The group this relation was set for ("every glob in group X waits for D"); null for an ordinary one. Set on each glob's own row. */
  readonly group: string | null;
  /** Set when a person dismissed it as not a dependency, with the plan hash then (a changed plan may infer it again). */
  readonly dismissedAt: string | null;
  readonly dismissedPlanHash: string | null;
  /** Set when a person chose Start now over it (inferred and learned start relations only). */
  readonly overriddenAt: string | null;
  readonly createdAt: string;
}

/** The fields of a relation that change after it is made. */
export type RelationPatch = Partial<Pick<Relation, 'until' | 'reason' | 'evidence' | 'dismissedAt' | 'dismissedPlanHash' | 'overriddenAt' | 'group'>>;

/**
 * How two decisions relate, as the KB pipeline (or an admin) found: closed into another learning (`duplicate_of`,
 * `suppressed_by`, `covered_by`), a hint that another may already say it (`possibly_covered_by`), a contradiction, or a
 * pair an admin kept apart by reopening a merge. Kept apart from the dependency edges (`after`, `impliedAfter`) on purpose:
 * they never hold a start or order a merge.
 */
export const DECISION_EDGE_KINDS = ['duplicate_of', 'suppressed_by', 'covered_by', 'possibly_covered_by', 'contradicts', 'kept_apart_from'] as const;
export type DecisionEdgeKind = (typeof DECISION_EDGE_KINDS)[number];

/** The links that close a decision: Reopen removes them. */
export const CLOSING_EDGE_KINDS: readonly DecisionEdgeKind[] = ['duplicate_of', 'suppressed_by', 'covered_by'];

/** A link from a decision glob to another (`id`): set by the KB `pipeline` or by a person (`explicit`), with its details. */
export interface GlobLink {
  readonly id: string;
  readonly kind: DecisionEdgeKind;
  readonly source: 'pipeline' | 'explicit';
  /** Per kind: a coverage hint's quotes and claim (`possibly_covered_by`), a contradiction's note (`contradicts`). */
  readonly detail?: JsonValue;
}

/** Another open glob that changes some of the same exclusive paths as this one; a warning, never a block. */
export interface PathClash {
  readonly with: string;
  readonly paths: readonly string[];
}

/**
 * Which globs a listing includes: `work` (the default: features, tasks and bugs, so every consumer that treats a glob as
 * work is unchanged), `decisions` (decision globs only), `actions` (action globs only), `human` (decisions and actions) or
 * `all`. Anything that must see human work asks for it.
 */
export type GlobInclude = 'work' | 'decisions' | 'actions' | 'human' | 'all';

/** Whether a listing with this `include` (default `work`) takes a glob of this category. */
export const includes = (include: GlobInclude | undefined, category: Category): boolean => {
  switch (include ?? 'work') {
    case 'all':
      return true;
    case 'decisions':
      return category === 'decision';
    case 'actions':
      return category === 'action';
    case 'human':
      return category === 'decision' || category === 'action';
    case 'work':
      return category !== 'decision' && category !== 'action';
  }
};

/** A glob that has a type: code work. */
export type CodeGlob = Glob & { readonly type: SlopType };
export const isCodeGlob = (glob: Glob): glob is CodeGlob => glob.type !== null;

export interface Glob {
  readonly id: string;
  readonly boardId: number;
  readonly title: string;
  /** Null for human work (decision and action globs): a type only says how code work is done. */
  readonly type: SlopType | null;
  readonly category: Category;
  /**
   * Whether the work fixes something broken (drives the bug path: reproduce first, never a super, left out of size learning).
   * Optional on the type for records from before it existed; read it through `fixOf`.
   */
  readonly fix?: boolean;
  readonly fixSource?: InferenceSource;
  /** What the time report counts this glob as; read it through `workKindOf`. */
  readonly workKind?: WorkKind;
  readonly workKindSource?: InferenceSource;
  /** Why `fix` and `workKind` have their values (inference's reason); null or absent when none was recorded. */
  readonly inferenceReason?: string | null;
  /** Per-category fields (a decision's scope and outcome); absent on legacy globs. */
  readonly attributes?: GlobAttributes;
  readonly group: string | null;
  readonly environment: string | null;
  readonly status: Status;
  readonly version: number;
  readonly generation: number;
  readonly creator: string;
  readonly planner: string;
  readonly implementer: string | null;
  readonly labels: Labels;
  /** Each sign-off label's review checklist; read-only once the glob is signed off. */
  readonly checklists: Checklists;
  readonly pr: PullRequest | null;
  /** PRs merged with Merge and continue, oldest first (supers); the final PR stays in `pr`. */
  readonly prs: readonly MergedPr[];
  /** Set while a Merge and continue is merging; null otherwise. */
  readonly mergeMode: MergeMode | null;
  /** Times slop updated a behind branch for the current merge request; a new Merge press starts it again at 0. */
  readonly mergeUpdates?: number;
  /** Set while the merging PR sits in the code host's merge queue (null or absent: slop merges it directly). */
  readonly mergeQueue?: MergeQueueState | null;
  readonly headChecks: HeadChecks | null;
  /** Every routine run, oldest first; the last one is the current run. */
  readonly runs: readonly Run[];
  readonly failure: Failure | null;
  /** Why a human should check this glob, when a sub was escalated to a same during implementation or review. */
  readonly escalation?: Escalation | null;
  /** Set while the open PR conflicts with the base branch; cleared when it merges cleanly again. */
  readonly conflict?: OpenConflict | null;
  /** Set while the branch of a glob in Doing lacks commits from the base branch; cleared when it is up to date. */
  readonly behind?: BehindBase | null;
  /** IDs of globs on the board this one waits for before it starts (unmerged when set). */
  readonly after?: readonly string[];
  /** Holds from the board's merge policy (exclusive paths): the same as `after`, with the reason. */
  readonly impliedAfter?: readonly ImpliedAfter[];
  /** Decisions only: how this decision relates to others (never a dependency; see `GlobLink`). */
  readonly links?: readonly GlobLink[];
  /**
   * Set while the glob is held in Planning for its `after`; cleared when released, started anyway or picked up. With
   * `investigation`, Start was pressed while an investigate-only run was live: the glob starts by itself when that run ends.
   */
  readonly waiting?: {
    readonly since: string;
    readonly investigation?: { readonly runId: string; readonly by: string };
  } | null;
  /**
   * Set while a merge that would have started is held back by an unmet `merge` relation (an armed merge-when-green whose checks
   * passed, or a sub whose gate passed): `sha` is the head it would merge. `gateReleased` resumes it; cleared on merge, disarm or a new head.
   */
  readonly mergeHold?: {
    readonly since: string;
    readonly sha: string;
    readonly for: readonly string[];
    /** The open `merge` questions that hold it too (IDs). */
    readonly questions?: readonly string[];
  } | null;
  /** Open questions raised on this glob (and the answered or dismissed ones): see `domain/questions.ts`. Absent on older globs. */
  readonly questions?: readonly OpenQuestion[];
  /** Set while another open glob changes the same exclusive paths; cleared when it no longer does. */
  readonly clash?: PathClash | null;
  readonly provisioning: ProvisioningState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly signedOffAt: string | null;
  /** When the glob last entered Doing; null outside Doing. Drives the aging colour. */
  readonly doingSince: string | null;
  /**
   * When the glob entered the list it is in (Planning, Doing, Reviewing, Signed Off): set when a transition changes the list,
   * left alone by everything else. The board orders its lists by it. Absent on documents from before it existed (the migration backfills it).
   */
  readonly listSince?: string;
}

/**
 * What deploys an environment besides branch deploys, which slop observes: `integration` is deployed by the base
 * branch's own pipeline, `release` by release refs cut from it. Without a role slop doesn't track which globs it holds.
 */
export const ENVIRONMENT_ROLES = ['integration', 'release'] as const;
export type EnvironmentRole = (typeof ENVIRONMENT_ROLES)[number];

/** How slop learns of an observed environment's deploys: a pipeline reports them (the default), or a person records each one. */
export const ENVIRONMENT_DEPLOY_KNOWN = ['pipeline', 'manual'] as const;
export type EnvironmentDeployKnown = (typeof ENVIRONMENT_DEPLOY_KNOWN)[number];

export interface Environment {
  readonly name: string;
  readonly allowBranchDeploy: boolean;
  /** At most one per board: the environment a sub gets when it is created without one. */
  readonly subDefault?: true;
  /** Set when the board's pipelines deploy the base branch or a release ref here and report it to slop. */
  readonly role?: EnvironmentRole;
  /** Only with a role: `manual` when a person records each deploy in slop. Absent means a pipeline reports them (`report-deploy.sh`). */
  readonly deployKnown?: 'manual';
  /** At most one per board, and only a release environment: deploying a glob here before sign-off is warned about. */
  readonly production?: true;
}

/**
 * How a board's branch deploys run. Deploy scripts never run on slop's server: slop starts the
 * provider's job, which runs the repo's `.sstor/deploy.sh <env>`.
 */
export type DeployIntegration =
  | {
      readonly provider: 'codebuild';
      readonly region: string;
      /** The CodeBuild project for environments without their own. */
      readonly defaultProject: string;
      /** Per environment, a CodeBuild project overriding the default. */
      readonly projects: Readonly<Record<string, string>>;
    }
  | {
      readonly provider: 'github_actions';
      /** The workflow file dispatched for deploys, e.g. `slop-deploy.yml`. */
      readonly workflow: string;
    };

/**
 * How a board's ATF stage learns what to run after a deploy. `pull`: the pipeline asks slop (`GET /api/boards/:b/atf-specs`).
 * `push`: slop starts the CodeBuild project itself with the spec list in environment variable overrides (a person sets up the
 * project and a role slop can assume; slop creates nothing in AWS).
 */
export interface AtfIntegration {
  readonly provider: 'codebuild';
  readonly region: string;
  readonly project: string;
  /** A role slop assumes to start the build; the server's own credentials when absent. */
  readonly roleArn?: string;
  readonly mode: 'pull' | 'push';
  /**
   * The `sts:ExternalId` slop sends on every AssumeRole for this board (the role owner puts it in the trust policy's
   * `sts:ExternalId` condition). Slop generates it when a server admin first sets a push role; a board setting never carries it.
   */
  readonly externalId?: string;
  /** The server admin who last set or changed the push configuration, and when. */
  readonly pushChangedBy?: string;
  readonly pushChangedAt?: string;
}

export interface Board {
  readonly id: number;
  readonly name: string;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly timeZone: string;
  readonly defaultRoutineOwner: string | null;
  readonly environments: readonly Environment[];
  readonly sensitivePaths: readonly string[];
  /** How branch deploys run; null when the board has none. */
  readonly deploy: DeployIntegration | null;
  /** How the ATF stage gets the specs to run after a deploy; null when the board has none set up. */
  readonly atf: AtfIntegration | null;
  /** Readiness items slop can't check, ticked by an admin (routines, the routine's repo, the Claude GitHub App). */
  readonly readinessTicks: Readonly<Partial<Record<'routines' | 'routine_repo' | 'claude_app', boolean>>>;
  /** Increases with every approved change to the board's agent set. */
  readonly agentSetVersion: number;
  /** The latest check result on the base branch head; null until the first check result arrives. */
  readonly baseChecks?: BaseChecks | null;
  /**
   * The hash of the catalog agent set the board's version last followed; a different catalog
   * hash bumps `agentSetVersion` (catalog files reach the board through layering). Null before the first.
   */
  readonly agentCatalogHash: string | null;
  /** A run with no slop call or push for this long is failed. */
  readonly runNoProgressHours: number;
  /** A queued run that hasn't called slop within this many minutes never started and is failed. */
  readonly runStartMinutes: number;
  /** A watching run that makes no slop call or push within this many minutes of its PR's checks failing is failed. */
  readonly runRespondMinutes: number;
  /** A run that has not marked its PR ready for review within this long is failed. */
  readonly runReadyHours: number;
  /** Sub gate: subs changing more lines than this convert to sames. */
  readonly subMaxChangedLines: number;
  /** The step the learned sub limit moves by now: grows while outcomes agree, shrinks on a reversal (`sub-limit.ts`). */
  readonly subLimitStep: number;
  /** Effect checks: how many globs each side of an approved change is compared over (admins set 3 to 50). */
  readonly effectCheckGlobs: number;
  /** Which KB items an admin's agent may approve (`decide_kb_item`); admins set it. */
  readonly agentKbApproval: AgentKbApproval;
  /** Slop starts an investigate-only run by itself on a glob in Planning that intake flagged as big (on by default). */
  readonly autoInvestigate: boolean;
  /** The knowledge page regenerates at most this often, in minutes (5 to 1440); a rebuild ignores it. */
  readonly knowledgePageIntervalMinutes: number;
  /** The independent reviewer's settings (on, model, severity, ignored paths, tool cap). */
  readonly review: ReviewBoardSettings;
  readonly version: number;
}

export interface Member {
  readonly boardId: number;
  readonly email: string;
  readonly role: Role;
}

export interface User {
  readonly email: string;
  readonly name: string;
  readonly active: boolean;
}

/** The person a command acts as, with their role on the glob's board. */
export interface Actor {
  readonly email: string;
  readonly role: Role;
}
