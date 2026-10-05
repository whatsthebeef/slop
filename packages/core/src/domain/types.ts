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
export type LabelState = 'required' | 'added';
export type Labels = Partial<Record<LabelName, LabelState>>;

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
  readonly pr: PullRequest | null;
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
  /** Increases with every approved change to the board's agent set. */
  readonly agentSetVersion: number;
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
