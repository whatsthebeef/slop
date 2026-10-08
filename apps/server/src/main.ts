import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ArtifactService, BoardService, DeployService, EnvironmentService, FindingsPipeline, FindingsService, EffectCheckService, GlobService, IntakeService, KbConsolidation, KbPipeline, KnowledgeService, LearningJobService, MiningService, SubLimitService } from '@slop/core';
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
import { environmentExecutors } from './environment-executors.js';
import { mountDeploys } from './http/deploys.js';
import { mountWeb } from './http/web.js';
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
import { LearningJobs } from './jobs/learning-jobs.js';
import { CodeHostManifests } from './jobs/manifests.js';
import { CodeHostSubDiffs } from './jobs/sub-diffs.js';

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
const environments = new EnvironmentService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });

const outbox = new OutboxRunner(
  db,
  { globs },
  {
    ...codeHostExecutors(github, boardOf, routines, boards),
    ...deployExecutors(
      deploys,
      new Deployers({ codebuild: new CodeBuildDeployer() }),
      boardOf,
      deployCallbackUrl(links, config.WEBHOOK_BASE_URL ?? config.PUBLIC_URL),
      logError,
    ),
    ...environmentExecutors(environments, github, () => github.configured, boardOf, logError),
  },
  logError,
);

const catalog = new FsCatalog(config.CATALOG_DIR);
const clock = { now: () => new Date().toISOString() };
// Mining measures the board's signals: the weekly job, and the signal an admin picks to watch when approving.
const mining = new MiningService({ store, notifier: hub });
const knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub, signals: mining });
const artifacts = new ArtifactService({ store, clock, notifier: hub });
const findings = new FindingsService({ store, clock, notifier: hub });
const logUsage = (u: { model: string; input: number; output: number }) =>
  console.log(`[llm] ${u.model} in=${String(u.input)} out=${String(u.output)}`);
// Credential and access failures mark a model down (logged once per change); no hint yet, since no
// page shows the AI status (the waiting KB cards get their own board.kb hints).
const llmHealth = new LlmHealth((model, h) => {
  console.log(h.state === 'down' ? `[llm] ${model} unavailable: ${h.reason}. ${h.fix}` : `[llm] ${model} ${h.state}`);
});
const intake = new IntakeService({
  store,
  llm: llmHealth.track(
    new BedrockLlm({ id: config.INTAKE_MODEL, configKey: 'INTAKE_MODEL' }, config.BEDROCK_REGION, logUsage),
    config.INTAKE_MODEL,
  ),
});
// Opus 5.5 takes no sampling parameters other than the defaults. Routing, dedupe and weekly consolidation share it.
const kbRouteLlm = llmHealth.track(
  new BedrockLlm({ id: config.KB_ROUTE_MODEL, configKey: 'KB_ROUTE_MODEL' }, config.BEDROCK_REGION, logUsage, null),
  config.KB_ROUTE_MODEL,
);
const kbPipeline = new KbPipeline({
  store,
  clock,
  catalog,
  notifier: hub,
  route: kbRouteLlm,
  draft: llmHealth.track(
    new BedrockLlm({ id: config.KB_DRAFT_MODEL, configKey: 'KB_DRAFT_MODEL' }, config.BEDROCK_REGION, logUsage, null),
    config.KB_DRAFT_MODEL,
  ),
});

// Haiku: splitting and classifying review findings, and checking bug reports for the learned sub limit.
const findingsLlm = llmHealth.track(
  new BedrockLlm({ id: config.FINDINGS_MODEL, configKey: 'FINDINGS_MODEL' }, config.BEDROCK_REGION, logUsage),
  config.FINDINGS_MODEL,
);
const findingsPipeline = new FindingsPipeline({ store, clock, notifier: hub, llm: findingsLlm });

// Weekly mining: signals from the board's own activity become mined KB items for the KB pipeline. Weekly
// consolidation then merges same-fact open items (verified quotes) and flags stale ones; it waits while its model is down.
// Daily effect checks compare each approved change's signal before and after it. Hourly, the sub size limit learns
// from merged subs' outcomes.
const subLimit = new SubLimitService({
  store,
  notifier: hub,
  llm: findingsLlm,
  findingsDown: () => llmHealth.isDown([config.FINDINGS_MODEL]),
  diffs: new CodeHostSubDiffs(github, logError),
});
const learningJobs = new LearningJobService({
  store,
  clock,
  notifier: hub,
  mining,
  effectChecks: new EffectCheckService({ store, notifier: hub, mining }),
  consolidation: new KbConsolidation({ store, clock, notifier: hub, llm: kbRouteLlm }),
  consolidationDown: () => llmHealth.isDown([config.KB_ROUTE_MODEL]),
  subLimit,
  manifests: new CodeHostManifests(github, logError),
  log: logError,
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
mountDeploys(app, { deploys, environments, boards, links, awsWebhookKeys: config.AWS_WEBHOOK_KEY, log: logError });
mountReadiness(app, { boards, globs, knowledge, host: github, log: logError });
mountKnowledge(app, { knowledge, artifacts, findings, catalog, intake, boards, host: github, jobs: learningJobs, subLimit, logError });
mountHealth(app, { llm: llmHealth, boards });

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
  handle: githubDeliveryHandler({ db, globs, findings, github, boardOf }),
});

app.onError((error, c) => {
  logError(`http ${c.req.method} ${c.req.path}`, error.stack ?? error.message);
  return c.json({ code: 'internal', message: 'Something went wrong' }, 500);
});

if (config.WEB_DIST !== undefined) mountWeb(app, config.WEB_DIST);

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
// The pipeline pauses on its own models only: intake's model says nothing about them.
const kbModels = [config.KB_ROUTE_MODEL, config.KB_DRAFT_MODEL];
const kbPipelineJob = new KbPipelineJob(kbPipeline, logError, { isDown: () => llmHealth.isDown(kbModels) });
kbPipelineJob.start();
// Findings pause on the findings model only, like the KB pipeline on its own.
const findingsJob = new KbPipelineJob(findingsPipeline, logError, { isDown: () => llmHealth.isDown([config.FINDINGS_MODEL]) }, Date.now, 'findings');
findingsJob.start();
const learningJobsRunner = new LearningJobs(learningJobs, logError);
learningJobsRunner.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  runWatch.stop();
  deployWatch.stop();
  kbPipelineJob.stop();
  findingsJob.stop();
  learningJobsRunner.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
