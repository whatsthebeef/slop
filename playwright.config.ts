import { defineConfig } from '@playwright/test';

/** Smoke tests against a running stack: `docker compose up -d postgres`, the server and the web dev server. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.SLOP_WEB_URL ?? 'http://localhost:5173',
    channel: 'chrome',
    headless: true,
  },
});
