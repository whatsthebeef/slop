import { CodeReviewService, GlobService, KnowledgeService } from '@slop/core';
import type { Board, Effect, Glob, KnowledgeDoc, NewCodeReviewComment } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CODE_REVIEW_REQUEST_BODY, CODE_REVIEW_REQUEST_MARKER, codeReviewExecutors } from '../src/code-review-executors.js';
import { autoReviewDisabled } from '../src/coderabbit-config.js';
import type { Repo } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountCodeReviews } from '../src/http/code-reviews.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

const glob = (id: string, boardId: number, patch: Partial<Glob> = {}): Glob => ({
  id,
  boardId,
  title: id,
  summary: '',
  type: 'same',
  category: 'feature',
  group: null,
  environment: null,
  status: 'pr_open',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 7, state: 'ready', headSha: 'abc' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: NOW,
  updatedAt: NOW,
  signedOffAt: null,
  doingSince: NOW,
  ...patch,
});

const comment = (globId: string, boardId: number, patch: Partial<NewCodeReviewComment> = {}): NewCodeReviewComment => ({
  boardId,
  globId,
  prNumber: 7,
  externalId: `coderabbit:review_comment:${globId}`,
  kind: 'inline',
  author: 'coderabbitai[bot]',
  commitSha: 'abc',
  path: 'src/a.ts',
  line: '12',
  body: 'Missing await.',
  url: 'https://github.com/acme/app/pull/7#discussion_r1',
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
});

const guide = (boardId: number): KnowledgeDoc => ({
  boardId,
  kind: 'doc',
  name: 'review_guide',
  area: 'review_guide',
  audience: [],
  description: 'What CodeRabbit should look for.',
  content: '# Review guide\n\nEvery write goes through a core service.',
  layer: 'file',
  version: 1,
  source: 'upload',
  updatedBy: DEV,
  updatedAt: NOW,
});

const AUTO_OFF = '# CodeRabbit\nreviews:\n  profile: chill\n  auto_review:\n    enabled: false # slop asks\n';

describe('.coderabbit.yaml', () => {
  it('turns automatic reviews off only with reviews.auto_review.enabled: false', () => {
    expect(autoReviewDisabled(AUTO_OFF)).toBe(true);
    expect(autoReviewDisabled('reviews: { auto_review: { enabled: false } }')).toBe(true);
    expect(autoReviewDisabled('reviews:\n  auto_review:\n    enabled: true\n')).toBe(false);
    expect(autoReviewDisabled('reviews:\n  auto_review:\n    # enabled: false\n    drafts: false\n')).toBe(false);
    expect(autoReviewDisabled('reviews:\n  profile: chill\nauto_review:\n  enabled: false\n')).toBe(false);
    expect(autoReviewDisabled('')).toBe(false);
    expect(autoReviewDisabled('reviews: [unclosed')).toBe(false);
  });
});

