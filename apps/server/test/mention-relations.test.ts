import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_mentionrel_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0083_mention_relations';

/** Migration 0083: an open mention row was a card question; now it is deleted and its glob is scanned again. */
describe('open mention questions become scans (migration 0083)', () => {
  let admin: Database;
  let database: Database;

  const scan = async (globId: string, mentioned: string, kind: string, state: string, hash: string) => {
    await database.db.execute(
      sql`insert into relation_scans (glob_id, mentioned_id, sentence_hash, board_id, kind, decision, sentence, state, created_at)
          values (${globId}, ${mentioned}, ${hash}, 1, ${kind}, 'unsure', 'Mentions it.', ${state}, now())`,
    );
  };
  const remaining = async () => {
    const rows = await database.db.execute<{ glob_id: string; mentioned_id: string; kind: string; state: string }>(
      sql`select glob_id, mentioned_id, kind, state from relation_scans order by glob_id, mentioned_id, sentence_hash`,
    );
    return rows.map((r) => `${r.glob_id}>${r.mentioned_id}:${r.kind}:${r.state}`);
  };
  const jobs = async () => {
    const rows = await database.db.execute<{ glob_id: string; kind: string; lane: string; state: string; effect: unknown }>(
      sql`select glob_id, kind, lane, state, effect from outbox where kind = 'scan_relations' order by glob_id`,
    );
    return rows.map((r) => ({ globId: r.glob_id, lane: r.lane, state: r.state, effect: r.effect }));
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'mention-relations-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back, so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`);
    // s1t1 has two open mentions, s1t2 one open mention and one decided, s1t3 an open failed-step question and a dismissed mention,
    // s1t4 an open mention with a scan already waiting.
    await scan('s1t1', 's1t9', 'mention', 'open', 'h1');
    await scan('s1t1', 's1t8', 'mention', 'open', 'h2');
    await scan('s1t2', 's1t9', 'mention', 'open', 'h3');
    await scan('s1t2', 's1t7', 'mention', 'done', 'h4');
    await scan('s1t3', 'hs_1', 'step_failed', 'open', 'h5');
    await scan('s1t3', 's1t9', 'mention', 'dismissed', 'h6');
    await scan('s1t4', 's1t9', 'mention', 'open', 'h7');
    await database.db.execute(
      sql`insert into outbox (kind, lane, glob_id, effect) values ('scan_relations', 'llm', 's1t4', '{"kind":"scan_relations","globId":"s1t4"}'::jsonb)`,
    );
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('deletes open mention rows only, keeping decided and dismissed ones and the failed-step question', async () => {
    expect(await remaining()).toEqual(['s1t2>s1t7:mention:done', 's1t3>hs_1:step_failed:open', 's1t3>s1t9:mention:dismissed']);
  });

  it('queues one scan_relations job per glob that had one, on the llm lane, without doubling a waiting job', async () => {
    const effect = (globId: string) => ({ kind: 'scan_relations', globId });
    expect(await jobs()).toEqual([
      { globId: 's1t1', lane: 'llm', state: 'pending', effect: effect('s1t1') },
      { globId: 's1t2', lane: 'llm', state: 'pending', effect: effect('s1t2') },
      { globId: 's1t4', lane: 'llm', state: 'pending', effect: effect('s1t4') },
    ]);
  });

  it('is idempotent: running it again changes nothing', async () => {
    const file = await readFile(new URL(`../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
    for (const statement of file.split('--> statement-breakpoint')) await database.db.execute(sql.raw(statement));
    expect(await jobs()).toHaveLength(3);
    expect(await remaining()).toHaveLength(3);
  });
});
