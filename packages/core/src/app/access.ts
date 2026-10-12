import { forbidden, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Actor, Role } from '../domain/types.js';
import type { Tx } from '../ports.js';

/** The person acting on a board: an active user with a membership there. */
export const memberOf = async (tx: Tx, email: string, boardId: number): Promise<Result<Actor>> => {
  const user = await tx.getUser(email);
  if (user === null || !user.active) return forbidden('Your account is not active in slop');
  const member = await tx.getMember(boardId, email);
  if (member === null) return forbidden(`You are not a member of board ${boardId}`);
  return ok({ email, role: member.role });
};

export const adminOf = async (tx: Tx, email: string, boardId: number): Promise<Result<Actor>> => {
  const actor = await memberOf(tx, email, boardId);
  if (!actor.ok) return actor;
  return actor.value.role === 'admin' ? actor : forbidden('Only board admins can do this');
};

/** A member of the board whose role is one of `roles` (decision globs let POs decide beside admins). */
export const roleOf = async (tx: Tx, email: string, boardId: number, roles: readonly Role[]): Promise<Result<Actor>> => {
  const actor = await memberOf(tx, email, boardId);
  if (!actor.ok) return actor;
  if (roles.includes(actor.value.role)) return actor;
  return forbidden(roles.length === 1 && roles[0] === 'admin' ? 'Only board admins can do this' : `Only ${roles.join(' and ')} members can do this`);
};
