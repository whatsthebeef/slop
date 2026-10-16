import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { KNOWLEDGE_PAGE_INTERVAL_MAX, KNOWLEDGE_PAGE_INTERVAL_MIN } from '../domain/knowledge-page.js';
import { EFFECT_CHECK_GLOBS_MAX, EFFECT_CHECK_GLOBS_MIN } from '../domain/effect-check.js';
import { nextFreePosition } from '../domain/board-sessions.js';
import type { BoardSession } from '../domain/board-sessions.js';
import { recordBaseChecks } from '../domain/checks.js';
import type { BaseChecksChange } from '../domain/checks.js';
import { MAX_REVIEW_TOOL_CAP } from '../domain/review-tools.js';
import { mergeReviewSettings } from '../domain/review-settings.js';
import type { ReviewBoardSettings } from '../domain/review-settings.js';
import { REVIEW_SEVERITIES } from '../domain/independent-review.js';
import { atfPushRefusal, samePushTarget } from '../domain/atf-policy.js';
import type { AtfPushPolicy } from '../domain/atf-policy.js';
import type { AtfIntegration, BaseChecks, Board, CheckFailure, Environment, Member, Role } from '../domain/types.js';
import type { Notifier, Store, Tx } from '../ports.js';

export interface CreateBoardInput {
  readonly name: string;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly timeZone: string;
  readonly environments: readonly Environment[];
}

/** What admins set. The sub size limit isn't here: slop learns it from outcomes (`sub-limit.ts`). */
export type BoardSettings = {
  /** Only the keys given change; the rest stay as they are. */
  readonly review?: Partial<ReviewBoardSettings>;
} & Partial<
  Pick<
    Board,
    | 'name'
    | 'repo'
    | 'baseBranch'
    | 'timeZone'
    | 'defaultRoutineOwner'
    | 'environments'
    | 'sensitivePaths'
    | 'runNoProgressHours'
    | 'runReadyHours'
    | 'runStartMinutes'
    | 'runRespondMinutes'
    | 'effectCheckGlobs'
    | 'agentKbApproval'
    | 'autoInvestigate'
    | 'knowledgePageIntervalMinutes'
    | 'deploy'
    | 'atf'
    | 'readinessTicks'
  >
>;

export interface Membership {
  readonly board: Board;
  readonly role: Role;
  /** The board's place in the person's board bar (1-based, gaps closed); null when it isn't in it. */
  readonly position: number | null;
  /** When the person last opened the board in the web app; null if never. */
  readonly lastViewedAt: string | null;
}

export const DEFAULT_ENVIRONMENTS: readonly Environment[] = [{ name: 'main', allowBranchDeploy: false }];

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Limits on the review settings, which are an input boundary: the model id goes to the provider and the paths run per file. */
const REVIEW_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
export const MAX_REVIEW_IGNORED_PATHS = 50;
export const MAX_REVIEW_PATH_LENGTH = 200;
export const MAX_REVIEW_PATH_WILDCARDS = 5;

const validateReview = (review: Partial<ReviewBoardSettings>): Result<null> => {
  if (review.model !== undefined && review.model !== null && !REVIEW_MODEL_PATTERN.test(review.model.trim())) {
    return invalidInput('The review model is an id of letters, digits and . _ : / -, up to 200 characters, or none for the default');
  }
  if (review.minSeverity !== undefined && !REVIEW_SEVERITIES.includes(review.minSeverity)) {
    return invalidInput(`The review severity is one of ${REVIEW_SEVERITIES.join(', ')}`);
  }
  const paths = review.ignoredPaths ?? [];
  if (paths.length > MAX_REVIEW_IGNORED_PATHS) {
    return invalidInput(`At most ${String(MAX_REVIEW_IGNORED_PATHS)} ignored review paths`);
  }
  for (const raw of paths) {
    const path = raw.trim();
    if (path === '') return invalidInput('Ignored review paths can not be empty');
    if (path.length > MAX_REVIEW_PATH_LENGTH) {
      return invalidInput(`Ignored review paths are at most ${String(MAX_REVIEW_PATH_LENGTH)} characters`);
    }
    if (path.split('**').length - 1 > MAX_REVIEW_PATH_WILDCARDS) {
      return invalidInput(`Ignored review paths use ** at most ${String(MAX_REVIEW_PATH_WILDCARDS)} times`);
    }
  }
  const cap = review.toolCap;
  if (cap !== undefined && cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > MAX_REVIEW_TOOL_CAP)) {
    return invalidInput(`The review tool cap is a whole number from 1 to ${MAX_REVIEW_TOOL_CAP}`);
  }
  return ok(null);
};

