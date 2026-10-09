import { ArtifactService, GlobService, LearningJobService, MiningService } from '@slop/core';
import type { Board, DomainEvent, KbSignalState, NewFinding, NewReviewSource, Result, Store } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitFiles, Repo } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { agentSetTrailer } from '../src/github/trailers.js';
import { CodeHostManifests } from '../src/jobs/manifests.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-10-07T12:00:00.000Z';
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('Mining reads and board jobs in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let otherBoardId: number;
  let now = NOW;
  const clock = { now: () => now };
  const notifier = { publish: () => undefined };

  const newGlob = async (board: number) =>
    unwrap(
      await globs.create(DEV, {
        boardId: board,
        title: 'Work',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;

  const event = (globId: string, type: DomainEvent['type'], at: string, data: DomainEvent['data'] = {}): DomainEvent => ({
    type,
    globId,
    actor: null,
    at,
    data,
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mining'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    artifacts = new ArtifactService({ store, clock, notifier });
    const ids = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const ids: number[] = [];
      for (const name of ['mined', 'other']) {
        const board = await tx.insertBoard({
          name,
          repo: 'acme/app',
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        });
        await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
        ids.push(board.id);
      }
      return ids;
    });
    boardId = ids[0] ?? 0;
    otherBoardId = ids[1] ?? 0;
  });

  afterAll(() => drop());

  it("lists a board's events since a time, oldest first, through its globs, optionally of some types", async () => {
    const mine = await newGlob(boardId);
    const theirs = await newGlob(otherBoardId);
    await store.transaction((tx) =>
      tx.appendEvents([
        event(mine, 'BuildCompleted', ago(40), { sha: 'old', passed: false }),
        event(mine, 'RunEnded', ago(2), { runId: 'r2', outcome: 'superseded', cause: 'take_over' }),
        event(mine, 'BuildCompleted', ago(3), { sha: 'abc1234', passed: false }),
        event(theirs, 'BuildCompleted', ago(1), { sha: 'zzz', passed: false }),
      ]),
    );
    const since = ago(28);
    const all = await store.transaction((tx) => tx.listBoardEvents(boardId, since));
    const recent = all.filter((e) => e.type === 'BuildCompleted' || e.type === 'RunEnded');
    expect(recent.map((e) => [e.type, e.data])).toEqual([
      ['BuildCompleted', { sha: 'abc1234', passed: false }],
      ['RunEnded', { runId: 'r2', outcome: 'superseded', cause: 'take_over' }],
    ]);
    expect(all.every((e) => e.at >= since)).toBe(true);
    expect(all.some((e) => e.globId === theirs)).toBe(false);
    const builds = await store.transaction((tx) => tx.listBoardEvents(boardId, since, ['BuildCompleted']));
    expect(builds.map((e) => e.data.sha)).toEqual(['abc1234']);
    expect(await store.transaction((tx) => tx.listBoardEvents(boardId, since, []))).toEqual([]);
  });

  it('lists artifact metadata of some kinds since a time, with content only for local reviews and implementation records', async () => {
    const globId = await newGlob(boardId);
    now = ago(10);
    unwrap(await artifacts.putArtifact(DEV, globId, 'implementation_plan', '# Plan\n', { commitSha: null, runId: null, agentSetVersion: 4 }));
    unwrap(
      await artifacts.putArtifact(DEV, globId, 'local_review', '## Review (round 2)', {
        commitSha: 'abc1234',
        runId: null,
        agentSetVersion: 4,
        reviewStats: { riskTier: 'normal', reviewRounds: 2, maxReviewRounds: 2, testFailRounds: 1 },
      }),
    );
    const stats = { riskTier: 'low' as const, reviewRounds: 1, maxReviewRounds: 1, testFailRounds: 0 };
    unwrap(await artifacts.putArtifact(DEV, globId, 'postplan', 'Long postplan', { commitSha: null, runId: null, agentSetVersion: 4, reviewStats: stats }));
    now = NOW;
    const meta = await store.transaction((tx) => tx.listArtifactMeta(boardId, ['implementation_plan', 'local_review', 'postplan'], ago(28)));
    const own = meta.filter((a) => a.globId === globId);
    expect(own.map((a) => [a.kind, a.version, a.content])).toEqual([
      ['implementation_plan', 1, '# Plan\n'],
      ['local_review', 1, '## Review (round 2)'],
      // A postplan write is the next version of the record, whose content is kept like a plan's.
      ['implementation_plan', 2, 'Long postplan'],
    ]);
    expect(own[1]?.provenance.reviewStats).toEqual({ riskTier: 'normal', reviewRounds: 2, maxReviewRounds: 2, testFailRounds: 1 });
    expect(own[1]?.commitSha).toBe('abc1234');
    // Only local reviews keep review stats.
    expect(own[2]?.provenance.reviewStats).toBeUndefined();
    expect(await store.transaction((tx) => tx.listArtifactMeta(boardId, ['local_review'], ago(5)))).toEqual([]);
    expect(await store.transaction((tx) => tx.listArtifactMeta(otherBoardId, ['local_review'], ago(28)))).toEqual([]);
  });

  it("windows a board's findings by when their review was written, not when it was split (s15f8)", async () => {
    const globId = await newGlob(boardId);
    const finding = (sourceId: number, text: string): NewFinding => ({
      boardId,
      globId,
      sourceId,
      source: 'local_review',
      commitSha: null,
      agentSetVersion: null,
      severity: 'in_scope',
      round: 1,
      path: null,
      line: null,
      text,
      fingerprint: text,
    });
    const source = (createdAt: string): NewReviewSource => ({
      boardId,
      globId,
      kind: 'local_review',
      artifactId: null,
      externalId: null,
      commitSha: null,
      agentSetVersion: null,
      content: 'review',
      path: null,
      line: null,
      createdAt,
    });
    await store.transaction(async (tx) => {
      const old = await tx.insertReviewSource(source(ago(40)));
      const recent = await tx.insertReviewSource(source(ago(3)));
      if (old === null || recent === null) throw new Error('No source');
      // Both split today (a backfill).
      await tx.insertFindings([finding(old.id, 'old review'), finding(recent.id, 'recent review')], NOW);
    });
    const listed = await store.transaction((tx) => tx.listBoardFindings(boardId, ago(28), NOW));
    expect(listed.filter((f) => f.globId === globId).map((f) => f.text)).toEqual(['recent review']);
    // Not after the window's end either.
    expect((await store.transaction((tx) => tx.listBoardFindings(boardId, ago(28), ago(4)))).filter((f) => f.globId === globId)).toEqual([]);
  });

  it('upserts kb_signals rows per board and key', async () => {
    const row: KbSignalState = {
      boardId,
      key: 'run_superseded',
      itemId: 's1k9',
      lastFigures: { affected: 4, eligible: 18, rate: 0.222, count: 4 },
      lastMeasuredAt: NOW,
      raisedAt: NOW,
      belowThresholdRuns: 0,
    };
    await store.transaction((tx) => tx.upsertKbSignal(row));
    await store.transaction((tx) => tx.upsertKbSignal({ ...row, belowThresholdRuns: 2, lastFigures: null }));
    expect(await store.transaction((tx) => tx.listKbSignals(boardId))).toEqual([{ ...row, belowThresholdRuns: 2, lastFigures: null }]);
    expect(await store.transaction((tx) => tx.listKbSignals(otherBoardId))).toEqual([]);
  });

  it('gives a board job lease to one claimer at a time, until it is finished or expires', async () => {
    const lease = 30 * 60 * 1000;
    const claims = await Promise.all([
      store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'mining', NOW, lease)),
      store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'mining', NOW, lease)),
    ]);
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ job: 'mining', lastRunAt: null, runningUntil: new Date(Date.parse(NOW) + lease).toISOString() });
    // Still held a minute later; free again once it expires.
    const minuteLater = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(await store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'mining', minuteLater, lease))).toBeNull();
    const expired = new Date(Date.parse(NOW) + lease).toISOString();
    const reclaimed = await store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'mining', expired, lease));
    expect(reclaimed).not.toBeNull();
    // Another job of the same board has its own lease.
    expect(await store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'consolidation', minuteLater, lease))).not.toBeNull();

    const result = { kind: 'mining' as const, measured: 3, crossed: 1, raised: ['s2k1'], refreshed: [] };
    if (reclaimed === null) throw new Error('not reclaimed');
    // The run that lost its lease to `reclaimed` records nothing.
    expect(await store.transaction((tx) => tx.finishBoardJob({ ...reclaimed, lastRunAt: NOW, lastResult: result }, won[0]?.runningUntil ?? ''))).toBe(false);
    expect(await store.transaction((tx) => tx.getBoardJob(otherBoardId, 'mining'))).toMatchObject({ lastRunAt: null, runningUntil: reclaimed.runningUntil });
    expect(await store.transaction((tx) => tx.finishBoardJob({ ...reclaimed, lastRunAt: expired, lastResult: result }, reclaimed.runningUntil ?? ''))).toBe(true);
    expect(await store.transaction((tx) => tx.getBoardJob(otherBoardId, 'mining'))).toEqual({
      boardId: otherBoardId,
      job: 'mining',
      lastRunAt: expired,
      lastResult: result,
      runningUntil: null,
    });
    expect(await store.transaction((tx) => tx.claimBoardJob(otherBoardId, 'mining', expired, lease))).not.toBeNull();
  });

  it('mines a crossed signal into a mined KB item with its signal, and only refreshes it on the next run', async () => {
    const mining = new MiningService({ store, notifier });
    const ended: DomainEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const globId = await newGlob(boardId);
      ended.push(event(globId, 'RunEnded', ago(5 - i), { runId: `r${String(i)}`, outcome: i < 3 ? 'superseded' : 'completed', cause: 'start_again' }));
    }
    await store.transaction((tx) => tx.appendEvents(ended));
    const first = await mining.mine(boardId, NOW);
    expect(first.raised).toHaveLength(1);
    const raised = first.raised[0];
    const item = await store.transaction((tx) => tx.getKbItem(raised ?? ''));
    expect(item).toMatchObject({
      source: 'mined',
      submittedBy: 'slop',
      processing: 'pending',
      signal: { key: 'run_superseded', kind: 'run_superseded', agent: 'orchestrator' },
    });
    expect(item?.signal?.figures.affected).toBeGreaterThanOrEqual(3);

    const second = await mining.mine(boardId, new Date(Date.parse(NOW) + DAY).toISOString());
    expect(second.raised).toEqual([]);
    expect(second.refreshed).toEqual(first.raised);
    expect((await store.transaction((tx) => tx.listKbSignals(boardId))).find((r) => r.key === 'run_superseded')).toMatchObject({
      itemId: raised,
      belowThresholdRuns: 0,
    });
  });
});

