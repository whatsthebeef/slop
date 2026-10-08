import type { DomainEvent } from './events.js';
import type { Board, Environment, EnvironmentRole, Glob } from './types.js';

/**
 * Release and integration environments. Slop doesn't deploy to them; the board's pipelines do and report each deploy
 * (the commit the environment now runs). A glob is in such an environment when that commit contains its merge commit,
 * worked out on the code host when the deploy is reported and stored per glob, so the board never asks the code host
 * while rendering. Every rule here is pure.
 */

/** Merged globs are rechecked on each deploy for this long; older ones only while an environment holds them. */
export const RECENT_MERGE_DAYS = 30;

/** One reported deploy of a commit to a release or integration environment. */
export interface EnvironmentDeploy {
  readonly id: number;
  readonly boardId: number;
  readonly environment: string;
  readonly sha: string;
  /** The branch or tag the pipeline deployed, when it said. */
  readonly ref: string | null;
  readonly succeeded: boolean;
  /** A link to the pipeline's run. */
  readonly url: string | null;
  /** When the deploy happened (the event's time, else when slop received it). */
  readonly at: string;
  /** The reporter's event ID: a redelivered event is recorded once per board. */
  readonly eventId: string;
}

export type NewEnvironmentDeploy = Omit<EnvironmentDeploy, 'id'>;

/** Whether an environment held a glob when it was last checked. */
export interface GlobPresence {
  readonly boardId: number;
  readonly globId: string;
  readonly environment: string;
  /** The glob's merge commit that was looked for. */
  readonly mergeSha: string;
  readonly contained: boolean;
  /** The environment's commit it was checked against. */
  readonly checkedSha: string;
  readonly checkedAt: string;
  /** When the environment first held it (since it last didn't); null while it doesn't. */
  readonly since: string | null;
}

/** A glob's merge commit, and whether an environment's commit contains it. */
export interface Containment {
  readonly globId: string;
  readonly mergeSha: string;
  readonly contained: boolean;
}

/** The environment, if slop observes its deploys (it has a role); null otherwise. */
export const observedEnvironment = (board: Board, name: string): Environment | null =>
  board.environments.find((e) => e.name === name && e.role !== undefined) ?? null;

/** Each glob's latest merge commit, from `Merged` events (oldest first): a continued super merges more than once. */
export const latestMerges = (events: readonly DomainEvent[]): Map<string, string> => {
  const merges = new Map<string, string>();
  for (const e of events) {
    const sha = e.data.sha;
    if (e.type === 'Merged' && typeof sha === 'string' && sha !== '') merges.set(e.globId, sha);
  }
  return merges;
};

/** What a containment check changes: presence rows to write, events for the glob logs, and the globs that moved. */
export interface ContainmentChange {
  readonly writes: readonly GlobPresence[];
  readonly events: readonly DomainEvent[];
  /** Globs that entered or left the environment. */
  readonly moved: readonly string[];
}

/**
 * The result of checking an environment's commit `sha` against globs' merge commits. A glob that newly appears logs
 * `Deployed` (observed, not a branch deploy); one the environment held and no longer does logs `DeployRolledBack`.
 * Every checked glob's row is rewritten with the commit it was checked against, so the check is idempotent.
 */
export const containmentChange = (
  previous: readonly GlobPresence[],
  results: readonly Containment[],
  target: { readonly boardId: number; readonly environment: string; readonly sha: string },
  now: string,
): ContainmentChange => {
  const before = new Map(previous.filter((p) => p.environment === target.environment).map((p) => [p.globId, p]));
  const writes: GlobPresence[] = [];
  const events: DomainEvent[] = [];
  const moved: string[] = [];
  for (const r of results) {
    const was = before.get(r.globId);
    const held = was?.contained === true;
    const event = (type: DomainEvent['type']): DomainEvent => ({
      type,
      globId: r.globId,
      actor: null,
      at: now,
      data: { environment: target.environment, sha: target.sha, mergeSha: r.mergeSha, observed: true },
    });
    if (r.contained && !held) {
      events.push(event('Deployed'));
      moved.push(r.globId);
    } else if (!r.contained && held) {
      events.push(event('DeployRolledBack'));
      moved.push(r.globId);
    }
    writes.push({
      boardId: target.boardId,
      globId: r.globId,
      environment: target.environment,
      mergeSha: r.mergeSha,
      contained: r.contained,
      checkedSha: target.sha,
      checkedAt: now,
      since: r.contained ? (held ? (was.since ?? now) : now) : null,
    });
  }
  return { writes, events, moved };
};

/** What a glob's card shows for one release or integration environment it is in. */
export interface EnvironmentIndicator {
  readonly environment: string;
  readonly role: EnvironmentRole;
  readonly production: boolean;
  /** The environment's commit that contains the glob. */
  readonly sha: string;
  readonly since: string | null;
  /** Production holds the glob before it was signed off: allowed, but flagged. */
  readonly warning?: 'before_sign_off';
}

/** The observed environments a glob is in, in the board's environment order. */
export const environmentIndicators = (
  board: Board,
  glob: Pick<Glob, 'id' | 'status'>,
  presences: readonly GlobPresence[],
): EnvironmentIndicator[] =>
  board.environments.flatMap((env): EnvironmentIndicator[] => {
    const presence = presences.find((p) => p.globId === glob.id && p.environment === env.name && p.contained);
    if (env.role === undefined || presence === undefined) return [];
    const production = env.production === true;
    return [
      {
        environment: env.name,
        role: env.role,
        production,
        sha: presence.checkedSha,
        since: presence.since,
        ...(production && glob.status !== 'signed_off' && { warning: 'before_sign_off' as const }),
      },
    ];
  });
