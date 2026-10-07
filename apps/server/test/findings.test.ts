import { readFile } from 'node:fs/promises';
import { ArtifactService, FindingsPipeline, FindingsService, GlobService, SPLIT_SYSTEM } from '@slop/core';
import type { Llm, NewFinding, NewReviewSource, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const STRUCTURED = '## Review (round 1)\n\n#### IN-SCOPE\n\n1. **[src/job.ts:10]** The job retries forever.\n2. Missing test for the retry path.\n';
const FREE_FORM = 'The reviewer found that nothing tests the retry path; it was fixed.';
const CLASSIFIED = JSON.stringify({ class: 'missing-test', note: 'No test for retries' });

describe('Review findings in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let artifacts: ArtifactService;
  let findings: FindingsService;
  let globs: GlobService;
  let boardId: number;
  const now = '2026-10-05T12:00:00.000Z';
  const clock = { now: () => now };
  const notifier = { publish: () => undefined };

  const newGlob = async () =>
    unwrap(
      await globs.create(DEV, {
        boardId,
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

  const source = (globId: string, patch: Partial<NewReviewSource> = {}): NewReviewSource => ({
    boardId,
    globId,
    kind: 'coderabbit_comment',
    artifactId: null,
    externalId: null,
    commitSha: 'abc',
    agentSetVersion: 2,
    content: 'body',
    path: 'a.ts',
    line: '3',
    createdAt: now,
    ...patch,
  });

  const newFinding = (globId: string, sourceId: number, text: string): NewFinding => ({
    boardId,
    globId,
    sourceId,
    source: 'coderabbit',
    commitSha: 'abc',
    agentSetVersion: 2,
    severity: 'in_scope',
    round: null,
    path: 'a.ts',
    line: '3',
    text,
    fingerprint: text.toLowerCase(),
  });

  /** Marks everything queued as done, so each test starts with an empty queue. */
  const clearQueue = async () => {
    await database.db.execute(sql`update review_sources set state = 'split' where state = 'pending'`);
    await database.db.execute(sql`update review_findings set state = 'classified', class = 'other' where state = 'pending'`);
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('findings'));
    store = new PgStore(database.db);
    artifacts = new ArtifactService({ store, clock, notifier });
    findings = new FindingsService({ store, clock, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
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
  });

  afterAll(async () => {
    await drop();
  });

  it('round-trips sources and findings, unique by artifact, external ID and fingerprint', async () => {
    const globId = await newGlob();
    const created = await store.transaction(async (tx) => ({
      a: await tx.insertReviewSource(source(globId, { externalId: 'coderabbit:1' })),
      again: await tx.insertReviewSource(source(globId, { externalId: 'coderabbit:1' })),
      // Many sources have no external ID (local reviews) or no artifact (comments).
      b: await tx.insertReviewSource(source(globId, { kind: 'local_review', artifactId: 77, content: null })),
      c: await tx.insertReviewSource(source(globId, { kind: 'local_review', artifactId: 78, content: null })),
      sameArtifact: await tx.insertReviewSource(source(globId, { kind: 'local_review', artifactId: 77, content: null })),
    }));
    expect(created.a).toMatchObject({ state: 'pending', attempts: 0, processAfter: null, error: null, version: 1, line: '3', createdAt: now });
    expect(created.again).toBeNull();
    expect(created.sameArtifact).toBeNull();
    expect(created.b?.artifactId).toBe(77);
    expect(created.c).not.toBeNull();
    if (created.a === null) throw new Error('No source');
    const sourceId = created.a.id;

    const inserted = await store.transaction(async (tx) => [
      await tx.insertFindings([newFinding(globId, sourceId, 'One'), newFinding(globId, sourceId, 'Two'), newFinding(globId, sourceId, 'One')], now),
      await tx.insertFindings([newFinding(globId, sourceId, 'Two'), newFinding(globId, sourceId, 'Three')], now),
      await tx.insertFindings([], now),
    ]);
    expect(inserted).toEqual([2, 1, 0]);
    const [first] = await store.transaction((tx) => tx.listFindings(globId));
    expect(first).toMatchObject({ text: 'One', class: null, classNote: null, state: 'pending', classifiedAt: null, version: 1 });
    if (first === undefined) throw new Error('No finding');

    const classified = { ...first, class: 'edge-case' as const, classNote: 'n', state: 'classified' as const, classifiedAt: now, version: 2 };
    expect(await store.transaction((tx) => tx.updateFinding(classified, 1))).toBe(true);
    expect(await store.transaction((tx) => tx.updateFinding({ ...classified, version: 3 }, 1))).toBe(false);
    expect(await store.transaction((tx) => tx.getFinding(first.id))).toMatchObject({ class: 'edge-case', state: 'classified', classifiedAt: now });

    const leased = { ...created.a, processAfter: '2026-10-05T12:02:00.000Z', version: 2 };
    expect(await store.transaction((tx) => tx.updateReviewSource(leased, 1))).toBe(true);
    expect(await store.transaction((tx) => tx.updateReviewSource({ ...leased, version: 3 }, 1))).toBe(false);
    expect(await store.transaction((tx) => tx.nextReviewSourceToSplit(now))).not.toMatchObject({ id: sourceId });
    expect((await store.transaction((tx) => tx.listBoardFindings(boardId, now, now))).filter((f) => f.globId === globId)).toHaveLength(3);
    expect(await store.transaction((tx) => tx.listBoardFindings(boardId, '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z'))).toEqual([]);
    // Windowed by when the review was written: findings split later from an older review count from its time.
    expect(await store.transaction((tx) => tx.listBoardFindings(boardId, '2026-09-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z'))).toEqual([]);

    await store.transaction((tx) => tx.deleteGlob(globId));
    expect(await store.transaction((tx) => tx.listFindings(globId))).toEqual([]);
    expect(await store.transaction((tx) => tx.listReviewSources(globId))).toEqual([]);
  });

  it('backfills existing local reviews as pending sources, and runs again harmlessly', async () => {
    await clearQueue();
    const globId = await newGlob();
    // Stored before the migration existed: no source yet.
    const review = await store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind: 'local_review',
        label: '',
        content: STRUCTURED,
        link: null,
        commitSha: 'be0976c',
        provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: 7 },
        createdAt: '2026-09-01T10:00:00.000Z',
      }),
    );
    const migration = await readFile(new URL('../drizzle/0015_review_findings.sql', import.meta.url), 'utf8');
    const statements = migration.split('--> statement-breakpoint');
    for (let run = 0; run < 2; run++) {
      for (const statement of statements) await database.db.execute(sql.raw(statement));
    }
    expect(await store.transaction((tx) => tx.listReviewSources(globId))).toEqual([
      expect.objectContaining({
        kind: 'local_review',
        artifactId: review.id,
        boardId,
        commitSha: 'be0976c',
        agentSetVersion: 7,
        state: 'pending',
        createdAt: '2026-09-01T10:00:00.000Z',
      }),
    ]);
  });

  it('queues a put local review and splits and classifies it end to end', async () => {
    await clearQueue();
    const globId = await newGlob();
    unwrap(await artifacts.putArtifact(DEV, globId, 'local_review', STRUCTURED, { commitSha: 'c0ffee1', runId: null, agentSetVersion: 3 }));
    const calls: string[] = [];
    const llm: Llm = {
      complete: (request) => {
        calls.push(request.system);
        return Promise.resolve(CLASSIFIED);
      },
    };
    const pipeline = new FindingsPipeline({ store, clock, notifier, llm });
    for (let i = 0; i < 10 && (await pipeline.processNext()) !== null; i++) {
      // Drains the split and both classifications.
    }
    expect(calls).toHaveLength(2);
    const view = unwrap(await findings.forGlob(DEV, globId));
    expect(view).toMatchObject({
      byClass: [{ class: 'missing-test', total: 2, inScope: 2, suggestions: 0 }],
      pending: 0,
      failed: 0,
      sources: { pending: 0, failed: 0 },
    });
    expect(view.findings[0]).toMatchObject({ path: 'src/job.ts', line: '10', round: 1, commitSha: 'c0ffee1', agentSetVersion: 3, classNote: 'No test for retries' });
  });

  it('lets only one of two concurrent workers claim a source', async () => {
    await clearQueue();
    const globId = await newGlob();
    unwrap(await artifacts.putArtifact(DEV, globId, 'local_review', FREE_FORM, { commitSha: null, runId: null, agentSetVersion: null }));
    let splitCalls = 0;
    // The claiming worker's model call waits until the other worker has come back empty-handed:
    // once split, its findings are legitimately due for classification, so an instant answer would
    // let the second worker claim one of them and make the test racy.
    let release = (): void => undefined;
    const otherWorkerDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: Llm = {
      complete: async (request) => {
        await otherWorkerDone;
        if (request.system === SPLIT_SYSTEM) splitCalls++;
        return JSON.stringify({
          findings: [{ severity: 'in_scope', path: null, line: null, quote: 'nothing tests the retry path', text: 'No test for retries.' }],
        });
      },
    };
    const workers = [0, 1].map(() => new FindingsPipeline({ store, clock, notifier, llm }));
    const results = await Promise.all(
      workers.map(async (w) => {
        let claimed: string | null = null;
        try {
          claimed = await w.processNext();
          return claimed;
        } finally {
          // The losing worker releases the gate; on a store error too, so the test fails fast.
          if (claimed === null) release();
        }
      }),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(splitCalls).toBe(1);
    expect(await store.transaction((tx) => tx.listFindings(globId))).toEqual([
      expect.objectContaining({ text: 'No test for retries.', state: 'pending', severity: 'in_scope' }),
    ]);
  });

  it('hands out due sources and findings oldest first, skipping leased and finished ones (s15f8)', async () => {
    await clearQueue();
    const globId = await newGlob();
    const ids = await store.transaction(async (tx) => {
      const later = await tx.insertReviewSource(source(globId, { externalId: 'coderabbit:order-2', createdAt: '2026-10-05T11:00:00.000Z' }));
      const older = await tx.insertReviewSource(source(globId, { externalId: 'coderabbit:order-1', createdAt: '2026-10-05T10:00:00.000Z' }));
      if (later === null || older === null) throw new Error('No source');
      return { later, older };
    });
    expect(await store.transaction((tx) => tx.nextReviewSourceToSplit(now))).toMatchObject({ id: ids.older.id });
    // Leased into the future: the next one is due instead.
    await store.transaction((tx) => tx.updateReviewSource({ ...ids.older, processAfter: '2026-10-05T12:02:00.000Z', version: 2 }, 1));
    expect(await store.transaction((tx) => tx.nextReviewSourceToSplit(now))).toMatchObject({ id: ids.later.id });
    // Its lease running out makes it due again.
    expect(await store.transaction((tx) => tx.nextReviewSourceToSplit('2026-10-05T12:02:00.000Z'))).toMatchObject({ id: ids.older.id });
    await store.transaction((tx) => tx.updateReviewSource({ ...ids.later, state: 'split', version: 2 }, 1));
    await store.transaction((tx) => tx.updateReviewSource({ ...ids.older, state: 'failed', processAfter: null, version: 3 }, 2));
    expect(await store.transaction((tx) => tx.nextReviewSourceToSplit('2026-10-06T00:00:00.000Z'))).toBeNull();

    await store.transaction((tx) => tx.insertFindings([newFinding(globId, ids.older.id, 'First'), newFinding(globId, ids.older.id, 'Second')], now));
    const [first, second] = await store.transaction((tx) => tx.listFindings(globId));
    if (first === undefined || second === undefined) throw new Error('No findings');
    expect(await store.transaction((tx) => tx.nextFindingToClassify(now))).toMatchObject({ id: first.id });
    await store.transaction((tx) => tx.updateFinding({ ...first, processAfter: '2026-10-05T12:02:00.000Z', version: 2 }, 1));
    expect(await store.transaction((tx) => tx.nextFindingToClassify(now))).toMatchObject({ id: second.id });
    await store.transaction((tx) => tx.updateFinding({ ...second, state: 'failed', version: 2 }, 1));
    expect(await store.transaction((tx) => tx.nextFindingToClassify(now))).toBeNull();
  });

  it('deletes the findings and sources of a deleted glob only (s15f8)', async () => {
    await clearQueue();
    const [doomed, kept] = [await newGlob(), await newGlob()];
    for (const globId of [doomed, kept]) {
      unwrap(await artifacts.putArtifact(DEV, globId, 'local_review', STRUCTURED, { commitSha: null, runId: null, agentSetVersion: null }));
    }
    const pipeline = new FindingsPipeline({ store, clock, notifier, llm: { complete: () => Promise.resolve(CLASSIFIED) } });
    await pipeline.processNext();
    await pipeline.processNext();
    await store.transaction((tx) => tx.deleteGlob(doomed));
    expect(await store.transaction((tx) => tx.listReviewSources(doomed))).toEqual([]);
    expect(await store.transaction((tx) => tx.listFindings(doomed))).toEqual([]);
    expect(await store.transaction((tx) => tx.listReviewSources(kept))).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listFindings(kept))).toHaveLength(2);
  });
});
