import { BoardService, FakeEmbedder, GlobService, IntakeLearningService, nearestExamples } from '@slop/core';
import type { DomainEvent, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const CREATED = '2026-10-01T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.parse(CREATED) + ms).toISOString();

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('Learned task categorisation in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let learning: IntakeLearningService;
  let boardId: number;
  const embedder = new FakeEmbedder();
  let now = CREATED;
  const clock = { now: () => now };
  const notifier = { publish: () => undefined };

  const create = async (request: string, over: Partial<Parameters<GlobService['create']>[1]> = {}) =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: request.slice(0, 30),
        summary: request,
        plan: `${request}\n\nDone when: it works.`,
        type: 'same',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...over,
      }),
    );
  const merge = (globId: string, when: string) =>
    store.transaction((tx) => tx.appendEvents([{ type: 'Merged', globId, actor: null, at: when, data: { sha: 'abc' } } satisfies DomainEvent]));
  const outcomes = () => store.transaction((tx) => tx.listGlobOutcomes(boardId));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('intake_learning'));
    store = new PgStore(database.db);
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) }, embedder });
    learning = new IntakeLearningService({ store, clock, embedder });
  });

  afterAll(async () => {
    await drop();
  });

  it('writes the snapshot with the create, with its embedding, and never edits it', async () => {
    const glob = await create('Export the board as a CSV file', {
      intake: { request: 'export the board as csv', source: 'mcp', categoryConfidence: 'medium', reason: 'New capability', model: 'haiku', promptVersion: 2, examples: [] },
    });
    // Editing the glob afterwards leaves the snapshot as it was created.
    unwrap(await globs.update(DEV, glob.id, glob.version, { category: 'bug', title: 'Renamed' }));
    const snapshot = (await store.transaction((tx) => tx.listLatestIntakeSnapshots(boardId))).find((s) => s.globId === glob.id);
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(snapshot).toMatchObject({
      version: 1,
      request: 'export the board as csv',
      source: 'mcp',
      decisions: { type: 'same', category: 'feature', categoryConfidence: 'medium', reason: 'New capability', model: 'haiku', promptVersion: 2 },
      features: { doneWhenLines: 1 },
      backfilled: false,
    });
    expect(snapshot.title).not.toBe('Renamed');
    const stored = await database.db.execute(sql`select embedding is not null as embedded from intake_snapshots where glob_id = ${glob.id}`);
    expect(stored[0]?.embedded).toBe(true);
    // A second insert of the same version is refused.
    expect(await store.transaction((tx) => tx.insertIntakeSnapshot({ ...snapshot, request: 'other' }, null))).toBe(false);
  });

  it('records the outcome at merge, refreshes it at 14 days and then leaves it', async () => {
    const glob = await create('Add a login page for guests');
    const changed = await create('Add a guest login page as well');
    unwrap(await globs.update(DEV, changed.id, changed.version, { category: 'bug' }));
    await merge(glob.id, at(DAY));
    await merge(changed.id, at(DAY));
    now = at(2 * DAY);
    expect(await learning.run(boardId, now)).toMatchObject({ recorded: 2, refreshed: 0 });
    const first = await outcomes();
    expect(first.find((o) => o.globId === glob.id)).toMatchObject({ final: false, corrections: { category: null } });
    expect(first.find((o) => o.globId === changed.id)).toMatchObject({ corrections: { category: { from: 'feature', to: 'bug', by: DEV } } });
    expect(await learning.run(boardId, at(5 * DAY))).toMatchObject({ recorded: 0, refreshed: 0 });
    now = at(16 * DAY);
    expect(await learning.run(boardId, now)).toMatchObject({ recorded: 0, refreshed: 2 });
    expect((await outcomes()).every((o) => o.final)).toBe(true);
    expect(await learning.run(boardId, at(40 * DAY))).toMatchObject({ recorded: 0, refreshed: 0 });
  });

  it('orders the nearest snapshots by distance, corrected ones first', async () => {
    const vector = (await embedder.embed(['Add a login page for guests']))[0] ?? [];
    const near = await store.transaction((tx) => tx.nearestIntakeSnapshots(boardId, vector, 10));
    expect(near[0]?.distance).toBeCloseTo(0, 1);
    expect(near.map((n) => n.distance)).toEqual([...near.map((n) => n.distance)].sort((a, b) => a - b));
    const examples = await store.transaction((tx) => nearestExamples(tx, boardId, vector));
    // The guest-login glob a person recategorised comes first although the other one is nearer.
    expect(examples[0]).toMatchObject({ corrected: true, category: 'bug', note: 'category changed feature -> bug' });
    expect(examples.slice(1).every((e) => !e.corrected)).toBe(true);
  });

  it('backfills snapshots for globs that have none, marked backfilled, and embeds them', async () => {
    const glob = await create('An older piece of work');
    await database.db.execute(sql`delete from intake_snapshots where glob_id = ${glob.id}`);
    const run = await learning.run(boardId, now);
    expect(run).toMatchObject({ backfilled: 1, embedded: 1 });
    const stored = (await store.transaction((tx) => tx.listLatestIntakeSnapshots(boardId))).find((s) => s.globId === glob.id);
    expect(stored).toMatchObject({ backfilled: true, source: 'backfill', decisions: { type: 'same', category: 'feature', promptVersion: null } });
    expect(await learning.run(boardId, now)).toMatchObject({ backfilled: 0, embedded: 0 });
  });

  it('shows accuracy to members and deletes snapshots and outcomes with the glob', async () => {
    const accuracy = unwrap(await learning.accuracy(DEV, boardId));
    // The backfilled glob and unmerged ones leave the counts alone; the two merged ones are counted.
    expect(accuracy).toMatchObject({ merged: 2, corrected: 1 });
    expect((await learning.accuracy('outsider@example.com', boardId)).ok).toBe(false);
    const [victim] = await outcomes();
    await store.transaction((tx) => tx.deleteGlob(victim?.globId ?? ''));
    expect((await outcomes()).some((o) => o.globId === victim?.globId)).toBe(false);
  });
});
