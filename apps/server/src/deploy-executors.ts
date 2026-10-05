import type { Board, DeployService, EffectKind } from '@slop/core';
import type { Deployer } from './deployer.js';
import type { Executor } from './jobs/outbox.js';

/** How long a deploy's signed callback URL stays valid. */
export const CALLBACK_TTL_SECONDS = 24 * 3600;

/**
 * Outbox executors for branch deploys. A push's deploy request goes through the deploy service's
 * queue; starting a deploy calls the board's provider. A deploy that can't start is recorded as
 * failed rather than retried, so its environment's queue moves on and the card shows why.
 */
export const deployExecutors = (
  deploys: DeployService,
  deployer: Deployer,
  boardOf: (id: number) => Promise<Board | null>,
  callbackUrl: (deployId: string) => string,
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
    if (board === null) return fail(`No board ${deploy.boardId}`);
    try {
      const started = await deployer.start({
        board,
        deploy,
        branch: glob.id,
        callbackUrl: callbackUrl(deploy.id),
      });
      const result = await deploys.started(deploy.id, started);
      if (!result.ok) throw new Error(result.error.message);
      return 'done';
    } catch (error) {
      return fail(`Couldn't start the deploy: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
