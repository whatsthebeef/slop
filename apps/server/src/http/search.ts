import { MAX_QUERY_LENGTH } from '@slop/core';
import type { SearchService } from '@slop/core';
import type { Hono } from 'hono';
import { isDate, toRequest } from '../search-request.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface SearchRoutesDeps {
  readonly search: Pick<SearchService, 'board'>;
}

const present = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/** The board's search box: keyword and semantic results fused; `history=1` ranks all of history, not just what is current. */
export const mountSearch = (app: Hono<Env>, deps: SearchRoutesDeps): void => {
  app.get('/api/boards/:b/search', async (c) => {
    const board = Number(c.req.param('b'));
    const query = (c.req.query('q') ?? '').trim();
    const from = present(c.req.query('from'));
    const to = present(c.req.query('to'));
    if (!Number.isInteger(board)) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
      return c.json({ code: 'invalid_input', message: 'from and to must be ISO dates' }, 422);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return c.json({ code: 'invalid_input', message: `q must be at most ${MAX_QUERY_LENGTH} characters` }, 422);
    }
    const history = c.req.query('history');
    const result = await deps.search.board(
      c.get('email'),
      toRequest({
        board,
        query,
        mode: history === '1' || history === 'true' ? 'all_time' : 'current',
        from,
        to,
        glob: present(c.req.query('glob')),
        group: present(c.req.query('group')),
      }),
    );
    return result.ok ? c.json({ value: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  });
};
