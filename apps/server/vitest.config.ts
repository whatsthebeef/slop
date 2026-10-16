import { defineConfig } from 'vitest/config';

const ci = process.env.CI === 'true';

export default defineConfig({
  // The tests are Postgres-backed integration tests: each makes a dozen round trips and shares a runner with the other
  // files' database setup, so the 5s default fails healthy tests under CI load (s15t264). The template database
  // (test/support/global-setup.ts) is migrated once; each file's database is a copy of it.
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ['./test/support/global-setup.ts'],
    // CI: a capped pool so the tests don't oversubscribe a 2-4 core runner shared with other jobs, and one retry whose
    // passes-on-retry are recorded as flaky (the JUnit report), not hidden.
    ...(ci ? { pool: 'forks' as const, maxWorkers: 2, retry: 1 } : {}),
  },
});
