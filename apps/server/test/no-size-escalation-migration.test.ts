import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_no_size_escalation_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0076_no_size_escalation';

/** The migration that reverts size escalations (0076), against Postgres: migrated up to the one before, rows left by the old size check, then it. */
describe('the size check no longer escalates (migration 0076)', () => {
  let admin: Database;
  let database: Database;

  const escalation = (criterion: string) => ({ reason: 'Flagged oversized: 6 tasks', criterion, evidence: 'moved a.ts', by: 'slop', at: '2026-10-15T13:37:00.000Z' });
  const glob = async (id: string, status: string, type: string, extra: Record<string, unknown> = {}) => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, ${status}, ${type}, 'x', ${JSON.stringify({ createdAt: '2026-10-01T00:00:00.000Z', type, ...extra })}::jsonb, now())`,
    );
  };
  const row = async (id: string) => {
    const rows = await database.db.execute<{ type: string; data: Record<string, unknown> }>(sql`select type, data from globs where id = ${id}`);
    return rows[0];
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'no-size-escalation-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration (and any later one) is held back, so that it runs against the seeded rows.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(
      sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b1', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`,
    );
    await glob('s1t1', 'planning', 'same', { escalation: escalation('size') });
    await glob('s1t2', 'implementing', 'same', { escalation: escalation('size') });
    await glob('s1t3', 'reviewing', 'same', { escalation: escalation('size') });
    await glob('s1t4', 'planning', 'same', { escalation: escalation('risk_area') });
    await glob('s1t5', 'planning', 'same');
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('turns open size-escalated globs back into subs and clears the escalation', async () => {
    for (const id of ['s1t1', 's1t2']) {
      const r = await row(id);
      expect(r?.type).toBe('sub');
      expect(r?.data).toMatchObject({ type: 'sub' });
      expect(r?.data).not.toHaveProperty('escalation');
    }
  });

  it('leaves merged globs, other escalations and unescalated globs alone', async () => {
    expect((await row('s1t3'))?.type).toBe('same');
    expect((await row('s1t3'))?.data).toHaveProperty('escalation');
    expect((await row('s1t4'))?.type).toBe('same');
    expect((await row('s1t4'))?.data).toHaveProperty('escalation');
    expect((await row('s1t5'))?.type).toBe('same');
  });
});
