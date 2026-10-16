import { sql } from 'drizzle-orm';
import { connect } from '../../src/db/store.js';
import type { Database } from '../../src/db/store.js';
import { ADMIN_URL, TEMPLATE_NAME } from './template-database.js';

/** A throwaway, migrated database next to the dev one (`docker compose up -d postgres`): a copy of the template that globalSetup migrates once. */
export const createTestDatabase = async (name: string): Promise<{ database: Database; url: string; drop: () => Promise<void> }> => {
  const dbName = `slop_test_${name}_${process.pid}`;
  const admin = connect(ADMIN_URL);
  await admin.db.execute(sql.raw(`create database ${dbName} template ${TEMPLATE_NAME}`));
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const database = connect(url);
  return {
    database,
    url,
    drop: async () => {
      await database.close();
      await admin.db.execute(sql.raw(`drop database if exists ${dbName} with (force)`));
      await admin.close();
    },
  };
};
