import type { ReportService, Result } from '@slop/core';
import type { Context, Hono } from 'hono';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ReportRoutesDeps {
  readonly reports: Pick<ReportService, 'overview' | 'report'>;
}

/**
 * A board's time reports (spec, Time tracking and reports), computed on demand: the work time zone (any member of the
 * board) and whether the caller may download, one period's report as JSON (the CLI, the board) or as a CSV download
 * (the board's admins).
 */
export const mountReports = (app: Hono<Env>, deps: ReportRoutesDeps): void => {
  const send = <T>(c: Context<Env>, result: Result<T>) =>
    result.ok ? c.json(result.value) : c.json(errorBody(result.error), statusOf(result.error));
  const boardOf = (param: string) => {
    const board = Number(param);
    return Number.isSafeInteger(board) ? board : null;
  };
  const badBoard = (c: Context<Env>) => c.json({ code: 'invalid_input', message: 'Bad board' }, 422);

  app.get('/api/boards/:b/reports', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return badBoard(c);
    return send(c, await deps.reports.overview(c.get('email'), board));
  });

  app.get('/api/boards/:b/reports/:period', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return badBoard(c);
    return send(c, await deps.reports.report(c.get('email'), board, c.req.param('period')));
  });

  app.get('/api/boards/:b/reports/:period/csv', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return badBoard(c);
    const result = await deps.reports.report(c.get('email'), board, c.req.param('period'));
    if (!result.ok) return c.json(errorBody(result.error), statusOf(result.error));
    // The board is an integer and the period is validated (YYYY-MM or YYYY), so both are safe in the file name.
    return c.body(result.value.csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="slop-report-${String(result.value.boardId)}-${result.value.period}.csv"`,
      'cache-control': 'no-store',
    });
  });
};
