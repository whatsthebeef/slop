import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { serve } from '@hono/node-server';
import { ArtifactService, AttachmentService, InvestigationService, BoardService, SearchIndexer, SearchService, ChatService, ChatFeedbackService, CHAT_EXTRA_STEPS, DeployService, TestRunService, DecisionPipeline, DecisionService, InboxPipeline, InboxService, IntegrationTokenService, AtfRunnerService, FindingsPipeline, FindingsService, EffectCheckService, GlobService, INTEGRATION_NAMES, integrationSource, IntakeService, GroupBackfillService, GroupService, KbConsolidation, KbPipeline, KnowledgeService, AgentSetCommitService, machine, readMergePolicy, LearningJobService, MiningService, NotificationService, ReportService, RiskAreaService, SubLimitService, IntakeLearningService, SizeCheckService, DependencyInferenceService, RelationScanService, RelationCheckService, ContextTuningService, ContextReportService, DependencyLearningService, RelationLearningService, CodeViewService, EscalationLearningService, HotspotDecisions, HotspotService, ReviewInputService, DEFAULT_REVIEW_BOARD_SETTINGS, resolveReviewSettings, SpendService, KnowledgePageService, ReviewFeedbackService, sizeIgnoredPathsOf, TypeLearningService, DecisionGlobService, SuggestService, RolloutService, rolloutPathsOf, kbJobHint, suggestJobHint } from '@slop/core';
import type { IntegrationId, Llm } from '@slop/core';
import { Auth } from './auth.js';
import { FsCatalog, renderAgentSetFile } from './catalog.js';
import { JOBS, loadConfig, type Job } from './config.js';
import { loadHelpCorpus } from './help-corpus.js';
import * as schema from './db/schema.js';
import { connect, PgStore, runMigrations } from './db/store.js';
import { createApp } from './http/app.js';
import { mountKnowledge } from './http/knowledge.js';
import { OutboxRunner } from './jobs/outbox.js';
import { requestMetrics } from './request-metrics.js';
import { eq, sql } from 'drizzle-orm';
import { AttachmentEventsJob } from './jobs/attachment-events.js';
import { mountAttachments } from './http/attachments.js';
import { mountSkillZip } from './http/skill-zip.js';
import { S3ObjectStore } from './s3-object-store.js';
import { SqsObjectEventQueue } from './sqs-object-events.js';
import { kbExecutors } from './kb-executors.js';
import { knowledgePageExecutors } from './knowledge-page-executors.js';
import { suggestExecutors } from './suggest-executors.js';
import { relationScanExecutors } from './relation-scan-executors.js';
import { relationCheckExecutors } from './relation-check-executors.js';
import { agentSetExecutors, readCommittedAgentSetVersion } from './agent-set-executors.js';
import { mountMcp } from './mcp/server.js';
import { mergeGate, readyGate } from './ready-gate.js';
import { GitHub } from './github/client.js';
import { AppCredentialsStore, fileSlot } from './github/credentials.js';
import { githubDeliveryHandler } from './github/events.js';
import { ReviewFeedbackPoller } from './review-feedback-poller.js';
import { HostBranchFiles } from './branch-files.js';
import { codeHostExecutors, queueBaseBranchRefreshes } from './codehost-executors.js';
import { mountGitHubSetup } from './github/setup.js';
import { mountGitHubWebhooks } from './github/webhooks.js';
import { createRunnerAuthenticator } from './atf-auth.js';
import { AwsCognitoClients, cognitoRunnerCredentials, createCognitoRunnerVerifier } from './atf-cognito.js';
import { createOidcRunnerVerifier } from './atf-oidc.js';
import { atfExecutors } from './atf-executors.js';
import { WebhookSecrets, atfWebhookExecutors, dnsResolver, httpsTransport, runnerWebhooks } from './atf-webhooks.js';
import { CodeBuildAtfStarter } from './atf-starter.js';
import { CodeBuildDeployer, Deployers } from './deployer.js';
import { deployCallbackUrl, deployExecutors } from './deploy-executors.js';
import { exclusivePathExecutors } from './exclusive-path-executors.js';
import { rolloutExecutors } from './rollout-executors.js';
import { questionExecutors } from './question-executors.js';
import { CapabilityReader, CapabilityWatch } from './capabilities.js';
import { reviewExecutors } from './review-executors.js';
import { makeRunReview } from './review-runner.js';
import { mountArtifactUploads } from './http/artifact-upload.js';
import { mountAtfResults } from './http/atf-results.js';
import { mountAtfRunners } from './http/atf-runners.js';
import { mountAtfSpecs } from './http/atf-specs.js';
import { mountDeploys } from './http/deploys.js';
import { mountWeb } from './http/web.js';
import { LocalFollowWatch } from './local-follow.js';
import { mountReadiness } from './http/readiness.js';
import { ReadinessWatch } from './readiness-watch.js';
import { HintHub } from './notifier.js';
import { BedrockLlm, reviewerLlm, shownModelId, spendRecorder } from './llm.js';
import { BedrockEmbedder } from './embedder.js';
import { CodeHostChanges } from './code-host-changes.js';
import { marksBoardDirty, SearchSync } from './jobs/search-sync.js';
import { LlmHealth } from './llm-health.js';
import { mountHealth } from './http/health.js';
import { mountChat } from './http/chat.js';
import { mountChatFeedback } from './http/chat-feedback.js';
import { mountSearch } from './http/search.js';
import { mountCode } from './http/code.js';
import { CodeClones, DEFAULT_CAP_BYTES } from './code-clones.js';
import { CodeIndex } from './code-index.js';
import { CodeIndexer } from './code-indexer.js';
import { GitCodeView } from './code-view.js';
import { mountDecisions } from './http/decisions.js';
import { mountDecisionGlobs } from './http/decision-globs.js';
import { mountInbox } from './http/inbox.js';
import { mountSlack } from './http/slack.js';
import { slackApi } from './slack.js';
import { mountIntegrations } from './http/integrations.js';
import { mountNotifications } from './http/notifications.js';
import { mountReports } from './http/reports.js';
import { AwsSignIn, AwsSsoOidc, readSsoSession, ssoCacheFile } from './aws-sso.js';
import { IntegrationRegistry } from './integration-health.js';
import { TunnelWatch } from './tunnel-watch.js';
import { FileRoutines, SecretRoutines } from './routines.js';
import { AwsSecretStore, secretNames, storeSlot, withSecrets } from './secrets.js';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SignedLinks } from './signed-links.js';
import { RunWatch } from './jobs/run-watch.js';
import { StallWatch } from './jobs/stall-watch.js';
import { ReconcileWatch } from './jobs/reconcile.js';
import { DeployWatch } from './jobs/deploy-watch.js';
import { KbPipelineJob } from './jobs/kb-pipeline.js';
import { LearningJobs } from './jobs/learning-jobs.js';
import { CodeHostManifests } from './jobs/manifests.js';
import { CodeHostSubDiffs } from './jobs/sub-diffs.js';

