import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ArtifactService, BoardService, SearchIndexer, SearchService, ChatService, CodeReviewService, DeployService, EnvironmentService, TestRunService, DecisionPipeline, DecisionService, InboxPipeline, InboxService, IntegrationTokenService, FindingsPipeline, FindingsService, EffectCheckService, GlobService, INTEGRATION_NAMES, integrationSource, IntakeService, KbConsolidation, KbPipeline, KnowledgeService, readMergePolicy, LearningJobService, MiningService, NotificationService, ReportService, SubLimitService, IntakeLearningService } from '@slop/core';
import type { IntegrationId, Llm } from '@slop/core';
import { Auth } from './auth.js';
import { FsCatalog, renderAgentSetFile } from './catalog.js';
import { JOBS, loadConfig, type Job } from './config.js';
import * as schema from './db/schema.js';
import { connect, PgStore, runMigrations } from './db/store.js';
import { createApp } from './http/app.js';
import { mountKnowledge } from './http/knowledge.js';
import { OutboxRunner } from './jobs/outbox.js';
import { mountMcp } from './mcp/server.js';
import { readyGate } from './ready-gate.js';
import { GitHub } from './github/client.js';
import { AppCredentialsStore } from './github/credentials.js';
import { githubDeliveryHandler } from './github/events.js';
import { HostBranchFiles } from './branch-files.js';
import { codeHostExecutors } from './codehost-executors.js';
import { mountGitHubSetup } from './github/setup.js';
import { mountGitHubWebhooks } from './github/webhooks.js';
import { CodeBuildDeployer, Deployers } from './deployer.js';
import { deployCallbackUrl, deployExecutors } from './deploy-executors.js';
import { environmentExecutors } from './environment-executors.js';
import { exclusivePathExecutors } from './exclusive-path-executors.js';
import { codeReviewExecutors } from './code-review-executors.js';
import { mountArtifactUploads } from './http/artifact-upload.js';
import { mountDeploys } from './http/deploys.js';
import { mountWeb } from './http/web.js';
import { LocalFollowWatch } from './local-follow.js';
import { mountReadiness } from './http/readiness.js';
import { ReadinessWatch } from './readiness-watch.js';
import { HintHub } from './notifier.js';
import { BedrockLlm, shownModelId } from './llm.js';
import { BedrockEmbedder } from './embedder.js';
import { CodeHostChanges } from './code-host-changes.js';
import { marksBoardDirty, SearchSync } from './jobs/search-sync.js';
import { LlmHealth } from './llm-health.js';
import { mountHealth } from './http/health.js';
import { mountCodeReviews } from './http/code-reviews.js';
import { mountChat } from './http/chat.js';
import { mountSearch } from './http/search.js';
import { mountDecisions } from './http/decisions.js';
import { mountInbox } from './http/inbox.js';
import { mountSlack } from './http/slack.js';
import { slackApi } from './slack.js';
import { mountIntegrations } from './http/integrations.js';
import { mountNotifications } from './http/notifications.js';
import { mountReports } from './http/reports.js';
import { AwsSignIn, AwsSsoOidc, readSsoSession, ssoCacheFile } from './aws-sso.js';
import { IntegrationRegistry } from './integration-health.js';
import { TunnelWatch } from './tunnel-watch.js';
import { FileRoutines } from './routines.js';
import { SignedLinks } from './signed-links.js';
import { RunWatch } from './jobs/run-watch.js';
import { ReconcileWatch } from './jobs/reconcile.js';
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
// The board's merge policy reads which files a branch changes; `github` exists by the time this is first called.
const branchFiles = new HostBranchFiles(() => github, logError);
const globs = new GlobService({
  store,
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  ids: { runId: () => randomUUID() },
  routines,
  branchFiles,
  // Embeds a new glob's request for its intake snapshot; `embedder` exists by the time the first glob is created.
  embedder: { model: config.EMBED_MODEL, dimensions: 1024, embed: (texts, signal) => embedder.embed(texts, signal) },
});
// Set once the SSO profile is read below; the registry asks when a status changes.
let awsSignInEnabled = false;
const notifications = new NotificationService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });
// Each integration reports its health here; a change tells every open board's banner to refetch.
const integrations = new IntegrationRegistry((status) => {
  console.log(`[health] ${status.name} ${status.state}${status.reason === null ? '' : `: ${status.reason}`}`);
  hub.broadcast('board.health');
}, undefined, notifications, () => awsSignInEnabled, (message) => logError('integrations', message));
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
const environments = new EnvironmentService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });
const testRuns = new TestRunService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });
const codeReviews = new CodeReviewService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });

