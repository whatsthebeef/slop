import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';

export const GROUP_BACKFILL_USAGE = 'group-backfill [--board <n>] [--apply]';

export interface GroupBackfillDeps {
  /** slop's REST API with the CLI's sign-in (`SlopClient.rest`). */
  readonly client: { rest(method: string, path: string, body?: unknown): Promise<unknown> };
  readonly stdout: (text: string) => void;
  /** SLOP_BOARD, for when `--board` isn't given. */
  readonly defaultBoard: string | undefined;
}

const backfillSchema = z.object({
  applied: z.boolean(),
  items: z.array(z.object({ id: z.string(), title: z.string(), group: z.string(), why: z.string(), result: z.string().optional() })),
});

/**
 * `slop group-backfill --board 15`: lists the groups slop proposes for the board's open globs that have none (the board's
 * admins), with why. Nothing is written until `--apply`, which writes each through the glob's update at the version it read; a
 * re-run then proposes nothing for them.
 */
export async function groupBackfillCommand(args: readonly string[], deps: GroupBackfillDeps): Promise<void> {
  const usage = `usage: slop ${GROUP_BACKFILL_USAGE}`;
  let board = deps.defaultBoard;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--apply') apply = true;
    else if (arg === '--board') {
      board = args[++i];
      if (board === undefined) throw new UsageError(`--board needs a value\n${usage}`);
    } else throw new UsageError(`${arg.startsWith('--') ? `unknown option ${arg}` : `unexpected ${arg}`}\n${usage}`);
  }
  if (board === undefined || !/^\d+$/.test(board)) {
    throw new UsageError(`no board: pass --board <n>, set SLOP_BOARD, or add SLOP_BOARD to .sstor/sstor.conf\n${usage}`);
  }
  const parsed = backfillSchema.safeParse(await deps.client.rest('POST', `/api/boards/${board}/groups/backfill`, { apply }));
  if (!parsed.success) throw new SlopError('group-backfill: unexpected response from slop');
  const { items } = parsed.data;
  for (const item of items) {
    deps.stdout(`${item.id}\t${item.group}\t${item.why}\t${item.title}${item.result === undefined ? '' : `\t[${item.result}]`}\n`);
  }
  if (items.length === 0) deps.stdout('No open globs need a group.\n');
  else if (!apply) deps.stdout(`${String(items.length)} proposed; run again with --apply to write them.\n`);
}