const baseConfig = loadConfig();
// With SECRETS=aws the sensitive settings come from Secrets Manager through the instance role; a missing one stops the start.
const secretStore = baseConfig.SECRETS === 'aws' ? new AwsSecretStore(new SecretsManagerClient({ region: baseConfig.SECRETS_REGION })) : null;
const config = secretStore === null ? baseConfig : await withSecrets(baseConfig, secretStore);
await runMigrations(config.DATABASE_URL, config.MIGRATIONS_DIR);
const database = connect(config.DATABASE_URL);
const { db } = database;

const logError = (task: string, message: string) => {
  console.error(`[${task}] ${message}`);
  void db.insert(schema.errors).values({ task, message }).catch(() => undefined);
};

const store = new PgStore(db);
const routines =
  secretStore === null
    ? new FileRoutines(config.ROUTINES_FILE)
    : new SecretRoutines(secretStore, secretNames(config.SECRETS_PREFIX).routinesPrefix, config.SECRETS_CACHE_SECONDS * 1000);
const hub = new HintHub();
const auth = new Auth(db, config);
const atfPolicy = { projects: config.ATF_PUSH_ALLOWED_PROJECTS, roleAccounts: config.ATF_PUSH_ALLOWED_ROLE_ACCOUNTS };
// How readily slop creates gating relations per source, learned from overrides, dismissals and collisions (weak links below a precision threshold).
const relationLearning = new RelationLearningService({ store, notifier: hub, clock: { now: () => new Date().toISOString() }, ids: { runId: () => randomUUID() },
  // Red-main blame uses the post-merge check's test: does the culprit's diff use what the other glob added? `relationCheck` is built below.
  uses: (a, b): Promise<boolean> => relationCheck.uses(a, b),
  log: logError,
});
const boards = new BoardService({ store, notifier: hub, atfPolicy, serverAdmins: config.SLOP_SERVER_ADMINS, onBaseRed: (boardId) => relationLearning.onBaseRed(boardId) });
// The board's merge policy reads which files a branch changes; `github` exists by the time this is first called.
const branchFiles = new HostBranchFiles(() => github, logError);
const catalog = new FsCatalog(config.CATALOG_DIR);
// Which dependency edges are real on each board: predicts shared files (internal) from learned weights, learns relations from failed runs.
const dependencyLearning = new DependencyLearningService({ store, notifier: hub, clock: { now: () => new Date().toISOString() }, ids: { runId: () => randomUUID() }, catalog, relationLearning, log: logError });
// File attachments live in a private bucket; without one configured the feature (routes and job) is off.
const attachmentObjects = config.ATTACHMENTS_BUCKET === undefined ? null : new S3ObjectStore(new S3Client({ region: config.ATTACHMENTS_REGION }), config.ATTACHMENTS_BUCKET);
const globs = new GlobService({
  store,
  dependencyLearning,
  relationLearning,
  log: (task, message) => logError(task, message),
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  ids: { runId: () => randomUUID() },
  routines,
  branchFiles,
  // Embeds a new glob's request for its intake snapshot; `embedder` exists by the time the first glob is created.
  embedder: { model: config.EMBED_MODEL, dimensions: 1024, embed: (texts, signal) => embedder.embed(texts, signal) },
  // Judges a new glob's size; `sizeCheck` exists by the time the first glob is created.
  sizeCheck: { assess: (boardId, plan, title): ReturnType<SizeCheckService['assess']> => sizeCheck.assess(boardId, plan, title), refresh: (globId) => sizeCheck.refresh(globId) },
  // Infers a new glob's relations (needs and decisions) from its plan; `dependencyInference` exists by the time the first glob is created.
  inference: { infer: (input) => dependencyInference.infer(input) },
  // Reads an action's script on the base branch; `codeView` exists by the time the first action is read.
  codeView: { read: (boardId, ref, path, range) => codeView.read(boardId, ref, path, range) },
  // The automatic relation pass (`relationScan` is built below): a changed text that names a glob queues a pass; `classifyAtCreate` and `remember` are the create-time path.
  relationScan: {
    request: (input: Parameters<RelationScanService['request']>[0]): Promise<void> => relationScan.request(input),
    classifyAtCreate: (input: Parameters<RelationScanService['classifyAtCreate']>[0]): ReturnType<RelationScanService['classifyAtCreate']> => relationScan.classifyAtCreate(input),
    remember: (globId: string, boardId: number, decided: Parameters<RelationScanService['remember']>[2]): Promise<void> => relationScan.remember(globId, boardId, decided),
  },
});
// Set once the SSO profile is read below; the registry asks when a status changes.
let awsSignInEnabled = false;
const notifications = new NotificationService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });
// Each integration reports its health here; a change tells every open board's banner to refetch.
const integrations = new IntegrationRegistry((status) => {
  console.log(`[health] ${status.name} ${status.state}${status.reason === null ? '' : `: ${status.reason}`}`);
  hub.broadcast('board.health');
}, undefined, notifications, () => awsSignInEnabled, (message) => logError('integrations', message));
const githubCredentials = new AppCredentialsStore(secretStore === null ? fileSlot(config.GITHUB_APP_FILE) : storeSlot(secretStore, secretNames(config.SECRETS_PREFIX).githubApp));
await githubCredentials.load();
const github = new GitHub(githubCredentials, integrations);
const boardOf = (id: number) => store.transaction((tx) => tx.getBoard(id));
// Signs agent-set download links, the board sign-in state and deploy callbacks.
const links = new SignedLinks(config.SIGNING_SECRET);
// Deploy-live webhooks seal each runner's signing secret under a key derived from SIGNING_SECRET: without it (local development) they are off.
const webhookSecrets = (config.SIGNING_SECRET ?? '') === '' ? null : new WebhookSecrets(config.SIGNING_SECRET ?? '');
const deploys = new DeployService({
  store,
  notifier: hub,
  clock: { now: () => new Date().toISOString() },
  newDeployId: () => `dep_${randomUUID()}`,
});
const testRuns = new TestRunService({ store, notifier: hub, clock: { now: () => new Date().toISOString() } });

