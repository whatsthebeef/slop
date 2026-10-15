import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewAtfRunner, NewTestRun } from '@slop/core';
import { runMigrations } from '../src/db/store.js';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';
import type { Database } from '../src/db/store.js';

const AT = '2026-10-05T12:00:00.000Z';
const LATER = '2026-10-06T12:00:00.000Z';

const runner = (boardId: number, patch: Partial<NewAtfRunner> = {}): NewAtfRunner => ({
  boardId,
  name: 'GitHub Actions',
  method: 'oidc',
  config: {
    issuer: 'https://token.actions.githubusercontent.com',
    claims: { repository: ['acme/app'] },
  },
  environments: ['staging'],
  enabled: true,
  createdBy: 'admin@example.com',
  createdAt: AT,
  ...patch,
});

const run = (boardId: number, patch: Partial<NewTestRun> = {}): NewTestRun => ({
  boardId,
  kind: 'atf',
  globId: null,
  environment: 'staging',
  sha: 'abc1234',
  passed: 1,
  failed: 0,
  skipped: 0,
  url: null,
  finishedAt: AT,
  eventId: 'r1',
  ...patch,
});

describe('ATF runners in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let database: Database;
  let url: string;
  let boardId: number;
  let otherBoardId: number;

  beforeAll(async () => {
    const test = await createTestDatabase('atf_runners');
    drop = test.drop;
    database = test.database;
    url = test.url;
    store = new PgStore(test.database.db);
    const board = (name: string) =>
      store.transaction((tx) =>
        tx.insertBoard({
          name,
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        }),
      );
    boardId = (await board('a')).id;
    otherBoardId = (await board('b')).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('stores a runner with its settings and reads it back by board, oldest first', async () => {
    const stored = await store.transaction((tx) => tx.insertAtfRunner(runner(boardId)));
    expect(stored).toMatchObject({
      boardId,
      name: 'GitHub Actions',
      method: 'oidc',
      environments: ['staging'],
      enabled: true,
      createdAt: AT,
      revokedAt: null,
      lastSeenAt: null,
      lastResultAt: null,
    });
    expect(stored?.config).toEqual({
      issuer: 'https://token.actions.githubusercontent.com',
      claims: { repository: ['acme/app'] },
    });
    const second = await store.transaction((tx) =>
      tx.insertAtfRunner(
        runner(boardId, {
          name: 'CodeBuild',
          method: 'aws_iam',
          config: { roleArns: ['arn:aws:iam::123456789012:role/atf'] },
        }),
      ),
    );
    expect(
      (await store.transaction((tx) => tx.listAtfRunners(boardId))).map((r) => r.name),
    ).toEqual(['GitHub Actions', 'CodeBuild']);
    expect(await store.transaction((tx) => tx.listAtfRunners(otherBoardId))).toEqual([]);
    expect(
      await store.transaction((tx) => tx.getAtfRunner(boardId, second?.id ?? 0)),
    ).toMatchObject({ method: 'aws_iam' });
    // A runner is read only through its own board.
    expect(
      await store.transaction((tx) => tx.getAtfRunner(otherBoardId, second?.id ?? 0)),
    ).toBeNull();
  });

  it('keeps an active runner’s name unique per board, without regard to case, and frees it on revoke', async () => {
    expect(
      await store.transaction((tx) =>
        tx.insertAtfRunner(runner(boardId, { name: 'github ACTIONS' })),
      ),
    ).toBeNull();
    expect(
      await store.transaction((tx) => tx.insertAtfRunner(runner(otherBoardId))),
    ).not.toBeNull();
    const current = (await store.transaction((tx) => tx.listAtfRunners(boardId))).find(
      (r) => r.name === 'GitHub Actions',
    );
    if (current === undefined) throw new Error('no runner');
    await store.transaction((tx) =>
      tx.updateAtfRunner(boardId, current.id, { enabled: false, revokedAt: LATER }),
    );
    expect(await store.transaction((tx) => tx.insertAtfRunner(runner(boardId)))).not.toBeNull();
    expect(
      (await store.transaction((tx) => tx.listAtfRunners(boardId))).map((r) => r.name),
    ).toEqual(['CodeBuild', 'GitHub Actions']);
    const all = await store.transaction((tx) =>
      tx.listAtfRunners(boardId, { includeRevoked: true }),
    );
    expect(all.map((r) => [r.name, r.revokedAt])).toEqual([
      ['GitHub Actions', LATER],
      ['CodeBuild', null],
      ['GitHub Actions', null],
    ]);
  });

  it('refuses a rename onto an active runner’s name without aborting the transaction, and updates the fields given', async () => {
    const codebuild = (await store.transaction((tx) => tx.listAtfRunners(boardId))).find(
      (r) => r.name === 'CodeBuild',
    );
    if (codebuild === undefined) throw new Error('no runner');
    const outcome = await store.transaction(async (tx) => {
      const clash = await tx.updateAtfRunner(boardId, codebuild.id, { name: 'GITHUB actions' });
      // The transaction is still usable after the refusal.
      const renamed = await tx.updateAtfRunner(boardId, codebuild.id, {
        name: 'CodeBuild dev',
        environments: ['staging', 'prod'],
        lastSeenAt: LATER,
        lastResultAt: LATER,
      });
      return { clash, renamed };
    });
    expect(outcome.clash).toBeNull();
    expect(outcome.renamed).toMatchObject({
      name: 'CodeBuild dev',
      environments: ['staging', 'prod'],
      lastSeenAt: LATER,
      lastResultAt: LATER,
      enabled: true,
    });
    expect(
      await store.transaction((tx) => tx.updateAtfRunner(boardId, 999_999, { enabled: false })),
    ).toBeNull();
    expect(
      await store.transaction((tx) =>
        tx.updateAtfRunner(otherBoardId, codebuild.id, { enabled: false }),
      ),
    ).toBeNull();
  });

  it('records a test run’s runner and reads it back, null when none', async () => {
    const [first] = await store.transaction((tx) => tx.listAtfRunners(boardId));
    if (first === undefined) throw new Error('no runner');
    await store.transaction(async (tx) => {
      expect(await tx.insertTestRun(run(boardId, { eventId: 'with', runnerId: first.id }))).toBe(
        true,
      );
      expect(await tx.insertTestRun(run(boardId, { eventId: 'without' }))).toBe(true);
    });
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(boardId, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
    );
    expect(Object.fromEntries(runs.map((r) => [r.eventId, r.runnerId]))).toEqual({
      with: first.id,
      without: null,
    });
  });

  it('keeps a deleted runner’s runs, with no runner', async () => {
    const [first] = await store.transaction((tx) => tx.listAtfRunners(boardId));
    if (first === undefined) throw new Error('no runner');
    await database.db.execute(sql`delete from atf_runners where id = ${first.id}`);
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(boardId, { commits: [{ environment: 'staging', sha: 'abc1234' }] }),
    );
    expect(runs.map((r) => [r.eventId, r.runnerId])).toEqual(
      expect.arrayContaining([
        ['with', null],
        ['without', null],
      ]),
    );
  });

  it('is removed with its board', async () => {
    await database.db.execute(sql`delete from boards where id = ${otherBoardId}`);
    expect(
      await store.transaction((tx) => tx.listAtfRunners(otherBoardId, { includeRevoked: true })),
    ).toEqual([]);
  });

  it('migrates again without error or change', async () => {
    const before = await database.db.execute(sql`select count(*)::int as n from atf_runners`);
    await runMigrations(url, new URL('../drizzle', import.meta.url).pathname);
    const after = await database.db.execute(sql`select count(*)::int as n from atf_runners`);
    expect(after).toEqual(before);
  });
});