describe('CodeRabbit reviews stored verbatim', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let codeReviews: CodeReviewService;
  let knowledge: KnowledgeService;
  let app: Hono<Env>;
  let board: Board;
  let bare: Board;

  beforeAll(async () => {
    const test = await createTestDatabase('code_reviews');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => NOW } };
    codeReviews = new CodeReviewService(deps);
    knowledge = new KnowledgeService({
      ...deps,
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h', files: [] }) },
    });
    app = new Hono<Env>();
    // Stands in for the app's sign-in middleware: the caller's email comes from a test header.
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? DEV);
      await next();
    });
    mountCodeReviews(app, { codeReviews });
    [board, bare] = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: STRANGER, name: 'Stranger', active: true });
      const insert = (name: string, repo: string) =>
        tx.insertBoard({ name, repo, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      const boards = [await insert('app', 'acme/app'), await insert('bare', 'acme/bare')];
      for (const b of boards) await tx.upsertMember({ boardId: b.id, email: DEV, role: 'dev' });
      await tx.insertGlob(glob('s1t1', boards[0]?.id ?? 0), null);
      await tx.insertGlob(glob('s1t2', boards[0]?.id ?? 0), null);
      await tx.insertGlob(glob('s2t1', boards[1]?.id ?? 0), null);
      await tx.saveKnowledge(guide(boards[0]?.id ?? 0));
      return boards as [Board, Board];
    });
  });

  afterAll(async () => {
    await drop();
  });

  const listed = (globId: string) => store.transaction((tx) => tx.listCodeReviewComments(board.id, [globId]));

  it('upserts by external ID: an edit replaces the body, a late older copy and a repeat change nothing', async () => {
    const first = comment('s1t2', board.id, { externalId: 'coderabbit:issue_comment:1', kind: 'comment', path: null, line: null, body: 'in progress' });
    expect(await store.transaction((tx) => tx.upsertCodeReviewComment(first))).toBe(true);
    expect(await store.transaction((tx) => tx.upsertCodeReviewComment(first))).toBe(false);
    const later = { ...first, kind: 'summary' as const, body: 'Walkthrough', updatedAt: '2026-10-05T13:00:00.000Z' };
    expect(await store.transaction((tx) => tx.upsertCodeReviewComment(later))).toBe(true);
    expect(await store.transaction((tx) => tx.upsertCodeReviewComment(first))).toBe(false);
    expect(await listed('s1t2')).toEqual([
      expect.objectContaining({ kind: 'summary', body: 'Walkthrough', createdAt: NOW, updatedAt: '2026-10-05T13:00:00.000Z' }),
    ]);
    expect(await store.transaction((tx) => tx.deleteCodeReviewComment('coderabbit:issue_comment:1'))).toMatchObject({ globId: 's1t2' });
    expect(await store.transaction((tx) => tx.deleteCodeReviewComment('coderabbit:issue_comment:1'))).toBeNull();
    expect(await listed('s1t2')).toEqual([]);
  });

  it("serves members the cards' badges and the glob view, and strangers a 403", async () => {
    await codeReviews.record('s1t1', { ...comment('s1t1', board.id), createdAt: NOW, updatedAt: NOW });
    await codeReviews.record('s1t1', {
      ...comment('s1t1', board.id, { externalId: 'coderabbit:review:9', kind: 'review', path: null, line: null, url: 'https://github.com/acme/app/pull/7#pullrequestreview-9' }),
    });
    const badges = await app.request(`/api/boards/${String(board.id)}/code-reviews?globs=s1t1,s1t2`);
    expect(badges.status).toBe(200);
    expect(await badges.json()).toEqual({
      value: { s1t1: { count: 1, url: 'https://github.com/acme/app/pull/7#pullrequestreview-9', hasSummary: false } },
    });
    const view = await app.request('/api/globs/s1t1/code-review');
    const body = z.object({ value: z.object({ inline: z.array(z.object({ body: z.string() })), reviews: z.array(z.unknown()) }) }).parse(await view.json());
    expect(body.value.inline.map((c) => c.body)).toEqual(['Missing await.']);
    expect(body.value.reviews).toHaveLength(1);
    const stranger = { headers: { 'x-test-email': STRANGER } };
    expect((await app.request(`/api/boards/${String(board.id)}/code-reviews?globs=s1t1`, stranger)).status).toBe(403);
    expect((await app.request('/api/globs/s1t1/code-review', stranger)).status).toBe(403);
  });

  it('is deleted with its glob', async () => {
    await codeReviews.record('s2t1', { ...comment('s2t1', bare.id, { externalId: 'coderabbit:review_comment:s2t1-gone' }) });
    await store.transaction((tx) => tx.deleteGlob('s2t1'));
    expect(await store.transaction((tx) => tx.listCodeReviewComments(bare.id, ['s2t1']))).toEqual([]);
  });

  describe('@coderabbitai review on ready for review', () => {
    let files: Map<string, string>;
    let comments: { prNumber: number; marker: string; body: string }[];
    const host = {
      configured: true,
      readFile: (_repo: Repo, ref: string, path: string) => Promise.resolve(files.get(`${ref}:${path}`) ?? null),
      commentOnce: (_repo: Repo, prNumber: number, marker: string, body: string) => {
        if (comments.some((c) => c.prNumber === prNumber && c.body.includes(marker))) return Promise.resolve('exists' as const);
        comments.push({ prNumber, marker, body });
        return Promise.resolve('posted' as const);
      },
    };
    const boardOf = (id: number) => store.transaction((tx) => tx.getBoard(id));
    const executors = codeReviewExecutors(host, boardOf, (id) => knowledge.hasReviewGuide(id));
    const run = (g: Glob) => {
      const effect: Effect = { kind: 'request_code_review', globId: g.id, generation: g.generation };
      const globs = new GlobService({
        store,
        notifier: { publish: () => undefined },
        clock: { now: () => NOW },
        ids: { runId: () => crypto.randomUUID() },
        routines: { hasRoutine: () => Promise.resolve(false) },
      });
      return executors.request_code_review?.(effect, g, { globs });
    };

    beforeEach(() => {
      files = new Map();
      comments = [];
    });

    it('asks once per PR when .coderabbit.yaml turns auto reviews off and the board has a review guide', async () => {
      files.set(`main:.coderabbit.yaml`, AUTO_OFF);
      expect(await run(glob('s1t1', board.id))).toBe('done');
      expect(await run(glob('s1t1', board.id))).toBe('done');
      expect(comments).toEqual([{ prNumber: 7, marker: CODE_REVIEW_REQUEST_MARKER, body: CODE_REVIEW_REQUEST_BODY }]);
      expect(CODE_REVIEW_REQUEST_BODY.startsWith('@coderabbitai review')).toBe(true);
    });

    it('reads .coderabbit.yml too, on the base branch', async () => {
      files.set(`s1t1:.coderabbit.yaml`, AUTO_OFF);
      expect(await run(glob('s1t1', board.id))).toBe('dropped');
      files.set(`main:.coderabbit.yml`, AUTO_OFF);
      expect(await run(glob('s1t1', board.id))).toBe('done');
      expect(comments).toHaveLength(1);
    });

    it('posts nothing when CodeRabbit reviews on its own, there is no config, no review guide, or no ready PR', async () => {
      expect(await run(glob('s1t1', board.id))).toBe('dropped');
      files.set(`main:.coderabbit.yaml`, 'reviews:\n  auto_review:\n    enabled: true\n');
      expect(await run(glob('s1t1', board.id))).toBe('dropped');
      files.set(`main:.coderabbit.yaml`, AUTO_OFF);
      // The bare board has no review guide.
      expect(await run(glob('s2t9', bare.id))).toBe('dropped');
      expect(await run(glob('s1t1', board.id, { pr: { number: 7, state: 'draft', headSha: 'abc' } }))).toBe('dropped');
      expect(await run(glob('s1t1', board.id, { pr: null }))).toBe('dropped');
      expect(comments).toEqual([]);
    });
  });

  describe('get_review_guide (MCP)', () => {
    const call = async (email: string, repo: string) => {
      const server = buildServer({ knowledge } as unknown as McpDeps, email, 'http://localhost');
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const result = await client.callTool({ name: 'get_review_guide', arguments: { repo } });
      await client.close();
      const text = z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? 'null';
      // An invalid argument comes back as the SDK's plain-text error.
      if (result.isError === true) return { isError: true, body: text };
      return { isError: false, body: z.unknown().parse(JSON.parse(text)) };
    };

    it("gives a member the guide of their board on that repo, and nothing to a stranger or for a repo without one", async () => {
      expect(await call(DEV, 'ACME/app')).toEqual({
        isError: false,
        body: [
          {
            board: board.id,
            boardName: 'app',
            documents: [{ name: 'review_guide', description: 'What CodeRabbit should look for.', version: 1, content: guide(board.id).content }],
          },
        ],
      });
      expect((await call(STRANGER, 'acme/app')).body).toEqual([]);
      expect((await call(DEV, 'acme/bare')).body).toEqual([]);
      expect((await call(DEV, 'not a repo')).isError).toBe(true);
    });
  });
});