// One executor table; each runner drains only its own lane (`laneOf(kind)`).
const outboxExecutors: ConstructorParameters<typeof OutboxRunner>[2] = {
    ...codeHostExecutors(github, boardOf, routines, boards, undefined, integrations, notifications, async (boardId) => (await store.transaction((tx) => readMergePolicy(tx, boardId))).sizeIgnoredPaths, logError, attachmentObjects, attachmentObjects === null ? null : (globId) => attachments?.pendingFor(globId) ?? Promise.resolve(0), async (boardId) => (await store.transaction((tx) => readMergePolicy(tx, boardId))).subGateCheck, (boardId) => store.transaction((tx) => readMergePolicy(tx, boardId))),
    ...deployExecutors(
      deploys,
      new Deployers({ codebuild: new CodeBuildDeployer() }),
      boardOf,
      deployCallbackUrl(links, config.WEBHOOK_BASE_URL ?? config.PUBLIC_URL),
      logError,
    ),
    ...atfExecutors({ testRuns, starter: new CodeBuildAtfStarter(atfPolicy), boardOf, log: logError }),
    ...(webhookSecrets === null
      ? {}
      : atfWebhookExecutors({ store, secrets: webhookSecrets, resolve: dnsResolver, transport: httpsTransport(), clock: { now: () => new Date().toISOString() }, log: logError })),
    ...exclusivePathExecutors(store, branchFiles, boardOf),
    // Plan changed during a run: raises the merge question.
    ...questionExecutors({ raisePlanChanged: (id, version) => globs.raisePlanChanged(id, version) }),
    // `rolloutService` is built below and only called once a job runs.
    ...rolloutExecutors(
      new CodeHostChanges(github, logError),
      boardOf,
      async (boardId) => (await store.transaction((tx) => readMergePolicy(tx, boardId))).rolloutPaths,
      logError,
      { run: (globId, sha) => rolloutService.run(globId, sha) },
    ),
    // The independent reviewer: `artifacts`, `trackLlm` and the config exist by the time the first job runs.
    ...reviewExecutors(github, boardOf, (glob, resolved) =>
      makeRunReview({
        host: github,
        inputs: new ReviewInputService({ store }),
        artifacts,
        boardOf,
        log: (message) => logError('review', message),
        // The board's settings over the server's default model and the merge policy's ignored paths.
        settings: async (boardId) =>
          resolveReviewSettings((await boardOf(boardId))?.review ?? DEFAULT_REVIEW_BOARD_SETTINGS, {
            defaultModel: config.REVIEW_MODEL,
            mergePolicyIgnoredPaths: sizeIgnoredPathsOf(await store.transaction((tx) => readMergePolicy(tx, boardId))),
          }),
        spend,
        // Per review (the model is a board setting); health tracking marks the model down on credential failures like the others.
        llmFor: (model, onUsage) =>
          trackLlm(
            reviewerLlm(model, config.BEDROCK_REGION, (u) => {
              logUsage(u);
              onUsage(u);
            }),
            model,
          ),
      })(glob, resolved),
      async (boardId) => (await boardOf(boardId))?.review.enabled !== false,
    ),
  // The KB pipeline's routing and drafting (the `llm` lane); `kbPipeline` and the health tracker are built below and
  // only called once a job runs. The pipeline pauses on its own models only: intake's model says nothing about them.
  ...kbExecutors({ runStep: (itemId, step) => kbPipeline.runStep(itemId, step) }, { isDown: () => llmHealth.isDown(kbModels) }),
  // The knowledge page's regeneration (the `llm` lane); `knowledgePage` is built below and only called once a job runs.
  ...knowledgePageExecutors({ regenerate: (boardId, full) => knowledgePage.regenerate(boardId, full) }),
  // Suggest on a decision glob (the `llm` lane); `suggestService` is built below and only called once a job runs.
  ...suggestExecutors({ run: (globId) => suggestService.run(globId) }),
  // The automatic relation pass (the `llm` lane); `relationScan` is built below and only called once a job runs.
  ...relationScanExecutors({ run: (globId) => relationScan.run(globId) }),
  // The post-merge relation check (the `llm` lane); `relationCheck` is built below and only called once a job runs.
  ...relationCheckExecutors({ run: (globId) => relationCheck.run(globId) }),
  // The agent set's commit to its glob's branch; `agentSetCommit` is built below and only called once a job runs.
  ...agentSetExecutors({ prepare: (boardId) => agentSetCommit.prepare(boardId) }, github, (id) => store.transaction((tx) => tx.getGlob(id)), (id) =>
    globs.applyEvent(id, (g, ctx) => machine.readyRequested(g, null, ctx)),
  ),
};
// `default` carries every effect but the slow model calls, which go in `llm` so they never hold up the others.
// `decisionGlobs` is built below, after the knowledge service it needs; it is only called once an effect runs.
const outboxDeps: ConstructorParameters<typeof OutboxRunner>[1] = { globs, decisions: { linkedMerged: (mergedId, boardId) => decisionGlobs.linkedMerged(mergedId, boardId) } };
const outbox = new OutboxRunner(db, outboxDeps, outboxExecutors, logError, 'default');
// A KB job that failed, will retry, or waits for a new reason refreshes the board's Knowledge page; a finished one
// already did (the pipeline publishes when it writes), and a dropped one changed nothing.
const llmOutbox = new OutboxRunner(db, outboxDeps, outboxExecutors, logError, 'llm', (effect, state) => {
  const hint = state === 'done' || state === 'dropped' ? null : (kbJobHint(effect) ?? suggestJobHint(effect));
  if (hint !== null) hub.publish(hint);
});