const outbox = new OutboxRunner(
  db,
  { globs },
  {
    ...codeHostExecutors(github, boardOf, routines, boards, undefined, integrations, notifications, async (boardId) => (await store.transaction((tx) => readMergePolicy(tx, boardId))).sizeIgnoredPaths, logError),
    ...deployExecutors(
      deploys,
      new Deployers({ codebuild: new CodeBuildDeployer() }),
      boardOf,
      deployCallbackUrl(links, config.WEBHOOK_BASE_URL ?? config.PUBLIC_URL),
      logError,
    ),
    ...environmentExecutors(environments, github, () => github.configured, boardOf, logError),
    ...exclusivePathExecutors(store, branchFiles, boardOf),
    // Runs only once the outbox starts, after `knowledge` below exists.
    ...codeReviewExecutors(github, boardOf, (boardId) => knowledge.hasReviewGuide(boardId)),
  },
  logError,
);

const catalog = new FsCatalog(config.CATALOG_DIR);
const clock = { now: () => new Date().toISOString() };
// Mining measures the board's signals: the weekly job, and the signal an admin picks to watch when approving.
const mining = new MiningService({ store, notifier: hub });
const knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub, signals: mining });
const findings = new FindingsService({ store, clock, notifier: hub });
const logUsage = (u: { model: string; input: number; output: number }) =>
  console.log(`[llm] ${u.model} in=${String(u.input)} out=${String(u.output)}`);
// Credential and access failures mark a model down (logged once per change); the worst model's state
// goes to the integration registry, whose banner shows it on every board (the waiting KB cards get
// their own board.kb hints).
const llmHealth: LlmHealth = new LlmHealth((model, h) => {
  console.log(h.state === 'down' ? `[llm] ${model} unavailable: ${h.reason}. ${h.fix}` : `[llm] ${model} ${h.state}`);
  const worst = llmHealth.state();
  if (worst.state === 'down') integrations.report('bedrock', { state: 'down', reason: worst.reason, fix: worst.fix });
  else if (worst.state === 'ok') integrations.report('bedrock', { state: 'ok' });
}, undefined, (model, throttled) => {
  // Throttling slows KB drafting down but pauses nothing, so it is a warning on every board, cleared by the next success.
  const source = `bedrock-throttling:${model}`;
  const done = throttled
    ? notifications.raise({
        boardId: null,
        source,
        severity: 'warning',
        title: `Bedrock is throttling ${shownModelId(model)}`,
        detail: 'KB drafting and other AI work are slowed down: busy calls wait and retry without failing.',
      })
    : notifications.clear(null, source);
  done.catch((error: unknown) => logError('llm-health', error instanceof Error ? error.message : String(error)));
});
// Each tracked model's LLM, so a finished AWS sign-in can probe the ones that were down.
const probes = new Map<string, Llm>();
const trackLlm = (llm: Llm, model: string): Llm => {
  const tracked = llmHealth.track(llm, model);
  probes.set(model, tracked);
  return tracked;
};
// Opus 5.5 takes no sampling parameters other than the defaults. Routing, dedupe and weekly consolidation share it.
const kbRouteLlm = trackLlm(
  new BedrockLlm({ id: config.KB_ROUTE_MODEL, configKey: 'KB_ROUTE_MODEL' }, config.BEDROCK_REGION, logUsage, null),
  config.KB_ROUTE_MODEL,
);
const kbPipeline = new KbPipeline({
  store,
  clock,
  catalog,
  notifier: hub,
  route: kbRouteLlm,
  draft: trackLlm(
    new BedrockLlm({ id: config.KB_DRAFT_MODEL, configKey: 'KB_DRAFT_MODEL' }, config.BEDROCK_REGION, logUsage, null),
    config.KB_DRAFT_MODEL,
  ),
});

// Haiku: splitting and classifying review findings, and checking bug reports for the learned sub limit.
const findingsLlm = trackLlm(
  new BedrockLlm({ id: config.FINDINGS_MODEL, configKey: 'FINDINGS_MODEL' }, config.BEDROCK_REGION, logUsage),
  config.FINDINGS_MODEL,
);
const findingsPipeline = new FindingsPipeline({ store, clock, notifier: hub, llm: findingsLlm });

