import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isLearning } from '../domain/learning.js';
import { validateScopeEdit } from '../domain/attributes.js';
import { formatId, letterOf } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import { listOf } from '../domain/matrix.js';
import type { ActionFacts, Context, CreateInput, FieldChanges, LabelCommand, Transition } from '../domain/machine.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import type { Artifact, ArtifactSummary, Provenance } from '../domain/knowledge.js';
import type { Actor, Board, Category, Escalation, Glob, ImpliedAfter, LabelName, SlopType } from '../domain/types.js';
import { mergeImplied } from '../domain/exclusive-paths.js';
import { deleteObjectEffect, knowledgePageEffect, recheckOverlapsEffect } from '../domain/events.js';
import { defaultAreas, matchRiskAreas, splitEvidence } from '../domain/risk-area.js';
import { MAX_AFTER, NO_CHAIN, blockingChain, checkAfter, checkOverlaps, explicitOverlaps, dependencyIds, dependencyState, pickUpWarning, waitingFor, waitsFor } from '../domain/waiting.js';
import type { AwaitedDependency, BlockingChain, DependencyState } from '../domain/waiting.js';
import type { InboxItem } from '../domain/inbox.js';
import type { IntakeRecord, SnapshotSource } from '../domain/intake-learning.js';
import type { BranchFiles, Clock, Embedder, GlobFilter, Hint, IdGenerator, Notifier, RoutineDirectory, Store, Tx } from '../ports.js';
import { DECISIONS_LABEL, decisionsAttachment } from '../domain/decision-glob.js';
import { addArtifact, governingDecisions } from './artifact-service.js';
import { fileKeysOf } from './attachment-service.js';
import { DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import { AttachConflict, linkInboxItem } from './inbox-service.js';
import { findHolds } from './hold-service.js';
import { recordTypeCorrection } from './type-learning-service.js';
import type { DependencyLearningService } from './dependency-learning-service.js';
import { embedRequest, snapshotOf } from './intake-learning-service.js';
import { checkFrom } from './size-check-service.js';
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
  /** Where a best-effort side task reports its failure (the server's error log). */
  readonly log?: (task: string, message: string) => void;
}

/** plan.md v1 of a new glob: the caller's plan, else what intake was given, else the title. */
const planOf = (input: Pick<CreateGlobInput, 'plan' | 'title' | 'intake'>): string => {
  for (const text of [input.plan, input.intake?.request]) if (text !== undefined && text !== null && text.trim() !== '') return text;
  return input.title.trim();
};

export interface CreateGlobInput {
  readonly boardId: number;
  readonly title: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  readonly environment: string | null;
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
  /** Globs on the board to start after (a sub waits in Planning until they merge); merged ones are ignored. */
  readonly after?: readonly string[];
  /** IDs of globs on the board this one overlaps: the same files may change, so only the merge order matters. Never blocks a start. */
  readonly overlaps?: readonly string[];
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
  /** Indexes of earlier parts this one starts after; none means it runs in parallel. Part 0 has none. */
  readonly after?: readonly number[];
  /** Indexes of earlier parts that may change the same files: recorded as overlaps, which order merges but never block a start. */
  readonly overlaps?: readonly number[];
  /** Labels of the original's text attachments to copy to this part (link attachments always are). New parts only. */
  readonly attachments?: readonly string[];
}

