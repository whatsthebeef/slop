import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_actormode_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0077_actor_mode_fix_workkind';

interface Data {
  category: string;
  fix?: boolean;
  fixSource?: string;
  workKind?: string;
  workKindSource?: string;
  inferenceReason?: string | null;
}

/** Migration 0077: fix and work kind are backfilled from the category, once, and a person's values are kept. */
describe('fix and work kind backfill (migration 0077)', () => {
  let admin: Database;
  let database: Database;

  const insert = async (id: string, category: string, type: string | null, extra: Partial<Data> = {}) => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, 'planning', ${type}, 'x', ${JSON.stringify({ id, category, type, ...extra })}::jsonb, now())`,
    );
  };
  const read = async (id: string): Promise<Data | undefined> => {
    const rows = await database.db.execute<{ data: Data }>(sql`select data from globs where id = ${id}`);
    return rows[0]?.data;
  };
  const all = () => database.db.execute(sql`select id, type, data from globs order by id`);

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'actor-mode-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back (a slice, not a filter), so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`);
    await insert('s1f1', 'feature', 'same');
    await insert('s1t1', 'task', 'sub');
    await insert('s1b1', 'bug', 'same');
    await insert('s1k1', 'decision', null);
    await insert('s1a1', 'action', null);
    // A glob a person already corrected before the migration ran on a later deploy: its values stay.
    await insert('s1t2', 'task', 'same', { fix: true, fixSource: 'person', workKind: 'rnd', workKindSource: 'person', inferenceReason: 'mine' });
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('a feature is R&D and not a fix', async () => {
    expect(await read('s1f1')).toMatchObject({ fix: false, fixSource: 'inferred', workKind: 'rnd', workKindSource: 'inferred', inferenceReason: null });
  });

  it('a task is maintenance and not a fix', async () => {
    expect(await read('s1t1')).toMatchObject({ fix: false, workKind: 'maintenance', fixSource: 'inferred', workKindSource: 'inferred' });
  });

  it('a bug is a fix and maintenance', async () => {
    expect(await read('s1b1')).toMatchObject({ fix: true, workKind: 'maintenance' });
  });

  it('leaves decisions and actions untouched', async () => {
    for (const id of ['s1k1', 's1a1']) {
      const data = await read(id);
      expect(data).not.toHaveProperty('fix');
      expect(data).not.toHaveProperty('workKind');
    }
  });

  it('keeps a record that already has a fix flag', async () => {
    expect(await read('s1t2')).toMatchObject({ fix: true, fixSource: 'person', workKind: 'rnd', workKindSource: 'person', inferenceReason: 'mine' });
  });

  it('keeps the category and type', async () => {
    expect(await read('s1b1')).toMatchObject({ category: 'bug', type: 'same' });
  });

  it('changes nothing when its data statement runs again', async () => {
    const before = await all();
    const sqlText = await readFile(new URL('../drizzle/0077_actor_mode_fix_workkind.sql', import.meta.url), 'utf8');
    await database.db.execute(sql.raw(sqlText));
    expect(await all()).toEqual(before);
  });
});
