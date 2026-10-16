import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wouldCycle } from '@slop/core';
import type { Relation } from '@slop/core';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_relations_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0067_relations';

type Row = {
  from_glob: string;
  to_glob: string;
  gate: string;
  until: string;
  reason: string | null;
  evidence: string[];
  source: string;
  dismissed_at: Date | null;
  dismissed_plan_hash: string | null;
  overridden_at: Date | null;
};

/** The relations migration (0067), against Postgres: migrated up to the one before, globs and split events, then it. */
describe('needs and splits become relations (migration 0067)', () => {
  let admin: Database;
  let database: Database;

  const glob = async (id: string, status: string, data: Record<string, unknown> = {}, board = 1) => {
    await database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, ${board}, 1, ${status}, 'same', 'x', ${JSON.stringify({ createdAt: '2026-10-01T00:00:00.000Z', ...data })}::jsonb, now())`,
    );
  };
  const split = async (source: string, parts: string[]) => {
    for (const [index, id] of parts.entries()) {
      await database.db.execute(
        sql`insert into events (glob_id, type, actor, at, data)
            values (${id}, 'GlobSplit', 'x', '2026-10-02T00:00:00.000Z', ${JSON.stringify({ source, part: index, parts })}::jsonb)`,
      );
    }
  };
  const rows = async () =>
    database.db.execute<Row>(sql`select from_glob, to_glob, gate, until, reason, evidence, source, dismissed_at, dismissed_plan_hash, overridden_at from relations order by from_glob, to_glob, gate`);
  const rowOf = async (from: string, to: string, gate = 'start') => (await rows()).find((r) => r.from_glob === from && r.to_glob === to && r.gate === gate);

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'relations-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back, so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    for (const id of [1, 2]) {
      await database.db.execute(
        sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (${id}, ${`b${id}`}, 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`,
      );
    }
    // s1t1 waits for s1t2 (person), s1t3 (learned), and has: a duplicate of s1t2 that was inferred, an inferred need Start now
    // overrode (s1t5), one a person dismissed (s1t6), an overlap (s1t4), a need on another board's glob, a deleted glob and itself.
    await glob('s1t1', 'planning', {
      after: ['s1t2', 's1t404', 's1t1', 's2t1'],
      impliedAfter: [
        { id: 's1t3', paths: ['a.ts', 'b.ts'], kind: 'needs', source: 'learned', evidence: 'the run failed without it' },
        { id: 's1t4', paths: ['x.ts'], source: 'implied' },
        { id: 's1t2', paths: [], kind: 'needs', source: 'inferred', evidence: 'a duplicate of the person one' },
        { id: 's1t5', paths: [], kind: 'needs', source: 'inferred', evidence: 'looks like it', overridden: true },
        { id: 's1t6', paths: [], kind: 'needs', source: 'inferred', evidence: 'also looks like it', overridden: true, dismissedPlanHash: 'h1' },
        { id: 's2t1', paths: [], kind: 'needs', source: 'inferred', evidence: 'other board' },
        { id: 's1t404', paths: [], kind: 'needs', source: 'learned', evidence: 'deleted' },
        { id: 's1t1', paths: [], kind: 'needs', source: 'learned', evidence: 'itself' },
        { id: 's1t4', paths: [], kind: 'overlaps', source: 'explicit' },
      ],
    });
    for (const id of ['s1t2', 's1t3', 's1t4', 's1t5', 's1t6']) await glob(id, 'planning');
    await glob('s2t1', 'planning', {}, 2);
    // A glob without any of it, and one whose lists are not lists.
    await glob('s1t20', 'planning');
    await glob('s1t21', 'planning', { after: 'nope', impliedAfter: { id: 's1t2' } });
    // A split of s1t7 into three parts (the source still in Planning), one of s1t10 that is signed off, and one with a deleted part.
    for (const id of ['s1t7', 's1t8', 's1t9']) await glob(id, 'planning');
    await split('s1t7', ['s1t7', 's1t8', 's1t9']);
    for (const id of ['s1t10', 's1t11']) await glob(id, id === 's1t10' ? 'signed_off' : 'planning');
    await split('s1t10', ['s1t10', 's1t11']);
    await glob('s1t12', 'reviewing');
    await split('s1t12', ['s1t12', 's1t13', 's1t14']);
    await glob('s1t14', 'planning');
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('turns after into start relations until merged, and skips dangling targets, other boards and itself', async () => {
    const person = await rowOf('s1t1', 's1t2');
    expect(person).toMatchObject({ gate: 'start', until: 'merged', source: 'person', reason: null });
    const targets = (await rows()).filter((r) => r.from_glob === 's1t1').map((r) => r.to_glob);
    expect(targets).not.toContain('s1t404');
    expect(targets).not.toContain('s2t1');
    expect(targets).not.toContain('s1t1');
  });

  it('keeps the source, reason and paths of recorded needs, and the person one when both exist', async () => {
    expect(await rowOf('s1t1', 's1t3')).toMatchObject({ source: 'learned', reason: 'the run failed without it', evidence: ['a.ts', 'b.ts'], dismissed_at: null, overridden_at: null });
    // The inferred duplicate of the explicit one is dropped: the person's relation stays as it was.
    expect(await rowOf('s1t1', 's1t2')).toMatchObject({ source: 'person', reason: null });
  });

  it('carries over what Start now overrode and what a person dismissed', async () => {
    const overridden = await rowOf('s1t1', 's1t5');
    expect(overridden?.overridden_at).not.toBeNull();
    expect(overridden?.dismissed_at).toBeNull();
    const dismissed = await rowOf('s1t1', 's1t6');
    expect(dismissed?.dismissed_at).not.toBeNull();
    expect(dismissed?.dismissed_plan_hash).toBe('h1');
    expect(dismissed?.overridden_at).toBeNull();
  });

  it('does not copy overlaps', async () => {
    expect(await rowOf('s1t1', 's1t4')).toBeUndefined();
  });

  it('turns split events into sign-off relations from the source, only for a source not yet signed off and parts that exist', async () => {
    expect(await rowOf('s1t7', 's1t8', 'sign_off')).toMatchObject({ until: 'merged', source: 'split' });
    expect(await rowOf('s1t7', 's1t9', 'sign_off')).toMatchObject({ until: 'merged', source: 'split' });
    expect(await rowOf('s1t7', 's1t7', 'sign_off')).toBeUndefined();
    expect((await rows()).filter((r) => r.from_glob === 's1t10')).toEqual([]);
    expect((await rows()).filter((r) => r.from_glob === 's1t12').map((r) => r.to_glob)).toEqual(['s1t14']);
  });

  it('has per-source counts equal to what was seeded', async () => {
    const all = await rows();
    const count = (source: string) => all.filter((r) => r.source === source).length;
    // person: s1t2. learned: s1t3. inferred: s1t5 (overridden) and s1t6 (dismissed). split: 2 + 1.
    expect(count('person')).toBe(1);
    expect(count('learned')).toBe(1);
    expect(count('inferred')).toBe(2);
    expect(count('split')).toBe(3);
    expect(all).toHaveLength(7);
    expect(all.filter((r) => r.gate === 'start')).toHaveLength(4);
  });

  it('gives every migrated relation the kind waits (migration 0081) and keys uniqueness on from, to, gate and kind', async () => {
    const kinds = await database.db.execute<{ kind: string; n: number }>(sql`select kind, count(*)::int as n from relations group by kind`);
    expect(kinds).toEqual([{ kind: 'waits', n: 7 }]);
    const indexes = await database.db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'relations' order by indexname`);
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain('relations_from_to_gate_kind_idx');
    expect(names).not.toContain('relations_from_to_gate_idx');
    // A supersession on the same pair and gate is a different row; a second of the same kind is refused.
    const insert = (id: string, kind: string) =>
      database.db.execute(
        sql`insert into relations (id, board_id, from_glob, to_glob, gate, "until", evidence, source, kind, created_at)
            values (${id}, 1, 's1t1', 's1t2', 'start', 'merged', '[]'::jsonb, 'person', ${kind}, now())`,
      );
    await insert('k1', 'superseded_by');
    await expect(insert('k2', 'superseded_by')).rejects.toThrow();
    await expect(insert('k3', 'waits')).rejects.toThrow();
    await database.db.execute(sql`delete from relations where id = 'k1'`);
  });

  it('creates relation_scans (migration 0082) with its key, index and board cascade', async () => {
    const columns = await database.db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'relation_scans'`);
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      ['board_id', 'created_at', 'decided_at', 'decision', 'gate', 'glob_id', 'kind', 'mentioned_id', 'model', 'reason', 'relation_id', 'sentence', 'sentence_hash', 'state'].sort(),
    );
    const insert = (hash: string) =>
      database.db.execute(
        sql`insert into relation_scans (glob_id, mentioned_id, sentence_hash, board_id, kind, decision, sentence, state, created_at)
            values ('s1t1', 's1t2', ${hash}, 2, 'mention', 'history', 'x', 'done', now())`,
      );
    await insert('h1');
    await expect(insert('h1')).rejects.toThrow();
    await insert('h2');
    await database.db.execute(sql`delete from boards where id = 2`);
    expect(await database.db.execute(sql`select 1 from relation_scans`)).toHaveLength(0);
  });

  it('is idempotent: running the backfill again adds nothing', async () => {
    const before = (await rows()).length;
    const folder = new URL('../drizzle/0067_relations.sql', import.meta.url).pathname;
    for (const statement of (await readFile(folder, 'utf8')).split('--> statement-breakpoint')) {
      await database.db.execute(sql.raw(statement));
    }
    expect((await rows()).length).toBe(before);
  });

  // The 0067 test above re-ran its old SQL, which makes the old unique index again: 0081 drops it again.
  it('is idempotent: running 0081 and 0082 again changes nothing', async () => {
    const before = (await rows()).length;
    for (const file of ['0081_relations_kind.sql', '0082_relation_scans.sql']) {
      for (const statement of (await readFile(new URL(`../drizzle/${file}`, import.meta.url).pathname, 'utf8')).split('--> statement-breakpoint')) {
        await database.db.execute(sql.raw(statement));
      }
    }
    expect((await rows()).length).toBe(before);
    const indexes = await database.db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename in ('relations', 'relation_scans')`);
    expect(indexes.map((i) => i.indexname)).toEqual(expect.arrayContaining(['relations_from_to_gate_kind_idx', 'relation_scans_board_state_idx']));
    expect(indexes.map((i) => i.indexname)).not.toContain('relations_from_to_gate_idx');
  });

  it('migrated rows hold no cycle under the gate-aware check', async () => {
    const relations: Relation[] = (await rows()).map((r, i) => ({
      id: `r${i}`,
      boardId: 1,
      from: r.from_glob,
      to: r.to_glob,
      gate: r.gate === 'sign_off' ? 'sign_off' : 'start',
      until: 'merged',
      reason: r.reason,
      evidence: r.evidence,
      source: 'person',
      group: null,
      dismissedAt: null,
      dismissedPlanHash: null,
      overriddenAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    }));
    for (const r of relations) {
      expect(wouldCycle(relations.filter((other) => other.id !== r.id), r)).toBe(false);
    }
  });
});
