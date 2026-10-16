import { webhookSubscribers } from '../domain/atf-runners.js';
import * as deploys from '../domain/deploys.js';
import type { Deploy, DeployChange, DeployIndicator } from '../domain/deploys.js';
import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Effect } from '../domain/events.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { markStepsDue } from './step-due.js';

/** A transaction, and the deploys written in it so far (to tell open boards after it commits). */
interface DeployTx {
  readonly tx: Tx;
  readonly written: Deploy[];
  /** Globs whose human steps fell due in it (their cards' Arm system and steps change). */
  readonly due: Glob[];
}

export interface DeployServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly newDeployId: () => string;
}

/** A deploy result reported by a provider or the signed callback. */
export interface DeployResult {
  readonly succeeded: boolean;
  readonly error: string | null;
}

/**
 * Application service for branch deploys. Pushes (through the outbox), Deploy now, provider events
 * and the signed callback all go through it, so the per-environment queue is applied in one place,
 * in the same transaction as the events and effects it produces.
 */
export class DeployService {
  constructor(private readonly deps: DeployServiceDeps) {}

  /** One deploy, for system callers (the outbox, provider results). */
  async get(id: string): Promise<Deploy | null> {
    return this.deps.store.transaction((tx) => tx.getDeploy(id));
  }

