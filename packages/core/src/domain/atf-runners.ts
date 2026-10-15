import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';

/**
 * ATF runners (spec, ATF runners): a board registers each system that runs its acceptance tests, with its own identity.
 * A runner pulls the spec list and posts results with its own credential, and results record which runner produced them.
 * Everything here is pure; the credential checks themselves (JWT signatures, JWKS, Cognito) are the server's.
 */

/** How a runner proves who it is. The legacy board token is not a method: it maps to no registered runner. */
export const ATF_RUNNER_METHODS = ['oidc', 'aws_iam', 'client_credentials'] as const;
export type AtfRunnerMethod = (typeof ATF_RUNNER_METHODS)[number];

/** What a resolved credential was: a registered runner's method, or the board's integration token (deprecated for ATF). */
export type AtfCredentialMethod = AtfRunnerMethod | 'board_token';

/** The name shown for runs that no registered runner produced (the board token, EventBridge). */
export const LEGACY_RUNNER_NAME = 'Legacy runner';

/** Claim name -> the values a token may carry for it. A value is exact, or `prefix*`. */
export type ClaimRules = Readonly<Record<string, readonly string[]>>;

/**
 * Method-specific settings, kept as one document so a later identity method needs no migration. Only the fields of the
 * runner's method are used: `issuer` and `claims` (oidc), `roleArns` and `accounts` (aws_iam), `clientId` (client_credentials).
 */
export interface AtfRunnerConfig {
  readonly issuer?: string;
  readonly claims?: ClaimRules;
  readonly roleArns?: readonly string[];
  readonly accounts?: readonly string[];
  readonly clientId?: string;
}

export interface AtfRunner {
  readonly id: number;
  readonly boardId: number;
  readonly name: string;
  readonly method: AtfRunnerMethod;
  readonly config: AtfRunnerConfig;
  /** The observed environments the runner may ask specs for and report on. */
  readonly environments: readonly string[];
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  /** Set when an admin revoked it: the name is free again and the credential never works again. */
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastResultAt: string | null;
}

export type NewAtfRunner = Omit<AtfRunner, 'id' | 'revokedAt' | 'lastSeenAt' | 'lastResultAt'>;

/** A change to a runner: the fields given are replaced. The method never changes (revoke it and register another). */
export interface AtfRunnerPatch {
  readonly name?: string;
  readonly config?: AtfRunnerConfig;
  readonly environments?: readonly string[];
  readonly enabled?: boolean;
  readonly revokedAt?: string;
  readonly lastSeenAt?: string;
  readonly lastResultAt?: string;
}

/** A registered runner is usable while it is enabled and not revoked. */
export const runnerUsable = (runner: Pick<AtfRunner, 'enabled' | 'revokedAt'>): boolean =>
  runner.enabled && runner.revokedAt === null;

export const MAX_RUNNER_NAME = 100;
const MAX_RULE_VALUES = 20;
const MAX_VALUE_LENGTH = 300;

/** GitHub Actions' issuer host: any workflow anywhere can mint a token for any audience, so its tokens must be pinned. */
const GITHUB_ISSUER_HOST = 'token.actions.githubusercontent.com';

/** Claims that identify the repository or workflow a CI token came from. */
const PIN_CLAIMS = ['repository', 'sub'] as const;

/** Whether one claim value matches an allowed value: exact, or `prefix*` (the star only at the end). */
export const claimValueMatches = (allowed: string, value: string): boolean =>
  allowed.endsWith('*') ? value.startsWith(allowed.slice(0, -1)) : value === allowed;

/**
 * Whether a token's claims satisfy every rule. A claim holds a string or a list of strings (an audience, say); it matches
 * when any of its values matches any allowed value. A missing claim never matches. No rules match nothing: a runner
 * without rules must not accept every token an issuer signs.
 */
export const claimsMatch = (
  rules: ClaimRules,
  claims: Readonly<Record<string, unknown>>,
): boolean => {
  const names = Object.keys(rules);
  if (names.length === 0) return false;
  return names.every((name) => {
    const allowed = rules[name] ?? [];
    const given = claims[name];
    const values =
      typeof given === 'string'
        ? [given]
        : Array.isArray(given)
          ? given.filter((v): v is string => typeof v === 'string')
          : [];
    return values.some((v) => allowed.some((a) => claimValueMatches(a, v)));
  });
};

