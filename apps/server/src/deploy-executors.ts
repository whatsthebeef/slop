import { deploys as deployRules } from '@slop/core';
import type { Board, Deploy, DeployService, EffectKind } from '@slop/core';
import type { Deployer, StartedDeploy } from './deployer.js';
import { callbackPath } from './http/deploys.js';
import type { Executor } from './jobs/outbox.js';
import type { SignedLinks } from './signed-links.js';

/** How long a deploy's signed callback URL stays valid, from when the deploy was requested. */
export const CALLBACK_TTL_SECONDS = 24 * 3600;

/**
 * A deploy's signed callback URL. It expires a fixed time after the request, so every start of the
 * same deploy sends the job identical parameters (CodeBuild's idempotency token needs that).
 */
export const deployCallbackUrl =
  (links: SignedLinks, baseUrl: string) =>
  (deploy: Deploy): string => {
    const path = callbackPath(deploy.id);
    const expires = Math.floor(Date.parse(deploy.requestedAt) / 1000) + CALLBACK_TTL_SECONDS;
    const { signature } = links.signUntil(path, expires);
    return `${baseUrl}${path}?expires=${String(expires)}&sig=${signature}`;
  };

/**
 * Outbox executors for branch deploys. A push's deploy request goes through the deploy service's
 * queue; starting a deploy calls the board's provider. A deploy that can't start is recorded as
 * failed rather than retried, so its environment's queue moves on and the card shows why.
 */
export const deployExecutors = (
  deploys: DeployService,
  deployer: Deployer,
  boardOf: (id: number) => Promise<Board | null>,
  callbackUrl: (deploy: Deploy) => string,
  log: (task: string, message: string) => void,
): Partial<Record<EffectKind, Executor>> => ({
  request_deploy: async (effect, glob) => {
    if (effect.kind !== 'request_deploy' || glob === null) return 'dropped';
    const result = await deploys.requestFromPush(glob.id, effect.sha);
    if (!result.ok) throw new Error(result.error.message);
    return result.value === null ? 'dropped' : 'done';
  },

  start_deploy: async (effect, glob) => {
    if (effect.kind !== 'start_deploy') return 'dropped';
    const deploy = await deploys.get(effect.deployId);
    // Already started, finished or replaced: a repeated effect.
    if (deploy?.state !== 'running' || deploy.startedAt !== null) return 'dropped';
    const fail = async (error: string) => {
      log('deploy', `${deploy.id} (${deploy.globId} to ${deploy.environment}): ${error}`);
      await deploys.finished(deploy.id, { succeeded: false, error });
      return 'done' as const;
    };
    if (glob === null) return fail(`${deploy.globId} was deleted`);
    const board = await boardOf(deploy.boardId);
    if (board === null) return fail(`No board ${String(deploy.boardId)}`);
    // The environment's settings may have changed while the deploy waited.
    const blocked = deployRules.startBlocked(board, deploy, glob.environment);
    if (blocked !== null) return fail(`Not started: ${blocked}`);
    let started: StartedDeploy;
    try {
      started = await deployer.start({ board, deploy, branch: glob.id, callbackUrl: callbackUrl(deploy) });
    } catch (error) {
      return fail(`Couldn't start the deploy: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The job is running now: if recording that fails, throw so the outbox retries (the start is
    // idempotent per deploy), rather than marking a running job failed.
    const result = await deploys.started(deploy.id, started);
    if (!result.ok) throw new Error(result.error.message);
    return 'done';
  },
});