  /** A glob's latest deploys, newest first, for the glob view's history. */
  async history(email: string, globId: string, limit = 10): Promise<Result<Deploy[]>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${glob.boardId}`);
      }
      return ok(await tx.listDeploys(glob.boardId, { globIds: [globId], limit }));
    });
  }

  /**
   * Deploy indicators for globs on a board, and the environments with a deploy running (where
   * Deploy now is disabled for everyone). Read alongside the glob list, not stored on globs.
   */
  async boardState(
    boardId: number,
    globIds: readonly string[],
  ): Promise<{ indicators: Map<string, DeployIndicator>; running: Set<string> }> {
    return this.deps.store.transaction(async (tx) => {
      const indicators = new Map<string, DeployIndicator>();
      const latest = new Map<string, Deploy>(
        (globIds.length === 0 ? [] : await tx.latestDeploys(boardId, globIds)).map((d) => [d.globId, d]),
      );
      const live = new Map<string, Deploy | null>();
      for (const d of latest.values()) {
        if (!live.has(d.environment)) live.set(d.environment, await this.liveIn(tx, boardId, d.environment));
      }
      for (const [globId, d] of latest) {
        const indicator = deploys.indicatorFor(d, live.get(d.environment) ?? null);
        if (indicator !== null) indicators.set(globId, indicator);
      }
      const running = new Set(
        (await tx.listDeploys(boardId, { states: ['running'] })).map((d) => d.environment),
      );
      return { indicators, running };
    });
  }

  /**
   * A push to a glob branch asked for a deploy (from the outbox, so a retry may repeat it): the same
   * commit already waiting, running or deployed by a push is not requested again.
   */
  async requestFromPush(globId: string, sha: string): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      if (deploys.deployBlocked(board, glob.environment) !== null || glob.environment === null) return ok(null);
      // Under the queue lock, so two deliveries of the same push can't both pass the duplicate check.
      await tx.lockDeployQueue(board.id, glob.environment);
      const [latest] = await tx.listDeploys(board.id, { globIds: [globId], limit: 1 });
      if (latest?.sha === sha && latest.trigger === 'push' && latest.state !== 'replaced') return ok(null);
      return ok(await this.enqueue(dtx, glob, glob.environment, sha, 'push', null));
    });
  }

  /**
   * Deploy now: deploys the glob's PR head to its environment. Any board member may, except while a
   * deploy runs in that environment (disabled for everyone).
   */
  async deployNow(email: string, globId: string): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${glob.boardId}`);
      }
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      const blocked = deploys.deployBlocked(board, glob.environment);
      if (blocked !== null || glob.environment === null) return invalidInput(blocked ?? 'The glob has no environment');
      const sha = glob.pr?.headSha ?? null;
      if (sha === null) return invalidInput(`${glob.id} has no pushed commit to deploy`);
      await tx.lockDeployQueue(board.id, glob.environment);
      const running = await tx.listDeploys(board.id, { environment: glob.environment, states: ['running'] });
      if (running.length > 0) return invalidInput(deployRunning(glob.environment, running[0]?.globId ?? ''));
      return ok(await this.enqueue(dtx, glob, glob.environment, sha, 'deploy_now', email));
    });
  }

  /** The provider accepted a deploy (from the outbox executor). */
  async started(deployId: string, ref: { providerRef: string; url: string | null }): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const found = await tx.getDeploy(deployId);
      if (found === null) return notFound(`No deploy ${deployId}`);
      // Under the queue lock, so a result that finished it meanwhile isn't overwritten.
      await tx.lockDeployQueue(found.boardId, found.environment);
      const deploy = (await tx.getDeploy(deployId)) ?? found;
      return ok(await this.apply(dtx, deploys.started(deploy, ref, this.deps.clock.now())));
    });
  }

  /** A deploy finished, or couldn't start; the environment's waiting deploy starts next. */
  async finished(deployId: string, result: DeployResult): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const deploy = await tx.getDeploy(deployId);
      if (deploy === null) return notFound(`No deploy ${deployId}`);
      return ok(await this.finish(dtx, deploy, result));
    });
  }

  /** A provider event about a deploy it knows by its own handle (e.g. a CodeBuild build ID). */
  async finishedByProviderRef(providerRef: string, result: DeployResult): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const deploy = await tx.findDeployByProviderRef(providerRef);
      // Builds slop didn't start (PR checks, other pipelines) are not deploys.
      if (deploy === null) return ok(null);
      return ok(await this.finish(dtx, deploy, result));
    });
  }

  /**
   * Gives up on running deploys that never started or whose result never came (see
   * `deploys.staleReason`), failing them so their environments' waiting deploys start. Returns how many.
   */
  async sweep(now: string = this.deps.clock.now()): Promise<number> {
    const stale = await this.deps.store.transaction(async (tx) => {
      const found: { id: string; reason: string }[] = [];
      for (const board of await tx.listAllBoards()) {
        for (const d of await tx.listDeploys(board.id, { states: ['running'] })) {
          const reason = deploys.staleReason(d, now);
          if (reason !== null) found.push({ id: d.id, reason });
        }
      }
      return found;
    });
    let gaveUp = 0;
    for (const { id } of stale) if (await this.giveUp(id, now)) gaveUp++;
    return gaveUp;
  }

  /**
   * Fails a stale running deploy, re-checking under the queue lock that it is still stale (it may have
   * started, or its result arrived, since the sweep looked). True if it gave up on it.
   */
  private async giveUp(id: string, now: string): Promise<boolean> {
    const result = await this.change(async (dtx) => {
      const { tx } = dtx;
      const found = await tx.getDeploy(id);
      if (found === null) return ok(false);
      await tx.lockDeployQueue(found.boardId, found.environment);
      const deploy = await tx.getDeploy(id);
      const reason = deploy === null ? null : deploys.staleReason(deploy, now);
      if (deploy === null || reason === null) return ok(false);
      await this.finish(dtx, deploy, { succeeded: false, error: reason });
      return ok(true);
    });
    return result.ok && result.value;
  }

  // -------------------------------------------------------------------------

  private async finish(dtx: DeployTx, found: Deploy, result: DeployResult): Promise<Deploy | null> {
    await dtx.tx.lockDeployQueue(found.boardId, found.environment);
    // Re-read under the lock: another transaction may have finished it meanwhile.
    const deploy = (await dtx.tx.getDeploy(found.id)) ?? found;
    const active = await dtx.tx.listDeploys(deploy.boardId, {
      environment: deploy.environment,
      states: ['waiting', 'running'],
    });
    const change = deploys.finished(active, deploy, result, this.deps.clock.now());
    const done = await this.apply(dtx, change);
    // Only the write that finished it succeeded it (a repeated result changes nothing, so this runs once per deploy).
    const finishedNow = change.writes.find((d) => d.id === deploy.id);
    if (finishedNow?.state === 'succeeded') await this.deployed(dtx, finishedNow);
    return done;
  }

  /**
   * A branch deploy succeeded: the glob's `after_deploy:<environment>` steps fall due (before the merge too), a push-mode
   * board's ATF project is started and runners that subscribed to the deploy-live webhook are told, all in the deploy's
   * transaction. The outbox keeps one start per board, environment and commit and one delivery per runner and deploy.
   */
  private async deployed(dtx: DeployTx, deploy: Deploy): Promise<void> {
    const { tx } = dtx;
    const now = this.deps.clock.now();
    const glob = await tx.getGlob(deploy.globId);
    if (glob !== null && (await markStepsDue(tx, deploy.boardId, [glob.id], deploy.environment, now)).length > 0) dtx.due.push(glob);
    const boardWide = `board-${String(deploy.boardId)}`;
    const effects: Effect[] = [];
    if ((await tx.getBoard(deploy.boardId))?.atf?.mode === 'push') {
      effects.push({ kind: 'start_atf', globId: boardWide, boardId: deploy.boardId, environment: deploy.environment, sha: deploy.sha });
    }
    for (const runner of webhookSubscribers(await tx.listAtfRunners(deploy.boardId), deploy.environment)) {
      effects.push({
        kind: 'deliver_atf_webhook',
        globId: boardWide,
        boardId: deploy.boardId,
        runnerId: runner.id,
        deployId: deploy.id,
        environment: deploy.environment,
        sha: deploy.sha,
        deployedAt: deploy.finishedAt ?? now,
      });
    }
    await tx.enqueueEffects(effects);
  }

  private async enqueue(
    dtx: DeployTx,
    glob: Glob,
    environment: string,
    sha: string,
    trigger: Deploy['trigger'],
    requestedBy: string | null,
  ): Promise<Deploy | null> {
    const { tx } = dtx;
    await tx.lockDeployQueue(glob.boardId, environment);
    const now = this.deps.clock.now();
    const active = await tx.listDeploys(glob.boardId, { environment, states: ['waiting', 'running'] });
    const deploy: Deploy = {
      id: this.deps.newDeployId(),
      boardId: glob.boardId,
      environment,
      globId: glob.id,
      sha,
      state: 'waiting',
      trigger,
      requestedBy,
      requestedAt: now,
      runningSince: null,
      startedAt: null,
      finishedAt: null,
      providerRef: null,
      url: null,
      error: null,
    };
    await this.apply(dtx, deploys.request(active, deploy, now));
    return tx.getDeploy(deploy.id);
  }

  /**
   * Writes a change; returns the deploy it was about (the last write), or null if nothing changed.
   * The transaction's writes are recorded so open boards can be told after it commits.
   */
  private async apply({ tx, written }: DeployTx, change: DeployChange): Promise<Deploy | null> {
    await tx.saveDeploys(change.writes);
    await tx.appendEvents(change.events);
    await tx.enqueueEffects(change.effects);
    written.push(...change.writes);
    return change.writes.at(-1) ?? null;
  }

  /** Runs a change in a transaction, then tells open boards which globs' deploys changed. */
  private async change<T>(work: (tx: DeployTx) => Promise<Result<T>>): Promise<Result<T>> {
    const written: Deploy[] = [];
    const due: Glob[] = [];
    const result = await this.deps.store.transaction((tx) => work({ tx, written, due }));
    if (result.ok) {
      const globs = new Map(written.map((d) => [d.globId, d.boardId]));
      for (const [globId, boardId] of globs) {
        const hint: Hint = { kind: 'glob.deploys', boardId, globId };
        this.deps.notifier.publish(hint);
      }
      // A step falling due changes the board's Arm system label and Human steps, which the deploys hint doesn't refresh.
      for (const glob of due) this.deps.notifier.publish({ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: glob.version });
    }
    return result;
  }

  private async liveIn(tx: Tx, boardId: number, environment: string): Promise<Deploy | null> {
    const [live] = await tx.listDeploys(boardId, { environment, states: ['succeeded'], limit: 1 });
    return live ?? null;
  }
}

export const deployRunning = (environment: string, globId: string): string =>
  `A deploy of ${globId} is running in ${environment}; Deploy now is available when it finishes`;
