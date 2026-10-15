import { LEGACY_RUNNER_NAME, runnerUsable } from '@slop/core';
import type { AtfCredentialMethod, IntegrationTokenService, Store } from '@slop/core';

/**
 * Who is calling an ATF door (spec, ATF runners): one place turns a bearer credential into a runner bound to one board,
 * or refuses it. Each identity method is a verifier that plugs in here; the board's integration token is the legacy
 * fallback. A refusal says nothing about why, and credentials, tokens and claims are never logged: only a runner's ID and
 * method.
 */

/** A registered runner, or the legacy board token (`runnerId` null), as the doors need it. */
export interface ResolvedRunner {
  readonly runnerId: number | null;
  readonly boardId: number;
  readonly name: string;
  readonly method: AtfCredentialMethod;
  /** The environments the runner serves; null for the legacy token, which serves every observed one. */
  readonly environments: readonly string[] | null;
}

/** What a door needs from a credential, for the methods that grant by scope (client credentials). */
export type AtfScope = 'atf.read-specs' | 'atf.write-results';

/**
 * Recognises one kind of credential. Returns the registered runner it identifies on this board, or null when the
 * credential isn't of its kind, doesn't verify, or matches no runner. A verifier that finds a credential matching more than
 * one runner must return null: the resolver also refuses when two verifiers answer for different runners.
 */
export type RunnerVerifier = (
  boardId: number,
  bearer: string,
  scope?: AtfScope,
) => Promise<ResolvedRunner | null>;

export const ATF_RUNNERS_README_URL =
  'https://github.com/whatsthebeef/slop/blob/main/catalog/scripts/README.md';

/** How often a board's legacy-token use is logged (once per board per period). */
const LEGACY_LOG_PERIOD_MS = 60 * 60 * 1000;

export interface AtfAuthDeps {
  readonly store: Pick<Store, 'transaction'>;
  readonly tokens: Pick<IntegrationTokenService, 'authenticate'>;
  /** Identity methods beyond the legacy token; OIDC and AWS identity, and Cognito client credentials, add theirs here. */
  readonly verifiers?: readonly RunnerVerifier[];
  readonly log: (task: string, message: string) => void;
  readonly now?: () => number;
}

/** `scope` is what the calling door needs; verifiers whose credentials aren't scoped (OIDC, AWS) ignore it. */
export type RunnerAuthenticator = (
  boardId: number,
  credential: string,
  scope?: AtfScope,
) => Promise<ResolvedRunner | null>;

/**
 * The resolver `authenticateRunner(boardId, credential)`. Verifiers answer first; whatever runner one names is read back
 * and must still be enabled, not revoked and on this board (so disabling or revoking works for every method alike). Two
 * different runners from the verifiers is an ambiguity and is refused. Only when no verifier answered is the credential tried as
 * the board's integration token, the deprecated way in, which resolves to no registered runner.
 */
export const createRunnerAuthenticator = (deps: AtfAuthDeps): RunnerAuthenticator => {
  const now = deps.now ?? Date.now;
  const lastLegacyLog = new Map<number, number>();
  return async (boardId, credential, scope) => {
    const bearer = credential.trim();
    if (bearer === '' || !Number.isSafeInteger(boardId) || boardId <= 0) return null;
    const answers = await Promise.all(
      (deps.verifiers ?? []).map((verify) =>
        verify(boardId, bearer, scope).catch(() => {
          deps.log('atf auth', 'An ATF credential verifier failed');
          return null;
        }),
      ),
    );
    const named = answers.filter(
      (a): a is ResolvedRunner & { runnerId: number } =>
        a !== null && a.runnerId !== null && a.boardId === boardId,
    );
    if (new Set(named.map((a) => a.runnerId)).size > 1) return null;
    const first = named[0];
    if (first !== undefined) {
      const runner = await deps.store.transaction((tx) => tx.getAtfRunner(boardId, first.runnerId));
      if (runner === null || !runnerUsable(runner) || runner.method !== first.method) return null;
      return {
        runnerId: runner.id,
        boardId,
        name: runner.name,
        method: runner.method,
        environments: runner.environments,
      };
    }
    const legacy = await deps.tokens.authenticate(boardId, bearer);
    if (!legacy.ok) return null;
    const at = now();
    if (at - (lastLegacyLog.get(boardId) ?? -Infinity) >= LEGACY_LOG_PERIOD_MS) {
      lastLegacyLog.set(boardId, at);
      deps.log(
        'atf legacy token',
        `Board ${String(boardId)} used the integration token for ATF (deprecated)`,
      );
    }
    return {
      runnerId: null,
      boardId,
      name: LEGACY_RUNNER_NAME,
      method: 'board_token',
      environments: null,
    };
  };
};

/** The bearer credential of a request, or null. */
export const bearerOf = (header: string | undefined): string | null => {
  if (header?.startsWith('Bearer ') !== true) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
};

/** What a caller on the legacy board token is told on every answer: move to a runner credential (none for a runner). */
export const deprecationHeaders = (runner: ResolvedRunner): Record<string, string> =>
  runner.runnerId === null
    ? {
        Deprecation: 'true',
        Link: `<${ATF_RUNNERS_README_URL}>; rel="deprecation"; type="text/html"`,
      }
    : {};
