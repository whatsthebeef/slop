import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ArtifactService, BoardService, DeployService, GlobService, IntakeService, KbPipeline, KnowledgeService } from '@slop/core';
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
import { CodeBuildDeployer, Deployers } from './deployer.js';
import { deployCallbackUrl, deployExecutors } from './deploy-executors.js';
import { mountDeploys } from './http/deploys.js';
import { mountReadiness } from './http/readiness.js';
import { HintHub } from './notifier.js';
import { BedrockLlm } from './llm.js';
import { LlmHealth } from './llm-health.js';
import { mountHealth } from './http/health.js';
import { FileRoutines } from './routines.js';
import { SignedLinks } from './signed-links.js';
import { RunWatch } from './jobs/run-watch.js';
import { DeployWatch } from './jobs/deploy-watch.js';
import { KbPipelineJob } from './jobs/kb-pipeline.js';

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
// Signs agent-set download links, the board sign-in state and deploy callbacks.
const links = new SignedLinks(config.SIGNING_SECRET);
const deploys = new DeployService({
  store,
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  newDeployId: () => `dep_${randomUUID()}`,
});

const outbox = new OutboxRunner(
  db,
  { globs },
  {
    ...codeHostExecutors(github, boardOf, routines),
    ...deployExecutors(
      deploys,
      new Deployers({ codebuild: new CodeBuildDeployer() }),
      boardOf,
      deployCallbackUrl(links, config.WEBHOOK_BASE_URL ?? config.PUBLIC_URL),
      logError,
    ),
  },
  logError,
);

const catalog = new FsCatalog(config.CATALOG_DIR);
const clock = { now: () => new Date().toISOString() };
const knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub });
const artifacts = new ArtifactService({ store, clock, notifier: hub });
const logUsage = (u: { model: string; input: number; output: number }) =>
  console.log(`[llm] ${u.model} in=${String(u.input)} out=${String(u.output)}`);
// Credential and access failures mark the LLM down. The hub only fans out per board, so the change
// reaches open boards as a board.changed hint on each.
const llmHealth = new LlmHealth((h) => {
  console.log(h.state === 'down' ? `[llm] unavailable: ${h.reason}. ${h.fix}` : `[llm] ${h.state}`);
  for (const boardId of hub.boardIds()) hub.publish({ kind: 'board.changed', boardId });
});
const intake = new IntakeService({
  store,
  llm: llmHealth.track(new BedrockLlm(config.INTAKE_MODEL, config.BEDROCK_REGION, logUsage)),
});
const kbPipeline = new KbPipeline({
  store,
  clock,
  catalog,
  notifier: hub,
  // Opus 5.5 takes no sampling parameters other than the defaults.
  route: llmHealth.track(new BedrockLlm(config.KB_ROUTE_MODEL, config.BEDROCK_REGION, logUsage, null)),
  draft: llmHealth.track(new BedrockLlm(config.KB_DRAFT_MODEL, config.BEDROCK_REGION, logUsage, null)),
});

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
    const adopted = await knowledge.adoptCatalogAgentSet(email, boardId);
    if (!adopted.ok) logError('board created', `Adopting the catalog agent set failed for board ${boardId}: ${adopted.error.message}`);
  },
});
mountDeploys(app, { deploys, boards, links, awsWebhookKeys: config.AWS_WEBHOOK_KEY, log: logError });
mountReadiness(app, { boards, globs, knowledge, host: github, log: logError });
mountKnowledge(app, { knowledge, artifacts, catalog, intake, boards, host: github });
mountHealth(app, { llm: llmHealth });

// Signed agent-set downloads: the link was issued to a member through the authenticated MCP.
const agentSetValues = { SLOP_URL: config.PUBLIC_URL, COGNITO_CLAUDE_CODE_CLIENT_ID: config.CLAUDE_CODE_CLIENT_ID };
app.get('/downloads/agent-set/:board', async (c) => {
  const boardId = Number(c.req.param('board'));
  if (!links.verify(c.req.path, Number(c.req.query('expires')), c.req.query('signature') ?? '')) {
    return c.json({ error: 'This download link is invalid or has expired' }, 403);
  }
  const set = await knowledge.agentSetForDownload(boardId);
  if (!set.ok) return c.json({ error: 'No such board' }, 404);
  return c.json({
    version: set.value.version,
    files: set.value.files.map((f) => ({ path: f.path, content: renderAgentSetFile(f.content, agentSetValues) })),
  });
});
mountMcp(app, {
  auth,
  boards,
  globs,
  deploys,
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

// Catalog agent files reach boards through layering; a changed catalog gives each board a new agent-set version.
try {
  const { bumped, failed } = await knowledge.syncCatalogAgentSet();
  if (bumped.length > 0) console.log(`[agent set] catalog changed: new agent-set version for boards ${bumped.join(', ')}`);
  for (const { boardId, error } of failed) {
    logError('agent set sync', `board ${boardId}: ${error instanceof Error ? error.message : String(error)}`);
  }
} catch (error) {
  logError('agent set sync', error instanceof Error ? (error.stack ?? error.message) : String(error));
}

outbox.start();
const runWatch = new RunWatch(store, globs, logError);
runWatch.start();
const deployWatch = new DeployWatch(deploys, logError);
deployWatch.start();
const kbPipelineJob = new KbPipelineJob(kbPipeline, logError);
kbPipelineJob.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  runWatch.stop();
  deployWatch.stop();
  kbPipelineJob.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