const clock = { now: () => new Date().toISOString() };
const spend = new SpendService({ store, clock });
const reviewFeedback = new ReviewFeedbackService({ store });
// Mining measures the board's signals: the weekly job, and the signal an admin picks to watch when approving.
const mining = new MiningService({ store, notifier: hub });
const knowledge = new KnowledgeService({ store, clock, catalog, notifier: hub, signals: mining });
const decisionGlobs = new DecisionGlobService({ store, clock, notifier: hub, knowledge, globs });
const agentSetCommit = new AgentSetCommitService({ store, clock, notifier: hub, knowledge, repo: { committedVersion: (board) => readCommittedAgentSetVersion(github, board) } });
const findings = new FindingsService({ store, clock, notifier: hub });
const logUsage = (u: { model: string; input: number; output: number }) =>
  console.log(`[llm] ${u.model} in=${String(u.input)} out=${String(u.output)}`);
// Every board-scoped call is tagged with its board and source (core sets `spend` on the request): one ledger row each.
// Untagged calls (reviews and the knowledge page record their own rows; the sign-in probe has no board) are only logged.
const recordUsage = spendRecorder(spend, (message) => logError('llm spend', message));
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
  new BedrockLlm({ id: config.KB_ROUTE_MODEL, configKey: 'KB_ROUTE_MODEL' }, config.BEDROCK_REGION, recordUsage, null),
  config.KB_ROUTE_MODEL,
);
const kbModels = [config.KB_ROUTE_MODEL, config.KB_DRAFT_MODEL];
const kbDraftLlm = trackLlm(
  new BedrockLlm({ id: config.KB_DRAFT_MODEL, configKey: 'KB_DRAFT_MODEL' }, config.BEDROCK_REGION, recordUsage, null),
  config.KB_DRAFT_MODEL,
);
const kbPipeline = new KbPipeline({
  store,
  clock,
  catalog,
  notifier: hub,
  route: kbRouteLlm,
  draft: kbDraftLlm,
});
// The knowledge page's decisions section is written by Haiku (KNOWLEDGE_PAGE_MODEL): a short rewrite over the board's
// decisions, at most daily by default. Its own jobs only ask it about what changed.
const knowledgePageLlm = trackLlm(
  new BedrockLlm({ id: config.KNOWLEDGE_PAGE_MODEL, configKey: 'KNOWLEDGE_PAGE_MODEL' }, config.BEDROCK_REGION, logUsage),
  config.KNOWLEDGE_PAGE_MODEL,
);
const knowledgePage = new KnowledgePageService({ store, clock, notifier: hub, llm: knowledgePageLlm, model: config.KNOWLEDGE_PAGE_MODEL, spend, knowledge });

// Suggest (Sonnet, SUGGEST_MODEL): an admin's on-demand recommendation for a decision glob; the call is tagged for the spend ledger.
const suggestLlm = trackLlm(
  new BedrockLlm({ id: config.SUGGEST_MODEL, configKey: 'SUGGEST_MODEL' }, config.BEDROCK_REGION, recordUsage, null),
  config.SUGGEST_MODEL,
);

