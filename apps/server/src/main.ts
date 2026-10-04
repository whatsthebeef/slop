import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { BoardService, GlobService } from '@slop/core';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import * as schema from './db/schema.js';
import { connect, PgStore, runMigrations } from './db/store.js';
import { createApp } from './http/app.js';
import { defaultExecutors, noRepositoryProvisioner, OutboxRunner } from './jobs/outbox.js';
import { mountMcp } from './mcp/server.js';
import { HintHub } from './notifier.js';

const config = loadConfig();
await runMigrations(config.DATABASE_URL, config.MIGRATIONS_DIR);
const database = connect(config.DATABASE_URL);
const { db } = database;

const logError = (task: string, message: string) => {
  console.error(`[${task}] ${message}`);
  void db.insert(schema.errors).values({ task, message }).catch(() => undefined);
};

const store = new PgStore(db);
const hub = new HintHub();
const auth = new Auth(db, config);
const boards = new BoardService({ store, notifier: hub });
const globs = new GlobService({
  store,
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  ids: { runId: () => randomUUID() },
  // Routine registration arrives in slice 4; until then every run falls back to the board default.
  routines: { hasRoutine: () => Promise.resolve(false) },
});
const outbox = new OutboxRunner(db, { globs }, defaultExecutors(noRepositoryProvisioner), logError);

const app = createApp({ auth, boards, globs, hub, outbox });
mountMcp(app, { auth, boards, globs, outbox, publicUrl: config.PUBLIC_URL });

app.onError((error, c) => {
  logError(`http ${c.req.method} ${c.req.path}`, error.stack ?? error.message);
  return c.json({ code: 'internal', message: 'Something went wrong' }, 500);
});

if (config.WEB_DIST !== undefined) {
  const root = config.WEB_DIST;
  const index = await readFile(join(root, 'index.html'), 'utf8');
  app.use('/*', serveStatic({ root }));
  // The board is a single-page app: unknown paths get index.html.
  app.get('*', (c) => c.html(index));
}

outbox.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
