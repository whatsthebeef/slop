import { JwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { arnAccount, claimsMatch, roleArnMatches, roleArnOf, runnerUsable } from '@slop/core';
import type { AtfRunner, Store } from '@slop/core';
import { z } from 'zod';
import type { ResolvedRunner, RunnerVerifier } from './atf-auth.js';

/**
 * OIDC workload identity for ATF runners (spec, ATF runners): a runner sends the JWT its CI system or AWS issues, and
 * slop checks it against the issuers the server trusts. One verifier serves two kinds of issuer:
 *
 * - `ATF_OIDC_ALLOWED_ISSUERS`: any OIDC issuer (GitHub Actions, GitLab, Buildkite...). Only `oidc` runners match, by the
 *   claim rules the board set.
 * - `ATF_AWS_ALLOWED_ISSUERS`: AWS outbound identity federation (STS `GetWebIdentityToken`). Only `aws_iam` runners match:
 *   the token's `sub` must be one of the runner's role ARNs and its account must be in `ATF_AWS_ALLOWED_ACCOUNTS`.
 *
 * The `iss` of the unverified token only picks which trusted issuer to verify against; an issuer that isn't listed is never
 * contacted. Discovery and JWKS fetches have a timeout, a size cap, no redirects and are cached. A token that matches
 * no runner, or more than one, resolves to nothing. Tokens and claims are never logged.
 */

const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 15_000;
const CLOCK_GRACE_SECONDS = 30;

/** Fetches one JSON document (a JWKS) as bytes. Matches the fetcher `aws-jwt-verify` takes. */
export interface DocumentFetcher {
  fetch(uri: string): Promise<ArrayBuffer>;
}

export interface BoundedFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Tests serve from a local http server; production only fetches https. */
  readonly allowHttp?: boolean;
}

/**
 * A GET that refuses anything but a 200 (a redirect is a failure, never followed), gives up after a timeout and stops reading
 * past a size cap. https only.
 */
export const boundedFetcher = (options: BoundedFetchOptions = {}): DocumentFetcher => {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  return {
    async fetch(uri) {
      const url = new URL(uri);
      if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) {
        throw new Error('Only https documents are fetched');
      }
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        throw new Error('The document could not be fetched');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw new Error('The document is too large');
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes.buffer;
    },
  };
};

const discoverySchema = z.object({ issuer: z.string(), jwks_uri: z.string() });

/** The first segments of a compact JWT as objects, or null. Nothing here is trusted: it only picks the verifier. */
const unverifiedParts = (
  token: string,
): { header: Record<string, unknown>; payload: Record<string, unknown> } | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const decode = (part: string | undefined): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;
    } catch {
      return null;
    }
  };
  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  return header === null || payload === null ? null : { header, payload };
};

export interface OidcVerifierDeps {
  readonly store: Pick<Store, 'transaction'>;
  /** Issuers for `oidc` runners (ATF_OIDC_ALLOWED_ISSUERS). */
  readonly oidcIssuers: readonly string[];
  /** AWS outbound-federation issuers for `aws_iam` runners (ATF_AWS_ALLOWED_ISSUERS). */
  readonly awsIssuers: readonly string[];
  /** Accounts whose roles may be runners (ATF_AWS_ALLOWED_ACCOUNTS). */
  readonly awsAccounts: readonly string[];
  /** The audience a token must carry: slop's. */
  readonly audience: string;
  readonly fetcher?: DocumentFetcher;
  readonly allowHttp?: boolean;
  readonly now?: () => number;
}

type IssuerVerifier = (token: string) => Promise<Record<string, unknown>>;

const resolved = (runner: AtfRunner): ResolvedRunner => ({
  runnerId: runner.id,
  boardId: runner.boardId,
  name: runner.name,
  method: runner.method,
  environments: runner.environments,
});

/** The account an AWS federation token claims, from the claim at the top level or under AWS's namespaced claim. */
const claimedAccount = (payload: Record<string, unknown>): string | null => {
  const top = payload['aws_account'];
  if (typeof top === 'string') return top;
  const namespaced = payload['https://sts.amazonaws.com/'];
  if (typeof namespaced === 'object' && namespaced !== null && 'aws_account' in namespaced) {
    const value: unknown = namespaced.aws_account;
    return typeof value === 'string' ? value : null;
  }
  return null;
};

