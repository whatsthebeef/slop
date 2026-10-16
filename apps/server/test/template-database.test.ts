import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';
import { connect } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';
import { ADMIN_URL, MIGRATIONS_FOLDER, TEMPLATE_NAME, ensureTemplateDatabase, migrationsHash } from './support/template-database.js';

describe('template database', () => {
  it('is built by globalSetup and stamped with the migrations hash', async () => {
    const admin = connect(ADMIN_URL);
    try {
      const rows = await admin.db.execute<{ comment: string | null }>(
        sql`select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${TEMPLATE_NAME}`,
      );
      expect(rows[0]?.comment).toBe(migrationsHash());
    } finally {
      await admin.close();
    }
  });

  it('is reused, not rebuilt, while the migrations are unchanged', async () => {
    expect((await ensureTemplateDatabase()).rebuilt).toBe(false);
  });

  it('is rebuilt when the migrations change, and reused after that', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'slop-drizzle-'));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      writeFileSync(join(folder, 'zz_extra.txt'), 'changed');
      expect(migrationsHash(folder)).not.toBe(migrationsHash());
      // The extra file is not a migration, so the copy migrates the same: only the hash differs.
      expect((await ensureTemplateDatabase(ADMIN_URL, folder)).rebuilt).toBe(true);
      expect((await ensureTemplateDatabase(ADMIN_URL, folder)).rebuilt).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await ensureTemplateDatabase();
    }
  });

  it('gives each file a migrated copy without running migrations again', async () => {
    const a = await createTestDatabase('template_a');
    const b = await createTestDatabase('template_b');
    try {
      for (const t of [a, b]) {
        const rows = await t.database.db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
        expect(Number(rows[0]?.n)).toBeGreaterThan(0);
      }
      await a.database.db.execute(sql`create table only_in_a (id int)`);
      const rows = await b.database.db.execute<{ n: string }>(sql`select count(*)::text as n from pg_tables where tablename = 'only_in_a'`);
      expect(rows[0]?.n).toBe('0');
    } finally {
      await a.drop();
      await b.drop();
    }
  });
});

describe('vitest config', () => {
  const test = (config as { test: Record<string, unknown> }).test;

  it('allows integration-test timeouts', () => {
    expect(test.testTimeout).toBe(20_000);
    expect(test.hookTimeout).toBe(30_000);
  });

  it('migrates the template once, in globalSetup', () => {
    expect(test.globalSetup).toEqual(['./test/support/global-setup.ts']);
  });
});
