import type { RaisedNotification } from '../domain/notifications.js';

/** The integrations slop watches: each can lapse on its own, and each has a fix a person must carry out. */
export type IntegrationId = 'bedrock' | 'github' | 'routines' | 'tunnel' | 'local';

export type IntegrationState = 'ok' | 'degraded' | 'down';

/** What one integration reports: ok, or what is wrong and what to do about it (never secrets or raw provider messages). */
export type IntegrationReport =
  | { readonly state: 'ok' }
  | { readonly state: 'degraded' | 'down'; readonly reason: string; readonly fix: string };

/** The port integrations report their health through; the server's registry implements it. */
export interface HealthSink {
  report(id: IntegrationId, report: IntegrationReport): void;
}

export interface IntegrationStatus {
  readonly id: IntegrationId;
  readonly name: string;
  readonly state: IntegrationState;
  readonly reason: string | null;
  readonly fix: string | null;
  /** When it last changed to this state. */
  readonly since: string;
}

export const INTEGRATION_NAMES: Readonly<Record<IntegrationId, string>> = {
  bedrock: 'AI features',
  github: 'GitHub App',
  routines: 'Routines',
  tunnel: 'Webhook tunnel',
  local: 'Local slop',
};

/** Statuses that need a person, down before degraded, then oldest first. */
export const needingAttention = (statuses: readonly IntegrationStatus[]): IntegrationStatus[] =>
  statuses
    .filter((s) => s.state !== 'ok')
    .sort((a, b) => Number(b.state === 'down') - Number(a.state === 'down') || a.since.localeCompare(b.since));

/** The reasons Bedrock reports when an AWS sign-in (rather than a model or IAM change) fixes it. */
const SIGN_IN_REASONS = ['AWS sign-in expired', 'AWS credentials are not valid'];

/** Whether the in-app AWS sign-in applies: Bedrock is down on a lapsed sign-in, and the server runs with an SSO profile. */
export const awsSignInApplies = (status: IntegrationStatus, serverUsesSso: boolean): boolean =>
  serverUsesSso && status.id === 'bedrock' && status.state === 'down' && SIGN_IN_REASONS.includes(status.reason ?? '');

/** The shared wording of a banner line, e.g. "AI features: AWS sign-in expired (since 14:02)". */
export const describeStatus = (status: IntegrationStatus): string => `${status.name}: ${status.reason ?? status.state}`;

const RATE_LIMITED = /rate limit|abuse|secondary/i;

/**
 * What a GitHub API failure says about the App's access: 401 means the App's key or installation
 * token no longer works, a 403 that isn't a rate limit means it lacks a permission. Anything else
 * (404, 422, throttling, server errors) says nothing about credentials.
 */
export const classifyGitHubFailure = (status: number | null, message = ''): IntegrationReport | null => {
  if (status === 401) {
    return {
      state: 'down',
      reason: "The GitHub App can't authenticate",
      fix: 'Check the App is installed and its private key is current (re-run /setup/github-app if the key was rotated or the App deleted)',
    };
  }
  if (status === 403 && !RATE_LIMITED.test(message)) {
    return {
      state: 'degraded',
      reason: 'The GitHub App is missing a permission',
      fix: "Accept the App's updated permissions on the installation page in GitHub",
    };
  }
  return null;
};

/** What a routine fire failure says about its credentials: a rejected token or URL needs a new one; throttling and server errors don't. */
export const classifyRoutineFailure = (status: number | null): IntegrationReport | null =>
  status === 401 || status === 403 || status === 404
    ? {
        state: 'down',
        reason: "A routine's fire token was rejected",
        fix: "Create a new API token for the routine's trigger in Claude and put it in the routines file (or Secrets Manager)",
      }
    : null;

export const integrationSource = (id: IntegrationId): string => `integration:${id}`;

/** Down is critical where slop can't do its job without it (AI features, GitHub, routines), warning for the rest; degraded is always a warning. */
const DOWN_SEVERITY: Readonly<Record<IntegrationId, 'critical' | 'warning'>> = {
  bedrock: 'critical',
  github: 'critical',
  routines: 'critical',
  tunnel: 'warning',
  local: 'warning',
};

/**
 * The board-wide notification for an integration that needs a person, or null when it is ok. Global (every board).
 * Bedrock's says the KB pipeline is paused and offers the in-app Sign in to AWS where it applies.
 */
export const integrationNotification = (status: IntegrationStatus, serverUsesSso: boolean): RaisedNotification | null => {
  if (status.state === 'ok') return null;
  const reason = status.reason ?? status.state;
  const paused = status.id === 'bedrock';
  return {
    boardId: null,
    source: integrationSource(status.id),
    severity: status.state === 'down' ? DOWN_SEVERITY[status.id] : 'warning',
    title: paused ? `AI features paused: ${reason}` : `${status.name}: ${reason}`,
    detail: `${paused ? 'The knowledge-base pipeline is paused. ' : ''}${status.fix ?? ''}`.trim(),
    link: null,
    action: awsSignInApplies(status, serverUsesSso) ? { label: 'Sign in to AWS', href: '', kind: 'aws-sign-in' } : null,
    clears: { kind: 'condition' },
  };
};
