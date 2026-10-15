import {
  CreateUserPoolClientCommand,
  DeleteUserPoolClientCommand,
  DescribeResourceServerCommand,
  DescribeUserPoolClientCommand,
  CognitoIdentityProviderClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Jwks } from 'aws-jwt-verify/jwk';
import { runnerUsable } from '@slop/core';
import type { RunnerCredentialIssuer, Store } from '@slop/core';
import type { AtfScope, ResolvedRunner, RunnerVerifier } from './atf-auth.js';

/**
 * OAuth client credentials for ATF runners (spec, ATF runners): a runner with neither OIDC nor AWS identity gets its own
 * Cognito app client in slop's user pool, limited to the ATF scopes of the `slop` resource server, and sends the access
 * token it fetches with the client's secret. Slop creates and deletes the clients (`CognitoClients`, an adapter on the
 * Cognito API) and verifies the tokens here, separately from the user verifier in `auth.ts`, which never accepts a
 * client's token (its client IDs are listed, a runner's is not). The client secret is returned once to the board admin
 * and is never stored or logged.
 */

/** The resource server's identifier (infra/lib/auth-stack.ts) and the ATF scopes under it. */
export const ATF_RESOURCE_SERVER = 'slop';
export const ATF_SCOPES: Readonly<Record<AtfScope, string>> = {
  'atf.read-specs': `${ATF_RESOURCE_SERVER}/atf.read-specs`,
  'atf.write-results': `${ATF_RESOURCE_SERVER}/atf.write-results`,
};
const ALL_SCOPES = Object.values(ATF_SCOPES);

/** A Cognito app client slop made. */
export interface IssuedClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What slop needs from Cognito's app-client API. Calls throw when Cognito refuses or can't be reached. */
export interface CognitoClients {
  /** A client with a secret, the `client_credentials` flow only and the two ATF scopes. */
  create(name: string): Promise<IssuedClient>;
  /** Removes a client; one that is already gone is success. */
  delete(clientId: string): Promise<void>;
  /** The client's scopes, or null when there is no such client. */
  describe(
    clientId: string,
  ): Promise<{ readonly clientId: string; readonly scopes: readonly string[] } | null>;
  /** Why clients can't be issued right now (no permission, scopes not deployed, unreachable), or null when they can. */
  unavailableReason(signal?: AbortSignal): Promise<string | null>;
}

export interface AwsCognitoClientsOptions {
  readonly userPoolId: string;
  readonly region: string;
  /** For tests of the adapter: a client that answers without the network. */
  readonly client?: Pick<CognitoIdentityProviderClient, 'send'>;
}

/** The adapter on `@aws-sdk/client-cognito-identity-provider`, with the instance role's credentials. */
export class AwsCognitoClients implements CognitoClients {
  private readonly client: Pick<CognitoIdentityProviderClient, 'send'>;

  constructor(private readonly options: AwsCognitoClientsOptions) {
    this.client = options.client ?? new CognitoIdentityProviderClient({ region: options.region });
  }

  async create(name: string): Promise<IssuedClient> {
    const { UserPoolClient: created } = await this.client.send(
      new CreateUserPoolClientCommand({
        UserPoolId: this.options.userPoolId,
        ClientName: name,
        GenerateSecret: true,
        AllowedOAuthFlows: ['client_credentials'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: [...ALL_SCOPES],
        AccessTokenValidity: 60,
        TokenValidityUnits: { AccessToken: 'minutes' },
        EnableTokenRevocation: true,
      }),
    );
    if (created?.ClientId === undefined || created.ClientSecret === undefined) {
      throw new Error('Cognito returned no client');
    }
    return { clientId: created.ClientId, clientSecret: created.ClientSecret };
  }

  async delete(clientId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteUserPoolClientCommand({
          UserPoolId: this.options.userPoolId,
          ClientId: clientId,
        }),
      );
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }

