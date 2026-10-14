import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_scope_cut_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0071_split_scope_cut';

/** The scope-cut migration (0071), against Postgres: migrated up to the one before, rows left by the old split rules, then it. */
describe('a split is a scope cut (migration 0071)', () => {
  let admin: Database;
  let database: Database;

  const glob = async (id: string, status: string, data: Record<string, unknown> = {}, type = 'same') => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, ${status}, ${type}, 'x', ${JSON.stringify({ createdAt: '2026-10-01T00:00:00.000Z', ...data })}::jsonb, now())`,
    );
  };
  const splitEvent = (id: string) =>
    database.db.execute(
      sql`insert into events (glob_id, type, actor, at, data) values (${id}, 'GlobSplit', 'x', '2026-10-02T00:00:00.000Z', ${JSON.stringify({ source: 's1t1', part: 1, parts: ['s1t1', id] })}::jsonb)`,
    );
  const relation = async (id: string, from: string, to: string, gate: string, source: string, extra: { dismissed?: boolean; overridden?: boolean } = {}) => {
    await database.db.execute(
      sql`insert into relations (id, board_id, from_glob, to_glob, gate, until, source, dismissed_at, overridden_at, created_at)
          values (${id}, 1, ${from}, ${to}, ${gate}, 'merged', ${source}, ${extra.dismissed === true ? '2026-10-03T00:00:00.000Z' : null}, ${extra.overridden === true ? '2026-10-03T00:00:00.000Z' : null}, now())`,
    );
  };
  const check = async (id: string, flagged: boolean, decision: string | null) => {
    await database.db.execute(
      sql`insert into glob_size_checks (glob_id, board_id, plan_hash, estimate, evidence, threshold, flagged, reasons, proposal, decision, decided_by, decided_at, created_at, updated_at)
          values (${id}, 1, 'h', '{}'::jsonb, '[]'::jsonb, '{"maxTasks":5,"maxParts":3}'::jsonb, ${flagged}, '[]'::jsonb, ${JSON.stringify({ parts: [{ title: 'A', plan: 'p', after: [] }] })}::jsonb, ${decision}, ${decision === null ? null : 'dev@example.com'}, ${decision === null ? null : '2026-10-03T00:00:00.000Z'}, now(), now())`,
    );
  };
  const dataOf = async (id: string): Promise<Record<string, unknown>> => {
    const rows = await database.db.execute<{ data: Record<string, unknown> }>(sql`select data from globs where id = ${id}`);
    return rows[0]?.data ?? {};
  };
  const relationRow = async (id: string) => {
    const rows = await database.db.execute<{ dismissed_at: string | null; overridden_at: string | null }>(sql`select dismissed_at, overridden_at from relations where id = ${id}`);
    return rows[0];
  };

  const migrateOnce = async (folder: string) => {
    await runMigrations(URL_, folder);
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'scope-cut-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration (and any later one) is held back, so that it runs against the seeded rows.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await migrateOnce(folder);
    database = connect(URL_);
    await database.db.execute(
      sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b1', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`,
    );

    // Split relations: s1t1 was cut into s1t2 (open sign-off), s1t3 (sign-off already dismissed), s1t4 (sign-off overridden); s1t3 starts after s1t2.
    for (const id of ['s1t1', 's1t2', 's1t3', 's1t4']) await glob(id, 'planning');
    await relation('rel_so_open', 's1t1', 's1t2', 'sign_off', 'split');
    await relation('rel_so_dismissed', 's1t1', 's1t3', 'sign_off', 'split', { dismissed: true });
    await relation('rel_so_overridden', 's1t1', 's1t4', 'sign_off', 'split', { overridden: true });
    await relation('rel_start_split', 's1t3', 's1t2', 'start', 'split');
    // A person's own sign-off relation stays as it is.
    await relation('rel_so_person', 's1t2', 's1t4', 'sign_off', 'person');

    // autoStart from a split: a part waiting in Planning, one already running, one with the flag but no split event (left alone).
    await glob('s1t10', 'planning', { autoStart: true, waiting: { since: '2026-10-01T00:00:00.000Z' }, title: 'part' });
    await splitEvent('s1t10');
    await glob('s1t11', 'implementing', { autoStart: true });
    await splitEvent('s1t11');
    await glob('s1t12', 'planning', { autoStart: true, waiting: { since: '2026-10-01T00:00:00.000Z' } });
    await glob('s1t13', 'planning', { title: 'no flag' });

    // Held for the oversized flag: flagged, no decision, waiting, nothing it starts after. One that also waits for a glob stays held for that.
    await glob('s1t20', 'planning', { waiting: { since: '2026-10-01T00:00:00.000Z' } });
    await check('s1t20', true, null);
    await glob('s1t21', 'planning', { waiting: { since: '2026-10-01T00:00:00.000Z' } });
    await check('s1t21', true, null);
    await relation('rel_needs', 's1t21', 's1t13', 'start', 'person');
    // A legacy flagged sub held for the flag becomes a same glob, as escalateToSame would have made it.
    await glob('s1t24', 'planning', { waiting: { since: '2026-10-01T00:00:00.000Z' } }, 'sub');
    await check('s1t24', true, null);
    // A flagged one that was split keeps its decision; keep whole is cleared.
    await glob('s1t22', 'planning');
    await check('s1t22', true, 'split');
    await glob('s1t23', 'implementing');
    await check('s1t23', true, 'kept_whole');

    await migrateOnce(new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('marks every open split sign-off relation done, and leaves the rest alone', async () => {
    expect((await relationRow('rel_so_open'))?.dismissed_at).not.toBeNull();
    expect((await relationRow('rel_so_open'))?.overridden_at).toBeNull();
    // Already dismissed or overridden: untouched.
    expect(new Date((await relationRow('rel_so_dismissed'))?.dismissed_at ?? '').toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect((await relationRow('rel_so_overridden'))?.dismissed_at).toBeNull();
    // A split start relation between old parts is an ordinary need of globs that exist: it stays open.
    expect(await relationRow('rel_start_split')).toMatchObject({ dismissed_at: null, overridden_at: null });
    expect(await relationRow('rel_so_person')).toMatchObject({ dismissed_at: null, overridden_at: null });
    const open = await database.db.execute<{ id: string }>(sql`select id from relations where source = 'split' and gate = 'sign_off' and dismissed_at is null and overridden_at is null`);
    expect(open).toEqual([]);
  });

  it('clears autoStart on parts of a split, ending the wait of one in Planning', async () => {
    expect(await dataOf('s1t10')).toEqual({ createdAt: '2026-10-01T00:00:00.000Z', title: 'part' });
    const running = await dataOf('s1t11');
    expect(running).not.toHaveProperty('autoStart');
    // A glob with the flag and no split event is not the migration's to touch.
    expect(await dataOf('s1t12')).toHaveProperty('autoStart', true);
    expect(await dataOf('s1t13')).toEqual({ createdAt: '2026-10-01T00:00:00.000Z', title: 'no flag' });
  });

  it('releases a glob held only for its oversized flag, and keeps one that still waits for a glob', async () => {
    expect(await dataOf('s1t20')).not.toHaveProperty('waiting');
    expect(await dataOf('s1t21')).toHaveProperty('waiting');
  });

  it('turns a legacy flagged sub into a same glob, and leaves a held one that waits for a glob alone', async () => {
    const rows = await database.db.execute<{ id: string; type: string }>(sql`select id, type from globs where id in ('s1t24', 's1t21') order by id`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.type]))).toEqual({ s1t21: 'same', s1t24: 'same' });
    expect(await dataOf('s1t24')).not.toHaveProperty('waiting');  });

  it('keeps a split decision and clears keep whole', async () => {
    const rows = await database.db.execute<{ glob_id: string; decision: string | null; decided_by: string | null }>(sql`select glob_id, decision, decided_by from glob_size_checks order by glob_id`);
    const by = new Map(rows.map((r) => [r.glob_id, r]));
    expect(by.get('s1t22')).toMatchObject({ decision: 'split', decided_by: 'dev@example.com' });
    expect(by.get('s1t23')).toMatchObject({ decision: null, decided_by: null });
    expect(by.get('s1t20')?.decision).toBeNull();
  });

  it('is idempotent: running its statements again changes nothing', async () => {
    const snapshot = async () => JSON.stringify([
      await database.db.execute(sql`select id, dismissed_at, overridden_at from relations order by id`),
      await database.db.execute(sql`select id, data from globs order by id`),
      await database.db.execute(sql`select glob_id, decision, decided_by from glob_size_checks order by glob_id`),
      await database.db.execute(sql`select id, type from globs order by id`),
    ]);
    const before = await snapshot();
    const file = join(new URL('../drizzle', import.meta.url).pathname, (await readdir(new URL('../drizzle', import.meta.url).pathname)).find((f) => f.startsWith(TAG)) ?? '');
    for (const statement of (await readFile(file, 'utf8')).split('--> statement-breakpoint')) {
      await database.db.execute(sql.raw(statement));
    }
    expect(await snapshot()).toBe(before);
  });
});