// Haiku: splitting and classifying review findings, and checking bug reports for the learned sub limit.
const findingsLlm = trackLlm(
  new BedrockLlm({ id: config.FINDINGS_MODEL, configKey: 'FINDINGS_MODEL' }, config.BEDROCK_REGION, recordUsage),
  config.FINDINGS_MODEL,
);
const findingsPipeline = new FindingsPipeline({ store, clock, notifier: hub, llm: findingsLlm });
// Rollout steps (Haiku, tagged `rollout` in the spend ledger): a merge that touches the rollout paths gets its steps written, or "No rollout needed", by the machine.
const rolloutService = new RolloutService({
  store,
  clock,
  globs,
  changes: new CodeHostChanges(github, logError),
  llm: findingsLlm,
  model: config.FINDINGS_MODEL,
  rolloutPathsOf: async (board) => rolloutPathsOf({ rolloutPaths: (await store.transaction((tx) => readMergePolicy(tx, board.id))).rolloutPaths }),
});

// The search index (spec, Knowledge and context): derived from the board's own material, so it syncs by content hash
// (the start-up run is the backfill). Titan embeds chunks; Haiku writes each merged change's "why". Both wait while
// unavailable, and chunks stay keyword-searchable meanwhile.
const embedder = llmHealth.trackEmbedder(
  new BedrockEmbedder({ id: config.EMBED_MODEL, configKey: 'EMBED_MODEL' }, config.BEDROCK_REGION),
  config.EMBED_MODEL,
);
const intakeLlm = trackLlm(
  new BedrockLlm({ id: config.INTAKE_MODEL, configKey: 'INTAKE_MODEL' }, config.BEDROCK_REGION, recordUsage),
  config.INTAKE_MODEL,
);
// The code view: a clone per board on the data disk, an index of its base branch in Postgres, one read-only port over both.
const codeClones = new CodeClones({
  dir: config.CODE_DIR,
  host: github,
  capBytes: config.CODE_CAP_MB * 1024 * 1024 || DEFAULT_CAP_BYTES,
  warn: (message) => console.warn(`[code] ${message}`),
});
const codeIndex = new CodeIndex(db);
const codeView = new GitCodeView({ clones: codeClones, index: codeIndex, board: boardOf, host: github });