describe('Learning jobs on two servers at once (s15f8)', () => {
  let database: Database;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mining_jobs'));
  });

  afterAll(() => drop());

  it('runs a due mining job on one server only, raising one item', async () => {
    const store = new PgStore(database.db);
    const clock = { now: () => NOW };
    const notifier = { publish: () => undefined };
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    const ended: DomainEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const globId = unwrap(
        await globs.create(DEV, { boardId, title: 'Work', summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
      ).id;
      ended.push({ type: 'RunEnded', globId, actor: null, at: ago(2), data: { runId: `r${String(i)}`, outcome: i < 3 ? 'superseded' : 'completed', cause: 'start_again' } });
    }
    await store.transaction((tx) => tx.appendEvents(ended));

    const server = () =>
      new LearningJobService({ store: new PgStore(database.db), clock, notifier, mining: new MiningService({ store: new PgStore(database.db), notifier }), manifests: null });
    const [a, b] = await Promise.all([server().runDue(), server().runDue()]);
    expect([...a, ...b]).toHaveLength(1);
    expect((await store.transaction((tx) => tx.listKbItems(boardId))).filter((i) => i.source === 'mined')).toHaveLength(1);
    expect(await store.transaction((tx) => tx.getBoardJob(boardId, 'mining'))).toMatchObject({ lastRunAt: NOW, runningUntil: null, lastResult: { kind: 'mining', raised: [expect.any(String)] } });

  });
});