// The search index (spec, Knowledge and context): derived from the board's own material, so it syncs by content hash
// (the start-up run is the backfill). Titan embeds chunks; Haiku writes each merged change's "why". Both wait while
// unavailable, and chunks stay keyword-searchable meanwhile.
const embedder = llmHealth.trackEmbedder(
  new BedrockEmbedder({ id: config.EMBED_MODEL, configKey: 'EMBED_MODEL' }, config.BEDROCK_REGION),
  config.EMBED_MODEL,
);
const intake = new IntakeService({
  store,
  llm: trackLlm(
    new BedrockLlm({ id: config.INTAKE_MODEL, configKey: 'INTAKE_MODEL' }, config.BEDROCK_REGION, logUsage),
    config.INTAKE_MODEL,
  ),
  // Intake shows the nearest past globs (corrected first); without the embedder it works as before.
  embedder,
  model: config.INTAKE_MODEL,
});
// Haiku, for the index's change summaries and for decisions.
const searchLlm = trackLlm(
  new BedrockLlm({ id: config.SEARCH_MODEL, configKey: 'SEARCH_MODEL' }, config.BEDROCK_REGION, logUsage),
  config.SEARCH_MODEL,
);
const searchIndexer = new SearchIndexer({
  store,
  clock,
  embedder,
  changes: new CodeHostChanges(github, logError),
  llm: searchLlm,
});
const search = new SearchService({ store, clock, embedder });
// Sonnet answers board chat questions (one call per question); it takes no sampling parameters.
const chat = new ChatService({
  store,
  clock,
  search,
  // Haiku rewrites the question for search, so typos and follow-ups still find their records.
  rewriteLlm: searchLlm,
  warn: (message) => console.warn(`[chat] ${message}`),
  llm: trackLlm(new BedrockLlm({ id: config.CHAT_MODEL, configKey: 'CHAT_MODEL' }, config.BEDROCK_REGION, logUsage, null), config.CHAT_MODEL),
});
const artifacts = new ArtifactService({ store, clock, notifier: hub, related: (tx, glob) => search.related(tx, glob) });
const searchSync = new SearchSync(searchIndexer, logError);
// Decisions (spec, Decisions and supersession): extracted from the board's plans and records with the search model,
// checked against earlier decisions for a replacement; the people on the board confirm or undo a replacement.
const decisionPipeline = new DecisionPipeline({
  store,
  clock,
  notifier: hub,
  embedder,
  llm: searchLlm,
});
const decisionSync = new SearchSync(decisionPipeline, logError, Date.now, 'decisions');
const decisions = new DecisionService({ store, clock, notifier: hub });
// The board inbox: `add` stores and indexes a paste at once; the pipeline then summarises it and suggests globs (Haiku).
const inbox = new InboxService({ store, clock, notifier: hub });
// The Meet notes Apps Script (and later integrations) deliver with a per-board token: only its hash is stored.
const integrationTokens = new IntegrationTokenService({
  store,
  clock,
  newSecret: () => `slopit_${randomBytes(32).toString('base64url')}`,
  hashSecret: (secret) => createHash('sha256').update(secret).digest('hex'),
});
const reports = new ReportService({ store, clock, timeZone: config.SLOP_WORK_TIME_ZONE });
const inboxPipeline = new InboxPipeline({ store, clock, notifier: hub, embedder, llm: searchLlm });
// A change to a board's material marks it for the next sync.
hub.tap((hint) => {
  if (marksBoardDirty(hint)) {
    searchSync.mark(hint.boardId);
    decisionSync.mark(hint.boardId);
  }
});

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
// Hourly: intake snapshots are embedded or rebuilt for older globs, and merged globs' outcomes recorded and refreshed at 14 days.
const intakeLearning = new IntakeLearningService({ store, clock, embedder });
const learningJobs = new LearningJobService({
  store,
  clock,
  notifier: hub,
  mining,
  effectChecks: new EffectCheckService({ store, notifier: hub, mining }),
  consolidation: new KbConsolidation({ store, clock, notifier: hub, llm: kbRouteLlm }),
  consolidationDown: () => llmHealth.isDown([config.KB_ROUTE_MODEL]),
  subLimit,
  intakeLearning,
  manifests: new CodeHostManifests(github, logError),
  log: logError,
});

if (config.AUTH_MODE === 'cognito' && (config.SIGNING_SECRET ?? '') === '') {
  console.warn('[auth] SIGNING_SECRET is not set: sign-ins and download links in flight fail across restarts and instances');
}