// Suggest reads a hotspot file's size and merge history from the code view.
const suggestService = new SuggestService({ store, clock, notifier: hub, knowledge, llm: suggestLlm, model: config.SUGGEST_MODEL, codeView });
// The size check: the intake model judges a plan's independent parts and proposes workstreams; a failing model leaves the text estimate.
const sizeCheck = new SizeCheckService({ store, clock, notifier: hub, llm: intakeLlm, codeView, embedder, onRechecked: (id): Promise<void> => globs.reconcileSizeCheck(id) });
// Slop builds each glob's dependency tree with the intake model: at create, and again when a plan is saved or an investigation pushed.
const dependencyInference = new DependencyInferenceService({
  store,
  llm: intakeLlm,
  apply: (globId, edges, planHash): Promise<void> => globs.applyInferred(globId, edges, planHash),
  release: (globId): Promise<unknown> => globs.release(globId),
  // Bolder where inference has missed dependencies: it also proposes globs that touch the same modules.
  bold: async (boardId): Promise<boolean> => (await relationLearning.posture(boardId, 'inferred')).bold,
  log: logError,
});
// The automatic relation pass: one batched intake-model call per debounced job, written through GlobService.applyAutomatic; the call's `spend` tag is its only ledger row.
const relationScan = new RelationScanService({
  store,
  clock,
  llm: intakeLlm,
  automatic: { applyAutomatic: (globId, planHash, adds, actorEmail) => globs.applyAutomatic(globId, planHash, adds, actorEmail) },
  model: config.INTAKE_MODEL,
  log: logError,
});
// Each merged glob's relations are judged from its diff and the code index; the model (spend `relation_check`) only settles what they cannot.
const relationCheck = new RelationCheckService({
  store,
  clock,
  changes: new CodeHostChanges(github, logError),
  learning: relationLearning,
  index: { importEdges: (boardId, from, to) => codeIndex.importEdges(boardId, from, to) },
  llm: intakeLlm,
  model: config.INTAKE_MODEL,
  log: logError,
});
const intake = new IntakeService({
  store,
  llm: intakeLlm,
  // Intake shows the nearest past globs (corrected first); without the embedder it works as before.
  embedder,
  model: config.INTAKE_MODEL,
});
const groupBackfill = new GroupBackfillService({ store, globs, intake });
const groups = new GroupService({ store, globs, boards, clock });
// Haiku, for the index's change summaries and for decisions.
const searchLlm = trackLlm(
  new BedrockLlm({ id: config.SEARCH_MODEL, configKey: 'SEARCH_MODEL' }, config.BEDROCK_REGION, recordUsage),
  config.SEARCH_MODEL,
);
// Slop's own help, indexed on every board; read once here (the files ship in the image).
const helpDocs = await loadHelpCorpus({ docsDir: config.DOCS_DIR, catalogDir: config.CATALOG_DIR }, (message) => {
  console.warn(`[help] ${message}`);
});
const searchIndexer = new SearchIndexer({
  store,
  clock,
  embedder,
  changes: new CodeHostChanges(github, logError),
  llm: searchLlm,
  help: helpDocs,
});
const search = new SearchService({ store, clock, embedder });
const codeIndexer = new CodeIndexer({ store, clones: codeClones, index: codeIndex });
const code = new CodeViewService({
  boards,
  view: codeView,
  usage: codeIndex,
  warn: (message) => console.warn(`[code] ${message}`),
});
// A push to a board's base branch marks it; the sync fetches and re-indexes within the debounce (10 s), and every 15 minutes anyway.
const codeSync = new SearchSync(codeIndexer, logError, Date.now, 'code');
// Sonnet answers board chat questions (one call per question); it takes no sampling parameters.
const chat = new ChatService({
  store,
  clock,
  search,
  // Haiku rewrites the question for search, so typos and follow-ups still find their records.
  rewriteLlm: searchLlm,
  // Questions about the code go through the code view (base branch, a capped loop of calls), counted as consumer `chat`.
  code,
  // A miss tries a second search, the code and Opus before giving up, within this many extra steps.
  extraSteps: CHAT_EXTRA_STEPS,
  warn: (message) => console.warn(`[chat] ${message}`),
  llm: trackLlm(new BedrockLlm({ id: config.CHAT_MODEL, configKey: 'CHAT_MODEL' }, config.BEDROCK_REGION, recordUsage, null), config.CHAT_MODEL),
  // "Think harder" answers one question with Opus.
  deepLlm: trackLlm(new BedrockLlm({ id: config.CHAT_THINK_MODEL, configKey: 'CHAT_THINK_MODEL' }, config.BEDROCK_REGION, recordUsage, null), config.CHAT_THINK_MODEL),
  // Save to knowledge goes to the proposal queue, like an agent's learning.
  submitLearning: (email, board, learning) => knowledge.submitLearning(email, board, learning),
  // "Why isn't X working": the same health facts as /api/health (request timing and the outbox for admins only).
  opsHealth: async (admin) => {
    const llm = llmHealth.state();
    const routes = admin ? requestMetrics.summary().routes : [];
    return {
      llm: llm.state === 'down' ? llm : llm.state === 'ok' ? { state: 'ok', since: llm.since } : { state: 'unknown' },
      throttledModels: llmHealth.throttledCount(),
      integrations: integrations.list(),
      capabilities: await capabilities.read(),
      capabilityReasons: await capabilities.reasons(),
      ...(admin ? { requests: { routes, outboxBacklog: await outboxBacklog() } } : {}),
    };
  },
});
// An arriving investigation escalates a sub that needs a human and raises the oversize flag with workstreams.
const investigation = new InvestigationService({ store, clock, notifier: hub, escalate: (email, id, input) => globs.escalateToSame(email, id, input), predictRollout: (id) => globs.predictRollout(id) });
// A saved plan re-infers the glob's fix flag and work kind (a person's choice is never touched); a failure only logs, the plan save has returned.
const workInference = {
  refresh: async (globId: string): Promise<void> => {
    try {
      const glob = await store.transaction((tx) => tx.getGlob(globId));
      if (glob === null) return;
      await globs.reinferWork(globId, (input) => intake.inferWork(glob.boardId, input));
    } catch (error) {
      logError('work-inference', error instanceof Error ? error.message : String(error));
    }
  },
};
const artifacts = new ArtifactService({ store, clock, notifier: hub, related: (tx, glob) => search.related(tx, glob), sizeCheck, dependencyInference, investigation, hotspots: (board, now) => hotspots.hotspots(board, now, false), relationLearning, workInference, relationScan, rollout: (email, id, record, source) => globs.reconcileRollout(email, id, record, source) });
const attachments =
  attachmentObjects === null
    ? null
    : new AttachmentService({ store, clock, notifier: hub, objects: attachmentObjects, newId: () => randomUUID(), maxBytes: () => config.ATTACHMENT_MAX_BYTES, log: logError });
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
const riskAreas = new RiskAreaService({
  store,
  clock,
  changes: new CodeHostChanges(github, logError),
  lift: (boardId, names) => globs.liftRiskAreaEscalations(boardId, names),
});
const subLimit = new SubLimitService({
  store,
  notifier: hub,
  llm: findingsLlm,
  findingsDown: () => llmHealth.isDown([config.FINDINGS_MODEL]),
  diffs: new CodeHostSubDiffs(github, logError),
  riskAreas,
  log: logError,
});
// Hourly: intake snapshots are embedded or rebuilt for older globs, and merged globs' outcomes recorded and refreshed at 14 days.
const escalations = new EscalationLearningService({ store, clock, riskAreas, notifier: hub });
const typeLearning = new TypeLearningService({ store, clock });
const intakeLearning = new IntakeLearningService({ store, clock, embedder, riskAreas, escalations });
const contextTuning = new ContextTuningService({ store, clock, notifier: hub });
const hotspots = new HotspotService({ store, clock, codeView, decisions: new HotspotDecisions({ store, clock, notifier: hub, llm: kbDraftLlm, codeView }) });
const contextReport = new ContextReportService({ store, clock, tuning: contextTuning });
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
  sizeCheck,
  contextTuning,
  hotspots,
  manifests: new CodeHostManifests(github, logError),
  // Reactions and `/wrong` replies are read from GitHub just before mining measures them.
  beforeMining: async (board, now) => {
    await new ReviewFeedbackPoller({ store, host: github, feedback: reviewFeedback, log: (m) => logError('review feedback', m) }).collect(board, now);
  },
  log: logError,
});

if (config.AUTH_MODE === 'cognito' && (config.SIGNING_SECRET ?? '') === '') {
  console.warn('[auth] SIGNING_SECRET is not set: sign-ins and download links in flight fail across restarts and instances');
}

