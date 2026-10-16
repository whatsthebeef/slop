import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { connect, runMigrations } from '../../src/db/store.js';

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
export const TEMPLATE_NAME = 'slop_test_template';
export const MIGRATIONS_FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** Hash of everything under `apps/server/drizzle/`: the template is rebuilt when it changes. */
export const migrationsHash = (folder = MIGRATIONS_FOLDER): string => {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else hash.update(entry.name).update(readFileSync(path));
    }
  };
  walk(folder);
  return hash.digest('hex');
};

/**
 * Creates and migrates `slop_test_template` once (vitest globalSetup) unless one for the current migrations exists. An
 * advisory lock keeps two vitest runs on one Postgres from building it at the same time. The hash is the database's comment.
 */
export const ensureTemplateDatabase = async (adminUrl = ADMIN_URL, folder = MIGRATIONS_FOLDER): Promise<{ rebuilt: boolean }> => {
  const hash = migrationsHash(folder);
  const admin = connect(adminUrl);
  try {
    await admin.db.execute(sql`select pg_advisory_lock(hashtext(${TEMPLATE_NAME}))`);
    try {
      const rows = await admin.db.execute<{ comment: string | null }>(
        sql`select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${TEMPLATE_NAME}`,
      );
      if (rows[0]?.comment === hash) return { rebuilt: false };
      await admin.db.execute(sql.raw(`drop database if exists ${TEMPLATE_NAME} with (force)`));
      await admin.db.execute(sql.raw(`create database ${TEMPLATE_NAME}`));
      await runMigrations(adminUrl.replace(/\/[^/]+$/, `/${TEMPLATE_NAME}`), folder);
      await admin.db.execute(sql.raw(`comment on database ${TEMPLATE_NAME} is '${hash}'`));
      return { rebuilt: true };
    } finally {
      await admin.db.execute(sql`select pg_advisory_unlock(hashtext(${TEMPLATE_NAME}))`);
    }
  } finally {
    await admin.close();
  }
};
