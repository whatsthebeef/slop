import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { Env } from './app.js';

/**
 * The built board. index.html is re-read whenever its mtime changes, so a rebuild is picked up without a restart.
 * A path with a file extension that is not a built file is a 404: answering it with the app page makes a stale
 * page's missing script arrive as HTML, which the browser refuses to run.
 */
export const mountWeb = (app: Hono<Env>, root: string): void => {
  const file = join(root, 'index.html');
  let cached: { readonly mtimeMs: number; readonly html: string } | undefined;
  const index = async (): Promise<string> => {
    const { mtimeMs } = await stat(file);
    if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, html: await readFile(file, 'utf8') };
    return cached.html;
  };
  app.use('/*', serveStatic({ root }));
  // The board is a single-page app: extension-less paths (/boards/15) get index.html.
  app.get('*', async (c) => {
    // An API route this server doesn't have is a JSON 404, never the page (the board would read the HTML as data).
    if (/^\/(api|auth)(\/|$)/.test(c.req.path)) {
      return c.json(
        { code: 'not_found', message: `No such API route: ${c.req.method} ${c.req.path} (is the server older than the board?)` },
        404,
      );
    }
    const last = c.req.path.slice(c.req.path.lastIndexOf('/') + 1);
    if (c.req.path.startsWith('/assets/') || last.includes('.')) return c.notFound();
    return c.html(await index());
  });
};