/** The review settings as stored: the model and the paths trimmed (validation has already passed). */
const trimReview = (review: Partial<ReviewBoardSettings>): Partial<ReviewBoardSettings> => ({
  ...review,
  ...(review.model === undefined || review.model === null ? {} : { model: review.model.trim() }),
  ...(review.ignoredPaths === undefined ? {} : { ignoredPaths: review.ignoredPaths.map((p) => p.trim()) }),
});

const validateSettings = (settings: BoardSettings): Result<null> => {
  if (settings.name?.trim() === '') return invalidInput('A board needs a name');
  if (settings.review !== undefined) {
    const review = validateReview(settings.review);
    if (!review.ok) return review;
  }
  if (settings.timeZone !== undefined && !isTimeZone(settings.timeZone)) {
    return invalidInput(`Unknown time zone ${settings.timeZone}`);
  }
  for (const key of ['runNoProgressHours', 'runReadyHours', 'runStartMinutes', 'runRespondMinutes'] as const) {
    const value = settings[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) return invalidInput(`${key} must be positive`);
  }
  const globs = settings.effectCheckGlobs;
  if (globs !== undefined && (!Number.isInteger(globs) || globs < EFFECT_CHECK_GLOBS_MIN || globs > EFFECT_CHECK_GLOBS_MAX)) {
    return invalidInput(`Effect checks compare ${EFFECT_CHECK_GLOBS_MIN} to ${EFFECT_CHECK_GLOBS_MAX} globs a side`);
  }
  const interval = settings.knowledgePageIntervalMinutes;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < KNOWLEDGE_PAGE_INTERVAL_MIN || interval > KNOWLEDGE_PAGE_INTERVAL_MAX)) {
    return invalidInput(`The knowledge page regenerates every ${KNOWLEDGE_PAGE_INTERVAL_MIN} to ${KNOWLEDGE_PAGE_INTERVAL_MAX} minutes`);
  }
  if (settings.environments !== undefined) {
    const names = settings.environments.map((e) => e.name.trim());
    if (names.some((n) => n === '')) return invalidInput('Environments need names');
    if (new Set(names).size !== names.length) return invalidInput('Environment names must be unique');
    const subDefaults = settings.environments.filter((e) => e.subDefault === true);
    if (subDefaults.length > 1) return invalidInput('Only one environment can be the default for subs');
    if (subDefaults.some((e) => !e.allowBranchDeploy)) {
      return invalidInput("The subs' default environment must allow branch deploys");
    }
    const production = settings.environments.filter((e) => e.production === true);
    if (production.length > 1) return invalidInput('Only one environment can be production');
    if (production.some((e) => e.role !== 'release')) return invalidInput('Only a release environment can be production');
    if (settings.environments.some((e) => e.deployKnown !== undefined && e.role === undefined)) {
      return invalidInput('Only an environment with a pipeline role can have its deploys recorded by hand');
    }
  }
  const deploy = settings.deploy;
  if (deploy?.provider === 'codebuild') {
    if (deploy.region.trim() === '' || deploy.defaultProject.trim() === '') {
      return invalidInput('CodeBuild deploys need a region and a default project');
    }
  }
  if (deploy?.provider === 'github_actions' && deploy.workflow.trim() === '') {
    return invalidInput('GitHub Actions deploys need a workflow file');
  }
  const atf = settings.atf;
  if (atf !== undefined && atf !== null && (atf.region.trim() === '' || atf.project.trim() === '')) {
    return invalidInput('ATF needs a region and a CodeBuild project');
  }
  return ok(null);
};

