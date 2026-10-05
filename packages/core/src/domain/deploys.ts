import type { DomainEvent, Effect } from './events.js';
import type { Board } from './types.js';

/**
 * Branch deploys. Deploy state is a flag beside a glob's status, not a status: it lives in deploy
 * records, one per request, and every rule here is a pure function over an environment's records.
 *
 * Per environment at most one deploy runs and at most one waits; a new request replaces the waiting
 * one. When the running one finishes, the waiting one starts. The environment's live glob is the
 * one whose deploy last succeeded there.
 */
export const DEPLOY_STATES = ['waiting', 'running', 'succeeded', 'failed', 'replaced'] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

export const DEPLOY_TRIGGERS = ['push', 'deploy_now'] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGERS)[number];

export interface Deploy {
  readonly id: string;
  readonly boardId: number;
  readonly environment: string;
  readonly globId: string;
  /** Deploys are pinned to an exact commit, never a moving branch. */
  readonly sha: string;
  readonly state: DeployState;
  readonly trigger: DeployTrigger;
  /** Who pressed Deploy now; null for pushes. */
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  /** When it became the environment's running deploy (at once, or promoted from waiting); null while waiting. */
  readonly runningSince: string | null;
  /** When the provider accepted it; null while waiting, or running but not yet accepted. */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The provider's handle on the deploy (e.g. a CodeBuild build ID), once started. */
  readonly providerRef: string | null;
  /** A link to the provider's run, for the glob view. */
  readonly url: string | null;
  readonly error: string | null;
}

export const isActive = (deploy: Deploy): boolean => deploy.state === 'waiting' || deploy.state === 'running';

/** The changes one deploy rule makes: records to write, events for the glob log, effects for the outbox. */
export interface DeployChange {
  readonly writes: readonly Deploy[];
  readonly events: readonly DomainEvent[];
  readonly effects: readonly Effect[];
}

const startEffect = (deploy: Deploy): Effect => ({
  kind: 'start_deploy',
  deployId: deploy.id,
  globId: deploy.globId,
});

/** Why a glob can't deploy to its environment now, or null when it can. */
export const deployBlocked = (board: Board, environment: string | null): string | null => {
  if (environment === null) return 'The glob has no environment';
  const env = board.environments.find((e) => e.name === environment);
  if (env === undefined) return `Board ${board.id} has no environment ${environment}`;
  if (!env.allowBranchDeploy) return `${environment} doesn't take branch deploys`;
  if (board.deploy === null) return `Board ${board.id} has no deploy integration set up`;
  return null;
};

/**
 * A new deploy request for an environment, given its active deploys. It starts at once if nothing
 * runs there; otherwise it waits, replacing any deploy already waiting.
 */
export const request = (active: readonly Deploy[], deploy: Deploy, now: string): DeployChange => {
  const running = active.some((d) => d.state === 'running');
  const replaced = active
    .filter((d) => d.state === 'waiting')
    .map((d): Deploy => ({ ...d, state: 'replaced', finishedAt: now }));
  const next: Deploy = running ? { ...deploy, state: 'waiting' } : { ...deploy, state: 'running', runningSince: now };
  return {
    writes: [...replaced, next],
    events: [
      ...replaced.map((d) => event('DeployReplaced', d, now, { by: deploy.id })),
      event('DeployRequested', next, now, { trigger: next.trigger, waiting: running }),
    ],
    effects: running ? [] : [startEffect(next)],
  };
};

/** The provider accepted the deploy. */
export const started = (deploy: Deploy, ref: { providerRef: string; url: string | null }, now: string): DeployChange => {
  if (deploy.state !== 'running' || deploy.startedAt !== null) return { writes: [], events: [], effects: [] };
  const next: Deploy = { ...deploy, startedAt: now, providerRef: ref.providerRef, url: ref.url };
  return { writes: [next], events: [event('DeployStarted', next, now, { providerRef: ref.providerRef })], effects: [] };
};

/**
 * A running deploy finished (or couldn't start). The environment's waiting deploy, if any, starts
 * next. Results for a deploy that already finished are ignored, so repeated reports are harmless.
 */
