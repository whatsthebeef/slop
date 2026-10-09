import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';

export const REPORT_USAGE = 'report [--board <n>] --period <YYYY-MM|YYYY> [--out <path>|-]';

export interface ReportDeps {
  /** slop's REST API with the CLI's sign-in (`SlopClient.rest`). */
  readonly client: { rest(method: string, path: string): Promise<unknown> };
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly log: (text: string) => void;
  /** SLOP_BOARD (environment, then the config files), for when `--board` isn't given. */
  readonly defaultBoard: string | undefined;
}

/** A month or a year, as the server accepts them. */
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

/** The server's `boardId` and `period` go into the default file name, so anything but a board id and a month or a year is refused. */
const reportSchema = z.object({ boardId: z.number().int().nonnegative(), period: z.string().regex(PERIOD), csv: z.string() });

/**
 * `slop report --board 15 --period 2026-10`: downloads a board's time report CSV, computed by slop from the event log (the
 * board's admins), into `slop-report-<board>-<period>.csv` in the current folder, or `--out <path>`, or stdout with
 * `--out -`. The board defaults to SLOP_BOARD.
 */
export async function reportCommand(args: readonly string[], deps: ReportDeps): Promise<void> {
  const usage = `usage: slop ${REPORT_USAGE}`;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg !== '--board' && arg !== '--period' && arg !== '--out') throw new UsageError(`${arg.startsWith('--') ? `unknown option ${arg}` : `unexpected ${arg}`}\n${usage}`);
    const value = args[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value\n${usage}`);
    values.set(arg, value);
  }
  const board = values.get('--board') ?? deps.defaultBoard;
  if (board === undefined || !/^\d+$/.test(board)) {
    throw new UsageError(`no board: pass --board <n>, set SLOP_BOARD, or add SLOP_BOARD to .sstor/sstor.conf\n${usage}`);
  }
  const period = values.get('--period');
  if (period === undefined) throw new UsageError(`--period is required\n${usage}`);
  if (!PERIOD.test(period)) throw new UsageError('--period must be YYYY-MM (a month) or YYYY (a year)');

  const parsed = reportSchema.safeParse(await deps.client.rest('GET', `/api/boards/${board}/reports/${period}`));
  if (!parsed.success) throw new SlopError('report: unexpected response from slop');
  if (String(parsed.data.boardId) !== String(Number(board)) || parsed.data.period !== period) {
    throw new SlopError(`report: slop answered for board ${String(parsed.data.boardId)} ${parsed.data.period}, not board ${board} ${period}`);
  }
  const out = values.get('--out') ?? `slop-report-${String(parsed.data.boardId)}-${parsed.data.period}.csv`;
  if (out === '-') {
    deps.stdout(parsed.data.csv);
    return;
  }
  try {
    await deps.writeFile(out, parsed.data.csv);
  } catch (error) {
    throw new SlopError(`report: could not write ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }
  deps.log(`slop: wrote ${out}`);
}
