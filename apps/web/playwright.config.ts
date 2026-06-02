import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 5174;
const API_PORT = 3002;
const E2E_DB = './folio-e2e.db';

/**
 * Playwright config — runs a dedicated dev stack on alternate ports and an
 * isolated SQLite file so e2e doesn't trample your local dev DB.
 *
 * Run: cd apps/web && bun run e2e
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false, // SQLite + shared DB → keep serial for now
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      // API server with isolated DB
      command: `bun run --hot src/index.ts`,
      cwd: '../server',
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: `file:${E2E_DB}`,
        // Test-only fixed value. Never use in production.
        FOLIO_MASTER_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
        // Phase A gated first-user registration behind this flag. The e2e
        // fixtures register a fresh owner per run against a wiped DB, so the
        // harness needs the bootstrap path open. Test-only — never on a deploy.
        FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: 'true',
        NODE_ENV: 'development',
      },
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Vite dev server, proxying /api to the alt-port API
      command: `bunx vite --port ${WEB_PORT}`,
      env: {
        VITE_API_PORT: String(API_PORT),
      },
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
