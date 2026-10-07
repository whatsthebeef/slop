import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
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
import { mountWeb } from './http/web.js';
import { mountReadiness } from './http/readiness.js';
import { HintHub } from './notifier.js';
import { BedrockLlm } from './llm.js';
import { LlmHealth } from './llm-health.js';
import { mountHealth } from './http/health.js';
import { mountAwsSignIn } from './http/aws-sign-in.js';
import { AwsSignIn, sdkSsoOidc } from './aws-sso-signin.js';
import { isLocalUrl, readSsoProfile } from './aws-sso.js';
import { IntegrationRegistry } from './integration-health.js';
import { TunnelWatch } from './tunnel-health.js';
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
// Each change of an integration's health reaches every board (they all show the banner).
const integrations = new IntegrationRegistry(() => {
  void store
    .transaction((tx) => tx.listAllBoards())
    .then((all) => {
      for (const board of all) hub.publish({ kind: 'board.health', boardId: board.id });
    })
    .catch((error: unknown) => logError('health hint', error instanceof Error ? error.message : String(error)));
});
// In-app AWS sign-in exists only on a server on this machine whose AWS_PROFILE is an SSO profile.
const awsConfigText = (() => {
  try {
    return readFileSync(process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'), 'utf8');
  } catch {
    return '';
  }
})();
const ssoProfile = isLocalUrl(config.PUBLIC_URL) ? readSsoProfile(process.env, awsConfigText) : null;
const githubCredentials = new AppCredentialsStore(config.GITHUB_APP_FILE);
await githubCredentials.load();
const github = new GitHub(githubCredentials, integrations);
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
    ...codeHostExecutors(github, boardOf, routines, boards, undefined, integrations),
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
// Credential and access failures mark a model down (logged once per change) and feed the board's
// integration banner (the waiting KB cards also get their own board.kb hints).
const llmHealth = new LlmHealth((model, h) => {
  console.log(h.state === 'down' ? `[llm] ${model} unavailable: ${h.reason}. ${h.fix}` : `[llm] ${model} ${h.state}`);
  integrations.syncBedrock(llmHealth.state(), ssoProfile?.ok === true);
});
const intake = new IntakeService({
  store,
  llm: llmHealth.track(
    new BedrockLlm({ id: config.INTAKE_MODEL, configKey: 'INTAKE_MODEL' }, config.BEDROCK_REGION, logUsage),
    config.INTAKE_MODEL,
  ),
});
const kbPipeline = new KbPipeline({
  store,
  clock,
  catalog,
  notifier: hub,
  // Opus 5.5 takes no sampling parameters other than the defaults.
  route: llmHealth.track(
    new BedrockLlm({ id: config.KB_ROUTE_MODEL, configKey: 'KB_ROUTE_MODEL' }, config.BEDROCK_REGION, logUsage, null),
    config.KB_ROUTE_MODEL,
  ),
  draft: llmHealth.track(
    new BedrockLlm({ id: config.KB_DRAFT_MODEL, configKey: 'KB_DRAFT_MODEL' }, config.BEDROCK_REGION, logUsage, null),
    config.KB_DRAFT_MODEL,
  ),
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
mountHealth(app, { llm: llmHealth, boards, integrations, awsSignInAvailable: ssoProfile?.ok === true });
const awsSignIn =
  ssoProfile?.ok === true
    ? new AwsSignIn({
        oidc: sdkSsoOidc(ssoProfile.value.region),
        profile: ssoProfile.value,
        home: homedir(),
        // The new token is read on the next call; check Bedrock now, then let the waiting KB items go.
        onSignedIn: async () => {
          await llmHealth.probe();
          void kbPipelineJob.drain();
        },
        log: (message) => console.log(`[aws] ${message}`),
      })
    : null;
if (awsSignIn !== null) mountAwsSignIn(app, { boards, signIn: awsSignIn });

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
// Locally the SSO token can lapse while nothing calls Bedrock, so ask once a minute (3 one-token calls).
let bedrockWatch: NodeJS.Timeout | null = null;
if (ssoProfile?.ok === true) {
  void llmHealth.probe();
  bedrockWatch = setInterval(() => void llmHealth.probe(), 60_000);
}
const tunnelWatch =
  config.SLOP_TUNNEL_DOMAIN !== undefined && isLocalUrl(config.PUBLIC_URL)
    ? new TunnelWatch(config.SLOP_TUNNEL_DOMAIN, integrations)
    : null;
tunnelWatch?.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  runWatch.stop();
  deployWatch.stop();
  kbPipelineJob.stop();
  if (bedrockWatch !== null) clearInterval(bedrockWatch);
  tunnelWatch?.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