/** The verifier to plug into `createRunnerAuthenticator`. It answers null for a credential that is not an OIDC token. */
export const createOidcRunnerVerifier = (deps: OidcVerifierDeps): RunnerVerifier | null => {
  if (deps.oidcIssuers.length === 0 && deps.awsIssuers.length === 0) return null;
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetcher ?? boundedFetcher({ allowHttp: deps.allowHttp === true });
  const jwksCache = new SimpleJwksCache({ fetcher });
  const verifiers = new Map<string, { at: number; verifier: Promise<IssuerVerifier> }>();
  const failures = new Map<string, number>();

  const discover = async (issuer: string): Promise<string> => {
    const url = `${issuer}/.well-known/openid-configuration`;
    const document = discoverySchema.parse(
      JSON.parse(Buffer.from(await fetcher.fetch(url)).toString('utf8')),
    );
    const jwks = new URL(document.jwks_uri);
    // The document must name the issuer it was fetched for, and keep the keys on the issuer's own origin.
    if (document.issuer !== issuer || jwks.origin !== new URL(issuer).origin) {
      throw new Error('The discovery document does not match the issuer');
    }
    return jwks.toString();
  };

  const build = async (issuer: string): Promise<IssuerVerifier> => {
    const jwksUri = await discover(issuer);
    const verifier = JwtVerifier.create(
      {
        issuer,
        jwksUri,
        audience: deps.audience,
        graceSeconds: CLOCK_GRACE_SECONDS,
        customJwtCheck: ({ payload }) => {
          // A token that never expires is not a workload credential.
          if (typeof payload.exp !== 'number') throw new Error('The token has no expiry');
        },
      },
      { jwksCache },
    );
    return async (token) => {
      const payload = await verifier.verify(token);
      return Object.fromEntries(Object.entries(payload));
    };
  };

  const verifierFor = (issuer: string): Promise<IssuerVerifier> => {
    const at = now();
    const failed = failures.get(issuer);
    if (failed !== undefined && at - failed < FAILURE_BACKOFF_MS) {
      return Promise.reject(new Error('The issuer is unavailable'));
    }
    const cached = verifiers.get(issuer);
    if (cached !== undefined && at - cached.at < DISCOVERY_TTL_MS) return cached.verifier;
    const created = build(issuer);
    verifiers.set(issuer, { at, verifier: created });
    created.catch(() => {
      failures.set(issuer, now());
      verifiers.delete(issuer);
    });
    return created;
  };

  const oidcMatch = (
    runners: readonly AtfRunner[],
    issuer: string,
    payload: Record<string, unknown>,
  ): AtfRunner[] =>
    runners.filter(
      (r) =>
        r.method === 'oidc' &&
        runnerUsable(r) &&
        r.config.issuer === issuer &&
        claimsMatch(r.config.claims ?? {}, payload),
    );

  const awsMatch = (
    runners: readonly AtfRunner[],
    issuer: string,
    payload: Record<string, unknown>,
  ): AtfRunner[] => {
    const sub = payload['sub'];
    if (typeof sub !== 'string') return [];
    const role = roleArnOf(sub);
    const account = role === null ? null : arnAccount(role);
    if (account === null || !deps.awsAccounts.includes(account)) return [];
    const claimed = claimedAccount(payload);
    if (claimed !== null && claimed !== account) return [];
    return runners.filter(
      (r) =>
        r.method === 'aws_iam' &&
        runnerUsable(r) &&
        (r.config.issuer === undefined || r.config.issuer === issuer) &&
        ((r.config.accounts ?? []).length === 0 || (r.config.accounts ?? []).includes(account)) &&
        roleArnMatches(r.config.roleArns ?? [], sub),
    );
  };

  return async (boardId, bearer) => {
    const parts = unverifiedParts(bearer);
    if (parts === null) return null;
    const alg = parts.header['alg'];
    if (typeof alg !== 'string' || alg.toLowerCase() === 'none') return null;
    const issuer = parts.payload['iss'];
    if (typeof issuer !== 'string') return null;
    const kind = deps.oidcIssuers.includes(issuer)
      ? 'oidc'
      : deps.awsIssuers.includes(issuer)
        ? 'aws'
        : null;
    if (kind === null) return null;
    const payload = await verifierFor(issuer)
      .then(
        (verify) => verify(bearer),
        () => null,
      )
      .catch(() => null);
    if (payload === null) return null;
    const runners = await deps.store.transaction((tx) => tx.listAtfRunners(boardId));
    const matches =
      kind === 'oidc' ? oidcMatch(runners, issuer, payload) : awsMatch(runners, issuer, payload);
    const only = matches.length === 1 ? matches[0] : undefined;
    return only === undefined ? null : resolved(only);
  };
};
