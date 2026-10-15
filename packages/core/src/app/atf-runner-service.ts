import { validateRunner } from '../domain/atf-runners.js';
import type { AtfRunner, AtfRunnerConfig, AtfRunnerMethod } from '../domain/atf-runners.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Board } from '../domain/types.js';
import type { Clock, Store } from '../ports.js';
import { adminOf } from './access.js';

export interface AtfRunnerServiceDeps {
  readonly store: Store;
  readonly clock: Clock;
}

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

  async create(email: string, boardId: number, input: RunnerInput): Promise<Result<AtfRunner>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${String(boardId)}`);
      const config = configFor(input.method, input.config ?? {});
      const valid = validateRunner({ ...input, config }, observed(board));
      if (!valid.ok) return valid;
      const runner = await tx.insertAtfRunner({
        boardId,
        name: valid.value.name,
        method: input.method,
        config,
        environments: valid.value.environments,
        enabled: true,
        createdBy: email,
        createdAt: now,
      });
      return runner === null ? invalidInput(NAME_TAKEN) : ok(runner);
    });
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
      const config = configFor(current.method, change.config ?? current.config);
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

  /** Ends the runner's credential for good and frees its name. Revoking one runner touches no other. */
  async revoke(email: string, boardId: number, id: number): Promise<Result<AtfRunner>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const current = await tx.getAtfRunner(boardId, id);
      if (current === null)
        return notFound(`No ATF runner ${String(id)} on board ${String(boardId)}`);
      if (current.revokedAt !== null) return ok(current);
      const revoked = await tx.updateAtfRunner(boardId, id, { enabled: false, revokedAt: now });
      return revoked === null
        ? notFound(`No ATF runner ${String(id)} on board ${String(boardId)}`)
        : ok(revoked);
    });
  }

  /** Notes that the runner's credential was accepted just now (shown as "last seen"). */
  async seen(boardId: number, id: number): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.store.transaction(async (tx) => {
      await tx.updateAtfRunner(boardId, id, { lastSeenAt: now });
    });
  }
}