const app = createApp({
  auth,
  readyGate: readyGate(github, globs, boards),
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
mountDeploys(app, { deploys, environments, testRuns, boards, links, awsWebhookKeys: config.AWS_WEBHOOK_KEY, log: logError });
mountReadiness(app, { boards, globs, store, host: github, notifications, log: logError });
mountKnowledge(app, { knowledge, artifacts, findings, catalog, intake, boards, host: github, jobs: learningJobs, subLimit, intakeLearning, logError });
// The in-app AWS sign-in exists only where the server runs on an SSO profile (local development); production uses its IAM role.
const ssoSession = await readSsoSession(process.env.AWS_PROFILE);
const awsSignIn =
  ssoSession === null
    ? null
    : new AwsSignIn({
        session: ssoSession,
        oidc: new AwsSsoOidc(),
        cacheFile: ssoCacheFile(ssoSession),
        // A cheap call per down model: success marks it ok (clearing the banner), and the paused pipelines resume on their next tick.
        onSignedIn: async () => {
          await Promise.allSettled(
            [...probes].filter(([model]) => llmHealth.isDown([model])).map(([, llm]) => llm.complete({ system: 'Reply with ok.', prompt: 'ok', maxTokens: 5 })),
          );
        },
      });
awsSignInEnabled = awsSignIn !== null;
// The registry starts empty: drop notifications a previous run left, so a problem fixed while the server was down doesn't linger.
for (const id of Object.keys(INTEGRATION_NAMES) as IntegrationId[]) await notifications.clear(null, integrationSource(id));
await notifications.clear(null, 'integration:local'); // the retired fake integration of local follow
mountHealth(app, { llm: llmHealth, boards, integrations, signIn: awsSignIn });
mountCodeReviews(app, { codeReviews });
mountSearch(app, { search });
mountChat(app, { chat });
mountDecisions(app, { decisions });
mountInbox(app, { inbox });
if (config.SLACK_SIGNING_SECRET !== undefined && config.SLACK_BOT_TOKEN !== undefined) {
  mountSlack(app, {
    signingSecret: config.SLACK_SIGNING_SECRET,
    workspaces: config.SLACK_WORKSPACES,
    api: slackApi(config.SLACK_BOT_TOKEN, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })),
    inbox,
    publicUrl: config.PUBLIC_URL,
    logError: (message) => { logError('slack', message); },
  });
}
mountIntegrations(app, { inbox, tokens: integrationTokens });
mountNotifications(app, { notifications });
mountReports(app, { reports });

// Signed agent-set downloads: the link was issued to a member through the authenticated MCP.
const agentSetValues = { SLOP_URL: config.PUBLIC_URL, COGNITO_CLAUDE_CODE_CLIENT_ID: config.CLAUDE_CODE_CLIENT_ID };
app.get('/downloads/agent-set/:board', async (c) => {
  const boardId = Number(c.req.param('board'));
  if (!links.verify(c.req.path, Number(c.req.query('expires')), c.req.query('signature') ?? '')) {
    return c.json({ error: 'This download link is invalid or has expired' }, 403);
  }
  const set = await knowledge.agentSetForDownload(boardId);
  if (!set.ok) return c.json({ error: 'No such board' }, 404);
  if (set.value.localRunProblem !== null) logError('local-run', `Board ${String(boardId)}: ${set.value.localRunProblem}`);
  return c.json({
    version: set.value.version,
    files: set.value.files.map((f) => ({ path: f.path, content: renderAgentSetFile(f.content, agentSetValues) })),
    // Beside the set, outside its version: sstor init writes it to .sstor/local-run.json (null removes that).
    localRun: set.value.localRun,
    ...(set.value.localRunProblem === null ? {} : { localRunProblem: set.value.localRunProblem }),
  });
});
mountArtifactUploads(app, { artifacts, globs, links });
mountMcp(app, {
  auth,
  readyGate: readyGate(github, globs, boards),
  boards,
  globs,
  deploys,
  outbox,
  knowledge,
  artifacts,
  search,
  chat,
  intake,
  inbox,
  publicUrl: config.PUBLIC_URL,
  agentSetValues,
  links,
  reports,
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
  handle: githubDeliveryHandler({ db, globs, findings, codeReviews, github, boardOf }),
});

app.onError((error, c) => {
  logError(`http ${c.req.method} ${c.req.path}`, error.stack ?? error.message);
  return c.json({ code: 'internal', message: 'Something went wrong' }, 500);
});

if (config.WEB_DIST !== undefined) mountWeb(app, config.WEB_DIST);