  async describe(clientId: string) {
    try {
      const { UserPoolClient: found } = await this.client.send(
        new DescribeUserPoolClientCommand({
          UserPoolId: this.options.userPoolId,
          ClientId: clientId,
        }),
      );
      return found?.ClientId === undefined
        ? null
        : { clientId: found.ClientId, scopes: found.AllowedOAuthScopes ?? [] };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /**
   * Reading the resource server proves two things at once: the instance role may call Cognito for this pool (host stack),
   * and the pool has the ATF scopes (auth stack). A message names what is missing, never a secret.
   */
  async unavailableReason(signal?: AbortSignal): Promise<string | null> {
    try {
      const { ResourceServer: server } = await this.client.send(
        new DescribeResourceServerCommand({
          UserPoolId: this.options.userPoolId,
          Identifier: ATF_RESOURCE_SERVER,
        }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      const have = new Set(
        (server?.Scopes ?? []).map((s) => `${ATF_RESOURCE_SERVER}/${s.ScopeName ?? ''}`),
      );
      return ALL_SCOPES.every((s) => have.has(s))
        ? null
        : 'the pool has no ATF scopes (deploy the auth stack)';
    } catch (error) {
      if (error instanceof ResourceNotFoundException)
        return 'the pool has no slop resource server (deploy the auth stack)';
      const name = error instanceof Error ? error.name : 'Error';
      return name === 'AccessDeniedException'
        ? 'the instance role may not manage Cognito app clients (deploy the host stack with cognitoUserPoolId)'
        : `Cognito did not answer (${name})`;
    }
  }
}

/** Core's port over Cognito: the board admin's one-time answer carries the secret and where to use it. */
export const cognitoRunnerCredentials = (
  clients: CognitoClients,
  tokenUrl: string,
): RunnerCredentialIssuer => ({
  async issue(name) {
    const client = await clients.create(name);
    return { ...client, tokenUrl, scope: ALL_SCOPES.join(' ') };
  },
  revoke: (clientId) => clients.delete(clientId),
});

export interface CognitoRunnerVerifierDeps {
  readonly store: Pick<Store, 'transaction'>;
  readonly userPoolId: string;
  /** Tests give the pool's signing keys instead of fetching them. */
  readonly jwks?: Jwks;
}

const resolved = (runner: {
  id: number;
  boardId: number;
  name: string;
  environments: readonly string[];
}): ResolvedRunner => ({
  runnerId: runner.id,
  boardId: runner.boardId,
  name: runner.name,
  method: 'client_credentials',
  environments: runner.environments,
});

/**
 * Verifies a machine-to-machine access token from slop's own pool and maps its `client_id` to the one enabled
 * `client_credentials` runner of the board that names that client. A token is refused when it is not an access token of
 * the pool, carries a `username` (a person's token), lacks the scope the route needs, or names no runner of the board. No
 * user is involved, so nothing here reaches `Auth`. A null answer says nothing about why.
 */
export const createCognitoRunnerVerifier = (deps: CognitoRunnerVerifierDeps): RunnerVerifier => {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: deps.userPoolId,
    tokenUse: 'access',
    clientId: null,
  });
  if (deps.jwks !== undefined) verifier.cacheJwks(deps.jwks);
  return async (boardId, bearer, scope) => {
    // Without a scope to check there is nothing to grant.
    if (scope === undefined || bearer.split('.').length !== 3) return null;
    const payload = await verifier.verify(bearer).catch(() => null);
    if (payload === null) return null;
    const claims: Record<string, unknown> = Object.fromEntries(Object.entries(payload));
    if ('username' in claims) return null;
    const clientId = claims['client_id'];
    const granted = claims['scope'];
    if (typeof clientId !== 'string' || typeof granted !== 'string') return null;
    if (!granted.split(' ').includes(ATF_SCOPES[scope])) return null;
    const runners = await deps.store.transaction((tx) => tx.listAtfRunners(boardId));
    const matches = runners.filter(
      (r) => r.method === 'client_credentials' && runnerUsable(r) && r.config.clientId === clientId,
    );
    const only = matches.length === 1 ? matches[0] : undefined;
    return only === undefined ? null : resolved(only);
  };
};
