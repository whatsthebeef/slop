import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_humanwork_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0075_human_work_no_type';

/** Migration 0075: decision globs lose their `same` type, in the column and the document; the column takes null. */
describe('human work has no type (migration 0075)', () => {
  let admin: Database;
  let database: Database;

  const insert = async (id: string, category: string, type: string | null) => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, 'planning', ${type}, 'x', ${JSON.stringify({ id, category, type })}::jsonb, now())`,
    );
  };
  const read = async (id: string) => {
    const rows = await database.db.execute<{ type: string | null; data: { type?: string | null; category: string } }>(sql`select type, data from globs where id = ${id}`);
    return rows[0];
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'human-work-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back (a slice, not a filter), so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`);
    await insert('s1k1', 'decision', 'same');
    await insert('s1k2', 'decision', 'same');
    await insert('s1t1', 'task', 'same');
    await insert('s1t2', 'task', 'sub');
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('nulls the type of decision globs in the column and the document', async () => {
    for (const id of ['s1k1', 's1k2']) {
      const row = await read(id);
      expect(row?.type).toBeNull();
      expect(row?.data.type).toBeNull();
    }
  });

  it('leaves code work alone', async () => {
    expect(await read('s1t1')).toMatchObject({ type: 'same', data: { type: 'same' } });
    expect(await read('s1t2')).toMatchObject({ type: 'sub', data: { type: 'sub' } });
  });

  it('changes nothing when its data statement runs again', async () => {
    const before = await database.db.execute(sql`select id, type, data from globs order by id`);
    await database.db.execute(
      sql`UPDATE "globs" SET "type" = NULL, "data" = jsonb_set("data", '{type}', 'null'::jsonb) WHERE "data"->>'category' = 'decision' AND ("type" IS NOT NULL OR "data"->>'type' IS NOT NULL)`,
    );
    expect(await database.db.execute(sql`select id, type, data from globs order by id`)).toEqual(before);
  });

  it('lets a glob without a type be stored (an action or a decision)', async () => {
    await insert('s1a1', 'action', null);
    expect(await read('s1a1')).toMatchObject({ type: null });
  });
});
