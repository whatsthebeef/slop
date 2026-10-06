import { BoardService, DeployService, GlobService } from '@slop/core';
import type { Board, Effect, Glob } from '@slop/core';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { deployCallbackUrl, deployExecutors } from '../src/deploy-executors.js';
import type { Deployer, DeployJob } from '../src/deployer.js';
import type { Env } from '../src/http/app.js';
import { callbackPath, mountDeploys } from '../src/http/deploys.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const KEY = 'test-aws-key';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  summary: '',
  type: 'super',
  category: 'feature',
  group: null,
  environment: 'dev1',
  status: 'in_progress',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'draft', headSha: `${id}-head` },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  signedOffAt: null,
  doingSince: '2026-10-05T12:00:00.000Z',
});

/** Records the jobs it was given; fails when told to. */
class FakeDeployer implements Deployer {
  jobs: DeployJob[] = [];
  failWith: string | null = null;
  start(job: DeployJob) {
    if (this.failWith !== null) return Promise.reject(new Error(this.failWith));
    this.jobs.push(job);
    return Promise.resolve({ providerRef: `arn:aws:codebuild:build/${job.deploy.id}`, url: null });
  }
}

describe('deploy results and executors', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let deploys: DeployService;
  let globs: GlobService;
  let board: Board;
  let app: Hono<Env>;
  let links: SignedLinks;
  let deployer: FakeDeployer;
  let n = 0;
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  const logged: string[] = [];

  /** Runs the outbox effects the deploy service queued, as the outbox would. */
  const drain = async () => {
    const executors = deployExecutors(
      deploys,
      deployer,
      (id) => store.transaction((tx) => tx.getBoard(id)),
      (d) => `https://slop.example${callbackPath(d.id)}`,
      (_task, message) => logged.push(message),
    );
    const rows = await store.transaction(async (tx) => {
      const pending = await tx.listDeploys(board.id, { states: ['running'] });
      return pending.filter((d) => d.startedAt === null);
    });
    for (const d of rows) {
      const effect: Effect = { kind: 'start_deploy', deployId: d.id, globId: d.globId };
      const g = await store.transaction((tx) => tx.getGlob(d.globId));
      await executors.start_deploy?.(effect, g, { globs });
    }
  };

  beforeAll(async () => {
    const test = await createTestDatabase('deploy_routes');
    drop = test.drop;
    store = new PgStore(test.database.db);
    deploys = new DeployService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date((clock += 1000)).toISOString() },
      newDeployId: () => `dep-${++n}`,
    });
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date(clock).toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(false) },
    });
    links = new SignedLinks('test-secret');
    app = new Hono<Env>();
    // Stands in for the app's sign-in middleware: the caller's email comes from a test header.
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? DEV);
      await next();
    });
    mountDeploys(app, {
      deploys,
      boards: new BoardService({ store, notifier: { publish: () => undefined } }),
      links,
      awsWebhookKeys: ['other-stack-key', KEY],
      log: () => undefined,
    });
    board = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const inserted = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'dev1', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      const withDeploy: Board = {
        ...inserted,
        deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: 'sandbox-deploy', projects: {} },
        version: inserted.version + 1,
      };
      await tx.updateBoard(withDeploy, inserted.version);
      for (const id of ['s9f1', 's9f2']) await tx.insertGlob(glob(id, inserted.id), null);
      await tx.upsertMember({ boardId: inserted.id, email: DEV, role: 'dev' });
      return withDeploy;
    });
  });

  beforeEach(() => {
    deployer = new FakeDeployer();
  });

  afterAll(async () => {
    await drop();
  });

  const callback = (deployId: string, body: unknown, signature?: string) => {
    const path = callbackPath(deployId);
    const signed = links.sign(path, 60);
    return app.request(`${path}?expires=${String(signed.expires)}&sig=${signature ?? signed.signature}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  };

  const codeBuildEvent = (buildId: string, status: string, key = KEY) =>
    app.request('/webhooks/aws', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slop-key': key },
      body: JSON.stringify({
        source: 'aws.codebuild',
        'detail-type': 'CodeBuild Build State Change',
        detail: { 'build-status': status, 'build-id': buildId, 'project-name': 'sandbox-deploy' },
      }),
    });

  it('starts a deploy at the pushed commit and finishes it from the CodeBuild event', async () => {
    await deploys.requestFromPush('s9f1', 'a1');
    await drain();
    expect(deployer.jobs.map((j) => [j.deploy.sha, j.deploy.environment, j.branch])).toEqual([['a1', 'dev1', 's9f1']]);
    expect(deployer.jobs[0]?.callbackUrl).toBe('https://slop.example/webhooks/deploy/dep-1');

    expect((await codeBuildEvent('arn:aws:codebuild:build/dep-1', 'IN_PROGRESS')).status).toBe(202);
    expect((await deploys.get('dep-1'))?.state).toBe('running');
    expect((await codeBuildEvent('arn:aws:codebuild:build/dep-1', 'SUCCEEDED', 'wrong')).status).toBe(401);
    expect((await codeBuildEvent('arn:aws:codebuild:build/dep-1', 'SUCCEEDED')).status).toBe(202);
    expect((await deploys.get('dep-1'))?.state).toBe('succeeded');
    // A build slop didn't start is ignored.
    expect((await codeBuildEvent('arn:aws:codebuild:build/pr-check', 'FAILED')).status).toBe(202);
  });

  it('takes the signed callback and refuses a forged one', async () => {
    await deploys.requestFromPush('s9f2', 'b1');
    await drain();
    expect((await callback('dep-2', { status: 'failed', message: 'migrations failed' }, 'forged')).status).toBe(401);
    expect((await callback('dep-2', { status: 'nope' })).status).toBe(400);
    expect((await callback('dep-2', { status: 'failed', message: 'migrations failed' })).status).toBe(202);
    expect(await deploys.get('dep-2')).toMatchObject({ state: 'failed', error: 'migrations failed' });
  });

  it('records a deploy that cannot start as failed, so the queue moves on', async () => {
    deployer.failWith = 'AccessDenied';
    await deploys.requestFromPush('s9f1', 'a2');
    await drain();
    expect(await deploys.get('dep-3')).toMatchObject({ state: 'failed', error: "Couldn't start the deploy: AccessDenied" });
    expect(logged.some((m) => m.includes('AccessDenied'))).toBe(true);
  });
  it("records CodeBuild's reason from the failed phase", async () => {
    await deploys.requestFromPush('s9f2', 'b0');
    await drain();
    const id = `dep-${String(n)}`;
    const response = await app.request('/webhooks/aws', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slop-key': KEY },
      body: JSON.stringify({
        source: 'aws.codebuild',
        'detail-type': 'CodeBuild Build State Change',
        detail: {
          'build-status': 'FAILED',
          'build-id': `arn:aws:codebuild:build/${id}`,
          'additional-information': {
            phases: [
              { 'phase-type': 'SUBMITTED', 'phase-status': 'SUCCEEDED' },
              {
                'phase-type': 'DOWNLOAD_SOURCE',
                'phase-status': 'CLIENT_ERROR',
                'phase-context': ['CLIENT_ERROR: Connection slop-sandbox is not available'],
              },
            ],
          },
        },
      }),
    });
    expect(response.status).toBe(202);
    expect((await deploys.get(id))?.error).toBe(
      'CodeBuild failed in DOWNLOAD_SOURCE: CLIENT_ERROR: Connection slop-sandbox is not available',
    );
  });

  it('shows deploy state and history to board members only', async () => {
    const asStranger = { headers: { 'x-test-email': 'stranger@example.com' } };
    expect((await app.request(`/api/boards/${String(board.id)}/deploys?globs=s9f1`)).status).toBe(200);
    expect((await app.request(`/api/boards/${String(board.id)}/deploys?globs=s9f1`, asStranger)).status).toBe(403);
    expect((await app.request('/api/globs/s9f1/deploys')).status).toBe(200);
    expect((await app.request('/api/globs/s9f1/deploys', asStranger)).status).toBe(403);
    expect((await app.request('/api/globs/s9f1/deploy-now', { method: 'POST', ...asStranger })).status).toBe(403);
  });

  it('refuses expired callbacks and callbacks signed for another deploy', async () => {
    const send = (id: string, path: string, ttl: number) => {
      const signed = links.sign(path, ttl);
      return app.request(`${callbackPath(id)}?expires=${String(signed.expires)}&sig=${signed.signature}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'succeeded' }),
      });
    };
    expect((await send('dep-1', callbackPath('dep-1'), -10)).status).toBe(401);
    expect((await send('dep-2', callbackPath('dep-1'), 60)).status).toBe(401);
  });

  it('turns /webhooks/aws off without a key', async () => {
    const bare = new Hono<Env>();
    mountDeploys(bare, {
      deploys,
      boards: new BoardService({ store, notifier: { publish: () => undefined } }),
      links,
      awsWebhookKeys: [],
      log: () => undefined,
    });
    const response = await bare.request('/webhooks/aws', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slop-key': '' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it("doesn't start a queued deploy whose environment stopped taking branch deploys", async () => {
    await deploys.requestFromPush('s9f1', 'a9');
    const id = `dep-${String(n)}`;
    await store.transaction(async (tx) => {
      const current = await tx.getBoard(board.id);
      if (current === null) throw new Error('no board');
      await tx.updateBoard(
        { ...current, environments: [{ name: 'dev1', allowBranchDeploy: false }], version: current.version + 1 },
        current.version,
      );
    });
    await drain();
    expect(await deploys.get(id)).toMatchObject({ state: 'failed', error: "Not started: dev1 doesn't take branch deploys" });
  });

  it('gives every start of a deploy the same callback URL, which verifies', async () => {
    const stored = await deploys.get('dep-1');
    if (stored === null) throw new Error('expected dep-1');
    // Requested now, so the link hasn't expired whenever the test runs.
    const d = { ...stored, requestedAt: new Date().toISOString() };
    const url = deployCallbackUrl(links, 'https://slop.example');
    expect(url(d)).toBe(url(d));
    const parsed = new URL(url(d));
    expect(links.verify(parsed.pathname, Number(parsed.searchParams.get('expires')), parsed.searchParams.get('sig') ?? '')).toBe(true);
  });
});
