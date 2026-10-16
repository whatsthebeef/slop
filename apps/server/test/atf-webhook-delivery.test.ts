import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AtfRunnerService,
  DeployService,
  WEBHOOK_HEADERS,
  webhookDeliveryId,
} from '@slop/core';
import type { Deploy, Effect, GlobService } from '@slop/core';
import {
  WebhookSecrets,
  atfWebhookExecutors,
  httpsTransport,
  pinTarget,
  runnerWebhooks,
  signWebhook,
} from '../src/atf-webhooks.js';
import type {
  AtfWebhookDeps,
  PinnedTarget,
  WebhookPost,
  WebhookResolver,
  WebhookTransport,
} from '../src/atf-webhooks.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountAtfRunners } from '../src/http/atf-runners.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const URL_OK = 'https://ci.example.com/hooks/slop';
const PUBLIC_IP = '93.184.216.34';
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const AT = '2026-10-05T12:00:00.000Z';
const KEY = 'signing-key-for-tests';

const run = promisify(execFile);

describe('the signing secrets', () => {
  const secrets = new WebhookSecrets(KEY);

  it('makes a distinct random secret each time', () => {
    const a = secrets.newSecret();
    expect(a).toMatch(/^whsec_[\w-]{43}$/);
    expect(secrets.newSecret()).not.toBe(a);
  });

  it('seals a secret so that only the same key opens it, and the sealed text does not contain it', () => {
    const secret = secrets.newSecret();
    const sealed = secrets.seal(secret);
    expect(sealed).not.toContain(secret);
    expect(secrets.seal(secret)).not.toBe(sealed);
    expect(secrets.open(sealed)).toBe(secret);
    expect(new WebhookSecrets('another key').open(sealed)).toBeNull();
  });

  it('refuses a sealed value that was cut, changed or is not ours', () => {
    const sealed = secrets.seal('whsec_x');
    const parts = sealed.split('.');
    expect(secrets.open(parts.slice(0, 3).join('.'))).toBeNull();
    expect(secrets.open([parts[0], parts[1], parts[2], 'AAAA'].join('.'))).toBeNull();
    expect(secrets.open('plain text')).toBeNull();
    expect(secrets.open('')).toBeNull();
  });
});

describe('resolving a webhook target once, and only to public addresses', () => {
  const resolves =
    (...addresses: string[]): WebhookResolver =>
    () =>
      Promise.resolve(addresses);

  it('pins the first public address, keeping the name, port and path for the request', async () => {
    const answer = await pinTarget(
      'https://vendor.example.org:8443/a/b?x=1',
      resolves(PUBLIC_IP, '8.8.8.8'),
    );
    expect(answer).toEqual({
      ok: true,
      target: { address: PUBLIC_IP, hostname: 'vendor.example.org', port: 8443, path: '/a/b?x=1' },
    });
    const plain = await pinTarget(URL_OK, resolves(PUBLIC_IP));
    expect(plain).toMatchObject({ ok: true, target: { port: 443, path: '/hooks/slop' } });
  });

  it('refuses a name that resolves to a private address, even among public ones (DNS rebinding)', async () => {
    for (const list of [
      ['10.0.0.5'],
      ['127.0.0.1'],
      ['169.254.169.254'],
      ['::1'],
      [PUBLIC_IP, '192.168.0.1'],
      ['192.168.0.1', PUBLIC_IP],
      ['::ffff:10.0.0.1'],
    ]) {
      const answer = await pinTarget(URL_OK, resolves(...list));
      expect(answer).toMatchObject({ ok: false, transient: false });
    }
  });

  it('looks a name up exactly once, and a literal address not at all', async () => {
    let lookups = 0;
    const counting: WebhookResolver = () => {
      lookups += 1;
      return Promise.resolve([PUBLIC_IP]);
    };
    await pinTarget(URL_OK, counting);
    expect(lookups).toBe(1);
    expect(await pinTarget('https://93.184.216.34/h', counting)).toMatchObject({
      ok: true,
      target: { address: PUBLIC_IP, hostname: PUBLIC_IP },
    });
    expect(await pinTarget('https://127.0.0.1/h', counting)).toMatchObject({ ok: false });
    expect(lookups).toBe(1);
  });

  it('treats a lookup that fails or finds nothing as transient, and a bad URL as final', async () => {
    const failing: WebhookResolver = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await pinTarget(URL_OK, failing)).toMatchObject({ ok: false, transient: true });
    expect(await pinTarget(URL_OK, resolves())).toMatchObject({ ok: false, transient: true });
    expect(await pinTarget('http://ci.example.com/h', resolves(PUBLIC_IP))).toMatchObject({
      ok: false,
      transient: false,
    });
    expect(await pinTarget('https://localhost/h', resolves(PUBLIC_IP))).toMatchObject({
      ok: false,
      transient: false,
    });
  });

  it('gives the registry a check that says why, in plain words', async () => {
    const hooks = runnerWebhooks(new WebhookSecrets(KEY), resolves('10.1.1.1'));
    expect(await hooks.checkTarget(URL_OK)).toMatch(/private or reserved/);
    expect(
      await runnerWebhooks(new WebhookSecrets(KEY), resolves(PUBLIC_IP)).checkTarget(URL_OK),
    ).toBeNull();
  });
});

