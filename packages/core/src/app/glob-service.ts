import { err, forbidden, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId, letterOf } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import type { ActionFacts, Context, CreateInput, FieldChanges, LabelCommand, Transition } from '../domain/machine.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import type { ArtifactSummary, Provenance } from '../domain/knowledge.js';
import type { Actor, Board, Category, Glob, ImpliedAfter, LabelName, SlopType } from '../domain/types.js';
import { checkAfter, dependencyIds, dependencyState, pickUpWarning, waitingFor, waitsFor } from '../domain/waiting.js';
import type { AwaitedDependency, DependencyState } from '../domain/waiting.js';
import type { BranchFiles, Clock, GlobFilter, Hint, IdGenerator, Notifier, RoutineDirectory, Store, Tx } from '../ports.js';
import { findHolds } from './hold-service.js';

export interface GlobServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly routines: RoutineDirectory;
  /** The files a branch changes, for the board's merge policy (exclusive paths); without it no glob is held for them. */
  readonly branchFiles?: BranchFiles;
}

export interface CreateGlobInput {
  readonly boardId: number;
  readonly title: string;
  readonly summary: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  readonly environment: string | null;
  readonly autoTrigger: boolean;
  readonly idempotencyKey: string | null;
  /**
   * plan.md v1, stored verbatim with the glob: the caller passes `plan`, else the summary as given, else the intake
   * input. Empty or missing stores no plan (get_plan then falls back to the summary, as it always has).
   */
  readonly plan?: string | null;
  /** Who is creating it, for the plan's provenance (default: a person). */
  readonly planBy?: Provenance['by'];
  /** Globs on the board to start after (a sub waits in Planning until they merge); merged ones are ignored. */
  readonly after?: readonly string[];
  /** Files intake guessed the work changes (advisory: with the plan, they decide whether exclusive paths hold it). */
  readonly files?: readonly string[];
}

export interface GlobView {
  readonly glob: Glob;
  readonly allowedActions: readonly machine.Action[];
  /** The latest version of each artifact, without content. */
  readonly artifacts: readonly ArtifactSummary[];
  /** What the glob still waits for (unmerged globs it starts after), with the reason for each. */
  readonly waitingFor: readonly AwaitedDependency[];
  /** Globs in Planning that wait for this one. */
  readonly waitedOnBy: readonly string[];
}

/** Artifacts in a stable order: by kind (plan first), then label. */
const byKind = (a: ArtifactSummary, b: ArtifactSummary): number =>
  ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label);

type Step = (glob: Glob, ctx: Context, board: Board, facts: ActionFacts) => Result<Transition>;

interface CommandOptions {
  /** Read the facts some actions depend on (the latest postplan); other steps get none. */
  readonly facts?: boolean;
  /** Read the state of the globs this one waits for into `facts.dependencies`. */
  readonly dependencies?: boolean;
  /** Runs before the step: checks input against the store, and returns more glob IDs whose state the step needs. */
  readonly prepare?: (tx: Tx, glob: Glob) => Promise<Result<readonly string[]>>;
  /** A system step that starts a run on someone's behalf: the glob's creator triggers it. */
  readonly triggeredByCreator?: boolean;
}

/** How many globs a cycle check reads at most. */
const CLOSURE_LIMIT = 200;

/** Integration events retry a few times on concurrent writes; they carry no client version. */
const EVENT_RETRIES = 5;

/**
 * Application service for globs. Every entry point (REST, MCP, webhooks, jobs) calls these
 * methods, so every change goes through the same authorisation, state machine and outbox.
 */
export class GlobService {
  constructor(private readonly deps: GlobServiceDeps) {}

  // -------------------------------------------------------------------------
  // Reads