const app = createApp({
  auth,
  intake,
  groupBackfill,
  groups,
  decisions: decisionGlobs,
  readyGate: readyGate(github, globs, boards),
  mergeGate: mergeGate(github, globs, boards),
  links,
  boards,
  globs,
  hub,
  outbox,
  spend,
  ...(attachments === null ? {} : { attachments }),
  onBoardCreated: async (email, boardId) => {
    const adopted = await knowledge.adoptCatalogAgentSet(email, boardId);
    if (!adopted.ok) logError('board created', `Adopting the catalog agent set failed for board ${boardId}: ${adopted.error.message}`);
  },
});
if (attachments !== null) mountAttachments(app, { attachments });
mountSkillZip(app, {
  boards,
  skillsDir: config.SKILLS_DIR,
  uploadHost: config.ATTACHMENTS_BUCKET === undefined ? null : `${config.ATTACHMENTS_BUCKET}.s3.${config.ATTACHMENTS_REGION}.amazonaws.com`,
});
mountDeploys(app, { deploys, testRuns, boards, links, awsWebhookKeys: config.AWS_WEBHOOK_KEY, log: logError });
// ATF runners (spec, ATF runners): each identity method adds a verifier here; the board's integration token is the legacy way in.
// Client credentials need slop's own Cognito pool; without its settings (local development) that method can't authenticate or be issued.
const cognitoClients =
  config.AUTH_MODE === 'cognito' && config.COGNITO_USER_POOL_ID !== undefined && config.COGNITO_REGION !== undefined
    ? new AwsCognitoClients({ userPoolId: config.COGNITO_USER_POOL_ID, region: config.COGNITO_REGION })
    : null;
const atfRunners = new AtfRunnerService({
  store,
  clock,
  ...(cognitoClients === null ? {} : { issuer: cognitoRunnerCredentials(cognitoClients, `https://${config.COGNITO_DOMAIN ?? ''}/oauth2/token`) }),
  ...(webhookSecrets === null ? {} : { webhooks: runnerWebhooks(webhookSecrets) }),
  log: logError,
});
const oidcRunnerVerifier = createOidcRunnerVerifier({
  store,
  oidcIssuers: config.ATF_OIDC_ALLOWED_ISSUERS,
  awsIssuers: config.ATF_AWS_ALLOWED_ISSUERS,
  awsAccounts: config.ATF_AWS_ALLOWED_ACCOUNTS,
  audience: config.ATF_OIDC_AUDIENCE ?? config.PUBLIC_URL,
});
const atfVerifiers = [
  ...(oidcRunnerVerifier === null ? [] : [oidcRunnerVerifier]),
  ...(cognitoClients === null || config.COGNITO_USER_POOL_ID === undefined ? [] : [createCognitoRunnerVerifier({ store, userPoolId: config.COGNITO_USER_POOL_ID })]),
];
const authenticateRunner = createRunnerAuthenticator({ store, tokens: integrationTokens, verifiers: atfVerifiers, log: logError });
mountAtfSpecs(app, { testRuns, boards, authenticate: authenticateRunner, runners: atfRunners, log: logError });
mountAtfResults(app, { testRuns, runners: atfRunners, authenticate: authenticateRunner, log: logError });
mountAtfRunners(app, { runners: atfRunners });
mountReadiness(app, { boards, globs, store, host: github, notifications, log: logError });
mountKnowledge(app, { dependencyLearning, relationLearning, knowledge, artifacts, findings, catalog, intake, boards, host: github, jobs: learningJobs, subLimit, riskAreas, escalations, typeLearning, intakeLearning, sizeCheck, contextTuning, hotspots, contextReport, knowledgePage, agentSetCommit, logError });
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
// What slop can verify about itself: /api/health reports it and human steps with a `check` tick against it.
const capabilities = new CapabilityReader({
  bucket: attachmentObjects,
  attachmentQueueConfigured: config.ATTACHMENTS_QUEUE_URL !== undefined,
  slackConfigured: config.SLACK_SIGNING_SECRET !== undefined && config.SLACK_BOT_TOKEN !== undefined,
  codeIndexRuns: config.SLOP_JOBS.has('code'),
  deployResultsConfigured: config.AWS_WEBHOOK_KEY.length > 0,
  atfClients: cognitoClients,
});
const outboxBacklog = async (): Promise<Record<string, number>> => {
  const rows = await db
    .select({ lane: schema.outbox.lane, n: sql<number>`count(*)::int` })
    .from(schema.outbox)
    .where(eq(schema.outbox.state, 'pending'))
    .groupBy(schema.outbox.lane);
  return Object.fromEntries(rows.map((r) => [r.lane, r.n]));
};
mountHealth(app, {
  llm: llmHealth,
  boards,
  integrations,
  signIn: awsSignIn,
  capabilities,
  metrics: requestMetrics,
  outboxBacklog,
});
mountSearch(app, { search });
mountCode(app, { code });
mountChat(app, { chat });
mountChatFeedback(app, { feedback: new ChatFeedbackService({ store, clock }) });
mountDecisions(app, { decisions });
mountInbox(app, { inbox, decisionGlobs });
mountDecisionGlobs(app, { decisions: decisionGlobs, suggest: suggestService, globs });
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
  groups,
  suggest: suggestService,
  readyGate: readyGate(github, globs, boards),
  mergeGate: mergeGate(github, globs, boards),
  boards,
  globs,
  deploys,
  outbox,
  knowledge,
  artifacts,
  search,
  code,
  chat,
  intake,
  inbox,
  ...(attachments === null ? {} : { attachments }),
  publicUrl: config.PUBLIC_URL,
  publicUrlAliases: config.PUBLIC_URL_ALIASES,
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
  handle: githubDeliveryHandler({ db, globs, github, boardOf, feedback: reviewFeedback, onBasePush: (boardId) => {
      codeSync.mark(boardId);
      // Open actions whose script wasn't on the base branch are offered again when it is.
      void globs.baseMoved(boardId).catch((e: unknown) => logError('base push', e instanceof Error ? e.message : String(e)));
    }, subGateCheck: async (boardId) => (await store.transaction((tx) => readMergePolicy(tx, boardId))).subGateCheck }),
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
// Boards created before slop read the base branch from GitHub have a stale or empty one; one refresh each (idempotent).
if (runs('outbox')) {
  void queueBaseBranchRefreshes(store).catch((error: unknown) => logError('base branch', error instanceof Error ? error.message : String(error)));
}
/** Set once shutdown begins, so nothing started later (the `llm` runner after its self-healing pass) starts. */
let stopping = false;
// The `llm` lane has its own switch; `kb` (SLOP_SESSION_JOBS=kb) starts it too, since it carries the KB pipeline.
if (runs('llm') || runs('kb')) {
  // Self-healing: an open learning whose step has no job waiting (lost, or dropped by a bug) gets one queued.
  void kbPipeline
    .queueDueSteps()
    .then((count) => count > 0 && console.log(`[kb-pipeline] queued ${String(count)} learning step(s) that had no job`))
    .catch((error: unknown) => logError('kb-pipeline', error instanceof Error ? error.message : String(error)))
    // A shutdown that began meanwhile has already stopped the runner: it must not start again.
    .finally(() => {
      if (!stopping) llmOutbox.start();
    });
  // Backfill: merged globs still showing "Rollout steps not written" get the rollout job (it replaces the step). Idempotent: a glob
  // whose job is pending or whose rollout is written queues nothing more.
  void store
    .transaction((tx) => tx.listAllBoards())
    .then(async (all) => {
      for (const b of all) {
        const queued = await rolloutService.backfill(b.id);
        if (queued > 0) console.log(`[rollout] queued the rollout job for ${String(queued)} glob(s) on board ${String(b.id)} that had no rollout steps written`);
      }
    })
    .catch((error: unknown) => logError('rollout', error instanceof Error ? error.message : String(error)));
  // Cleanup: inferred relations that hold a glob behind a KB learning are dismissed. Idempotent.
  void store
    .transaction((tx) => tx.listAllBoards())
    .then(async (all) => {
      for (const b of all) {
        const dismissed = await dependencyInference.dismissLearningHolds(b.id);
        if (dismissed > 0) console.log(`[relations] dismissed ${String(dismissed)} inferred relation(s) to KB learnings on board ${String(b.id)}`);
      }
    })
    .catch((error: unknown) => logError('relations', error instanceof Error ? error.message : String(error)));
  // Backfill: open decision globs get a group by the rule new ones follow. Idempotent: only group-less ones are written.
  void store
    .transaction((tx) => tx.listAllBoards())
    .then(async (all) => {
      for (const b of all) {
        const written = await groupBackfill.backfillDecisionGroups(b.id);
        if (written > 0) console.log(`[groups] gave ${String(written)} open decision glob(s) on board ${String(b.id)} a group`);
      }
    })
    .catch((error: unknown) => logError('groups', error instanceof Error ? error.message : String(error)));
}
const runWatch = new RunWatch(store, globs, logError);
if (runs('runs')) runWatch.start();
const stallWatch = new StallWatch(store, globs, notifications, logError);
if (runs('runs')) stallWatch.start();
const deployWatch = new DeployWatch(deploys, logError);
if (runs('deploys')) deployWatch.start();
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
if (runs('code')) codeSync.start();
const tunnelWatch = config.SLOP_TUNNEL_DOMAIN === undefined ? null : new TunnelWatch(config.SLOP_TUNNEL_DOMAIN, integrations);
if (runs('tunnel')) tunnelWatch?.start();
const followWatch =
  config.SLOP_FOLLOW_FILE === undefined
    ? null
    : new LocalFollowWatch(config.SLOP_FOLLOW_FILE, notifications, logError);
