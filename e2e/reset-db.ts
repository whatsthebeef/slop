import postgres from 'postgres';

export const E2E_DATABASE = 'slop_e2e';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';

/** Recreates the e2e database so every run starts empty; the server migrates it on start. */
export const resetDatabase = async (): Promise<void> => {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`drop database if exists ${E2E_DATABASE} with (force)`);
    await sql.unsafe(`create database ${E2E_DATABASE}`);
  } finally {
    await sql.end();
  }
};

await resetDatabase();