describe('Mining runs at once without a lease (s15f8)', () => {
  let database: Database;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mining_lock'));
  });

  afterAll(() => drop());

  it("raises one item from two concurrent runs: the board job's lock makes the second read the first's", async () => {
    const store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    const globs = new GlobService({
      store,
      notifier,
      clock: { now: () => NOW },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    const ended: DomainEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const globId = unwrap(
        await globs.create(DEV, { boardId, title: 'Work', summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
      ).id;
      ended.push({ type: 'RunEnded', globId, actor: null, at: ago(2), data: { runId: `r${String(i)}`, outcome: i < 3 ? 'superseded' : 'completed', cause: 'take_over' } });
    }
    await store.transaction((tx) => tx.appendEvents(ended));

    // Two servers' runs, neither holding the lease (as when one outlives it). The first waits after reading
    // kb_signals until the second has either read it too (without the lock: both read no row and both raise) or is
    // seen waiting for the board job's advisory lock in pg_locks (with it: the second reads the first's row once the
    // first commits). Neither branch depends on timing; the cap only stops a broken run from hanging the test.
    let firstRead: () => void = () => undefined;
    const firstHasRead = new Promise<void>((resolve) => (firstRead = resolve));
    let secondRead: () => void = () => undefined;
    const secondHasRead = new Promise<void>((resolve) => (secondRead = resolve));
    const secondWaitsForLock = async (): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        const waiting = await database.db.execute(
          sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
        );
        if (waiting.length > 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    };
    const reading = (onRead: () => Promise<void>): Store => {
      const base = new PgStore(database.db);
      return {
        transaction: (work) =>
          base.transaction((tx) =>
            work({
              ...tx,
              listKbSignals: async (b) => {
                const rows = await tx.listKbSignals(b);
                await onRead();
                return rows;
              },
            }),
          ),
      };
    };
    const first = new MiningService({
      store: reading(async () => {
        firstRead();
        await Promise.race([secondHasRead, secondWaitsForLock()]);
      }),
      notifier,
    }).mine(boardId, NOW);
    await firstHasRead;
    const second = new MiningService({
      store: reading(() => {
        secondRead();
        return Promise.resolve();
      }),
      notifier,
    }).mine(boardId, NOW);
    const [a, b] = await Promise.all([first, second]);
    expect([...a.raised, ...b.raised]).toHaveLength(1);
    expect(b.refreshed).toEqual(a.raised);
    const mined = (await store.transaction((tx) => tx.listKbItems(boardId))).filter((i) => i.source === 'mined');
    expect(mined).toHaveLength(1);
    expect((await store.transaction((tx) => tx.listKbSignals(boardId))).find((r) => r.key === 'run_superseded')?.itemId).toBe(mined[0]?.id);
  });
});

describe('Manifest changes and commit trailers', () => {
  const board: Board = {
    id: 1,
    name: 'b',
    repo: 'acme/app',
    baseBranch: 'main',
    timeZone: 'UTC',
    defaultRoutineOwner: null,
    environments: [],
    sensitivePaths: [],
    deploy: null,
    readinessTicks: {},
    agentSetVersion: 3,
    agentCatalogHash: null,
    runNoProgressHours: 2,
    runReadyHours: 8,
    runStartMinutes: 30,
    runRespondMinutes: 30,
    subMaxChangedLines: 2000,
    effectCheckGlobs: 10,
    version: 1,
  };

  /** A code host with one commit per SHA and files per (ref, path). */
  const fakeHost = (commits: Record<string, CommitFiles>, files: Record<string, string>, configured = true) => {
    const reads: string[] = [];
    return {
      reads,
      host: {
        configured,
        commitFiles: (_repo: Repo, sha: string) => {
          const commit = commits[sha];
          return commit === undefined ? Promise.reject(new Error(`No commit ${sha}`)) : Promise.resolve(commit);
        },
        readFile: (_repo: Repo, ref: string, path: string) => {
          reads.push(`${ref}:${path}`);
          return Promise.resolve(files[`${ref}:${path}`] ?? null);
        },
      },
    };
  };

  it("reads each merged commit's changed manifests before and after, and parses the dependencies it added", async () => {
    const { host, reads } = fakeHost(
      {
        m1: {
          parent: 'p1',
          files: [
            { path: 'apps/web/package.json', previousPath: null, status: 'modified' },
            { path: 'src/index.ts', previousPath: null, status: 'modified' },
            { path: 'old/requirements.txt', previousPath: null, status: 'removed' },
          ],
        },
        m2: { parent: 'p2', files: [{ path: 'tools/requirements-dev.txt', previousPath: null, status: 'added' }] },
      },
      {
        'p1:apps/web/package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
        'm1:apps/web/package.json': JSON.stringify({
          dependencies: { react: '^19.0.0', zustand: '^5.0.0', '@slop/core': 'workspace:*' },
          devDependencies: { msw: '^2.0.0' },
        }),
        'm2:tools/requirements-dev.txt': 'ruff==0.6.0\n# a comment\n-r base.txt\n',
      },
    );
    const logged: string[] = [];
    const manifests = new CodeHostManifests(host, (_task, message) => logged.push(message));
    const changes = await manifests.manifestChanges(board, [
      { globId: 's1t1', sha: 'm1' },
      { globId: 's1t2', sha: 'missing' },
      { globId: 's1t3', sha: 'm2' },
    ]);
    expect(changes).toEqual([
      { globId: 's1t1', sha: 'm1', path: 'apps/web/package.json', dependencies: ['msw', 'zustand'] },
      { globId: 's1t3', sha: 'm2', path: 'tools/requirements-dev.txt', dependencies: ['ruff'] },
    ]);
    // A new file has no before; source files and removed manifests aren't read.
    expect(reads).toEqual(['p1:apps/web/package.json', 'm1:apps/web/package.json', 'm2:tools/requirements-dev.txt']);
    expect(logged).toEqual(["Reading the manifests of s1t2's merge missing failed: No commit missing"]);
  });

  it('reads a renamed manifest before the commit at its previous path (s15f8)', async () => {
    const { host, reads } = fakeHost(
      { m1: { parent: 'p1', files: [{ path: 'web/package.json', previousPath: 'app/package.json', status: 'renamed' }] } },
      {
        'p1:app/package.json': JSON.stringify({ dependencies: { react: '1' } }),
        'm1:web/package.json': JSON.stringify({ dependencies: { react: '1', zod: '4' } }),
      },
    );
    const changes = await new CodeHostManifests(host, () => undefined).manifestChanges(board, [{ globId: 's1t1', sha: 'm1' }]);
    expect(changes).toEqual([{ globId: 's1t1', sha: 'm1', path: 'web/package.json', dependencies: ['zod'] }]);
    expect(reads).toEqual(['p1:app/package.json', 'm1:web/package.json']);
  });

  it('gives every code-host call its own timeout signal, so a hung request fails its commit instead of holding the run (s15f8)', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const host = {
      configured: true,
      commitFiles: (_repo: Repo, _sha: string, signal?: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve<CommitFiles>({ parent: 'p1', files: [{ path: 'package.json', previousPath: null, status: 'modified' }] });
      },
      readFile: (_repo: Repo, _ref: string, _path: string, signal?: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve('{}');
      },
    };
    await new CodeHostManifests(host, () => undefined).manifestChanges(board, [{ globId: 's1t1', sha: 'm1' }]);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    expect(new Set(signals).size).toBe(3);
  });

  it('measures nothing without a reachable repo', async () => {
    const { host } = fakeHost({}, {}, false);
    const manifests = new CodeHostManifests(host, () => undefined);
    expect(await manifests.manifestChanges(board, [{ globId: 's1t1', sha: 'm1' }])).toBeNull();
    expect(await new CodeHostManifests(fakeHost({}, {}).host, () => undefined).manifestChanges({ ...board, repo: null }, [])).toBeNull();
  });

  it('parses the Slop-Agent-Set trailer', () => {
    expect(agentSetTrailer('s1t1: work\n\n- change\n\nSlop-Agent-Set: 12\nSlop-Run: abc')).toBe(12);
    expect(agentSetTrailer('s1t1: work\n\nSlop-Agent-Set: v7')).toBe(7);
    expect(agentSetTrailer('s1t1: work\n\nSlop-Agent-Set: <v>')).toBeNull();
    expect(agentSetTrailer('s1t1: mentions Slop-Agent-Set: 3 in the subject')).toBeNull();
    expect(agentSetTrailer(null)).toBeNull();
  });
});
