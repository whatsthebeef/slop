import { readFile } from 'node:fs/promises';
import { GlobService, machine } from '@slop/core';
import type { Result } from '@slop/core';
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

describe('sign-off label checklists in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let boardId = 0;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('labels'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'labels',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  const mergedGlob = async () => {
    const glob = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Checklist',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    return unwrap(
      await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: 'abc' }, ctx)),
    );
  };

  it('stores checklist items and ticks with the glob', async () => {
    const reviewing = await mergedGlob();
    const added = unwrap(
      await globs.reviewLabel(DEV, reviewing.id, reviewing.version, 'CR', {
        kind: 'submit_items',
        items: ['Rename x', 'Add test'],
      }),
    );
    unwrap(
      await globs.reviewLabel(DEV, added.id, added.version, 'CR', {
        kind: 'tick',
        itemId: '2',
        done: true,
      }),
    );
    const stored = await store.transaction((tx) => tx.getGlob(reviewing.id));
    expect(stored?.labels).toEqual({ FR: 'required', CR: 'added', QA: 'required' });
    expect(stored?.checklists.CR?.map((i) => [i.id, i.text, i.done, i.addedBy, i.doneBy])).toEqual([
      ['1', 'Rename x', false, DEV, null],
      ['2', 'Add test', true, DEV, DEV],
    ]);
  });

  it('stores draft items with the glob until they are sent', async () => {
    const reviewing = await mergedGlob();
    const first = unwrap(
      await globs.reviewLabel(DEV, reviewing.id, reviewing.version, 'QA', { kind: 'save_draft_item', text: 'Check copy' }),
    );
    const second = unwrap(await globs.reviewLabel(DEV, first.id, first.version, 'QA', { kind: 'save_draft_item', text: 'Check A11y' }));
    const edited = unwrap(
      await globs.reviewLabel(DEV, second.id, second.version, 'QA', { kind: 'save_draft_item', text: 'Check a11y', itemId: '2' }),
    );
    expect(edited.version).toBeGreaterThan(reviewing.version);
    const stored = await store.transaction((tx) => tx.getGlob(reviewing.id));
    expect(stored?.labels.QA).toBe('required');
    expect(stored?.checklists.QA?.map((i) => [i.id, i.text, i.draft])).toEqual([
      ['1', 'Check copy', true],
      ['2', 'Check a11y', true],
    ]);
    const removed = unwrap(await globs.reviewLabel(DEV, edited.id, edited.version, 'QA', { kind: 'remove_draft_item', itemId: '1' }));
    const sent = unwrap(await globs.reviewLabel(DEV, removed.id, removed.version, 'QA', { kind: 'send_items' }));
    expect(sent.labels.QA).toBe('added');
    expect(sent.checklists.QA?.map((i) => [i.id, i.text, i.draft])).toEqual([['2', 'Check a11y', undefined]]);
  });

  it('migration 0006 renames added to approved in globs and events and adds empty checklists', async () => {
    const reviewing = await mergedGlob();
    // Put the glob and an event back into the shape stored before 0006.
    await database.db.execute(sql`
      update globs set data = (data - 'checklists') || ${JSON.stringify({ labels: { FR: 'added', CR: 'required', QA: 'added' } })}::jsonb
      where id = ${reviewing.id}`);
    await database.db.execute(sql`
      insert into events (glob_id, type, actor, at, data)
      values (${reviewing.id}, 'LabelChanged', ${DEV}, now(), ${JSON.stringify({ label: 'FR', from: 'required', to: 'added' })}::jsonb)`);

    const migration = await readFile(
      new URL('../drizzle/0006_label_checklists.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await database.db.execute(sql.raw(statement));
    }

    const stored = await store.transaction((tx) => tx.getGlob(reviewing.id));
    expect(stored?.labels).toEqual({ FR: 'approved', CR: 'required', QA: 'approved' });
    expect(stored?.checklists).toEqual({});
    const events = await database.db.execute<{ data: unknown }>(
      sql`select data from events where glob_id = ${reviewing.id} and type = 'LabelChanged'`,
    );
    expect(events.map((e) => e.data)).toEqual([{ label: 'FR', from: 'required', to: 'approved' }]);
  });

  it('migration 0006 run again leaves labels waiting on developers alone', async () => {
    const reviewing = await mergedGlob();
    // A glob already in the new shape: CR has items added (the developer's turn).
    await database.db.execute(sql`
      update globs set data = data || ${JSON.stringify({ labels: { FR: 'approved', CR: 'added', QA: 'required' }, checklists: {} })}::jsonb
      where id = ${reviewing.id}`);
    await database.db.execute(sql`
      insert into events (glob_id, type, actor, at, data)
      values (${reviewing.id}, 'LabelChanged', ${DEV}, now(), ${JSON.stringify({ label: 'CR', from: 'required', to: 'added', items: ['x'] })}::jsonb)`);

    const migration = await readFile(new URL('../drizzle/0006_label_checklists.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      await database.db.execute(sql.raw(statement));
    }

    const stored = await store.transaction((tx) => tx.getGlob(reviewing.id));
    expect(stored?.labels).toEqual({ FR: 'approved', CR: 'added', QA: 'required' });
    const events = await database.db.execute<{ data: unknown }>(
      sql`select data from events where glob_id = ${reviewing.id} and type = 'LabelChanged'`,
    );
    expect(events.map((e) => e.data)).toEqual([{ label: 'CR', from: 'required', to: 'added', items: ['x'] }]);
  });
});
