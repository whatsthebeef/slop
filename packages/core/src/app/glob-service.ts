import { err, forbidden, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId, letterOf } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import type { ActionFacts, Context, CreateInput, FieldChanges, LabelCommand, Transition } from '../domain/machine.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import type { ArtifactSummary, Provenance } from '../domain/knowledge.js';
import type { Actor, Board, Category, Glob, LabelName, SlopType } from '../domain/types.js';
import type { Clock, GlobFilter, Hint, IdGenerator, Notifier, RoutineDirectory, Store, Tx } from '../ports.js';

export interface GlobServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly routines: RoutineDirectory;
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
}

export interface GlobView {
  readonly glob: Glob;
  readonly allowedActions: readonly machine.Action[];
  /** The latest version of each artifact, without content. */
  readonly artifacts: readonly ArtifactSummary[];
}

/** Artifacts in a stable order: by kind (plan first), then label. */
const byKind = (a: ArtifactSummary, b: ArtifactSummary): number =>
  ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label);

type Step = (glob: Glob, ctx: Context, board: Board, facts: ActionFacts) => Result<Transition>;

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
      const facts = { postplanSha: machine.postplanShaOf(artifacts) };
      return ok({ glob, allowedActions: machine.allowedActions(glob, actor.value, facts), artifacts });
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
      const createInput: CreateInput = { ...input, id: formatId(board.id, letter, n) };
      const ctx = await this.context(actor.value, board);
      const transition = machine.create(createInput, board, ctx);
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

  update(email: string, id: string, version: number, changes: FieldChanges) {
    return this.command(email, id, version, (glob, ctx, board) =>
      machine.changeFields(glob, changes, board, ctx),
    );
  }

  start(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.start(glob, ctx));
  }

  /** `environment` (optional) is chosen at pick-up; leaving it out keeps the glob's environment. */
  pickUp(email: string, id: string, version: number, takeOver: boolean, environment?: string | null) {
    return this.command(email, id, version, (glob, ctx, board) =>
      machine.pickUp(glob, ctx, board, environment === undefined ? { takeOver } : { takeOver, environment }),
    );
  }

  retrigger(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retrigger(glob, ctx));
  }

  resolveConflict(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.resolveConflict(glob, ctx));
  }

  startAgain(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.startAgain(glob, ctx));
  }

  /** Merge, or (`continueAfter`, supers) Merge and continue, which needs the latest postplan at the head. */
  merge(email: string, id: string, version: number, continueAfter = false) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.requestMerge(glob, ctx, { continue: continueAfter, facts }),
      continueAfter,
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
      true,
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

  // -------------------------------------------------------------------------

  private async command(
    email: string | null,
    id: string,
    expectedVersion: number | null,
    step: Step,
    /** Read the facts some actions depend on (the latest postplan); other steps get none. */
    withFacts = false,
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
        const facts: ActionFacts = withFacts
          ? { postplanSha: machine.postplanShaOf(await tx.listArtifactSummaries(glob.boardId, [glob.id])) }
          : {};
        const transition = step(glob, await this.context(actor, board), board, facts);
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

  private async context(actor: Actor | null, board: Board): Promise<Context> {
    const now = this.deps.clock.now();
    // Only the actor ever triggers a run, so resolve their routine owner up front.
    let owner = actor?.email ?? board.defaultRoutineOwner ?? '';
    if (actor !== null && !(await this.deps.routines.hasRoutine(actor.email, board.id))) {
      owner = board.defaultRoutineOwner ?? actor.email;
    }
    return {
      actor,
      now,
      newRunId: () => this.deps.ids.runId(),
      routineOwnerFor: () => owner,
    };
  }
}