if (runs('follow')) followWatch?.start();
// Arrivals come from the bucket's events (when a queue is set) and the sweep, which also expires links nobody used.
const attachmentEvents =
  attachments === null
    ? null
    : new AttachmentEventsJob(
        attachments,
        config.ATTACHMENTS_QUEUE_URL === undefined ? null : new SqsObjectEventQueue(new SQSClient({ region: config.ATTACHMENTS_REGION }), config.ATTACHMENTS_QUEUE_URL),
        logError,
      );
if (runs('attachments')) attachmentEvents?.start();
const capabilityWatch = new CapabilityWatch(async () => (await store.transaction((tx) => tx.listAllBoards())).map((b) => b.id), globs, capabilities, logError);
if (runs('capabilities')) capabilityWatch.start();
const readinessWatch = new ReadinessWatch(store, { globs, store, host: github, log: logError }, notifications, logError);
if (runs('readiness')) readinessWatch.start();
const reconcileWatch = new ReconcileWatch(store, globs, logError);
// After the outbox starts, so the queued re-reads run.
if (runs('reconcile')) reconcileWatch.start();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`slop listening on http://localhost:${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = () => {
  stopping = true;
  outbox.stop();
  llmOutbox.stop();
  runWatch.stop();
  stallWatch.stop();
  reconcileWatch.stop();
  deployWatch.stop();
  findingsJob.stop();
  searchSync.stop();
  codeSync.stop();
  searchJob.stop();
  decisionSync.stop();
  decisionJob.stop();
  inboxJob.stop();
  learningJobsRunner.stop();
  tunnelWatch?.stop();
  followWatch?.stop();
  readinessWatch.stop();
  attachmentEvents?.stop();
  capabilityWatch.stop();
  server.close();
  void database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
