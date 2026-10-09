import { describe, expect, it } from 'vitest';
import { SlopError, UsageError } from '../src/errors.js';
import { reportCommand } from '../src/report.js';

const CSV = 'developer,period,RnD hours,maintenance hours,% RnD\r\nana@example.com,2026-10,4.00,3.00,57.1\r\n';

function setup(answer: () => Promise<unknown> = () => Promise.resolve({ boardId: 15, period: '2026-10', kind: 'month', csv: CSV }), board: string | null = '15') {
  const paths: string[] = [];
  const written = new Map<string, string>();
  const out: string[] = [];
  const logs: string[] = [];
  const deps = {
    client: {
      rest: (method: string, path: string) => {
        paths.push(`${method} ${path}`);
        return answer();
      },
    },
    writeFile: (path: string, text: string) => {
      written.set(path, text);
      return Promise.resolve();
    },
    stdout: (t: string) => out.push(t),
    log: (t: string) => logs.push(t),
    defaultBoard: board ?? undefined,
  };
  return { paths, written, out, logs, deps };
}

describe('slop report', () => {
  it('writes slop-report-<board>-<period>.csv in the current folder by default, for SLOP_BOARD', async () => {
    const { paths, written, out, logs, deps } = setup();
    await reportCommand(['--period', '2026-10'], deps);
    expect(paths).toEqual(['GET /api/boards/15/reports/2026-10']);
    expect([...written]).toEqual([['slop-report-15-2026-10.csv', CSV]]);
    expect(out).toEqual([]);
    expect(logs).toEqual(['slop: wrote slop-report-15-2026-10.csv']);
  });

  it('takes the board from --board over SLOP_BOARD, and needs one', async () => {
    const chosen = setup(() => Promise.resolve({ boardId: 3, period: '2026', kind: 'year', csv: CSV }));
    await reportCommand(['--board', '3', '--period', '2026'], chosen.deps);
    expect(chosen.paths).toEqual(['GET /api/boards/3/reports/2026']);
    expect([...chosen.written]).toEqual([['slop-report-3-2026.csv', CSV]]);
    const none = setup(undefined, null);
    await expect(reportCommand(['--period', '2026'], none.deps)).rejects.toThrow(/no board: pass --board/);
    await expect(reportCommand(['--board', 'x', '--period', '2026'], none.deps)).rejects.toThrow(UsageError);
    expect(none.paths).toEqual([]);
  });

  it('writes to --out, or prints with --out -', async () => {
    const file = setup();
    await reportCommand(['--period', '2026-10', '--out', 'reports/oct.csv'], file.deps);
    expect([...file.written]).toEqual([['reports/oct.csv', CSV]]);
    const stdout = setup();
    await reportCommand(['--out', '-', '--period', '2026-10'], stdout.deps);
    expect(stdout.out).toEqual([CSV]);
    expect(stdout.written.size).toBe(0);
  });

  it('needs a valid period', async () => {
    const { paths, deps } = setup();
    await expect(reportCommand([], deps)).rejects.toThrow(UsageError);
    await expect(reportCommand(['--period'], deps)).rejects.toThrow(UsageError);
    await expect(reportCommand(['--period', '2026-13'], deps)).rejects.toThrow(/YYYY-MM/);
    await expect(reportCommand(['--period', '2026', '--format', 'x'], deps)).rejects.toThrow(/unknown option --format/);
    expect(paths).toEqual([]);
  });

  it("surfaces slop's error and an unexpected answer", async () => {
    const refused = setup(() => Promise.reject(new SlopError('GET /api/boards/15/reports/2026-10 failed (403): Only board admins can download reports')));
    await expect(reportCommand(['--period', '2026-10'], refused.deps)).rejects.toThrow('Only board admins');
    const odd = setup(() => Promise.resolve({ nope: true }));
    await expect(reportCommand(['--period', '2026-10'], odd.deps)).rejects.toThrow(/unexpected response/);
  });

  it('refuses a report for a different board or period than the one asked for', async () => {
    const otherBoard = setup(() => Promise.resolve({ boardId: 16, period: '2026-10', kind: 'month', csv: CSV }));
    await expect(reportCommand(['--period', '2026-10'], otherBoard.deps)).rejects.toThrow(/answered for board 16 2026-10, not board 15 2026-10/);
    const otherPeriod = setup(() => Promise.resolve({ boardId: 15, period: '2026', kind: 'year', csv: CSV }));
    await expect(reportCommand(['--period', '2026-10', '--out', '-'], otherPeriod.deps)).rejects.toThrow(SlopError);
    expect(otherBoard.written.size + otherPeriod.written.size + otherPeriod.out.length).toBe(0);
  });

  it('refuses a period from slop that is not a month or a year, before naming a file with it', async () => {
    const traversal = setup(() => Promise.resolve({ boardId: 15, period: '../x', kind: 'month', csv: CSV }));
    await expect(reportCommand(['--period', '2026-10'], traversal.deps)).rejects.toThrow(/unexpected response/);
    expect(traversal.written.size).toBe(0);
  });
});