  async get(email: string, id: string): Promise<Result<GlobView>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const actor = await this.actorFor(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const artifacts = (await tx.listArtifactSummaries(glob.boardId, [glob.id])).sort(byKind);
      const dependencies = await this.dependencyStates(tx, dependencyIds(glob));
      const facts = { postplanSha: machine.postplanShaOf(artifacts), dependencies };
      const waiting = await tx.listGlobs(glob.boardId, { status: ['planning'] });
      return ok({
        glob,
        allowedActions: machine.allowedActions(glob, actor.value, facts),
        artifacts,
        waitingFor: waitingFor(glob, dependencies),
        waitedOnBy: waiting.filter((g) => waitsFor(g, glob.id)).map((g) => g.id),
      });
    });
  }

  /** Integrations' read of one glob, with no signed-in person. */
  async peek(id: string): Promise<Glob | null> {
    return this.deps.store.transaction((tx) => tx.getGlob(id));
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
  ): Promise<Result<{ glob: Glob; artifacts: ArtifactSummary[] }[]>> {
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
      return ok(globs.map((glob) => ({ glob, artifacts: (byGlob.get(glob.id) ?? []).sort(byKind) })));
    });
  }

  // -------------------------------------------------------------------------
  // Commands from people (each carries the version the client read)

  async create(email: string, input: CreateGlobInput): Promise<Result<Glob>> {
    // A glob about to start waits for open globs that may change the same exclusive paths (read before the transaction:
    // it asks the code host).
    let holds: readonly ImpliedAfter[] = [];
    if ((input.type === 'sub' || (input.type === 'same' && input.autoTrigger)) && this.deps.branchFiles !== undefined) {
      const board = await this.deps.store.transaction((tx) => tx.getBoard(input.boardId));
      if (board !== null) {
        const candidate = { id: null, plan: input.plan ?? input.summary, ...(input.files === undefined ? {} : { files: input.files }) };
        holds = await findHolds(this.deps.store, this.deps.branchFiles, board, candidate, new Set(input.after ?? []));
      }
    }
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Transition>> => {
      const board = await tx.getBoard(input.boardId);
      if (board === null) return notFound(`No board ${input.boardId}`);
      const actor = await this.actorFor(tx, email, board.id);
      if (!actor.ok) return actor;
      if (input.idempotencyKey !== null) {
        const existing = await tx.findGlobByCreationKey(board.id, input.idempotencyKey);
        if (existing !== null) return ok({ glob: existing, changed: false, events: [], effects: [] });
      }
      const letter = letterOf(input.category);
      const n = await tx.nextNumber(board.id, letter);
      let after: readonly string[] = [];
      if (input.after !== undefined && input.after.length > 0) {
        const wanted = input.after;
        const found = await this.closure(tx, wanted);
        const checked = checkAfter(null, wanted, board.id, (id) => found.get(id));
        if (!checked.ok) return checked;
        after = checked.value;
      }
      const createInput: CreateInput = { ...input, id: formatId(board.id, letter, n), after, impliedAfter: holds };
      const ctx = await this.context(actor.value, board);
      const awaitedIds = [...after, ...holds.map((h) => h.id)];
      const transition = machine.create(createInput, board, ctx, await this.dependencyStates(tx, awaitedIds));
      if (!transition.ok) return transition;
      const glob = { ...transition.value.glob, version: 1 };
      if (!(await tx.insertGlob(glob, input.idempotencyKey))) {
        throw new Error(`Glob ID collision for ${glob.id}`);
      }
      await tx.appendEvents(transition.value.events);
      await tx.enqueueEffects(transition.value.effects);
      const plan = input.plan ?? '';
      if (plan.trim() !== '') {
        const artifact = await tx.insertArtifact({
          globId: glob.id,
          kind: 'plan',
          label: '',
          content: plan,
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
      }
      return ok({ ...transition.value, glob, changed: true });
    });
    if (!result.ok) return result;
    if (result.value.changed) this.publish(result.value.glob);
    return ok(result.value.glob);
  }

  /** `changes.after` is checked here (IDs exist on the board, no cycle, merged ones dropped) before the machine sees it. */
  async update(email: string, id: string, version: number, changes: FieldChanges) {
    const wanted = changes.after;
    // A same becoming a sub is about to start: the merge policy may hold it.
    const holds = changes.type === 'sub' ? await this.holdsFor(id) : [];
    let checkedAfter: readonly string[] | undefined;
    return this.command(
      email,
      id,
      version,
      (glob, ctx, board, facts) =>
        machine.changeFields(
          glob,
          { ...changes, ...(checkedAfter === undefined ? {} : { after: checkedAfter }), ...(holds.length === 0 ? {} : { impliedAfter: holds }) },
          board,
          ctx,
          facts.dependencies,
        ),
      {
        dependencies: true,
        ...((wanted !== undefined || holds.length > 0) && {
          prepare: async (tx: Tx, glob: Glob): Promise<Result<readonly string[]>> => {
            if (wanted !== undefined) {
              const found = await this.closure(tx, wanted);
              const checked = checkAfter(glob.id, wanted, glob.boardId, (gid) => found.get(gid));
              if (!checked.ok) return checked;
              checkedAfter = checked.value;
            }
            return ok([...(checkedAfter ?? []), ...holds.map((h) => h.id)]);
          },
        }),
      },
    );
  }

  async start(email: string, id: string, version: number) {
    const holds = await this.holdsFor(id);
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.start(glob, ctx, facts.dependencies, holds), {
      dependencies: true,
      ...(holds.length > 0 && { prepare: () => Promise.resolve(ok(holds.map((h) => h.id))) }),
    });
  }

  /** Start a glob that waits for others to merge, before they have. */
  startAnyway(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAnyway(glob, ctx, facts.dependencies), {
      dependencies: true,
    });
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
    const result = await this.command(
      email,
      id,
      version,
      (glob, ctx, board, facts) => {
        const dependencies = facts.dependencies;
        warning = glob.status === 'planning' && dependencies !== undefined ? pickUpWarning(waitingFor(glob, dependencies)) : null;
        return machine.pickUp(glob, ctx, board, { takeOver, ...(environment === undefined ? {} : { environment }), ...(dependencies === undefined ? {} : { dependencies }) });
      },
      { dependencies: true },
    );
    return result.ok ? ok({ glob: result.value, warning }) : result;
  }

  retryAutofix(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retryAutofix(glob, ctx));
  }

  retrigger(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retrigger(glob, ctx));
  }

  resolveConflict(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.resolveConflict(glob, ctx));
  }

  startAgain(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAgain(glob, ctx, facts.dependencies), {
      dependencies: true,
    });
  }

  /** Merge, or (`continueAfter`, supers) Merge and continue, which needs the latest postplan at the head. */
  merge(email: string, id: string, version: number, continueAfter = false) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.requestMerge(glob, ctx, { continue: continueAfter, facts }),
      { facts: continueAfter },
    );
  }

  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel(email: string, id: string, version: number, name: LabelName, command: LabelCommand) {
    return this.command(email, id, version, (glob, ctx) => machine.reviewLabel(glob, name, command, ctx));
  }

  /** `mark_ready`: ask slop to mark the glob's draft PR ready for review. */
  requestReady(email: string, id: string, runId: string | null) {
    return this.command(email, id, null, (glob, ctx) => machine.readyRequested(glob, runId, ctx));
  }

  /** The board's Ready for review on a super: allowed once the latest postplan is at the PR head. */
  requestReadyFromBoard(email: string, id: string, version: number) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.readyRequested(glob, null, ctx, { from: 'board', facts }),
      { facts: true },
    );
  }

  /** `report_failure` from a person's interactive session (no run ID). */
  reportFailure(email: string, id: string, reason: string, runId: string | null, agentSetVersion: number | null = null) {
    return this.command(email, id, null, (glob, ctx) =>
      machine.reportFailure(glob, { reason, runId, agentSetVersion }, ctx),
    );
  }

  async delete(email: string, id: string, version: number): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Glob>> => {
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
      await tx.deleteEvents(glob.id);
      await tx.deleteGlob(glob.id);
      // The deletion itself is logged without a glob, so reports lose the glob's time.
      await tx.enqueueEffects(transition.value.effects);
      return ok(glob);
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({
      kind: 'glob.deleted',
      boardId: result.value.boardId,
      globId: result.value.id,
      version: result.value.version + 1,
    });
    return ok(null);
  }

  // -------------------------------------------------------------------------
  // Events from integrations and routines (applied against the current version)

  applyEvent(id: string, step: (glob: Glob, ctx: Context) => Result<Transition>) {
    return this.command(null, id, null, (glob, ctx) => step(glob, ctx));
  }

  /**
   * A glob this one waited for merged (`release_waiting`): starts the globs in Planning that wait for it and for nothing
   * else that is unmerged. Each release is its own write and a no-op when already done, so a retry is safe.
   * Returns the IDs released.
   */
  async releaseDependents(mergedId: string, boardId: number): Promise<string[]> {
    const planning = await this.deps.store.transaction((tx) => tx.listGlobs(boardId, { status: ['planning'] }));
    const released: string[] = [];
    for (const waiting of planning) {
      if (waiting.waiting == null || !waitsFor(waiting, mergedId)) continue;
      const result = await this.release(waiting.id);
      if (result.ok && result.value.status !== 'planning') released.push(waiting.id);
    }
    return released;
  }

  /** Starts one held glob if everything it waits for has merged and the merge policy still lets it. */
  async release(id: string) {
    const holds = await this.holdsFor(id, true);
    return this.command(null, id, null, (glob, ctx, _board, facts) => machine.released(glob, ctx, facts.dependencies, holds), {
      dependencies: true,
      triggeredByCreator: true,
      ...(holds.length > 0 && { prepare: () => Promise.resolve(ok(holds.map((h) => h.id))) }),
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
      const states = await this.dependencyStates(tx, dependencyIds(glob));
      if (waitingFor(glob, states).length > 0) return null;
      const plan = (await tx.listArtifacts(id, 'plan'))[0]?.content ?? glob.summary;
      return { glob, board, plan };
    });
    if (read === null) return [];
    // Holds a person overrode, and globs already waited for, are not held for again.
    const skip = new Set([...(read.glob.after ?? []), ...(read.glob.impliedAfter ?? []).map((i) => i.id)]);
    return findHolds(this.deps.store, branchFiles, read.board, { id, plan: read.plan }, skip);
  }

  /** The state of each glob in `ids` (a glob that no longer exists is `missing`). */
  private async dependencyStates(tx: Tx, ids: readonly string[]): Promise<Map<string, DependencyState>> {
    const found = ids.length === 0 ? [] : await tx.getGlobs(ids);
    const byId = new Map(found.map((g) => [g.id, g]));
    return new Map(ids.map((id) => [id, dependencyState(byId.get(id))]));
  }

  /** The globs with these IDs and everything they wait for in turn (bounded), for the cycle check. */
  private async closure(tx: Tx, ids: readonly string[]): Promise<Map<string, Glob>> {
    const found = new Map<string, Glob>();
    let next = [...new Set(ids)];
    while (next.length > 0 && found.size < CLOSURE_LIMIT) {
      const globs = await tx.getGlobs(next);
      for (const glob of globs) found.set(glob.id, glob);
      next = [...new Set(globs.flatMap((g) => dependencyIds(g)))].filter((id) => !found.has(id));
    }
    return found;
  }

  private async command(
    email: string | null,
    id: string,
    expectedVersion: number | null,
    step: Step,
    options: CommandOptions = {},
  ): Promise<Result<Glob>> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.deps.store.transaction(async (tx): Promise<Result<Glob> | 'retry'> => {
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
        let extraIds: readonly string[] = [];
        if (options.prepare !== undefined) {
          const prepared = await options.prepare(tx, glob);
          if (!prepared.ok) return prepared;
          extraIds = prepared.value;
        }
        const postplan = options.facts === true
          ? { postplanSha: machine.postplanShaOf(await tx.listArtifactSummaries(glob.boardId, [glob.id])) }
          : {};
        const dependencies =
          options.dependencies === true
            ? { dependencies: await this.dependencyStates(tx, [...new Set([...dependencyIds(glob), ...extraIds])]) }
            : {};
        const facts: ActionFacts = { ...postplan, ...dependencies };
        const ctx = await this.context(actor, board, options.triggeredByCreator === true ? glob.creator : undefined);
        const transition = step(glob, ctx, board, facts);
        if (!transition.ok) return transition;
        const { changed, events, effects } = transition.value;
        if (!changed) {
          await tx.appendEvents(events);
          await tx.enqueueEffects(effects);
          return ok(glob);
        }
        const next = { ...transition.value.glob, version: glob.version + 1 };
        if (!(await tx.updateGlob(next, glob.version))) {
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
        return ok(next);
      });
      if (result === 'retry') {
        if (attempt < EVENT_RETRIES) continue;
        throw new Error(`Could not apply event to ${id} after ${EVENT_RETRIES} retries`);
      }
      if (result.ok) this.publish(result.value);
      return result;
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
