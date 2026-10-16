import {
  ArtifactService,
  BoardService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MiningService,
  SubLimitService,
} from '@slop/core';
import type { Result } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by these tests'));
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

const GOOD =
  '| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `e2e/a.spec.ts` | runs |\n\n```atf-specs\nspecs:\n  - e2e/a.spec.ts\ngrep: null\n```\n';
const NO_BLOCK =
  '| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `e2e/a.spec.ts` | runs |\n';

interface Doc {
  current: {
    version: number;
    kind: string;
    content: string;
    provenance: { validation?: string; atfSpecs?: { specs: string[]; grep: string | null } };
  } | null;
  versions: { version: number; by: string }[];
}

describe('test plan routes', () => {
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let globId = '';

  const request = (method: string, path: string, body?: unknown, email = DEV) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${email}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const put = (body: unknown, email = DEV) =>
    request('PUT', `/api/globs/${globId}/test-plan`, body, email);
  const get = (query = '', email = DEV) =>
    request('GET', `/api/globs/${globId}/test-plan${query}`, undefined, email);

  beforeAll(async () => {
    const test = await createTestDatabase('test_plan_routes');
    drop = test.drop;
    const { db } = test.database;
    const store = new PgStore(db);
    const hub = new HintHub();
    const deps = { store, notifier: hub, clock: { now: () => new Date().toISOString() } };
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(false) },
    });
    const boards = new BoardService(deps);
    const mining = new MiningService(deps);
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    mountKnowledge(app, {
      knowledge: new KnowledgeService({ ...deps, catalog, signals: mining }),
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards,
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({
        ...deps,
        mining,
        subLimit: new SubLimitService({ store, notifier: hub, diffs: null }),
        manifests: null,
      }),
      logError: () => undefined,
    });
    await store.transaction(async (tx) => {
      for (const email of [DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    const boardId = unwrap(
      await boards.create(DEV, {
        name: 'b',
        repo: null,
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'T',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: 'Do it',
      }),
    ).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('reads an empty test plan before the first save', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'test_plan', current: null, versions: [] });
  });

  it('saves a version, reads it back with the parsed specs, and lists the versions', async () => {
    const saved = await put({ content: GOOD, version: 0 });
    expect(saved.status).toBe(200);
    const stored = (await saved.json()) as {
      version: number;
      provenance: { atfSpecs?: unknown; validation?: string };
    };
    expect(stored.version).toBe(1);
    expect(stored.provenance.validation).toBeUndefined();
    const doc = (await (await get()).json()) as Doc;
    expect(doc.current).toMatchObject({ version: 1, kind: 'test_plan', content: GOOD });
    expect(doc.current?.provenance.atfSpecs).toEqual({ specs: ['e2e/a.spec.ts'], grep: null });
    expect(doc.versions.map((v) => [v.version, v.by])).toEqual([[1, DEV]]);
  });

  it('keeps text with problems and says what is wrong, with no spec list', async () => {
    const saved = await put({ content: NO_BLOCK, version: 1 });
    expect(saved.status).toBe(200);
    const doc = (await (await get()).json()) as Doc;
    expect(doc.current?.version).toBe(2);
    expect(doc.current?.content).toBe(NO_BLOCK);
    expect(doc.current?.provenance.validation).toMatch(
      /^Test plan not fully valid: No ```atf-specs block/,
    );
    expect(doc.current?.provenance.atfSpecs).toBeUndefined();
  });

  it('reads an older version and 404s an unknown one', async () => {
    const old = (await (await get('?version=1')).json()) as Doc;
    expect(old.current?.content).toBe(GOOD);
    expect(old.versions).toHaveLength(2);
    expect((await get('?version=9')).status).toBe(404);
  });

  it('refuses a stale version with 409 version_conflict', async () => {
    const res = await put({ content: GOOD, version: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'version_conflict',
      message: 'The test plan is at version 2, not 1: read it again and retry',
    });
    // A save without a version always lands.
    expect((await put({ content: GOOD })).status).toBe(200);
  });

  it('does not touch plan.md', async () => {
    const plan = (await (await request('GET', `/api/globs/${globId}/plan`)).json()) as Doc;
    expect(plan.current?.content).toBe('Do it');
    expect(plan.versions).toHaveLength(1);
  });

  it('serves the kind through the generic artifact read too', async () => {
    const res = await request('GET', `/api/globs/${globId}/artifacts/test_plan`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(3);
  });

  it('rejects a bad body and a non-member', async () => {
    expect((await put({ version: 1 })).status).toBe(422);
    expect((await put({ content: GOOD }, OUTSIDER)).status).toBe(403);
    expect((await get('', OUTSIDER)).status).toBe(403);
    expect((await request('GET', '/api/globs/nope/test-plan')).status).toBe(404);
  });
});
