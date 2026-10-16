import { AtfRefusedError } from '@slop/core';
import type { Board, Effect, EffectKind, RunnerStarter, TestRunService } from '@slop/core';
import type { Outcome, SettledExecutor } from './jobs/outbox.js';

/** What `start_atf` needs to run; split from the executor table so it can be exercised without the outbox. */
export interface AtfStartDeps {
  readonly testRuns: Pick<TestRunService, 'atfBatch'>;
  readonly starter: RunnerStarter;
  readonly boardOf: (id: number) => Promise<Pick<Board, 'atf'> | null>;
  readonly log: (task: string, message: string) => void;
}

export const startAtf = async (effect: Effect, deps: AtfStartDeps): Promise<Outcome> => {
  if (effect.kind !== 'start_atf') return 'dropped';
  const board = await deps.boardOf(effect.boardId);
  // The setting may have changed since the deploy: pull boards run what they fetch.
  const integration = board?.atf;
  if (integration?.mode !== 'push') return 'dropped';
  const result = await deps.testRuns.atfBatch(effect.boardId, effect.environment, effect.sha);
  if (!result.ok) {
    deps.log(
      'atf',
      `board ${String(effect.boardId)} ${effect.environment}: ${result.error.message}`,
    );
    return 'dropped';
  }
  // A newer deploy replaced this one: its own success starts the run.
  if (result.value.status === 'superseded') return 'dropped';
  if (result.value.status === 'pending')
    throw new Error(`${effect.environment} at ${effect.sha} has no succeeded deploy yet`);
  const batch = result.value;
  let started;
  try {
    started = await deps.starter.start({
      boardId: effect.boardId,
      integration,
      environment: batch.environment,
      sha: batch.sha,
      specs: batch.specs.map((s) => s.spec),
      greps: batch.greps.map((g) => g.grep),
    });
  } catch (e) {
    // A refusal by the server's allow-list won't change on a retry: log it plainly and drop the start.
    if (!(e instanceof AtfRefusedError)) throw e;
    deps.log('atf', `board ${String(effect.boardId)} ${effect.environment}: push refused: ${e.message}`);
    return 'dropped';
  }
  deps.log(
    'atf',
    `board ${String(effect.boardId)} ${effect.environment} at ${batch.sha}: started ${started.buildId}`,
  );
  return 'done';
};

/**
 * Outbox executors for push-mode ATF (nothing queues `start_atf` since ATF moved to the int pipeline). The board's ATF project is started with the
 * specs the newly held globs' test plans listed. The batch is the same stored one the pull endpoint serves, and CodeBuild's
 * idempotency token (per board, environment and commit) makes a repeated start return the build already running. Nothing
 * here blocks: a superseded deploy, a board switched back to pull, or a refused batch ends the effect, and a start that
 * throws is retried by the outbox.
 */
export const atfExecutors = (deps: AtfStartDeps): Partial<Record<EffectKind, SettledExecutor>> => ({
  start_atf: (effect) => startAtf(effect, deps),
});
