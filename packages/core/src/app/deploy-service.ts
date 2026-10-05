import * as deploys from '../domain/deploys.js';
import type { Deploy, DeployChange, DeployIndicator } from '../domain/deploys.js';
import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Hint, Notifier, Store, Tx } from '../ports.js';

/** A transaction, and the deploys written in it so far (to tell open boards after it commits). */
interface DeployTx {
  readonly tx: Tx;
  readonly written: Deploy[];
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
      const recent = globIds.length === 0 ? [] : await tx.listDeploys(boardId, { globIds });
      const latest = new Map<string, Deploy>();
      // Newest first, so the first one seen per glob is its latest.
      for (const d of recent) if (!latest.has(d.globId)) latest.set(d.globId, d);
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
      const running = await tx.listDeploys(board.id, { environment: glob.environment, states: ['running'] });
      if (running.length > 0) return invalidInput(deployRunning(glob.environment, running[0]?.globId ?? ''));
      return ok(await this.enqueue(dtx, glob, glob.environment, sha, 'deploy_now', email));
    });
  }

  /** The provider accepted a deploy (from the outbox executor). */
  async started(deployId: string, ref: { providerRef: string; url: string | null }): Promise<Result<Deploy | null>> {
    return this.change(async (dtx) => {
      const { tx } = dtx;
      const deploy = await tx.getDeploy(deployId);
      if (deploy === null) return notFound(`No deploy ${deployId}`);
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

  // -------------------------------------------------------------------------

  private async finish(dtx: DeployTx, deploy: Deploy, result: DeployResult): Promise<Deploy | null> {
    const active = await dtx.tx.listDeploys(deploy.boardId, {
      environment: deploy.environment,
      states: ['waiting', 'running'],
    });
    return this.apply(dtx, deploys.finished(active, deploy, result, this.deps.clock.now()));
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
    const result = await this.deps.store.transaction((tx) => work({ tx, written }));
    if (result.ok) {
      const globs = new Map(written.map((d) => [d.globId, d.boardId]));
      for (const [globId, boardId] of globs) {
        const hint: Hint = { kind: 'glob.deploys', boardId, globId };
        this.deps.notifier.publish(hint);
      }
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
