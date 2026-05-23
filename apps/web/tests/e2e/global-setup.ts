import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const E2E_DB_REL = './folio-e2e.db';

/**
 * Wipe the e2e SQLite DB and re-run migrations before any test runs.
 *
 * Runs from apps/web (Playwright cwd). Migrations live in apps/server.
 */
export default async function globalSetup() {
  const serverDir = resolve(__dirname, '../../../server');
  const dbPath = join(serverDir, E2E_DB_REL);

  // Wipe DB + WAL/SHM so each `bun run e2e` starts from zero.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }

  // Run migrations against the e2e DB.
  const result = spawnSync('bun', ['run', 'src/db/migrate.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${E2E_DB_REL}`,
      FOLIO_MASTER_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`e2e migrations failed with exit code ${result.status}`);
  }
}