export const finished = (
  active: readonly Deploy[],
  deploy: Deploy,
  outcome: { succeeded: boolean; error: string | null },
  now: string,
): DeployChange => {
  if (deploy.state !== 'running') return { writes: [], events: [], effects: [] };
  const done: Deploy = {
    ...deploy,
    state: outcome.succeeded ? 'succeeded' : 'failed',
    finishedAt: now,
    error: outcome.succeeded ? null : (outcome.error ?? 'The deploy failed'),
  };
  const waiting = active.find((d) => d.state === 'waiting' && d.id !== deploy.id);
  const next: Deploy | null = waiting === undefined ? null : { ...waiting, state: 'running', runningSince: now };
  return {
    writes: next === null ? [done] : [done, next],
    events: [
      outcome.succeeded
        ? event('Deployed', done, now, {})
        : event('DeployFailed', done, now, { error: done.error }),
    ],
    effects: next === null ? [] : [startEffect(next)],
  };
};

/** How long a running deploy may wait for its provider to accept it, and then for its result. */
export const START_TIMEOUT_MINUTES = 10;
export const RESULT_TIMEOUT_MINUTES = 60;

/**
 * Why a running deploy should be given up on, or null: its provider never accepted it, or no result
 * arrived in time (a lost webhook, a stopped tunnel, a job that failed before reporting). Giving up
 * fails it, which starts the environment's waiting deploy, so a queue never sticks.
 */
export const staleReason = (deploy: Deploy, now: string): string | null => {
  if (deploy.state !== 'running') return null;
  const minutesSince = (iso: string) => (Date.parse(now) - Date.parse(iso)) / 60_000;
  if (deploy.startedAt === null) {
    // From when it began running, not when it was requested: a deploy may queue for a long time.
    return minutesSince(deploy.runningSince ?? deploy.requestedAt) >= START_TIMEOUT_MINUTES
      ? `The deploy job didn't start within ${String(START_TIMEOUT_MINUTES)} minutes`
      : null;
  }
  return minutesSince(deploy.startedAt) >= RESULT_TIMEOUT_MINUTES
    ? `No result from the deploy job after ${String(RESULT_TIMEOUT_MINUTES)} minutes`
    : null;
};

/**
 * Why a deploy that is about to start must not (the environment stopped taking branch deploys, the
 * integration was removed, or the glob moved to another environment while it waited), or null.
 */
export const startBlocked = (board: Board, deploy: Deploy, globEnvironment: string | null): string | null => {
  const blocked = deployBlocked(board, deploy.environment);
  if (blocked !== null) return blocked;
  if (globEnvironment !== deploy.environment) {
    return `${deploy.globId} moved to ${globEnvironment ?? 'no environment'} while this deploy waited`;
  }
  return null;
};

/** What a glob's card shows about its deploys. */
export type DeployIndicator =
  | { readonly state: 'deploying'; readonly environment: string; readonly waiting: boolean }
  | { readonly state: 'live'; readonly environment: string; readonly sha: string }
  | { readonly state: 'failed'; readonly environment: string; readonly error: string | null }
  /** It was live, and another glob's deploy has succeeded in the environment since. */
  | { readonly state: 'replaced'; readonly environment: string; readonly by: string };

/**
 * A glob's deploy indicator from its own latest deploy and the environment's live deploy: an active
 * deploy shows as deploying; a failed latest deploy as failed (the deploy failure flag, cleared by the
 * next success); a success as live, or replaced once another glob is live there.
 */
export const indicatorFor = (latest: Deploy | null, live: Deploy | null): DeployIndicator | null => {
  if (latest === null) return null;
  const environment = latest.environment;
  if (isActive(latest)) return { state: 'deploying', environment, waiting: latest.state === 'waiting' };
  if (latest.state === 'failed') return { state: 'failed', environment, error: latest.error };
  if (latest.state !== 'succeeded') return null;
  if (live !== null && live.globId !== latest.globId) return { state: 'replaced', environment, by: live.globId };
  return { state: 'live', environment, sha: latest.sha };
};

const event = (
  type: DomainEvent['type'],
  deploy: Deploy,
  at: string,
  data: DomainEvent['data'],
): DomainEvent => ({
  type,
  globId: deploy.globId,
  actor: deploy.trigger === 'deploy_now' && type === 'DeployRequested' ? deploy.requestedBy : null,
  at,
  data: { deployId: deploy.id, environment: deploy.environment, sha: deploy.sha, ...data },
});