const issuerHost = (issuer: string): string | null => {
  try {
    const url = new URL(issuer);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const validateOidc = (config: AtfRunnerConfig): Result<null> => {
  if (config.issuer === undefined)
    return invalidInput('An OIDC runner needs the issuer URL of its tokens');
  const host = issuerHost(config.issuer);
  if (host === null) return invalidInput('The issuer must be an https URL');
  const claims = config.claims ?? {};
  const names = Object.keys(claims);
  if (names.length === 0)
    return invalidInput(
      'An OIDC runner needs at least one claim rule, or any token from the issuer would be accepted',
    );
  for (const name of names) {
    const values = claims[name] ?? [];
    if (values.length === 0 || values.length > MAX_RULE_VALUES)
      return invalidInput(`Claim ${name} needs 1 to ${String(MAX_RULE_VALUES)} values`);
    for (const value of values) {
      if (value.trim() === '' || value.length > MAX_VALUE_LENGTH)
        return invalidInput(`Claim ${name} has an empty or oversized value`);
      if (value.replaceAll('*', '') === '')
        return invalidInput(`Claim ${name} can't match every value`);
      if (value.slice(0, -1).includes('*'))
        return invalidInput(`Claim ${name}: a * can only end a value`);
    }
  }
  if (host === GITHUB_ISSUER_HOST && !PIN_CLAIMS.some((c) => names.includes(c))) {
    return invalidInput(
      'A GitHub Actions runner must pin the repository (or sub) claim: any workflow on GitHub can get a token for slop',
    );
  }
  return ok(null);
};

const ROLE_ARN = /^arn:aws[\w-]*:(iam|sts)::\d{12}:[\w+=,.@/*-]+$/;
const ACCOUNT_ID = /^\d{12}$/;

const validateAwsIam = (config: AtfRunnerConfig): Result<null> => {
  const arns = config.roleArns ?? [];
  if (arns.length === 0) return invalidInput('An AWS IAM runner needs at least one role ARN');
  if (arns.length > MAX_RULE_VALUES || arns.some((a) => !ROLE_ARN.test(a)))
    return invalidInput('Role ARNs look like arn:aws:iam::123456789012:role/name');
  if ((config.accounts ?? []).some((a) => !ACCOUNT_ID.test(a)))
    return invalidInput('Accounts are 12-digit AWS account IDs');
  return ok(null);
};

/**
 * Checks a runner to register (or an update's resulting runner) against the board: a name, one known method with the
 * settings it needs, and a non-empty list of environments the board observes. Name uniqueness is the service's.
 */
export const validateRunner = (
  input: {
    readonly name: string;
    readonly method: AtfRunnerMethod;
    readonly config: AtfRunnerConfig;
    readonly environments: readonly string[];
  },
  observedEnvironments: readonly string[],
): Result<{ readonly name: string; readonly environments: readonly string[] }> => {
  const name = input.name.trim();
  if (name === '' || name.length > MAX_RUNNER_NAME)
    return invalidInput(`A runner's name is 1 to ${String(MAX_RUNNER_NAME)} characters`);
  const environments = [...new Set(input.environments)];
  if (environments.length === 0) return invalidInput('A runner serves at least one environment');
  const unknown = environments.filter((e) => !observedEnvironments.includes(e));
  if (unknown.length > 0)
    return invalidInput(`${unknown.join(', ')} isn't an environment this board observes`);
  const checked =
    input.method === 'oidc'
      ? validateOidc(input.config)
      : input.method === 'aws_iam'
        ? validateAwsIam(input.config)
        : ok(null);
  if (!checked.ok) return checked;
  return ok({ name, environments });
};

/** Names are unique per board among runners that aren't revoked, compared without regard to case. */
export const sameRunnerName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const ARN_ACCOUNT = /^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):/;

/** The 12-digit account an IAM or STS ARN belongs to, or null when it isn't one. */
export const arnAccount = (arn: string): string | null => ARN_ACCOUNT.exec(arn)?.[1] ?? null;

/**
 * The IAM role ARN an identity ARN stands for. An assumed-role ARN (`arn:aws:sts::123456789012:assumed-role/Name/session`)
 * becomes `arn:aws:iam::123456789012:role/Name`; STS drops a role's path, so a path is kept only when the ARN names the role
 * itself. Anything else (a user, a federated session) returns null: only roles are runner identities.
 */
export const roleArnOf = (arn: string): string | null => {
  const assumed = /^(arn:aws[\w-]*):sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/[^/]+$/.exec(arn);
  if (assumed !== null) return `${assumed[1] ?? ''}:iam::${assumed[2] ?? ''}:role/${assumed[3] ?? ''}`;
  return /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn) ? arn : null;
};

/** The role's name without its path, so an ARN with a path still matches the path-less one STS reports. */
const roleTail = (arn: string): string => arn.slice(arn.lastIndexOf('/') + 1);

/**
 * Whether a token's identity ARN is one of a runner's allowed role ARNs. Both sides are reduced to a role ARN; an allowed
 * ARN is exact, or `prefix*`. A role registered with a path also matches the path-less ARN of its assumed sessions
 * (same account and name).
 */
export const roleArnMatches = (allowed: readonly string[], identityArn: string): boolean => {
  const role = roleArnOf(identityArn);
  if (role === null) return false;
  return allowed.some((a) => {
    if (claimValueMatches(a, role)) return true;
    if (a.endsWith('*')) return false;
    const allowedRole = roleArnOf(a);
    if (allowedRole === null || arnAccount(allowedRole) !== arnAccount(role)) return false;
    // An assumed-role ARN carries no path, so compare account and name when the registered ARN has one.
    return roleTail(allowedRole) === roleTail(role) && !role.slice(role.indexOf(':role/') + 6).includes('/');
  });
};
