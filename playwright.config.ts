import { defineConfig } from '@playwright/test';

const API_PORT = 3100;
const WEB_PORT = 5174;
const DATABASE_URL = 'postgres://slop:slop@localhost:5432/slop_e2e';

/**
 * Smoke tests on an isolated stack: a fresh `slop_e2e` database, its own server and its own
 * board dev server. Needs `docker compose up -d postgres`.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: 'chrome',
    headless: true,
  },
  webServer: [
    {
      // Runs before the server so it migrates a fresh database (webServers start before globalSetup).
      command: 'node --import tsx ../../e2e/reset-db.ts && node --conditions=development --import tsx src/main.ts',
      cwd: 'apps/server',
      url: `http://localhost:${API_PORT}/auth/config`,
      env: { PORT: String(API_PORT), DATABASE_URL, AUTH_MODE: 'dev', PUBLIC_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`,
      cwd: 'apps/web',
      url: `http://localhost:${WEB_PORT}`,
      env: { SLOP_API_URL: `http://localhost:${API_PORT}`, SLOP_WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
    },
  ],
});