/** Boards, settings and members. Roles live in slop, per board. */
export class BoardService {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly notifier: Notifier;
      /** What push-mode ATF may start (the server's configuration); absent: push mode is off. */
      readonly atfPolicy?: AtfPushPolicy;
      /** Emails of the server's admins (not board admins): only they set up ATF push mode. */
      readonly serverAdmins?: readonly string[];
      readonly newExternalId?: () => string;
      readonly clock?: { now(): string };
      /** Told when the base branch turned red because of a merged glob, so relation learning can look for the glob it collided with (best effort). */
      readonly onBaseRed?: (boardId: number) => Promise<void>;
    },
  ) {}

  /** `whoami`: the person's boards and their role on each. */
  async memberships(email: string): Promise<Membership[]> {
    return this.deps.store.transaction(async (tx) => {
      const boards = await tx.listBoards(email);
      const sessions = new Map((await tx.listBoardSessions(email)).map((s) => [s.boardId, s]));
      const result: Membership[] = [];
      for (const board of boards) {
        const member = await tx.getMember(board.id, email);
        const session = sessions.get(board.id);
        if (member !== null) {
          result.push({ board, role: member.role, position: session?.position ?? null, lastViewedAt: session?.lastViewedAt ?? null });
        }
      }
      return result;
    });
  }

  /** Anyone can create a board; its creator is its admin. */
  async create(email: string, input: CreateBoardInput): Promise<Result<Board>> {
    const valid = validateSettings(input);
    if (!valid.ok) return valid;
    return this.deps.store.transaction(async (tx) => {
      const user = await tx.getUser(email);
      if (user === null || !user.active) return forbidden('Your account is not active in slop');
      const board = await tx.insertBoard({
        name: input.name.trim(),
        repo: input.repo,
        baseBranch: input.baseBranch,
        timeZone: input.timeZone,
        defaultRoutineOwner: email,
        environments: input.environments.length > 0 ? input.environments : DEFAULT_ENVIRONMENTS,
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email, role: 'admin' });
      return ok(board);
    });
  }

  async get(email: string, boardId: number): Promise<Result<Pick<Membership, 'board' | 'role'>>> {
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      const member = await this.member(tx, email, boardId);
      if (!member.ok) return member;
      return ok({ board, role: member.value.role });
    });
  }

  /**
   * The person opened the board in the web app: records the time only. The bar is unchanged: a board joins it through
   * addSession. Returns their sessions as shown. Personal state, so no board hint is published.
   */
  async openBoard(email: string, boardId: number, now: string): Promise<Result<BoardSession[]>> {
    return this.writeSessions(email, boardId, async (tx) => {
      await tx.touchBoardSession(email, boardId, now);
    });
  }

  /** Adds the board to the person's bar at the lowest free number. Idempotent: a board already in it keeps its number. */
  async addSession(email: string, boardId: number): Promise<Result<BoardSession[]>> {
    return this.writeSessions(email, boardId, async (tx, sessions) => {
      if (sessions.some((s) => s.boardId === boardId && s.position !== null)) return;
      await tx.setBoardSessionPosition(email, boardId, nextFreePosition(sessions.map((s) => s.position)));
    });
  }

  /** Takes the board out of the person's bar; the other sessions keep their numbers, so a gap stays. Idempotent. */
  async removeSession(email: string, boardId: number): Promise<Result<BoardSession[]>> {
    return this.writeSessions(email, boardId, async (tx, sessions) => {
      if (sessions.some((s) => s.boardId === boardId && s.position !== null)) await tx.setBoardSessionPosition(email, boardId, null);
    });
  }

  /** A session write for a member, serialised per person so concurrent opens can't take the same position. */
  private async writeSessions(
    email: string,
    boardId: number,
    write: (tx: Tx, sessions: readonly BoardSession[]) => Promise<void>,
  ): Promise<Result<BoardSession[]>> {
    if (!Number.isInteger(boardId)) return invalidInput('A board ID is a whole number');
    return this.deps.store.transaction(async (tx) => {
      const member = await this.member(tx, email, boardId);
      if (!member.ok) return member;
      await tx.lockBoardSessions(email);
      await write(tx, await tx.listBoardSessions(email));
      return ok(await tx.listBoardSessions(email));
    });
  }

  async updateSettings(
    email: string,
    boardId: number,
    version: number,
    settings: BoardSettings,
  ): Promise<Result<Board>> {
    const valid = validateSettings(settings);
    if (!valid.ok) return valid;
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Board>> => {
      const admin = await this.admin(tx, email, boardId);
      if (!admin.ok) return admin;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      if (board.version !== version) return invalidInput('The board settings have changed; reload them');
      const atf = this.checkAtf(email, board, settings.atf);
      if (!atf.ok) return atf;
      const next: Board = {
        ...board,
        ...settings,
        ...(settings.atf === undefined ? {} : { atf: atf.value }),
        review: settings.review === undefined ? board.review : mergeReviewSettings(board.review, trimReview(settings.review)),
        version: board.version + 1,
      };
      if (!(await tx.updateBoard(next, version))) {
        return invalidInput('The board settings have changed; reload them');
      }
      return ok(next);
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return result;
  }

  /**
   * Integrations' write of the base branch's latest check result. Returns what changed, or null for an unknown board.
   * Idempotent: the same result again changes nothing.
   */
  async recordBaseChecks(
    boardId: number,
    result: { sha: string; passed: boolean; failure: CheckFailure | null; merged: string | null; fromGreen?: boolean },
    now: string,
  ): Promise<{ checks: BaseChecks; change: BaseChecksChange } | null> {
    const recorded = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return null;
      const change = recordBaseChecks(board.baseChecks, result, now);
      if (change.changed) await tx.setBaseChecks(boardId, change.next);
      return { checks: change.next, change };
    });
    if (recorded?.change.changed === true) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    if (recorded?.change.changed === true && recorded.checks.state === 'failed' && recorded.checks.since !== null) await this.deps.onBaseRed?.(boardId);
    return recorded;
  }

  async members(email: string, boardId: number): Promise<Result<Member[]>> {
    return this.deps.store.transaction(async (tx) => {
      const member = await this.member(tx, email, boardId);
      if (!member.ok) return member;
      return ok(await tx.listMembers(boardId));
    });
  }

  /** Admins add people by email; they are linked to their account on first sign-in. */
  async setMember(email: string, boardId: number, target: string, role: Role): Promise<Result<Member>> {
    return this.deps.store.transaction(async (tx) => {
      const admin = await this.admin(tx, email, boardId);
      if (!admin.ok) return admin;
      const normalised = target.trim().toLowerCase();
      if (!normalised.includes('@')) return invalidInput('Members are added by email');
      if (normalised === email && role !== 'admin') {
        const admins = (await tx.listMembers(boardId)).filter((m) => m.role === 'admin');
        if (admins.length === 1) return invalidInput('A board needs at least one admin');
      }
      if ((await tx.getUser(normalised)) === null) {
        await tx.upsertUser({ email: normalised, name: normalised, active: true });
      }
      const member: Member = { boardId, email: normalised, role };
      await tx.upsertMember(member);
      return ok(member);
    });
  }

  async removeMember(email: string, boardId: number, target: string): Promise<Result<null>> {
    return this.deps.store.transaction(async (tx) => {
      const admin = await this.admin(tx, email, boardId);
      if (!admin.ok) return admin;
      const members = await tx.listMembers(boardId);
      const removing = members.find((m) => m.email === target);
      if (removing === undefined) return notFound(`${target} is not a member`);
      if (removing.role === 'admin' && members.filter((m) => m.role === 'admin').length === 1) {
        return invalidInput('A board needs at least one admin');
      }
      await tx.deleteMember(boardId, target);
      return ok(null);
    });
  }

  /**
   * The ATF setting to store. A board admin may switch ATF to pull or off, or leave a push setup as it is; turning on or
   * changing push mode (its project or role) is for a server admin, and only for what the server's allow-list permits. The
   * ExternalId is slop's: generated once per board when a push role is first set, never taken from the request.
   */
  private checkAtf(email: string, board: Board, requested: AtfIntegration | null | undefined): Result<AtfIntegration | null> {
    if (requested === undefined) return ok(board.atf);
    if (requested === null) return ok(null);
    // The request never sets these: slop's own fields.
    const setting: AtfIntegration = {
      provider: requested.provider,
      region: requested.region,
      project: requested.project,
      mode: requested.mode,
      ...(requested.roleArn === undefined ? {} : { roleArn: requested.roleArn }),
    };
    // Switching to pull keeps the ExternalId, so a later push setup still matches the role's trust policy.
    if (setting.mode !== 'push') return ok({ ...setting, ...(board.atf?.externalId === undefined ? {} : { externalId: board.atf.externalId }) });
    const serverAdmin = (this.deps.serverAdmins ?? []).includes(email.toLowerCase());
    // A board admin may leave a push setup as it is; a server admin's resave still gives a role that has no ExternalId one.
    if (samePushTarget(setting, board.atf) && (!serverAdmin || setting.roleArn === undefined || board.atf?.externalId !== undefined)) {
      return ok(board.atf);
    }
    if (!serverAdmin) {
      return forbidden('Only a server admin can turn on ATF push mode or change its project or role');
    }
    const refusal = atfPushRefusal(setting, this.deps.atfPolicy ?? { projects: [], roleAccounts: [] });
    if (refusal !== null) return invalidInput(refusal);
    const externalId =
      setting.roleArn === undefined
        ? {}
        : { externalId: board.atf?.externalId ?? (this.deps.newExternalId ?? (() => globalThis.crypto.randomUUID()))() };
    return ok({
      ...setting,
      ...externalId,
      pushChangedBy: email,
      pushChangedAt: (this.deps.clock ?? { now: () => new Date().toISOString() }).now(),
    });
  }

  private async member(tx: Tx, email: string, boardId: number): Promise<Result<Member>> {
    const user = await tx.getUser(email);
    if (user === null || !user.active) return forbidden('Your account is not active in slop');
    const member = await tx.getMember(boardId, email);
    return member === null ? forbidden(`You are not a member of board ${boardId}`) : ok(member);
  }

  private async admin(tx: Tx, email: string, boardId: number): Promise<Result<Member>> {
    const member = await this.member(tx, email, boardId);
    if (!member.ok) return member;
    return member.value.role === 'admin' ? member : err({ code: 'forbidden', message: 'Only board admins can do this' });
  }
}
