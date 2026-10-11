import type { CodeViewService, Result } from '@slop/core';
import type { Context, Hono } from 'hono';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface CodeRoutesDeps {
  readonly code: CodeViewService;
}

const present = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);
const whole = (value: string | undefined): number | undefined => (value === undefined || !/^\d+$/.test(value) ? undefined : Number(value));

/** The same read-only code view the MCP tools give, for the board's web app and other REST clients (member of the board required). */
export const mountCode = (app: Hono<Env>, deps: CodeRoutesDeps): void => {
  const reply = <T>(c: Context<Env>, result: Result<T>) =>
    result.ok ? c.json({ value: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  const board = (raw: string | undefined): number => Number(raw);

  app.get('/api/boards/:b/code/search', async (c) =>
    reply(
      c,
      await deps.code.grep(c.get('email'), {
        board: board(c.req.param('b')),
        pattern: c.req.query('q') ?? '',
        ref: present(c.req.query('ref')),
        paths: c.req.queries('path') ?? [],
        limit: whole(c.req.query('limit')),
        consumer: 'rest',
      }),
    ),
  );

  app.get('/api/boards/:b/code/file', async (c) =>
    reply(
      c,
      await deps.code.read(c.get('email'), {
        board: board(c.req.param('b')),
        path: c.req.query('path') ?? '',
        ref: present(c.req.query('ref')),
        start: whole(c.req.query('start')),
        end: whole(c.req.query('end')),
        consumer: 'rest',
      }),
    ),
  );

  app.get('/api/boards/:b/code/tree', async (c) =>
    reply(c, await deps.code.tree(c.get('email'), { board: board(c.req.param('b')), path: c.req.query('path'), ref: present(c.req.query('ref')), consumer: 'rest' })),
  );

  app.get('/api/boards/:b/code/history', async (c) =>
    reply(c, await deps.code.history(c.get('email'), { board: board(c.req.param('b')), path: c.req.query('path') ?? '', limit: whole(c.req.query('limit')), consumer: 'rest' })),
  );

  app.get('/api/boards/:b/code/imports', async (c) =>
    reply(
      c,
      await deps.code.imports(c.get('email'), {
        board: board(c.req.param('b')),
        path: c.req.query('path') ?? '',
        direction: c.req.query('direction') === 'importedBy' ? 'importedBy' : 'imports',
        consumer: 'rest',
      }),
    ),
  );
};
