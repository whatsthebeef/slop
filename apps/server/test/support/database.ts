import { sql } from 'drizzle-orm';
import { connect, runMigrations } from '../../src/db/store.js';
import type { Database } from '../../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';

/** A throwaway, migrated database next to the dev one (`docker compose up -d postgres`). */
export const createTestDatabase = async (name: string): Promise<{ database: Database; drop: () => Promise<void> }> => {
  const dbName = `slop_test_${name}_${process.pid}`;
  const admin = connect(ADMIN_URL);
  await admin.db.execute(sql.raw(`create database ${dbName}`));
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  await runMigrations(url, new URL('../../drizzle', import.meta.url).pathname);
  const database = connect(url);
  return {
    database,
    drop: async () => {
      await database.close();
      await admin.db.execute(sql.raw(`drop database if exists ${dbName} with (force)`));
      await admin.close();
    },
  };
};