const runs = (job: Job): boolean => config.SLOP_JOBS.has(job);
if (config.SLOP_JOBS.size < JOBS.length) {
  console.log(`[jobs] starting only: ${[...config.SLOP_JOBS].join(', ') || 'none'} (SLOP_JOBS)`);
}

// Catalog agent files reach boards through layering; a changed catalog gives each board a new agent-set version.
if (runs('catalog')) {
  try {
    const { bumped, failed } = await knowledge.syncCatalogAgentSet();
    if (bumped.length > 0) console.log(`[agent set] catalog changed: new agent-set version for boards ${bumped.join(', ')}`);
    for (const { boardId, error } of failed) {
      logError('agent set sync', `board ${boardId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    logError('agent set sync', error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

if (runs('outbox')) outbox.start();
const runWatch = new RunWatch(store, globs, logError);
if (runs('runs')) runWatch.start();
const deployWatch = new DeployWatch(deploys, logError);
if (runs('deploys')) deployWatch.start();
// The pipeline pauses on its own models only: intake's model says nothing about them.
const kbModels = [config.KB_ROUTE_MODEL, config.KB_DRAFT_MODEL];
// One-off on start: items that failed only because Bedrock was busy (before that stopped spending attempts) go back to their stage.
void kbPipeline
  .requeueBusyFailed()
  .then((count) => count > 0 && console.log(`[kb-pipeline] requeued ${String(count)} item(s) that failed while Bedrock was busy`))
  .catch((error: unknown) => logError('kb-pipeline', error instanceof Error ? error.message : String(error)));
const kbPipelineJob = new KbPipelineJob(kbPipeline, logError, { isDown: () => llmHealth.isDown(kbModels) });
if (runs('kb')) kbPipelineJob.start();
// Findings pause on the findings model only, like the KB pipeline on its own.
const findingsJob = new KbPipelineJob(findingsPipeline, logError, { isDown: () => llmHealth.isDown([config.FINDINGS_MODEL]) }, Date.now, 'findings');
if (runs('findings')) findingsJob.start();
// The index pauses on its own two models, like the other pipelines.
const searchJob = new KbPipelineJob(searchIndexer, logError, { isDown: () => llmHealth.isDown([config.EMBED_MODEL, config.SEARCH_MODEL]) }, Date.now, 'search');
if (runs('search')) {
  searchSync.start();
  searchJob.start();
}
// Decisions pause on the search model alone (the embedder only adds candidates, and its failure is ignored).
const decisionJob = new KbPipelineJob(decisionPipeline, logError, { isDown: () => llmHealth.isDown([config.SEARCH_MODEL]) }, Date.now, 'decisions');
if (runs('decisions')) {
  decisionSync.start();
  decisionJob.start();
}
// The inbox waits on the search model alone (the embedder only adds suggestion candidates, and its failure is ignored).
const inboxJob = new KbPipelineJob(inboxPipeline, logError, { isDown: () => llmHealth.isDown([config.SEARCH_MODEL]) }, Date.now, 'inbox');
if (runs('inbox')) inboxJob.start();
const learningJobsRunner = new LearningJobs(learningJobs, logError);
if (runs('learning')) learningJobsRunner.start();
const tunnelWatch = config.SLOP_TUNNEL_DOMAIN === undefined ? null : new TunnelWatch(config.SLOP_TUNNEL_DOMAIN, integrations);
if (runs('tunnel')) tunnelWatch?.start();
const followWatch =
  config.SLOP_FOLLOW_FILE === undefined
    ? null
    : new LocalFollowWatch(config.SLOP_FOLLOW_FILE, config.SLOP_FOLLOW_ENVIRONMENT, notifications, (d) => environments.recordDeploy(d), logError);
if (runs('follow')) followWatch?.start();
const readinessWatch = new ReadinessWatch(store, { globs, store, host: github, log: logError }, notifications, logError);
if (runs('readiness')) readinessWatch.start();
const reconcileWatch = new ReconcileWatch(store, globs, logError);
// After the outbox starts, so the queued re-reads run.
if (runs('reconcile')) reconcileWatch.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  outbox.stop();
  runWatch.stop();
  reconcileWatch.stop();
  deployWatch.stop();
  kbPipelineJob.stop();
  findingsJob.stop();
  searchSync.stop();
  searchJob.stop();
  decisionSync.stop();
  decisionJob.stop();
  inboxJob.stop();
  learningJobsRunner.stop();
  tunnelWatch?.stop();
  followWatch?.stop();
  readinessWatch.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
