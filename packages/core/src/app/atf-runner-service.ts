import { validateRunner } from '../domain/atf-runners.js';
import type { AtfRunner, AtfRunnerConfig, AtfRunnerMethod } from '../domain/atf-runners.js';
import { invalidCombination, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Board } from '../domain/types.js';
import type { Clock, Store } from '../ports.js';
import { adminOf } from './access.js';

/** What a runner is told once, when slop creates its client credentials. The secret is never stored or logged. */
export interface IssuedRunnerCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where the runner exchanges them for a token. */
  readonly tokenUrl: string;
  /** The scope the runner asks for (space separated). */
  readonly scope: string;
}

/**
 * Creates and removes a client-credentials client in the identity provider (Cognito, an adapter in the server). Both throw
 * when the provider can't be reached or refuses; removing a client that is already gone is success.
 */
export interface RunnerCredentialIssuer {
  issue(name: string): Promise<IssuedRunnerCredentials>;
  revoke(clientId: string): Promise<void>;
}

export interface AtfRunnerServiceDeps {
  readonly store: Store;
  readonly clock: Clock;
  /** Present when the server can create client credentials for `client_credentials` runners. */
  readonly issuer?: RunnerCredentialIssuer;
  /** Task and a message with no secrets, for failures nobody is waiting on. */
  readonly log?: (task: string, message: string) => void;
}

/** A created runner; `credentials` is set only on the answer to the create call that issued them. */
export type CreatedRunner = AtfRunner & { readonly credentials?: IssuedRunnerCredentials };

/** A revoked runner; `cleanup` is `failed` when its client credentials could not be removed (the runner is revoked anyway). */
export type RevokedRunner = AtfRunner & { readonly cleanup?: 'failed' };

/** A runner to register. */
export interface RunnerInput {
  readonly name: string;
  readonly method: AtfRunnerMethod;
  readonly config?: AtfRunnerConfig;
  readonly environments: readonly string[];
}

/** What an admin may change on a runner; the method and the credential's owner never change. */
export interface RunnerChange {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly environments?: readonly string[];
  readonly config?: AtfRunnerConfig;
}

/** Only the settings the method uses are kept, so a runner's config never carries another method's leftovers. */
const configFor = (method: AtfRunnerMethod, config: AtfRunnerConfig): AtfRunnerConfig => {
  if (method === 'oidc')
    return {
      ...(config.issuer !== undefined && { issuer: config.issuer }),
      claims: config.claims ?? {},
    };
  if (method === 'aws_iam')
    return {
      roleArns: config.roleArns ?? [],
      ...(config.accounts !== undefined && { accounts: config.accounts }),
    };
  return config.clientId === undefined ? {} : { clientId: config.clientId };
};

const observed = (board: Board): string[] =>
  board.environments.filter((e) => e.role !== undefined).map((e) => e.name);

const NAME_TAKEN = 'Another runner of this board already has that name';

/**
 * A board's ATF runners (spec, ATF runners): board admins register, change, disable and revoke them. Revoking frees the
 * name and ends the credential for good; the runner's earlier results stay, still pointing at it. The identity checks
 * that turn a request's credential into a runner are the server's (`atf-auth.ts`); this service holds the registry rules.
 */
export class AtfRunnerService {
  constructor(private readonly deps: AtfRunnerServiceDeps) {}

