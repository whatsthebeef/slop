export const SLOP_TYPES = ['sub', 'same', 'super'] as const;
export type SlopType = (typeof SLOP_TYPES)[number];

export const CATEGORIES = ['feature', 'task', 'bug'] as const;
export type Category = (typeof CATEGORIES)[number];

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
}

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

/** `continue`: the merge in progress is a super's Merge and continue, so the glob stays in Doing. */
export type MergeMode = 'continue';

/** Result of the required checks on the PR's current head commit. */
export interface HeadChecks {
  readonly sha: string;
  readonly state: 'pending' | 'passed' | 'failed';
}

/** `none` until the glob first enters Doing: branches and draft PRs are created when work starts. */
export type ProvisioningState = 'none' | 'pending' | 'ok' | 'failed';

export interface Failure {
  readonly reason: string;
  readonly at: string;
  /** Failure reports: the agent-set version the session or run used, when it said. */
  readonly agentSetVersion?: number;
}

export interface Glob {
  readonly id: string;
  readonly boardId: number;
  readonly title: string;
  readonly summary: string;
  readonly type: SlopType;
  readonly category: Category;
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
  readonly headChecks: HeadChecks | null;
  /** Every routine run, oldest first; the last one is the current run. */
  readonly runs: readonly Run[];
  readonly failure: Failure | null;
  readonly provisioning: ProvisioningState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly signedOffAt: string | null;
  /** When the glob last entered Doing; null outside Doing. Drives the aging colour. */
  readonly doingSince: string | null;
}

export interface Environment {
  readonly name: string;
  readonly allowBranchDeploy: boolean;
  /** At most one per board: the environment a sub gets when it is created without one. */
  readonly subDefault?: true;
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
  /** Readiness items slop can't check, ticked by an admin (routines, the routine's repo, the Claude GitHub App). */
  readonly readinessTicks: Readonly<Partial<Record<'routines' | 'routine_repo' | 'claude_app', boolean>>>;
  /** Increases with every approved change to the board's agent set. */
  readonly agentSetVersion: number;
  /**
   * The hash of the catalog agent set the board's version last followed; a different catalog
   * hash bumps `agentSetVersion` (catalog files reach the board through layering). Null before the first.
   */
  readonly agentCatalogHash: string | null;
  /** A run with no slop call or push for this long is failed. */
  readonly runNoProgressHours: number;
  /** A run that has not marked its PR ready for review within this long is failed. */
  readonly runReadyHours: number;
  /** Sub gate: subs changing more lines than this convert to sames. */
  readonly subMaxChangedLines: number;
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
