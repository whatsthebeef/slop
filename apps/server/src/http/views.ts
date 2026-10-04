import type { Action, DomainError, Glob, Role } from '@slop/core';
import { listOf, machine } from '@slop/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The glob as clients see it: the stored document plus derived fields. */
export const globView = (glob: Glob, allowedActions: readonly Action[] | null = null) => ({
  ...glob,
  list: listOf(glob.status),
  branch: glob.id,
  currentRun: machine.currentRun(glob),
  ...(allowedActions === null ? {} : { allowedActions }),
});

export const globViewFor = (glob: Glob, email: string, role: Role) =>
  globView(glob, machine.allowedActions(glob, { email, role }));

export const statusOf = (error: DomainError): ContentfulStatusCode => {
  switch (error.code) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'version_conflict':
    case 'invalid_transition':
    case 'run_active':
      return 409;
    case 'invalid_combination':
    case 'invalid_input':
      return 422;
  }
};

export const errorBody = (error: DomainError) =>
  error.code === 'version_conflict' ? { ...error, current: globView(error.current) } : error;

const SIGNED_OFF_VISIBLE_MS = 14 * 86_400_000;

/** Signed-off globs drop off the board after two weeks (computed on display). */
export const onBoard = (glob: Glob, now: number): boolean =>
  glob.status !== 'signed_off' ||
  glob.signedOffAt === null ||
  now - Date.parse(glob.signedOffAt) < SIGNED_OFF_VISIBLE_MS;
