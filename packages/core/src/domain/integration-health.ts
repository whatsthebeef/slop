export type IntegrationId = 'bedrock' | 'github_app' | 'routines' | 'tunnel';

export type IntegrationState = 'ok' | 'degraded' | 'down';

/** Something a person can do from the board itself. */
export type IntegrationAction = 'aws_sign_in';

export interface IntegrationHealth {
  readonly id: IntegrationId;
  readonly state: IntegrationState;
  /** Plain language, never secrets or raw provider messages. */
  readonly reason: string;
  readonly fix: string;
  /** When the current state (and reason) began, ISO. */
  readonly since: string;
  readonly action?: IntegrationAction;
}

const SEVERITY: Record<IntegrationState, number> = { ok: 0, degraded: 1, down: 2 };

/** The worst state in the list (down before degraded before ok); ok when empty. */
export const worst = (list: readonly { readonly state: IntegrationState }[]): IntegrationState =>
  list.reduce<IntegrationState>((w, h) => (SEVERITY[h.state] > SEVERITY[w] ? h.state : w), 'ok');

export const anyDown = (list: readonly { readonly state: IntegrationState }[]): boolean =>
  list.some((h) => h.state === 'down');

export interface AuthFailure {
  readonly reason: string;
  readonly fix: string;
}

const GITHUB_AUTH_MESSAGE =
  /bad credentials|integration not found|'exp' claim|jwt.*(expired|invalid)|expiration time/i;

/**
 * A rejected credential, from an HTTP status (and a GitHub message, where 403 also means rate limits
 * or missing permissions on one repo). 404, 429 and 5xx say nothing about the credential: null.
 */
export const classifyHttpAuthFailure = (
  status: number | null,
  source: 'github' | 'routine',
  message = '',
): AuthFailure | null => {
  if (status === null) return null;
  if (source === 'routine') {
    return status === 401 || status === 403
      ? { reason: 'Routine credential rejected', fix: 'Replace the token in .routines.json' }
      : null;
  }
  const rejected = status === 401 || (status === 403 && GITHUB_AUTH_MESSAGE.test(message));
  return rejected
    ? {
        reason: "GitHub App can't authenticate",
        fix: 'Re-run /setup/github-app or check the private key',
      }
    : null;
};

/** Whether the board offers "Sign in to AWS": the cause is an expired SSO sign-in and the server can run the device flow. */
export const signInOffered = (input: {
  readonly state: IntegrationState;
  readonly code: 'sso_expired' | undefined;
  readonly ssoAvailable: boolean;
}): boolean => input.state === 'down' && input.code === 'sso_expired' && input.ssoAvailable;
