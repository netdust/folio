/**
 * Test harness for Phase 1 backend tests.
 *
 * Spins up an in-memory SQLite, runs all migrations, seeds one
 * user/workspace/project, and returns the Hono app plus a session cookie.
 *
 * IMPORTANT: This sets `globalThis.__folioTestDb` BEFORE importing `app.ts` so
 * that `db/client.ts` (and every route that imports `db`) sees the test DB
 * instead of the file-backed one. `__resetDbForTests()` is called on every
 * invocation so successive `makeTestApp()` calls within one test file each get
 * a fresh, isolated DB (the route-level `db` proxy re-resolves to the new
 * override). Bun caches `app.ts` after the first dynamic import; the proxy
 * indirection is what gives us per-call isolation.
 */

// Must come first: populates env vars before downstream modules read them.
import './env-setup.ts';

import { Database } from 'bun:sqlite';
import { resolve as pathResolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { nanoid } from 'nanoid';
import { __resetDbForTests, type DB } from '../db/client.ts';
import * as schema from '../db/schema.ts';
import { createSession, hashPassword } from '../lib/auth.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';

// Resolve migrations relative to *this file*, not the caller's CWD, so the
// harness works whether `bun test` is run from the repo root or apps/server.
const MIGRATIONS_DIR = pathResolve(import.meta.dir, '../db/migrations');

export interface TestSeed {
  user: schema.User;
  workspace: schema.Workspace;
  project: schema.Project;
  sessionCookie: string;
}

type ServerApp = typeof import('../app.ts')['app'];

export interface HarnessOptions {
  /**
   * When true, seed the auto-created project with its default statuses + views
   * (mirrors what POST /projects does in production). Default: false, so tests
   * that exercise the empty-statuses code path keep their original behavior.
   */
  seedProjectDefaults?: boolean;
}

export async function makeTestApp(opts: HarnessOptions = {}): Promise<{
  app: ServerApp;
  db: DB;
  seed: TestSeed;
}> {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Install the fresh DB and reset the proxy's resolution cache so route
  // handlers that hold a reference to the `db` proxy will see THIS db, not the
  // one resolved on a previous `makeTestApp()` call in the same file.
  globalThis.__folioTestDb = db;
  __resetDbForTests();

  const { app } = await import('../app.ts');

  const userId = nanoid();
  const passwordHash = await hashPassword('password123');
  await db.insert(schema.users).values({
    id: userId,
    email: 'alice@test.local',
    name: 'Alice',
    passwordHash,
  });

  const workspaceId = nanoid();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    slug: 'acme',
    name: 'Acme',
  });
  await db.insert(schema.memberships).values({
    workspaceId,
    userId,
    role: 'owner',
  });

  const projectId = nanoid();
  await db.insert(schema.projects).values({
    id: projectId,
    workspaceId,
    slug: 'web',
    name: 'Web',
  });
  // Mirror what POST /projects does — seed default statuses + views — but only
  // when the test opts in. Most existing tests assume an empty project.
  if (opts.seedProjectDefaults) {
    await seedProjectDefaults(db, projectId);
  }

  const session = await createSession(userId);

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  return {
    app,
    db,
    seed: {
      user: user!,
      workspace: workspace!,
      project: project!,
      sessionCookie: `folio_session=${session.id}`,
    },
  };
}