describe('the HTTPS transport', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let cert: string;
  const seen: {
    headers: Record<string, string | string[] | undefined>;
    body: string;
    url: string | undefined;
  }[] = [];
  let mode: 'ok' | 'redirect' | 'flood' | 'hang' = 'ok';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slop-webhook-'));
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ]);
    cert = await readFile(join(dir, 'cert.pem'), 'utf8');
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url,
        });
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'https://127.0.0.1:1/elsewhere' }).end();
        } else if (mode === 'flood') {
          res.writeHead(200);
          const timer = setInterval(() => res.write(Buffer.alloc(32 * 1024)), 1);
          res.on('close', () => clearInterval(timer));
        } else if (mode === 'hang') {
          // never answers
        } else res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen.length = 0;
    mode = 'ok';
  });

  const target = (patch: Partial<PinnedTarget> = {}): PinnedTarget => ({
    address: '127.0.0.1',
    hostname: 'localhost',
    port,
    path: '/hook?x=1',
    ...patch,
  });
  const post: WebhookPost = {
    headers: { 'Content-Type': 'application/json', 'Slop-Event': 'deploy.live' },
    body: '{"a":1}',
  };

  it('connects to the pinned address with the name as Host and for the certificate, and sends the body', async () => {
    const answer = await httpsTransport({ ca: cert })(target(), post);
    expect(answer).toEqual({ status: 204 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(seen[0]?.url).toBe('/hook?x=1');
    expect(seen[0]?.headers['host']).toBe(`localhost:${String(port)}`);
    expect(seen[0]?.headers['slop-event']).toBe('deploy.live');
  });

  it('checks the certificate against the name, not the address it connected to', async () => {
    await expect(
      httpsTransport({ ca: cert })(target({ hostname: 'other.example.com' }), post),
    ).rejects.toThrow();
    await expect(httpsTransport()(target(), post)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('does not follow a redirect: the 302 is the answer', async () => {
    mode = 'redirect';
    expect(await httpsTransport({ ca: cert })(target(), post)).toEqual({ status: 302 });
    expect(seen).toHaveLength(1);
  });

  it('answers with the status without reading an endless body', async () => {
    mode = 'flood';
    expect(await httpsTransport({ ca: cert })(target(), post)).toEqual({ status: 200 });
  });

  it('gives up on a receiver that never answers', async () => {
    mode = 'hang';
    await expect(httpsTransport({ ca: cert, timeoutMs: 300 })(target(), post)).rejects.toThrow();
  });

  it('refuses an oversized body before connecting', async () => {
    await expect(
      httpsTransport({ ca: cert })(target(), { headers: {}, body: 'x'.repeat(70 * 1024) }),
    ).rejects.toThrow(/too large/);
    expect(seen).toEqual([]);
  });
});

/** A succeeded branch deploy of a glob's commit to staging. */
const branchDeploy = (boardId: number, id: string, sha: string, at: string, state: Deploy['state'] = 'succeeded'): Deploy => ({
  id,
  boardId,
  environment: 'staging',
  globId: 's1t1',
  sha,
  state,
  trigger: 'push',
  requestedBy: null,
  requestedAt: at,
  runningSince: at,
  startedAt: at,
  finishedAt: state === 'succeeded' ? at : null,
  providerRef: null,
  url: null,
  error: null,
});

describe('deploy-live delivery through the outbox', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let runnerId: number;
  let deployId: string;
  const secrets = new WebhookSecrets(KEY);
  let secret: string;
  const sent: { target: PinnedTarget; post: WebhookPost }[] = [];
  let answers: (number | Error)[];
  let resolveTo: string[];
  const logged: string[] = [];

  const transport: WebhookTransport = (target, post) => {
    sent.push({ target, post });
    const next = answers.shift() ?? 204;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ status: next });
  };
  const deps = (): AtfWebhookDeps => ({
    store,
    secrets,
    resolve: () => Promise.resolve(resolveTo),
    transport,
    clock: { now: () => '2026-10-05T12:00:30.000Z' },
    log: (_task, message) => logged.push(message),
  });
  const outbox = () =>
    new OutboxRunner(
      database.db,
      { globs: {} as GlobService },
      atfWebhookExecutors(deps()),
      () => undefined,
    );
  const effect = (
    patch: Partial<Extract<Effect, { kind: 'deliver_atf_webhook' }>> = {},
  ): Effect => ({
    kind: 'deliver_atf_webhook',
    globId: `board-${String(boardId)}`,
    boardId,
    runnerId,
    deployId,
    environment: 'staging',
    sha: SHA,
    deployedAt: AT,
    ...patch,
  });
  const jobs = async () =>
    (
      await database.db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'deliver_atf_webhook'))
    ).filter((j) => j.effect.kind === 'deliver_atf_webhook' && j.effect.runnerId === runnerId);
  const queue = (e: Effect) => store.transaction((tx) => tx.enqueueEffects([e]));
  /** Backoff after a failed try is seconds; make the job due again instead of waiting. */
  const due = () =>
    database.db
      .update(schema.outbox)
      .set({ runAfter: new Date(Date.now() - 1_000) })
      .where(eq(schema.outbox.kind, 'deliver_atf_webhook'));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_webhooks'));
    store = new PgStore(database.db);
  });

  afterAll(() => drop());

  beforeEach(async () => {
    sent.length = 0;
    logged.length = 0;
    answers = [];
    resolveTo = [PUBLIC_IP];
    secret = secrets.newSecret();
    await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: `demo ${String(Math.random())}`,
        repo: `acme/app${String(Math.random())}`.toLowerCase(),
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'staging', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      boardId = board.id;
      const runner = await tx.insertAtfRunner({
        boardId,
        name: 'vendor',
        method: 'oidc',
        config: {
          issuer: 'https://ci.example.com',
          claims: { sub: ['x'] },
          webhook: { url: URL_OK, secret: secrets.seal(secret) },
        },
        environments: ['staging'],
        enabled: true,
        createdBy: ADMIN,
        createdAt: AT,
      });
      runnerId = runner?.id ?? 0;
      deployId = `dep-${String(boardId)}`;
      await tx.saveDeploys([branchDeploy(boardId, deployId, SHA, AT)]);
    });
    await database.db.delete(schema.outbox).where(eq(schema.outbox.kind, 'deliver_atf_webhook'));
  });

  it('posts the signed deploy-live event to the pinned address, and the HMAC verifies with the runner’s secret', async () => {
    await queue(effect());
    await outbox().drain();
    expect(sent).toHaveLength(1);
    const { target, post } = sent[0] ?? { target: null, post: null };
    expect(target).toEqual({
      address: PUBLIC_IP,
      hostname: 'ci.example.com',
      port: 443,
      path: '/hooks/slop',
    });
    const body: unknown = JSON.parse(post?.body ?? '');
    expect(body).toMatchObject({
      event: 'deploy.live',
      id: webhookDeliveryId(runnerId, deployId),
      board: { id: boardId },
      environment: 'staging',
      sha: SHA,
      deployId,
      deployedAt: AT,
    });
    const headers = post?.headers ?? {};
    expect(headers[WEBHOOK_HEADERS.event]).toBe('deploy.live');
    expect(headers[WEBHOOK_HEADERS.delivery]).toBe(webhookDeliveryId(runnerId, deployId));
    const timestamp = headers[WEBHOOK_HEADERS.timestamp] ?? '';
    expect(Number(timestamp)).toBe(Date.parse('2026-10-05T12:00:30.000Z') / 1000);
    // What a receiver does: HMAC-SHA256 under its secret over `<timestamp>.<body>`.
    const expected = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.${post?.body ?? ''}`)
      .digest('hex')}`;
    expect(headers[WEBHOOK_HEADERS.signature]).toBe(expected);
    expect(headers[WEBHOOK_HEADERS.signature]).toBe(
      signWebhook(secret, Number(timestamp), post?.body ?? ''),
    );
    expect(
      createHmac('sha256', 'another secret')
        .update(`${timestamp}.${post?.body ?? ''}`)
        .digest('hex'),
    ).not.toBe(expected.slice(7));
    expect((await jobs()).map((j) => j.state)).toEqual(['done']);
    // Neither the secret, the signature nor the body is logged.
    expect(logged.join('\n')).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(expected.slice(7));
    expect(logged.join('\n')).not.toContain('"sha"');
  });

  it('retries a failed delivery through the outbox with the same delivery ID, and never again after it succeeded', async () => {
    answers = [503, new Error('socket hang up'), 200];
    await queue(effect());
    const runner = outbox();
    await runner.drain();
    expect(sent).toHaveLength(1);
    let [job] = await jobs();
    expect(job).toMatchObject({ state: 'pending', attempts: 1 });
    expect(job?.lastError).toMatch(/answered 503/);
    // Not due yet: the backoff holds it.
    await runner.drain();
    expect(sent).toHaveLength(1);
    await due();
    await runner.drain();
    [job] = await jobs();
    expect(job).toMatchObject({ state: 'pending', attempts: 2 });
    expect(job?.lastError).toMatch(/delivery failed/);
    await due();
    await runner.drain();
    [job] = await jobs();
    expect(job).toMatchObject({ state: 'done', attempts: 3 });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.post.headers[WEBHOOK_HEADERS.delivery])).size).toBe(1);
    // Done is final: more drains, a due job or a repeated enqueue send nothing.
    await due();
    await queue(effect());
    await runner.drain();
    await runner.drain();
    expect(sent).toHaveLength(3);
    expect(await jobs()).toHaveLength(1);
  });

  it('gives up after the outbox’s attempts and leaves the job failed, without throwing out of the drain', async () => {
    answers = Array<number>(10).fill(500);
    await queue(effect());
    const runner = outbox();
    for (let i = 0; i < 10; i += 1) {
      await runner.drain();
      await due();
    }
    const [job] = await jobs();
    expect(job?.state).toBe('failed');
    expect(sent.length).toBe(job?.attempts);
  });

  it('queues one delivery per runner and deploy however often it is asked', async () => {
    await Promise.all([queue(effect()), queue(effect())]);
    await queue(effect());
    expect(await jobs()).toHaveLength(1);
    const other = await store.transaction((tx) =>
      tx.insertAtfRunner({
        boardId,
        name: 'second',
        method: 'oidc',
        config: {},
        environments: ['staging'],
        enabled: true,
        createdBy: ADMIN,
        createdAt: AT,
      }),
    );
    await queue(effect({ runnerId: other?.id ?? 0 }));
    await queue(effect({ deployId: `${deployId}-later` }));
    expect(
      (
        await database.db
          .select()
          .from(schema.outbox)
          .where(eq(schema.outbox.kind, 'deliver_atf_webhook'))
      ).filter((j) => j.globId === `board-${String(boardId)}`),
    ).toHaveLength(3);
  });

  it('does not queue a delivery again after it was dropped, whatever state the earlier one ended in', async () => {
    await queue(effect());
    await database.db
      .update(schema.outbox)
      .set({ state: 'dropped', lastError: 'The receiver refused' })
      .where(eq(schema.outbox.kind, 'deliver_atf_webhook'));
    await queue(effect());
    expect((await jobs()).map((j) => j.state)).toEqual(['dropped']);
    for (const state of ['done', 'failed'] as const) {
      await database.db
        .update(schema.outbox)
        .set({ state })
        .where(eq(schema.outbox.kind, 'deliver_atf_webhook'));
      await queue(effect());
      expect((await jobs()).map((j) => j.state)).toEqual([state]);
    }
  });

  it('is not queued by a succeeding branch deploy (the int pipeline starts ATF)', async () => {
    const deploys = new DeployService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => AT },
      newDeployId: () => 'unused',
    });
    await store.transaction(async (tx) => {
      await tx.insertAtfRunner({
        boardId,
        name: 'no hook',
        method: 'oidc',
        config: {},
        environments: ['staging'],
        enabled: true,
        createdBy: ADMIN,
        createdAt: AT,
      });
      await tx.saveDeploys([branchDeploy(boardId, 'dep-running', SHA, '2026-10-05T12:10:00.000Z', 'running')]);
    });
    expect((await deploys.finished('dep-running', { succeeded: true, error: null })).ok).toBe(true);
    // A repeated result of the same deploy changes nothing.
    expect((await deploys.finished('dep-running', { succeeded: true, error: null })).ok).toBe(true);
    const queued = (
      await database.db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'deliver_atf_webhook'))
    ).filter((j) => j.globId === `board-${String(boardId)}`);
    expect(queued).toEqual([]);
  });

  describe.each([
    [
      'the runner is revoked',
      () =>
        store.transaction((tx) =>
          tx.updateAtfRunner(boardId, runnerId, { enabled: false, revokedAt: AT }),
        ),
    ],
    [
      'the runner is disabled',
      () => store.transaction((tx) => tx.updateAtfRunner(boardId, runnerId, { enabled: false })),
    ],
    [
      'the runner no longer serves the environment',
      () =>
        store.transaction((tx) =>
          tx.updateAtfRunner(boardId, runnerId, { environments: ['prod'] }),
        ),
    ],
    [
      'the webhook was removed',
      () =>
        store.transaction((tx) =>
          tx.updateAtfRunner(boardId, runnerId, {
            config: { issuer: 'https://ci.example.com', claims: { sub: ['x'] } },
          }),
        ),
    ],
    [
      'a newer deploy replaced the commit',
      () =>
        store.transaction((tx) =>
          tx.saveDeploys([branchDeploy(boardId, `newer-${String(boardId)}`, 'f'.repeat(40), '2026-10-05T13:00:00.000Z')]),
        ),
    ],
  ])('drops the delivery when %s', (_name, change) => {
    it('and sends nothing', async () => {
      await queue(effect());
      await change();
      await outbox().drain();
      expect(sent).toEqual([]);
      expect((await jobs()).map((j) => j.state)).toEqual(['dropped']);
    });
  });

  it('re-checks the address at delivery: a name that now resolves to a private address gets nothing', async () => {
    resolveTo = ['169.254.169.254'];
    await queue(effect());
    await outbox().drain();
    expect(sent).toEqual([]);
    expect((await jobs()).map((j) => j.state)).toEqual(['dropped']);
    expect(logged.join('\n')).toMatch(/private or reserved/);
  });

  it('retries when the host cannot be resolved right now', async () => {
    resolveTo = [];
    await queue(effect());
    await outbox().drain();
    expect(sent).toEqual([]);
    expect((await jobs()).map((j) => j.state)).toEqual(['pending']);
    resolveTo = [PUBLIC_IP];
    await due();
    await outbox().drain();
    expect((await jobs()).map((j) => j.state)).toEqual(['done']);
  });

  it('does not retry a redirect or a refusal by the receiver, and retries a 408 and a 429', async () => {
    for (const status of [301, 302, 400, 401, 403, 404, 410]) {
      await database.db.delete(schema.outbox).where(eq(schema.outbox.kind, 'deliver_atf_webhook'));
      answers = [status];
      await queue(effect());
      await outbox().drain();
      expect((await jobs()).map((j) => j.state)).toEqual(['dropped']);
    }
    for (const status of [408, 429]) {
      await database.db.delete(schema.outbox).where(eq(schema.outbox.kind, 'deliver_atf_webhook'));
      answers = [status];
      await queue(effect());
      await outbox().drain();
      expect((await jobs()).map((j) => j.state)).toEqual(['pending']);
    }
  });

  it('drops a delivery whose secret cannot be opened (the signing key changed), and says so without the secret', async () => {
    const other = new WebhookSecrets('rotated key');
    await queue(effect());
    await new OutboxRunner(
      database.db,
      { globs: {} as GlobService },
      atfWebhookExecutors({ ...deps(), secrets: other }),
      () => undefined,
    ).drain();
    expect(sent).toEqual([]);
    expect((await jobs()).map((j) => j.state)).toEqual(['dropped']);
    expect(logged.join('\n')).toMatch(/signing secret can't be opened/);
  });
});

