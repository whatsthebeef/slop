import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ArtifactService, BoardService, GlobService, IntakeService, KnowledgeService } from '@slop/core';
import { Auth } from './auth.js';
import { FsCatalog, renderAgentSetFile } from './catalog.js';
import { loadConfig } from './config.js';
import * as schema from './db/schema.js';
import { connect, PgStore, runMigrations } from './db/store.js';
import { createApp } from './http/app.js';
import { mountKnowledge } from './http/knowledge.js';
import { OutboxRunner } from './jobs/outbox.js';
import { mountMcp } from './mcp/server.js';
import { GitHub } from './github/client.js';
import { AppCredentialsStore } from './github/credentials.js';
import { githubDeliveryHandler } from './github/events.js';
import { codeHostExecutors } from './codehost-executors.js';
import { mountGitHubSetup } from './github/setup.js';
import { mountGitHubWebhooks } from './github/webhooks.js';
import { HintHub } from './notifier.js';
import { BedrockLlm } from './llm.js';
import { FileRoutines } from './routines.js';
import { SignedLinks } from './signed-links.js';
import { RunWatch } from './jobs/run-watch.js';

const config = loadConfig();
await runMigrations(config.DATABASE_URL, config.MIGRATIONS_DIR);
const database = connect(config.DATABASE_URL);
const { db } = database;

const logError = (task: string, message: string) => {
  console.error(`[${task}] ${message}`);
  void db.insert(schema.errors).values({ task, message }).catch(() => undefined);
};

const store = new PgStore(db);
const routines = new FileRoutines(config.ROUTINES_FILE);
const hub = new HintHub();
const auth = new Auth(db, config);
const boards = new BoardService({ store, notifier: hub });
const globs = new GlobService({
  store,
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  ids: { runId: () => randomUUID() },
  routines,
});
const githubCredentials = new AppCredentialsStore(config.GITHUB_APP_FILE);
await githubCredentials.load();
const github = new GitHub(githubCredentials);
const boardOf = (id: number) => store.transaction((tx) => tx.getBoard(id));
const outbox = new OutboxRunner(db, { globs }, codeHostExecutors(github, boardOf, routines), logError);

const catalog = new FsCatalog(config.CATALOG_DIR);
const clock = { now: () => new Date().toISOString() };
const knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub });
const artifacts = new ArtifactService({ store, clock, notifier: hub });
const intake = new IntakeService({
  store,
  llm: new BedrockLlm(config.INTAKE_MODEL, config.BEDROCK_REGION, (u) =>
    console.log(`[llm] ${u.model} in=${String(u.input)} out=${String(u.output)}`),
  ),
});

// Signs agent-set download links and the board sign-in state.
const links = new SignedLinks(config.SIGNING_SECRET);
if (config.AUTH_MODE === 'cognito' && (config.SIGNING_SECRET ?? '') === '') {
  console.warn('[auth] SIGNING_SECRET is not set: sign-ins and download links in flight fail across restarts and instances');
}

const app = createApp({
  auth,
  links,
  boards,
  globs,
  hub,
  outbox,
  onBoardCreated: async (email, boardId) => {
    const forked = await knowledge.forkAgentSet(email, boardId);
    if (!forked.ok) logError('board created', `Agent set fork failed for board ${boardId}: ${forked.error.message}`);
  },
});
mountKnowledge(app, { knowledge, artifacts, catalog, intake, boards, host: github });

// Signed agent-set downloads: the link was issued to a member through the authenticated MCP.
const agentSetValues = { SLOP_URL: config.PUBLIC_URL, COGNITO_CLAUDE_CODE_CLIENT_ID: config.CLAUDE_CODE_CLIENT_ID };
app.get('/downloads/agent-set/:board', async (c) => {
  const boardId = Number(c.req.param('board'));
  if (!links.verify(c.req.path, Number(c.req.query('expires')), c.req.query('signature') ?? '')) {
    return c.json({ error: 'This download link is invalid or has expired' }, 403);
  }
  const files = await store.transaction(async (tx) => {
    const board = await tx.getBoard(boardId);
    if (board === null) return null;
    const docs = (await tx.listKnowledge(boardId)).filter((d) => d.kind !== 'doc');
    return {
      version: board.agentSetVersion,
      files: docs.map((d) => ({ path: d.name, content: renderAgentSetFile(d.content, agentSetValues) })),
    };
  });
  return files === null ? c.json({ error: 'No such board' }, 404) : c.json(files);
});
mountMcp(app, {
  auth,
  boards,
  globs,
  outbox,
  knowledge,
  artifacts,
  intake,
  publicUrl: config.PUBLIC_URL,
  agentSetValues,
  links,
});

mountGitHubSetup(app, {
  auth,
  credentials: githubCredentials,
  publicUrl: config.PUBLIC_URL,
  appName: config.GITHUB_APP_NAME,
});
mountGitHubWebhooks(app, {
  credentials: githubCredentials,
  log: logError,
  handle: githubDeliveryHandler({ db, globs, github, boardOf }),
});

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
const runWatch = new RunWatch(store, globs, logError);
runWatch.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  runWatch.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