export const MAX_SPLIT_PARTS = 10;

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
  const before = original.escalation ?? null;
  const matches = parts.map((p) => (p.type === 'super' ? null : matchRiskAreas(areas, p.plan)));
  const anyMatch = matches.some((m) => m !== null && m.areas.length > 0);
  return parts.map((part, index): PartEscalation => {
    const match = matches[index];
    const had = index === 0 ? before : null;
    if (match === null || match === undefined) return { type: part.type, escalation: had, change: null };
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

const escalationEvent = (globId: string, actor: string, at: string, change: NonNullable<PartEscalation['change']>) =>
  ({ type: change.kind, globId, actor, at, data: change.data }) as const;

/** Where a glob came from in a split: the glob that was cut, its own place and every part's ID in order. */
export interface SplitInfo {
  readonly source: string;
  readonly part: number;
  readonly parts: readonly string[];
}

export interface SplitInput {
  readonly parts: readonly SplitPart[];
  readonly idempotencyKey: string | null;
  /** Who is splitting, for the new plans' provenance (default: a person). */
  readonly planBy?: Provenance['by'];
}

/** Part N's glob ID wherever a plan or summary writes `{part:N}`. */
export const fillPartIds = (text: string, ids: readonly string[]): string =>
  text.replace(/\{part:(\d+)\}/g, (match, n: string) => ids[Number(n)] ?? match);

export interface GlobView {
  readonly glob: Glob;
  readonly allowedActions: readonly machine.Action[];
  /** The latest version of each artifact, without content. */
  readonly artifacts: readonly ArtifactSummary[];
  /** What the glob still waits for (unmerged globs named in `after`), with the reason for each. */
  readonly waitingFor: readonly AwaitedDependency[];
  /** Globs in Planning that wait for this one. */
  readonly waitedOnBy: readonly string[];
  /** Everything unmerged ahead of the glob, transitively, and which of it can start now. */
  readonly chain: BlockingChain;
  /** The size check (flag, estimate, proposed split); null when none was made. */
  readonly sizeCheck: SizeCheck | null;
}

/** Artifacts in a stable order: by kind (plan first), then label. */
const byKind = (a: ArtifactSummary, b: ArtifactSummary): number =>
  ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label);

type Step = (glob: Glob, ctx: Context, board: Board, facts: ActionFacts) => Result<Transition>;

interface CommandOptions {
  /** Read the facts some actions depend on (the latest implementation record); other steps get none. */
  readonly facts?: boolean;
  /** Read the state of the globs this one waits for into `facts.dependencies`. */
  readonly dependencies?: boolean;
  /** Read the glob's whole blocking chain into `facts.chain`. */
  readonly chain?: boolean;
  /** Runs before the step: checks input against the store, and returns more glob IDs whose state the step needs. */
  readonly prepare?: (tx: Tx, glob: Glob) => Promise<Result<readonly string[]>>;
  /** A system step that starts a run on someone's behalf: the glob's creator triggers it. */
  readonly triggeredByCreator?: boolean;
  /** Which globs the step applies to: work globs (the default), decision globs only, or either (pick-up, field edits). */
  readonly applies?: 'work' | 'decision' | 'any';
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
      const sizeCheck = await tx.getSizeCheck(glob.id);
      const sizeHeld = glob.status === 'planning' && glob.waiting != null && unresolved(sizeCheck);
      const facts = { recordSha: machine.recordShaOf(artifacts), dependencies, sizeHeld };
      const waiting = await tx.listGlobs(glob.boardId, { status: ['planning'] });
      return ok({
        glob,
        allowedActions: machine.allowedActions(glob, actor.value, facts),
        artifacts,
        waitingFor: waitingFor(glob, dependencies),
        waitedOnBy: waiting.filter((g) => waitsFor(g, glob.id)).map((g) => g.id),
        chain: await this.chainOf(tx, glob),
        sizeCheck,
      });
    });
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
  ): Promise<Result<{ glob: Glob; artifacts: ArtifactSummary[]; dependencies: ReadonlyMap<string, DependencyState>; chain: BlockingChain }[]>> {
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
      // One read of every dependency of the globs in Planning, so the list's allowed actions agree with a single read.
      const dependencies = await this.dependencyStates(tx, [
        ...new Set(globs.filter((g) => g.status === 'planning').flatMap((g) => dependencyIds(g))),
      ]);
      // The chain only matters where a run could be started (Planning) or started again (failed).
      const blocked = globs.filter((g) => (g.status === 'planning' || g.status === 'failed') && g.type !== 'super' && dependencyIds(g).length > 0);
      const reach = blocked.length === 0 ? new Map<string, Glob>() : await this.closure(tx, blocked.flatMap((g) => dependencyIds(g)));
      const chains = new Map(blocked.map((g) => [g.id, blockingChain(g.id, g, (gid) => reach.get(gid))]));
      return ok(
        globs.map((glob) => ({
          glob,
          artifacts: (byGlob.get(glob.id) ?? []).sort(byKind),
          dependencies,
          chain: chains.get(glob.id) ?? NO_CHAIN,
        })),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Commands from people (each carries the version the client read)

  async create(email: string, input: CreateGlobInput): Promise<Result<Glob>> {
    try {
      return await this.createWithItem(email, input);
    } catch (e) {
      if (e instanceof AttachConflict) return invalidInput('The inbox item changed: try again');
      throw e;
    }
  }

  private async createWithItem(email: string, input: CreateGlobInput): Promise<Result<Glob>> {
    // Decisions come from knowledge proposals, the inbox and the backfill: never through the work form.
    if (input.category === 'decision') return invalidInput('A decision glob is created from a knowledge proposal or an inbox item, not directly');
    // A glob about to start waits for open globs that may change the same exclusive paths (read before the transaction:
    // it asks the code host).
    let holds: readonly ImpliedAfter[] = [];
    if ((input.type === 'sub' || (input.type === 'same' && input.autoTrigger)) && this.deps.branchFiles !== undefined) {
      const board = await this.deps.store.transaction((tx) => tx.getBoard(input.boardId));
      if (board !== null) {
        const candidate = { id: null, plan: planOf(input), ...(input.files === undefined ? {} : { files: input.files }) };
        holds = await findHolds(this.deps.store, this.deps.branchFiles, board, candidate, new Set(input.after ?? []), await this.deps.dependencyLearning?.prediction(board.id));
      }
    }
    // The snapshot's embedding is computed here, outside the transaction (it calls a model).
    const embedding = await embedRequest(this.deps.embedder, input.intake?.request ?? planOf(input));
    // The size check asks a model too, so it is made here as well; a failing model leaves the text estimate.
    const planText = planOf(input);
    const size = this.deps.sizeCheck === undefined ? null : await this.deps.sizeCheck.assess(input.boardId, planText);
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
      let overlaps: readonly ImpliedAfter[] = [];
      if (input.overlaps !== undefined && input.overlaps.length > 0) {
        const wanted = input.overlaps;
        const found = await this.closure(tx, wanted);
        const checked = checkOverlaps(null, wanted, board.id, (id) => found.get(id));
        if (!checked.ok) return checked;
        overlaps = explicitOverlaps(checked.value.filter((id) => !after.includes(id)));
      }
      const sizeHold = size !== null && size.flagged ? `Oversized: ${size.reasons.join('; ')}. Split it or keep it whole to start it` : undefined;
      const createInput: CreateInput = { ...input, id: formatId(board.id, letter, n), after, impliedAfter: mergeImplied(overlaps, holds), ...(sizeHold === undefined ? {} : { sizeHold }) };
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
      // The frozen record of what intake saw and decided (spec, Intake): written with the glob, never edited.
      await tx.insertIntakeSnapshot(snapshotOf(glob, planText, input.intake ?? null, input.source ?? 'api'), embedding);
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
   * Cuts a glob in Planning into parts in one transaction: the original keeps part 0 (its ID, history and decisions; a new
   * plan.md version, title and summary), the others are created in its group with their share of the plan, copies of its
   * link attachments and the `after` chain between them. Refused once the glob has started. With an idempotency key a retry
   * returns the same parts, whatever the version.
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
      for (const n of part.overlaps ?? []) {
        if (!Number.isInteger(n) || n < 0 || n >= index) return invalidInput(`Part ${index} can only overlap earlier parts, not ${n}`);
      }
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
      if (original.status !== 'planning' || original.provisioning !== 'none' || original.runs.some((r) => r.purpose !== 'investigate') || original.pr !== null) {
        return invalidInput(`${id} has started, so it can no longer be split: finish it and create the rest as follow-ups`);
      }
      const board = await tx.getBoard(original.boardId);
      if (board === null) return notFound(`No board ${original.boardId}`);
      const ctx = await this.context(actor.value, board);

      // IDs first, so every plan can name the others.
      const ids: string[] = [original.id];
      for (const part of wanted.slice(1)) {
        const letter = letterOf(part.category ?? original.category);
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
      const escalations = splitEscalations(
        original,
        wanted.map((part) => ({ plan: fillPartIds(part.plan, ids), type: part.type ?? original.type })),
        areas.length > 0 ? areas : defaultAreas(board.id, ctx.now),
        email,
        ctx.now,
      );

      // Part 0: the original keeps its ID and gets the new fields.
      const first = wanted[0];
      if (first === undefined) return invalidInput('A split needs at least 2 parts');
      const firstEscalation = escalations[0];
      const firstType = firstEscalation?.type ?? first.type;
      const changes: FieldChanges = {
        title: first.title,
        ...(first.category === undefined ? {} : { category: first.category }),
        ...(firstType === undefined || (first.type === undefined && firstType === original.type) ? {} : { type: firstType }),
      };
      const changed = machine.changeFields(original, changes, board, ctx, new Map());
      if (!changed.ok) return changed;
      const escalationChanged = firstEscalation?.change != null;
      const moved = escalationChanged ? { ...changed.value.glob, escalation: firstEscalation.escalation } : changed.value.glob;
      const updated = changed.value.changed || escalationChanged ? { ...moved, version: original.version + 1 } : original;
      if (updated !== original && !(await tx.updateGlob(updated, original.version))) {
        const current = await tx.getGlob(id);
        return current === null ? notFound(`No glob ${id}`) : err({ code: 'version_conflict', message: 'The glob has changed', current });
      }
      await tx.appendEvents(changed.value.events);
      await tx.enqueueEffects(changed.value.effects);
      if (firstEscalation?.change != null) await tx.appendEvents([escalationEvent(id, email, ctx.now, firstEscalation.change)]);

      const attachments = await tx.listArtifacts(original.id, 'attachment');
      const inherited = [...(original.after ?? [])];
      const globs: Glob[] = [updated];
      const withArtifacts = [original.id];
      for (const [index, part] of wanted.entries()) {
        if (index === 0) continue;
        const partId = ids[index];
        if (partId === undefined) throw new Error(`No ID for part ${index}`);
        const awaitedIds = [...new Set([...inherited, ...(part.after ?? []).map((n) => ids[n] ?? '')])];
        const found = await this.closure(tx, awaitedIds);
        const checked = checkAfter(null, awaitedIds, board.id, (gid) => found.get(gid));
        if (!checked.ok) return checked;
        if (checked.value.length > MAX_AFTER) return invalidInput(`Part ${index} would wait for more than ${MAX_AFTER} globs`);
        // Overlaps are never needs: a part that also needs the glob keeps only the need.
        const overlapIds = [...new Set((part.overlaps ?? []).map((n) => ids[n] ?? ''))].filter((o) => !checked.value.includes(o));
        const foundOverlaps = await this.closure(tx, overlapIds);
        const checkedOverlaps = checkOverlaps(null, overlapIds, board.id, (gid) => foundOverlaps.get(gid));
        if (!checkedOverlaps.ok) return checkedOverlaps;
        const created = machine.create(
          {
            id: partId,
            boardId: board.id,
            title: part.title,
            type: escalations[index]?.type ?? part.type ?? original.type,
            category: part.category ?? original.category,
            group: original.group,
            environment: original.environment,
            autoTrigger: false,
            after: checked.value,
            ...(checkedOverlaps.value.length === 0 ? {} : { impliedAfter: explicitOverlaps(checkedOverlaps.value) }),
            // A same part that waits for others starts by itself when they merge (a person can turn that off).
            autoStart: true,
          },
          board,
          ctx,
          await this.dependencyStates(tx, checked.value),
        );
        if (!created.ok) return created;
        const partEscalation = escalations[index];
        const glob = { ...created.value.glob, version: 1, ...(partEscalation?.escalation == null ? {} : { escalation: partEscalation.escalation }) };
        if (!(await tx.insertGlob(glob, key(index)))) throw new Error(`Glob ID collision for ${glob.id}`);
        await tx.appendEvents(created.value.events);
        if (partEscalation?.change != null) await tx.appendEvents([escalationEvent(partId, email, ctx.now, partEscalation.change)]);
        await tx.enqueueEffects(created.value.effects);
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

  /** `changes.after` is checked here (IDs exist on the board, no cycle, merged ones dropped) before the machine sees it. */
  async update(email: string, id: string, version: number, changes: FieldChanges) {
    // A scope on one glob must name a work glob of the board (the pure step cannot look it up; it reports other faults itself).
    if (changes.attributes !== undefined) {
      const checked = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
        const decision = await tx.getGlob(id);
        const scope = decision === null ? null : validateScopeEdit(decision.category, changes.attributes);
        if (decision === null || scope === null || !scope.ok || scope.value.kind !== 'glob') return ok(null);
        const governed = await tx.getGlob(scope.value.ref);
        return governed?.boardId !== decision.boardId || governed.category === 'decision'
          ? invalidInput(`No work glob ${scope.value.ref} on board ${String(decision.boardId)}`)
          : ok(null);
      });
      if (!checked.ok) return checked;
    }
    const wanted = changes.after;
    const wantedOverlaps = changes.overlaps;
    // A same becoming a sub is about to start: the merge policy may hold it.
    const holds = changes.type === 'sub' ? await this.holdsFor(id) : [];
    let checkedAfter: readonly string[] | undefined;
    let checkedOverlaps: readonly string[] | undefined;
    const before: { type: SlopType | null } = { type: null };
    const result = await this.command(
      email,
      id,
      version,
      (glob, ctx, board, facts) => {
        before.type = glob.type;
        return machine.changeFields(
          glob,
          { ...changes, ...(checkedAfter === undefined ? {} : { after: checkedAfter }), ...(checkedOverlaps === undefined ? {} : { overlaps: checkedOverlaps }), ...(holds.length === 0 ? {} : { impliedAfter: holds }) },
          board,
          ctx,
          facts.dependencies,
        );
      },
      {
        applies: 'any',
        dependencies: true,
        ...((wanted !== undefined || wantedOverlaps !== undefined || holds.length > 0) && {
          prepare: async (tx: Tx, glob: Glob): Promise<Result<readonly string[]>> => {
            if (wantedOverlaps !== undefined) {
              const found = await this.closure(tx, wantedOverlaps);
              const checked = checkOverlaps(glob.id, wantedOverlaps, glob.boardId, (gid) => found.get(gid));
              if (!checked.ok) return checked;
              checkedOverlaps = checked.value;
            }
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
    if (result.ok && before.type !== null && before.type !== result.value.type) await this.recordRetype(result.value, before.type, email);
    return result;
  }

  /** A person's retype teaches the board's intake (spec, Intake); recording never fails the change. */
  private recordRetype(glob: Glob, from: SlopType, actor: string): Promise<void> {
    return recordTypeCorrection(this.deps.store, this.deps.clock, { boardId: glob.boardId, globId: glob.id, from, to: glob.type, actor }, this.deps.log);
  }

  async start(email: string, id: string, version: number) {
    const holds = await this.holdsFor(id);
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.start(glob, ctx, facts.dependencies, holds, facts.chain), {
      dependencies: true,
      chain: true,
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
      { dependencies: true, applies: 'any' },
    );
    return result.ok ? ok({ glob: result.value, warning }) : result;
  }

  /** Review now: queues a fresh independent review of a glob with a PR in Doing or Reviewing (any board member; no version needed). */
  reviewNow(email: string, id: string) {
    return this.command(email, id, null, (glob, ctx) => machine.reviewNow(glob, ctx));
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
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.retrigger(glob, ctx, facts.chain, anyway), {
      chain: true,
    });
  }

  resolveConflict(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.resolveConflict(glob, ctx));
  }

  startAgain(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx, _board, facts) => machine.startAgain(glob, ctx, facts.dependencies), {
      dependencies: true,
    });
  }

  /** Merge, or (`continueAfter`, supers) Merge and continue, which needs the latest implementation record at the head. */
  merge(email: string, id: string, version: number, continueAfter = false) {
    return this.command(
      email,
      id,
      version,
      (glob, ctx, _board, facts) => machine.requestMerge(glob, ctx, { continue: continueAfter, facts }),
      { facts: continueAfter },
    );
  }

  /** Retry merge: a failed merge (not a conflict) goes back to merging at the head, which already passed. */
  retryMerge(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.retryMerge(glob, ctx));
  }

  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel(email: string, id: string, version: number, name: LabelName, command: LabelCommand) {
    return this.command(email, id, version, (glob, ctx) => machine.reviewLabel(glob, name, command, ctx));
  }

  /** Decision globs: sign off an accepted decision (Reviewing to Signed off). */
  signOffDecision(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.signOffDecision(glob, ctx), { applies: 'decision' });
  }

  /** Decision globs: take an accepted decision back to Doing, its outcome cleared. */
  reopenDecision(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.reopenDecision(glob, ctx), { applies: 'decision' });
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

  /** A person makes an escalated glob a sub again. */
  deescalate(email: string, id: string, version: number) {
    return this.command(email, id, version, (glob, ctx) => machine.deescalate(glob, ctx));
  }

  /** Make it a super: a person takes over a failed sub or same whose routine asked for pairing. Counts as a type correction. */
  async makeSuper(email: string, id: string, version: number) {
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
    return this.command(email, id, null, (glob, ctx) =>
      machine.reportFailure(glob, { reason, runId, agentSetVersion, ...(pairing === undefined ? {} : pairing) }, ctx),
    ).then(async (result) => {
      // A run that failed for unmerged prerequisites teaches the board a need; the report itself never fails on it.
      if (result.ok) await this.deps.dependencyLearning?.onFailed(id, reason).catch((e: unknown) => this.deps.log?.('dependency learning', e instanceof Error ? e.message : String(e)));
      return result;
    });
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
      // A learning an agent submitted or slop mined is a KB item: deleting it would lose the learning (and a rejected one
      // suppresses repeats), so it is rejected instead. Decisions people made (inbox, extracted, manual) can go.
      if (isLearning(glob)) return invalidInput('This decision is a knowledge item an agent submitted or slop mined; reject it instead of deleting it');
      const fileKeys = await fileKeysOf(tx, glob.id);
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
    // The merge is also an outcome for the board's dependency rules (its overlaps went cleanly or not); it never blocks the release.
    await this.deps.dependencyLearning?.onMerged(mergedId).catch((e: unknown) => this.deps.log?.('dependency learning', e instanceof Error ? e.message : String(e)));
    const planning = await this.deps.store.transaction((tx) => tx.listGlobs(boardId, { status: ['planning'] }));
    const released: string[] = [];
    for (const waiting of planning) {
      if (waiting.waiting == null || !waitsFor(waiting, mergedId)) continue;
      const result = await this.release(waiting.id);
      if (result.ok && result.value.status !== 'planning') released.push(waiting.id);
    }
    return released;
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
   * After a size check was re-judged (its plan was saved): a sub held in Planning for the flag starts once the check no
   * longer holds it. A newly flagged sub needs nothing here: `release` refuses an unanswered flag, and a sub in Planning
   * is always waiting on something.
   */
  async reconcileSizeHold(id: string): Promise<void> {
    const lift = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob !== null && glob.status === 'planning' && glob.type === 'sub' && glob.waiting != null && !unresolved(await tx.getSizeCheck(id));
    });
    if (lift) await this.release(id);
    // The plan was re-judged: a glob that now looks big is investigated (a no-op when it already was).
    await this.autoInvestigate(id);
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
      return { board, globs, plans };
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
      const skip = new Set([...(glob.after ?? []), ...mine.filter((i) => !machine.isReplaceableOverlap(i)).map((i) => i.id)]);
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
        const state = other === undefined ? 'missing' : dependencyState(other);
        dropReasons.set(
          edge.id,
          other === undefined
            ? `${edge.id} was deleted`
            : state === 'merged'
              ? `${edge.id} merged`
              : state === 'planning'
                ? `${edge.id} is back in Planning`
                : other.status === 'failed'
                  ? `${edge.id} failed`
                  : `${edge.id} no longer changes ${edge.paths.slice(0, 3).join(', ')}`,
        );
      }
      const result = await this.command(null, glob.id, null, (g, ctx) => machine.overlapsRechecked(g, { edges: found, dropReasons }, ctx));
      if (result.ok && result.value.version !== glob.version) changed.push(glob.id);
    }
    return changed;
  }

  /** Starts one held glob if everything it waits for has merged and the merge policy still lets it. */
  async release(id: string) {
    // A glob held for its size flag stays held until a person splits it or keeps it whole.
    const held = await this.deps.store.transaction(async (tx) => (unresolved(await tx.getSizeCheck(id)) ? await tx.getGlob(id) : null));
    if (held !== null) return ok(held);
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
      const plan = (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '';
      return { glob, board, plan };
    });
    if (read === null) return [];
    // Holds a person overrode, and globs already waited for, are not held for again.
    const skip = new Set([...(read.glob.after ?? []), ...(read.glob.impliedAfter ?? []).map((i) => i.id)]);
    return findHolds(this.deps.store, branchFiles, read.board, { id, plan: read.plan }, skip, await this.deps.dependencyLearning?.prediction(read.board.id));
  }

  /** The state of each glob in `ids` (a glob that no longer exists is `missing`). */
  private async dependencyStates(tx: Tx, ids: readonly string[]): Promise<Map<string, DependencyState>> {
    const found = ids.length === 0 ? [] : await tx.getGlobs(ids);
    const byId = new Map(found.map((g) => [g.id, g]));
    return new Map(ids.map((id) => [id, dependencyState(byId.get(id))]));
  }

  /** What the glob is blocked by: its unmerged prerequisites and theirs in turn. */
  private async chainOf(tx: Tx, glob: Glob): Promise<BlockingChain> {
    if (glob.type === 'super') return NO_CHAIN;
    const reach = await this.closure(tx, dependencyIds(glob));
    return blockingChain(glob.id, glob, (id) => reach.get(id));
  }

  /** The chain of a glob by ID, for the routine executor's last check before a session is spent. */
  async blockingChainOf(id: string): Promise<BlockingChain> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      return glob === null ? NO_CHAIN : this.chainOf(tx, glob);
    });
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
        // No work command (start, merge, labels, retrigger...) may run on a decision, and no decision step on work.
        const applies = options.applies ?? 'work';
        if (applies !== 'any' && (glob.category === 'decision') !== (applies === 'decision')) {
          return err({
            code: 'invalid_transition',
            message: glob.category === 'decision' ? 'A decision glob has no such action' : 'Only a decision glob can do this',
            status: glob.status,
            allowedActions: actor === null ? [] : machine.allowedActions(glob, actor),
          });
        }
        let extraIds: readonly string[] = [];
        if (options.prepare !== undefined) {
          const prepared = await options.prepare(tx, glob);
          if (!prepared.ok) return prepared;
          extraIds = prepared.value;
        }
        const record = options.facts === true
          ? { recordSha: machine.recordShaOf(await tx.listArtifactSummaries(glob.boardId, [glob.id])) }
          : {};
        const dependencies =
          options.dependencies === true
            ? { dependencies: await this.dependencyStates(tx, [...new Set([...dependencyIds(glob), ...extraIds])]) }
            : {};
        const chain = options.chain === true ? { chain: await this.chainOf(tx, glob) } : {};
        const facts: ActionFacts = { ...record, ...dependencies, ...chain };
        const ctx = await this.context(actor, board, options.triggeredByCreator === true ? glob.creator : undefined);
        const transition = step(glob, ctx, board, facts);
        if (!transition.ok) return transition;
        const { changed, events } = transition.value;
        // A status change, a push or a merge may change which open globs overlap: queue the board's recheck (coalesced).
        const moved =
          changed && (transition.value.glob.status !== glob.status || events.some((e) => e.type === 'CommitPushed' || e.type === 'Merged'));
        // A work glob signed off is a recent change on the board's knowledge page (decisions queue their own).
        const signedOff = changed && glob.category !== 'decision' && glob.status !== 'signed_off' && transition.value.glob.status === 'signed_off';
        const effects = [...transition.value.effects, ...(moved ? [recheckOverlapsEffect(glob.boardId)] : []), ...(signedOff ? [knowledgePageEffect(glob.boardId)] : [])];
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
