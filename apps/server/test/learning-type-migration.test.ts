import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_learningtype_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0053_learning_type_decision_to_pattern';

/** The migration that drops the `decision` learning type, against Postgres: migrated up to the one before, rows, then it. */
describe('decision learnings become patterns (migration 0053)', () => {
  let admin: Database;
  let database: Database;

  const insert = async (id: string, data: Record<string, unknown>) => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, 'planning', 'same', 'x', ${JSON.stringify(data)}::jsonb, now())`,
    );
  };
  const kindOf = async (id: string) => {
    const rows = await database.db.execute<{ data: { attributes?: { kind?: string; scope?: unknown } } }>(sql`select data from globs where id = ${id}`);
    return rows[0]?.data.attributes;
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'learning-type-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back, so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`);
    const scope = { kind: 'project', ref: null };
    await insert('s1k1', { category: 'decision', attributes: { kind: 'decision', scope } });
    await insert('s1k2', { category: 'decision', attributes: { kind: 'gotcha', scope } });
    await insert('s1k3', { category: 'task', attributes: { kind: 'decision' } });
    await insert('s1k4', { category: 'decision', attributes: { scope, origin: { kind: 'inbox' } } });
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('turns kind decision into pattern on decision globs, keeping their scope', async () => {
    expect(await kindOf('s1k1')).toEqual({ kind: 'pattern', scope: { kind: 'project', ref: null } });
  });

  it('leaves other kinds, other categories and globs without a kind alone', async () => {
    expect((await kindOf('s1k2'))?.kind).toBe('gotcha');
    expect((await kindOf('s1k3'))?.kind).toBe('decision');
    expect((await kindOf('s1k4'))?.kind).toBeUndefined();
  });
});
