import * as environments from '../domain/environments.js';
import type { Containment, EnvironmentDeploy, EnvironmentIndicator, GlobPresence } from '../domain/environments.js';
import { forbidden, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Effect } from '../domain/events.js';
import type { EnvironmentRole } from '../domain/types.js';
import type { Clock, Hint, Notifier, Store } from '../ports.js';

export interface EnvironmentServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
}

/** A deploy a board's pipeline reported (through EventBridge, or posted directly with the key). */
export interface ReportedDeploy {
  /** `owner/name`: every board on that repo with a release or integration environment of that name records it. */
  readonly repo: string;
  readonly environment: string;
  readonly sha: string;
  readonly ref: string | null;
  readonly succeeded: boolean;
  readonly url: string | null;
  /** When it happened, if the reporter said; else now. */
  readonly at: string | null;
  readonly eventId: string;
}

/** One observed environment in the glob view: whether it holds the glob, and what it runs. */
export interface GlobEnvironment {
  readonly environment: string;
  readonly role: EnvironmentRole;
  readonly production: boolean;
  /** Null until a deploy there has been checked against the glob (or the glob hasn't merged). */
  readonly presence: GlobPresence | null;
  /** The environment's latest succeeded deploy. */
  readonly latest: EnvironmentDeploy | null;
}

const DAY_MS = 86_400_000;

/**
 * Application service for release and integration environments: records the deploys pipelines report, works out
 * (with the code host's answers, from the outbox) which globs each environment holds, and serves that to the board.
 * Presence lives beside the glob, like branch deploys: it doesn't bump the glob's version, so open boards get
 * `glob.deploys` hints.
 */
export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  /**
   * Records a reported deploy on every board whose repo and observed environment match, and queues the containment
   * check when it is the environment's newest succeeded deploy. Returns the boards that recorded it (none: ignored).
   */
  async recordDeploy(input: ReportedDeploy): Promise<number[]> {
    const at = input.at ?? this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const recorded: number[] = [];
      const repo = input.repo.toLowerCase();
      for (const board of await tx.listAllBoards()) {
        if (board.repo?.toLowerCase() !== repo) continue;
        if (environments.observedEnvironment(board, input.environment) === null) continue;
        const inserted = await tx.insertEnvironmentDeploy({
          boardId: board.id,
          environment: input.environment,
          sha: input.sha,
          ref: input.ref,
          succeeded: input.succeeded,
          url: input.url,
          at,
          eventId: input.eventId,
        });
        // A redelivery: its check was queued the first time.
        if (!inserted) continue;
        recorded.push(board.id);
        if (!input.succeeded) continue;
        await tx.lockEnvironment(board.id, input.environment);
        // An older deploy reported late changes nothing: the environment runs the newer one.
        const latest = await tx.latestEnvironmentDeploy(board.id, input.environment);
        if (latest?.eventId !== input.eventId) continue;
        const effect: Effect = {
          kind: 'check_environment',
          globId: `board-${String(board.id)}`,
          boardId: board.id,
          environment: input.environment,
          sha: input.sha,
        };
        await tx.enqueueEffects([effect]);
      }
      return recorded;
    });
  }

  /**
   * The merge commits to look for in the environment's commit `sha`: every glob merged in the last
   * `RECENT_MERGE_DAYS`, and every glob the environment held at its last check (so a rollback reaches older globs).
   * Null when `sha` is no longer what the environment runs (a newer deploy's check will run) or it isn't observed.
   */
  async candidates(boardId: number, environment: string, sha: string): Promise<{ globId: string; mergeSha: string }[] | null> {
    const since = new Date(Date.parse(this.deps.clock.now()) - environments.RECENT_MERGE_DAYS * DAY_MS).toISOString();
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null || environments.observedEnvironment(board, environment) === null) return null;
      if ((await tx.latestEnvironmentDeploy(boardId, environment))?.sha !== sha) return null;
      const merges = environments.latestMerges(await tx.listBoardEvents(boardId, since, ['Merged']));
      for (const held of await tx.listGlobPresence(boardId, { environment, contained: true })) {
        if (!merges.has(held.globId)) merges.set(held.globId, held.mergeSha);
      }
      return [...merges].map(([globId, mergeSha]) => ({ globId, mergeSha }));
    });
  }

  /**
   * Stores which globs the environment's commit `sha` contains. Dropped ('stale') when the environment has had a
   * newer deploy since the check started: that deploy's own check decides.
   */
  async recordContainment(
    boardId: number,
    environment: string,
    sha: string,
    results: readonly Containment[],
  ): Promise<'recorded' | 'stale'> {
    const now = this.deps.clock.now();
    const outcome = await this.deps.store.transaction(async (tx) => {
      await tx.lockEnvironment(boardId, environment);
      if ((await tx.latestEnvironmentDeploy(boardId, environment))?.sha !== sha) return null;
      // Globs deleted while the code host was asked are left out; their rows went with them.
      const globs = await tx.getGlobs(results.map((r) => r.globId));
      const onBoard = new Set(globs.filter((g) => g.boardId === boardId).map((g) => g.id));
      const live = results.filter((r) => onBoard.has(r.globId));
      const previous = await tx.listGlobPresence(boardId, { environment, globIds: live.map((r) => r.globId) });
      const change = environments.containmentChange(previous, live, { boardId, environment, sha }, now);
      await tx.saveGlobPresence(change.writes);
      await tx.appendEvents(change.events);
      // ATF reported before this check ran now shows on every glob the commit holds, moved or not.
      const tested = (await tx.listTestRuns(boardId, { commits: [{ environment, sha }] })).length > 0;
      return { moved: change.moved, tested: tested && change.writes.some((w) => w.contained) };
    });
    if (outcome === null) return 'stale';
    const hints: Hint[] = outcome.tested
      ? [{ kind: 'board.tests', boardId }]
      : outcome.moved.map((globId) => ({ kind: 'glob.deploys', boardId, globId }));
    for (const hint of hints) this.deps.notifier.publish(hint);
    return 'recorded';
  }

  /** The observed environments each of the given globs is in, for their cards. */
  async boardState(boardId: number, globIds: readonly string[]): Promise<Map<string, EnvironmentIndicator[]>> {
    return this.deps.store.transaction(async (tx) => {
      const state = new Map<string, EnvironmentIndicator[]>();
      const board = await tx.getBoard(boardId);
      if (board === null || globIds.length === 0) return state;
      const presences = await tx.listGlobPresence(boardId, { globIds, contained: true });
      for (const glob of await tx.getGlobs([...new Set(presences.map((p) => p.globId))])) {
        const indicators = environments.environmentIndicators(board, glob, presences);
        if (indicators.length > 0) state.set(glob.id, indicators);
      }
      return state;
    });
  }

  /** The board's observed environments for the glob view: whether each holds the glob, and what it runs. */
  async forGlob(email: string, globId: string): Promise<Result<GlobEnvironment[]>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${String(glob.boardId)}`);
      }
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${String(glob.boardId)}`);
      const presences = await tx.listGlobPresence(board.id, { globIds: [globId] });
      const result: GlobEnvironment[] = [];
      for (const env of board.environments) {
        if (env.role === undefined) continue;
        result.push({
          environment: env.name,
          role: env.role,
          production: env.production === true,
          presence: presences.find((p) => p.environment === env.name) ?? null,
          latest: await tx.latestEnvironmentDeploy(board.id, env.name),
        });
      }
      return ok(result);
    });
  }
}
