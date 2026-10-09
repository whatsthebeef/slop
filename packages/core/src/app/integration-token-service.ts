import { forbidden, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { IntegrationTokenStatus } from '../domain/integration-tokens.js';
import type { Clock, Store } from '../ports.js';
import { adminOf, memberOf } from './access.js';

/**
 * A board's integration token: one active token per board, created (and shown once) and revoked by an admin. Making a new
 * one revokes the old. Random bytes and hashing are the server's (`newSecret`, `hashSecret`), so core stays free of them.
 */
export class IntegrationTokenService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      newSecret: () => string;
      hashSecret: (secret: string) => string;
    },
  ) {}

  async status(email: string, boardId: number): Promise<Result<IntegrationTokenStatus>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const token = await tx.getActiveIntegrationToken(boardId);
      return ok({ active: token !== null, createdAt: token?.createdAt ?? null });
    });
  }

  /** Creates the board's token, replacing any active one; the secret is returned here and never again. */
  async create(
    email: string,
    boardId: number,
  ): Promise<Result<{ token: string; createdAt: string }>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const secret = this.deps.newSecret();
      await tx.revokeIntegrationTokens(boardId, now);
      await tx.insertIntegrationToken({
        boardId,
        tokenHash: this.deps.hashSecret(secret),
        createdAt: now,
        createdBy: email,
      });
      return ok({ token: secret, createdAt: now });
    });
  }

  async revoke(email: string, boardId: number): Promise<Result<IntegrationTokenStatus>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      await tx.revokeIntegrationTokens(boardId, this.deps.clock.now());
      return ok({ active: false, createdAt: null });
    });
  }

  /** Whether `secret` is the board's active token. A token for another board, a revoked one and an unknown one are all refused alike. */
  async authenticate(boardId: number, secret: string): Promise<Result<{ boardId: number }>> {
    const token = await this.deps.store.transaction((tx) =>
      tx.findIntegrationToken(this.deps.hashSecret(secret)),
    );
    if (token?.boardId !== boardId || token.revokedAt !== null)
      return forbidden('The integration token is not valid for this board');
    return ok({ boardId });
  }
}
