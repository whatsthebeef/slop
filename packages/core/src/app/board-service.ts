import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { EFFECT_CHECK_GLOBS_MAX, EFFECT_CHECK_GLOBS_MIN } from '../domain/effect-check.js';
import { recordBaseChecks } from '../domain/checks.js';
import type { BaseChecksChange } from '../domain/checks.js';
import type { BaseChecks, Board, CheckFailure, Environment, Member, Role } from '../domain/types.js';
import type { Notifier, Store, Tx } from '../ports.js';

export interface CreateBoardInput {
  readonly name: string;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly timeZone: string;
  readonly environments: readonly Environment[];
}

/** What admins set. The sub size limit isn't here: slop learns it from outcomes (`sub-limit.ts`). */
export type BoardSettings = Partial<
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
    | 'deploy'
    | 'readinessTicks'
  >
>;

export interface Membership {
  readonly board: Board;
  readonly role: Role;
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

const validateSettings = (settings: BoardSettings): Result<null> => {
  if (settings.name?.trim() === '') return invalidInput('A board needs a name');
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
  return ok(null);
};

/** Boards, settings and members. Roles live in slop, per board. */
export class BoardService {
  constructor(private readonly deps: { readonly store: Store; readonly notifier: Notifier }) {}

  /** `whoami`: the person's boards and their role on each. */
  async memberships(email: string): Promise<Membership[]> {
    return this.deps.store.transaction(async (tx) => {
      const boards = await tx.listBoards(email);
      const result: Membership[] = [];
      for (const board of boards) {
        const member = await tx.getMember(board.id, email);
        if (member !== null) result.push({ board, role: member.role });
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

  async get(email: string, boardId: number): Promise<Result<Membership>> {
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      const member = await this.member(tx, email, boardId);
      if (!member.ok) return member;
      return ok({ board, role: member.value.role });
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
      const next: Board = { ...board, ...settings, version: board.version + 1 };
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
    result: { sha: string; passed: boolean; failure: CheckFailure | null; merged: string | null },
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
