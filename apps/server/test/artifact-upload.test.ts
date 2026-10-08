import { ArtifactService, GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { MAX_UPLOAD_BYTES, mountArtifactUploads } from '../src/http/artifact-upload.js';
import type { Env } from '../src/http/app.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const ORIGIN = 'http://localhost';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('artifact upload URLs', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let artifacts: ArtifactService;
  let app: Hono<Env>;
  let dev: Client;
  let outsider: Client;
  let globId: string;

  const connect = async (deps: McpDeps, email: string) => {
    const server = buildServer(deps, email, ORIGIN);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };

  beforeAll(async () => {
    const test = await createTestDatabase('artifact_upload');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const base = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    const globs = new GlobService({
      ...base,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(false) },
    });
    artifacts = new ArtifactService(base);
    const links = new SignedLinks('test-secret');
    const boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: OUTSIDER, name: 'Out', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Sub',
        summary: 'x',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    app = new Hono<Env>();
    mountArtifactUploads(app, { artifacts, globs, links });
    const deps = { artifacts, globs, links } as unknown as McpDeps;
    dev = await connect(deps, DEV);
    outsider = await connect(deps, OUTSIDER);
  });

  afterAll(async () => {
    await dev.close();
    await outsider.close();
    await drop();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const issue = async (client: Client, extra: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: 'artifact_upload_url',
      arguments: { id: globId, kind: 'local_review', ...extra },
    });
    const [first] = result.content as { text: string }[];
    return {
      isError: result.isError === true,
      body: JSON.parse(first?.text ?? 'null') as { url: string },
    };
  };
  const post = (url: string, body: BodyInit) =>
    app.request(url.slice(ORIGIN.length), { method: 'POST', body });
  const latest = async () => {
    const all = unwrap(await artifacts.list(DEV, globId)).filter((a) => a.kind === 'local_review');
    return all.at(-1);
  };

  it('stores the uploaded bytes exactly, with the fields and provenance the URL was issued with', async () => {
    const text = `# Review\n${'é≠x'.repeat(20_000)}\n`;
    const stats = { riskTier: 'high', reviewRounds: 2, maxReviewRounds: 3, testFailRounds: 1 };
    const { body } = await issue(dev, {
      commitSha: 'abc123',
      agentSetVersion: 4,
      reviewStats: stats,
    });
    const res = await post(body.url, text);
    expect(res.status).toBe(200);
    const stored = await latest();
    expect(stored?.content).toBe(text);
    expect(stored?.commitSha).toBe('abc123');
    expect(stored?.provenance).toMatchObject({
      actor: DEV,
      by: 'sessionator',
      agentSetVersion: 4,
      reviewStats: stats,
    });
  });

  it('is single use', async () => {
    const { body } = await issue(dev);
    expect((await post(body.url, 'first')).status).toBe(200);
    expect((await post(body.url, 'second')).status).toBe(403);
    expect((await latest())?.content).toBe('first');
  });

  it('expires after a few minutes', async () => {
    const { body } = await issue(dev);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await post(body.url, 'late')).status).toBe(403);
  });

  it('rejects a tampered link', async () => {
    const { body } = await issue(dev);
    const [path, query] = body.url.slice(ORIGIN.length).split('?');
    const payload = path?.split('/').at(-1) ?? '';
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        email: OUTSIDER,
      }),
    ).toString('base64url');
    const res = await app.request(`/uploads/artifact/${forged}?${query ?? ''}`, {
      method: 'POST',
      body: 'x',
    });
    expect(res.status).toBe(403);
  });

  it("refuses to issue a link to someone who is not on the glob's board", async () => {
    const { isError } = await issue(outsider);
    expect(isError).toBe(true);
  });

  it('refuses an upload over the size limit and an empty one, and does not spend the link on a refusal before storing', async () => {
    const { body } = await issue(dev);
    expect((await post(body.url, 'x'.repeat(MAX_UPLOAD_BYTES + 1))).status).toBe(413);
    expect((await post(body.url, '  \n')).status).toBe(400);
    expect((await post(body.url, new Uint8Array([0xff, 0xfe]))).status).toBe(400);
    expect((await post(body.url, 'fine')).status).toBe(200);
  });
});
