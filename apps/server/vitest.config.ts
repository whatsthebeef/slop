import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Postgres-backed API tests make a dozen round trips each and share a runner with the other test files' database
  // setup; under CI load a healthy one (a few hundred ms alone) passed the 5s default (relations-api, human-work-api).
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