describe('the runners routes with a webhook', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boardId: number;
  const secrets = new WebhookSecrets(KEY);
  const body = z.object({
    value: z.object({ id: z.number(), config: z.record(z.string(), z.unknown()) }),
    webhookSecret: z.string().optional(),
  });
  const send = (method: string, path: string, json?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_webhook_routes'));
    store = new PgStore(database.db);
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: ADMIN, active: true });
      const board = await tx.insertBoard({
        name: 'b',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'staging', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
    const runners = new AtfRunnerService({
      store,
      clock: { now: () => AT },
      webhooks: runnerWebhooks(secrets, () => Promise.resolve([PUBLIC_IP])),
    });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', ADMIN);
      await next();
    });
    mountAtfRunners(app, { runners });
  });

  afterAll(() => drop());

  afterEach(async () => {
    await database.db.delete(schema.atfRunners).where(eq(schema.atfRunners.boardId, boardId));
  });

  const config = { roleArns: ['arn:aws:iam::123456789012:role/x'] };

  it('shows the signing secret once on create and on turning it on, never in the list, and stores it sealed', async () => {
    const created = await send('POST', `/api/boards/${String(boardId)}/atf-runners`, {
      name: 'vendor',
      method: 'aws_iam',
      environments: ['staging'],
      config: { ...config, webhook: { url: URL_OK } },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const made = body.parse(await created.json());
    expect(made.webhookSecret).toMatch(/^whsec_/);
    expect(made.value.config['webhook']).toEqual({ url: URL_OK });

    const stored = await store.transaction((tx) => tx.getAtfRunner(boardId, made.value.id));
    const sealed = stored?.config.webhook?.secret ?? '';
    expect(sealed).not.toBe('');
    expect(secrets.open(sealed)).toBe(made.webhookSecret);

    const listed = await (await send('GET', `/api/boards/${String(boardId)}/atf-runners`)).text();
    expect(listed).not.toContain(sealed);
    expect(listed).not.toContain(made.webhookSecret ?? '?');
    expect(listed).toContain(URL_OK);

    // Off, then on again: a new secret, shown once.
    expect(
      (
        await send('PATCH', `/api/boards/${String(boardId)}/atf-runners/${String(made.value.id)}`, {
          config,
        })
      ).status,
    ).toBe(200);
    const again = await send(
      'PATCH',
      `/api/boards/${String(boardId)}/atf-runners/${String(made.value.id)}`,
      { config: { ...config, webhook: { url: URL_OK } } },
    );
    expect(again.headers.get('cache-control')).toBe('no-store');
    const second = body.parse(await again.json());
    expect(second.webhookSecret).toMatch(/^whsec_/);
    expect(second.webhookSecret).not.toBe(made.webhookSecret);
    const plain = await send(
      'PATCH',
      `/api/boards/${String(boardId)}/atf-runners/${String(made.value.id)}`,
      { enabled: false },
    );
    expect(body.parse(await plain.json()).webhookSecret).toBeUndefined();
  });

  it('refuses a secret in the request, a plain http URL and a private address, with 422', async () => {
    const make = (webhook: unknown) =>
      send('POST', `/api/boards/${String(boardId)}/atf-runners`, {
        name: 'x',
        method: 'aws_iam',
        environments: ['staging'],
        config: { ...config, webhook },
      });
    expect((await make({ url: URL_OK, secret: 'mine' })).status).toBe(422);
    expect((await make({ url: 'http://ci.example.com/x' })).status).toBe(422);
    expect((await make({ url: 'https://10.0.0.1/x' })).status).toBe(422);
    expect((await make({ url: 'https://localhost/x' })).status).toBe(422);
    expect(await store.transaction((tx) => tx.listAtfRunners(boardId))).toEqual([]);
  });
});
