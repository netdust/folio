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
   * When true (the default), seed the auto-created project with its default
   * "Work Items" table + 4 statuses + 2 views — mirroring what POST /projects
   * does in production. Set to false only for tests that intentionally need an
   * empty project (e.g. asserting the auto-create-table path on POST).
   */
  seedProjectDefaults?: boolean;
}

/**
 * Shared db wiring for both harness entrypoints (review fix #9): a fresh migrated
 * in-memory db installed into the app's `db` proxy, returning `{ app, db }`. The
 * two PRAGMAs are load-bearing — `busy_timeout` (R9) mirrors production
 * lock-waiting so race tests reproduce real SQLITE_BUSY semantics (would
 * otherwise mask F1/F14 fixes); `foreign_keys = ON` enforces FK cascades. Both
 * `makeTestApp` (seeds on top) and `makeBareTestDb` (no seed) build on this so
 * the wiring can't silently diverge.
 */
async function setupTestDb(): Promise<{ app: ServerApp; db: DB }> {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Install the fresh DB and reset the proxy's resolution cache so route
  // handlers that hold a reference to the `db` proxy will see THIS db, not the
  // one resolved on a previous setup call in the same file.
  globalThis.__folioTestDb = db;
  __resetDbForTests();

  const { app } = await import('../app.ts');
  return { app, db };
}

export async function makeTestApp(opts: HarnessOptions = {}): Promise<{
  app: ServerApp;
  db: DB;
  seed: TestSeed;
}> {
  const { app, db } = await setupTestDb();

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
  // Post-tenancy model: the test user is the instance OWNER (users.role) with an
  // explicit workspace_access grant. The legacy `memberships` table was dropped
  // in Phase 4 (migration 0028).
  await db.update(schema.users).set({ role: 'owner' }).where(eq(schema.users.id, userId));
  await db.insert(schema.workspaceAccess).values({ userId, workspaceId });

  const projectId = nanoid();
  await db.insert(schema.projects).values({
    id: projectId,
    workspaceId,
    slug: 'web',
    name: 'Web',
  });
  // Mirror what POST /projects does — seed default Work Items table + statuses
  // + views. Default ON; tests that need a bare project opt out explicitly.
  if (opts.seedProjectDefaults !== false) {
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

/**
 * A migrated, EMPTY in-memory db wired to the app's db proxy — no seeded user,
 * workspace, or project. For tests that need the zero-users state (e.g. the
 * first-user registration gate). Shares makeTestApp's db wiring via setupTestDb,
 * minus the seed.
 */
export async function makeBareTestDb(): Promise<{ app: ServerApp; db: DB }> {
  return setupTestDb();
}

/**
 * Mint an INSTANCE-reach PAT (workspace_id null) and return BOTH the plaintext
 * bearer (for Authorization headers) and the row id (for revocation assertions).
 * The ONE shared instance-PAT seeder for tests — several route test files have
 * their own near-identical copies (seedInstanceToken etc.) that return only the
 * id; new tests should call this instead so the scope vocabulary lives in one
 * place. `scopes` defaults to the full owner/admin document-scope set (an "admin
 * PAT").
 */
export async function mintInstancePat(
  db: DB,
  createdBy: string,
  scopes: string[] = [
    'documents:read',
    'documents:write',
    'documents:delete',
    'agents:write',
    'config:write',
  ],
): Promise<{ token: string; id: string }> {
  const { newApiToken } = await import('../lib/auth.ts');
  const { apiTokens } = await import('../db/schema.ts');
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    workspaceId: null, // instance reach
    name: 'instance-pat',
    tokenHash: hash,
    scopes,
    createdBy,
  });
  return { token, id };
}
