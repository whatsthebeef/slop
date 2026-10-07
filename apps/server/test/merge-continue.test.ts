import { readFile } from 'node:fs/promises';
import { GlobService, machine } from '@slop/core';
import type { Board, Effect, Glob, Result } from '@slop/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost, MergeResult } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A code host that records what slop asked of it; only the calls these tests make do anything. */
class FakeHost implements CodeHost {
  readonly configured = true;
  commitFiles = () => Promise.resolve({ parent: null, files: [] });
  readonly opened: string[] = [];
  readonly deleted: string[] = [];
  nextPr: { number: number; headSha: string } | null = { number: 8, headSha: 'd4' };
  mergeResult: MergeResult = { outcome: 'merged', sha: 'm1' };

  connection = () =>
    Promise.resolve({ configured: true, connected: true, installUrl: null, appName: null });
  provision = (_repo: unknown, glob: Glob) =>
    Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: HEAD } });
  openDraftPr = (_repo: unknown, glob: Glob) => {
    this.opened.push(glob.id);
    return Promise.resolve(this.nextPr);
  };
  syncLabels = () => Promise.resolve();
  closePr = () => Promise.resolve();
  deleteBranch = (_repo: unknown, branch: string) => {
    this.deleted.push(branch);
    return Promise.resolve();
  };
  reopenPr = () => Promise.resolve('reopened' as const);
  mergeState = () => Promise.resolve({ sha: HEAD, state: 'passed' as const });
  completedCheckRun = () => Promise.resolve(null);
  markReady = () => Promise.resolve({ wasDraft: true, sha: HEAD });
  conflictFiles = () => Promise.resolve([] as string[]);
  commentOnce = () => Promise.resolve('posted' as const);
  diffSummary = () => Promise.resolve({ changedLines: 0, files: [] });
  readFile = () => Promise.resolve(null);
  squashMerge = () => Promise.resolve(this.mergeResult);
}

describe('Merge and continue (row 31) through the executors and webhooks', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let executors: ReturnType<typeof codeHostExecutors>;
  let n = 0;
  const deliveryId = () => `delivery-${++n}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('continue'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: REPO,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> =>
      store.transaction((tx) => tx.getBoard(boardId));
    host = new FakeHost();
    // These deliveries never carry review comments.
    const findings = { recordCodeRabbitComment: () => Promise.reject(new Error('not used here')) };
    handle = githubDeliveryHandler({ db: database.db, globs, findings, boardOf, github: host });
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'));
  });

  afterAll(() => drop());

  /** A super whose ready PR #7 passed its checks, with its latest postplan at the head. */
  let globId: string;
  beforeEach(async () => {
    host.opened.length = 0;
    host.deleted.length = 0;
    const created = unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title: 'Super glob',
        summary: '',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    globId = created.id;
    await globs.applyEvent(globId, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: HEAD } }, ctx),
    );
    await globs.applyEvent(globId, (g, ctx) =>
      machine.prReadyForReview(g, { number: 7, headSha: HEAD }, ctx),
    );
    await globs.applyEvent(globId, (g, ctx) =>
      machine.checksCompleted(g, { sha: HEAD, passed: true }, ctx),
    );
    await store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind: 'postplan',
        label: '',
        content: '# postplan',
        link: null,
        commitSha: HEAD.slice(0, 7),
        provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: new Date().toISOString(),
      }),
    );
  });

  const current = async () => unwrap(await globs.get(DEV, globId)).glob;
  const pendingEffects = async (kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter(
      (row) => row.kind === kind && row.state === 'pending',
    );
  const run = async (kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const [row] = await pendingEffects(kind);
    if (row === undefined) throw new Error(`No pending ${kind}`);
    return executor(row.effect, await current(), { globs });
  };
  const mergeContinue = async () =>
    unwrap(await globs.merge(DEV, globId, (await current()).version, true));
  const closedMerged = (number: number) => ({
    id: deliveryId(),
    event: 'pull_request',
    payload: {
      action: 'closed',
      pull_request: {
        number,
        draft: false,
        merged: true,
        merge_commit_sha: 'm1',
        head: { ref: globId, sha: HEAD },
      },
      repository: { full_name: REPO },
    },
  });
  const push = (sha: string, created = false) => ({
    id: deliveryId(),
    event: 'push',
    payload: { ref: `refs/heads/${globId}`, after: sha, created, repository: { full_name: REPO } },
  });

  it("slop's own merge response returns the super to in_progress, and the merged webhook after it is a no-op", async () => {
    await mergeContinue();
    expect(await run('squash_merge')).toBe('done');
    const continued = await current();
    expect(continued).toMatchObject({
      status: 'in_progress',
      pr: null,
      labels: {},
      mergeMode: null,
    });
    expect(continued.prs).toMatchObject([{ number: 7, mergeSha: 'm1' }]);

    await handle(closedMerged(7));
    const after = await current();
    expect(after.version).toBe(continued.version);
    expect(after.status).toBe('in_progress');
  });

  it('the merged webhook first, then the merge response, is the same', async () => {
    await mergeContinue();
    await handle(closedMerged(7));
    const continued = await current();
    expect(continued.status).toBe('in_progress');
    // The glob no longer has the PR, so the pending merge is dropped.
    expect(await run('squash_merge')).toBe('dropped');
    expect((await current()).version).toBe(continued.version);
  });

  it('the next push opens a fresh draft PR, and the branch is never deleted', async () => {
    await mergeContinue();
    await run('squash_merge');
    // A branch deleted by GitHub after the merge and recreated by the push is kept.
    await handle(push('d4', true));
    expect(host.deleted).toEqual([]);
    expect(await pendingEffects('open_pr')).toHaveLength(1);

    expect(await run('open_pr')).toBe('done');
    expect(host.opened).toEqual([globId]);
    expect((await current()).pr).toEqual({ number: 8, state: 'draft', headSha: 'd4' });

    // The `opened` webhook for the same PR changes nothing.
    const version = (await current()).version;
    await handle({
      id: deliveryId(),
      event: 'pull_request',
      payload: {
        action: 'opened',
        pull_request: {
          number: 8,
          draft: true,
          merged: false,
          merge_commit_sha: null,
          head: { ref: globId, sha: 'd4' },
        },
        repository: { full_name: REPO },
      },
    });
    expect((await current()).version).toBe(version);
  });

  it('a push with nothing to merge yet leaves the glob without a PR until the next one', async () => {
    await mergeContinue();
    await run('squash_merge');
    await handle(push('d4'));
    host.nextPr = null;
    try {
      expect(await run('open_pr')).toBe('done');
    } finally {
      host.nextPr = { number: 8, headSha: 'd4' };
    }
    expect((await current()).pr).toBeNull();
  });

  it('migration 0008 gives older globs an empty PR history and no merge mode, and is idempotent', async () => {
    await database.db.execute(
      sql`update globs set data = data - 'prs' - 'mergeMode' where id = ${globId}`,
    );
    const migration = await readFile(
      new URL('../drizzle/0008_glob_prs.sql', import.meta.url),
      'utf8',
    );
    for (let i = 0; i < 2; i++) {
      for (const statement of migration.split('--> statement-breakpoint')) {
        await database.db.execute(sql.raw(statement));
      }
    }
    const glob = await current();
    expect(glob.prs).toEqual([]);
    expect(glob.mergeMode).toBeNull();
  });
});