  /** The board's runners that aren't revoked (admins only). */
  async list(email: string, boardId: number): Promise<Result<AtfRunner[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listAtfRunners(boardId));
    });
  }

  /**
   * Registers a runner. When the server can issue client credentials, a `client_credentials` runner gets its client from
   * the provider: the runner is saved disabled first (so the name is held and a half-made runner is never usable), the
   * client is created, and only its ID is stored. The secret comes back in `credentials` of this answer alone.
   */
  async create(email: string, boardId: number, input: RunnerInput): Promise<Result<CreatedRunner>> {
    const now = this.deps.clock.now();
    const issuer = input.method === 'client_credentials' ? this.deps.issuer : undefined;
    const saved = await this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${String(boardId)}`);
      // With an issuer the client ID is ours to set, never a caller's.
      const config = issuer === undefined ? configFor(input.method, input.config ?? {}) : {};
      const valid = validateRunner({ ...input, config }, observed(board));
      if (!valid.ok) return valid;
      const runner = await tx.insertAtfRunner({
        boardId,
        name: valid.value.name,
        method: input.method,
        config,
        environments: valid.value.environments,
        enabled: issuer === undefined,
        createdBy: email,
        createdAt: now,
      });
      return runner === null ? invalidInput(NAME_TAKEN) : ok(runner);
    });
    if (!saved.ok || issuer === undefined) return saved;
    return this.issueFor(boardId, saved.value, issuer);
  }

  private async issueFor(
    boardId: number,
    runner: AtfRunner,
    issuer: RunnerCredentialIssuer,
  ): Promise<Result<CreatedRunner>> {
    const failed = async (issued: IssuedRunnerCredentials | null): Promise<Result<never>> => {
      // The runner never became usable: free its name, and take back a client that was made.
      if (issued !== null) await issuer.revoke(issued.clientId).catch(() => undefined);
      await this.deps.store
        .transaction((tx) =>
          tx.updateAtfRunner(boardId, runner.id, { enabled: false, revokedAt: this.deps.clock.now() }),
        )
        .catch(() => undefined);
      this.deps.log?.('atf runners', `Client credentials for runner ${String(runner.id)} could not be created`);
      return invalidCombination('The client credentials could not be created. Nothing was saved; try again later');
    };
    let issued: IssuedRunnerCredentials;
    try {
      issued = await issuer.issue(`slop-atf-b${String(boardId)}-r${String(runner.id)}`);
    } catch {
      return await failed(null);
    }
    try {
      const updated = await this.deps.store.transaction((tx) =>
        tx.updateAtfRunner(boardId, runner.id, { config: { clientId: issued.clientId }, enabled: true }),
      );
      if (updated === null) return await failed(issued);
      return ok({ ...updated, credentials: issued });
    } catch {
      return await failed(issued);
    }
  }

  async update(
    email: string,
    boardId: number,
    id: number,
    change: RunnerChange,
  ): Promise<Result<AtfRunner>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      const current = await tx.getAtfRunner(boardId, id);
      if (board === null || current === null)
        return notFound(`No ATF runner ${String(id)} on board ${String(boardId)}`);
      if (current.revokedAt !== null)
        return invalidInput('A revoked runner can no longer be changed');
      // A client ID issued by the provider belongs to the runner for good.
      const managed = current.method === 'client_credentials' && this.deps.issuer !== undefined;
      const config = managed ? current.config : configFor(current.method, change.config ?? current.config);
      const valid = validateRunner(
        {
          name: change.name ?? current.name,
          method: current.method,
          config,
          environments: change.environments ?? current.environments,
        },
        observed(board),
      );
      if (!valid.ok) return valid;
      const updated = await tx.updateAtfRunner(boardId, id, {
        name: valid.value.name,
        config,
        environments: valid.value.environments,
        ...(change.enabled !== undefined && { enabled: change.enabled }),
      });
      return updated === null ? invalidInput(NAME_TAKEN) : ok(updated);
    });
  }

  /**
   * Ends the runner's credential for good and frees its name. Revoking one runner touches no other. The runner is marked
   * revoked first, so a provider failure never leaves it usable; the client credentials are then removed from the
   * provider, and when that fails the answer says `cleanup: 'failed'` and revoking again retries it.
   */
  async revoke(email: string, boardId: number, id: number): Promise<Result<RevokedRunner>> {
    const now = this.deps.clock.now();
    const revoked = await this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const current = await tx.getAtfRunner(boardId, id);
      if (current === null)
        return notFound(`No ATF runner ${String(id)} on board ${String(boardId)}`);
      if (current.revokedAt !== null) return ok(current);
      const updated = await tx.updateAtfRunner(boardId, id, { enabled: false, revokedAt: now });
      return updated === null
        ? notFound(`No ATF runner ${String(id)} on board ${String(boardId)}`)
        : ok(updated);
    });
    if (!revoked.ok) return revoked;
    const clientId = revoked.value.method === 'client_credentials' ? revoked.value.config.clientId : undefined;
    if (clientId === undefined) return revoked;
    try {
      if (this.deps.issuer === undefined) throw new Error('no issuer');
      await this.deps.issuer.revoke(clientId);
      return revoked;
    } catch {
      this.deps.log?.('atf runners', `Client credentials of revoked runner ${String(id)} could not be removed`);
      return ok({ ...revoked.value, cleanup: 'failed' });
    }
  }

  /** Notes that the runner's credential was accepted just now (shown as "last seen"). */
  async seen(boardId: number, id: number): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.store.transaction(async (tx) => {
      await tx.updateAtfRunner(boardId, id, { lastSeenAt: now });
    });
  }
}
