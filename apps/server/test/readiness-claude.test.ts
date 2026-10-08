import { BoardService, GlobService, KnowledgeService } from '@slop/core';
import type { Catalog, ReadinessItem } from '@slop/core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeHost } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountReadiness } from '../src/http/readiness.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const unused = () => Promise.reject(new Error('not used by the readiness route'));

const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

/** A repo whose `.github/workflows/` holds `files` (path to text) on every branch. */
const hostWith = (files: Record<string, string>): CodeHost => ({
  configured: true,
  connection: () =>
    Promise.resolve({ configured: true, connected: true, installUrl: null, appName: null }),
  provision: unused,
  openDraftPr: unused,
  syncLabels: unused,
  closePr: unused,
  deleteBranch: unused,
  reopenPr: unused,
  mergeState: unused,
  conflictFiles: unused,
  completedCheckRun: unused,
  readFile: (_repo, _ref, path) => Promise.resolve(files[path] ?? null),
  listFiles: (_repo, _ref, dir) =>
    Promise.resolve(
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    ),
  commitFiles: unused,
  commitDiffSummary: unused,
  markReady: unused,
  diffSummary: unused,
  squashMerge: unused,
  headOf: unused,
  commitChecks: unused,
  updateBranch: unused,
  commentOnce: unused,
});

describe('GET /api/boards/:b/readiness: Claude workflow', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let deps: { store: PgStore; notifier: { publish: () => void }; clock: { now: () => string } };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('readiness_claude'));
    store = new PgStore(database.db);
    deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  const claudeItem = async (host: CodeHost): Promise<ReadinessItem | undefined> => {
    const app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', ADMIN);
      await next();
    });
    mountReadiness(app, {
      boards: new BoardService(deps),
      globs: new GlobService({
        ...deps,
        ids: { runId: () => crypto.randomUUID() },
        routines: { hasRoutine: () => Promise.resolve(true) },
      }),
      knowledge: new KnowledgeService({ ...deps, catalog }),
      host,
      log: () => undefined,
    });
    const response = await app.request(`/api/boards/${String(boardId)}/readiness`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ReadinessItem[] }).items.find(
      (i) => i.key === 'claude_workflow',
    );
  };

  it('is missing, with the fix, when no workflow runs the Claude action', async () => {
    const none = await claudeItem(hostWith({}));
    expect(none).toMatchObject({ state: 'missing' });
    expect(none?.detail).toMatch(/copy catalog\/scripts\/claude\.yml/);
    const other = await claudeItem(
      hostWith({ '.github/workflows/checks.yml': 'steps:\n  - uses: actions/checkout@v4\n' }),
    );
    expect(other).toMatchObject({ state: 'missing' });
  });

  it('turns ok once a workflow on the base branch uses anthropics/claude-code-action', async () => {
    const item = await claudeItem(
      hostWith({
        '.github/workflows/checks.yml': 'steps:\n  - uses: actions/checkout@v4\n',
        '.github/workflows/claude.yml': 'steps:\n  - uses: anthropics/claude-code-action@v1\n',
      }),
    );
    expect(item).toMatchObject({ state: 'ok' });
  });
});
