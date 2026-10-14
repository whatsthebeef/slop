import { ArtifactService, GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { mountArtifactUploads } from '../src/http/artifact-upload.js';
import type { Env } from '../src/http/app.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const ORIGIN = 'http://localhost';
const GOOD =
  '| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `e2e/a.spec.ts` | runs |\n\n```atf-specs\nspecs:\n  - e2e/a.spec.ts\ngrep: "@a"\n```\n';
const BAD =
  'Just words, no block and no matrix rows.\n\n| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `e2e/a.spec.ts` | runs |\n';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('MCP test plan tools', () => {
  let drop: () => Promise<void>;
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
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { text: string }[];
    return { isError: result.isError === true, text: first?.text ?? '' };
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  const json = <T>(text: string): T => JSON.parse(text) as T;

  beforeAll(async () => {
    const test = await createTestDatabase('mcp_test_plan');
    drop = test.drop;
    const store = new PgStore(test.database.db);
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
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: 'Do it',
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

  it('has no test plan before the first save', async () => {
    const read = await call(dev, 'get_test_plan', { id: globId });
    expect(json(read.text)).toEqual({ kind: 'test_plan', current: null, versions: [] });
    expect(
      json<{ testPlan: unknown }>((await call(dev, 'get_context', { id: globId })).text).testPlan,
    ).toBeNull();
  });

  it('saves with the version read, returns the version, and refuses a stale one', async () => {
    const saved = await call(dev, 'save_test_plan', { id: globId, version: 0, content: GOOD });
    expect(json(saved.text)).toMatchObject({ version: 1 });
    expect(json<{ validation?: string }>(saved.text).validation).toBeUndefined();
    const stale = await call(dev, 'save_test_plan', { id: globId, version: 0, content: GOOD });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('version_conflict');
  });

  it('reads the plan back with its parsed specs, and in get_context in full', async () => {
    const read = json<{
      current: { version: number; provenance: { atfSpecs: unknown } };
      versions: unknown[];
    }>((await call(dev, 'get_test_plan', { id: globId })).text);
    expect(read.current.version).toBe(1);
    expect(read.current.provenance.atfSpecs).toEqual({ specs: ['e2e/a.spec.ts'], grep: '@a' });
    const context = json<{
      testPlan: { version: number; content: string; atfSpecs: unknown; validation: string | null };
      available: { kind: string }[];
    }>((await call(dev, 'get_context', { id: globId })).text);
    expect(context.testPlan).toEqual({
      version: 1,
      content: GOOD,
      atfSpecs: { specs: ['e2e/a.spec.ts'], grep: '@a' },
      validation: null,
    });
    expect(context.available.map((a) => a.kind)).not.toContain('test_plan');
  });

  it('stores put_artifact(kind test_plan) and reports a validation note for a plan with problems', async () => {
    const put = await call(dev, 'put_artifact', { id: globId, kind: 'test_plan', content: BAD });
    const body = json<{ kind: string; version: number; validation?: string }>(put.text);
    expect(body).toMatchObject({ kind: 'test_plan', version: 2 });
    expect(body.validation).toMatch(/^Test plan not fully valid: No ```atf-specs block/);
    const artifact = json<{ content: string }>(
      (await call(dev, 'get_artifact', { id: globId, kind: 'test_plan' })).text,
    );
    expect(artifact.content).toBe(BAD);
    const read = json<{ versions: unknown[] }>(
      (await call(dev, 'get_test_plan', { id: globId })).text,
    );
    expect(read.versions).toHaveLength(2);
    expect(
      json<{ current: { content: string } }>(
        (await call(dev, 'get_test_plan', { id: globId, version: 1 })).text,
      ).current.content,
    ).toBe(GOOD);
  });

  it('takes a test plan from an upload URL', async () => {
    const issued = json<{ url: string }>(
      (await call(dev, 'artifact_upload_url', { id: globId, kind: 'test_plan' })).text,
    );
    const res = await app.request(issued.url.slice(ORIGIN.length), { method: 'POST', body: GOOD });
    expect(res.status).toBe(200);
    expect(unwrap(await artifacts.testPlan(DEV, globId, null)).current).toMatchObject({
      version: 3,
      content: GOOD,
    });
  });

  it('refuses a person who is not on the board', async () => {
    expect(
      (await call(outsider, 'save_test_plan', { id: globId, version: 3, content: GOOD })).isError,
    ).toBe(true);
    expect((await call(outsider, 'get_test_plan', { id: globId })).isError).toBe(true);
  });
});
