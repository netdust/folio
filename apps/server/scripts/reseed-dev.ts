/**
 * Dev-DB reseed — produces a CLEAN folio.db with exactly one workspace/project/
 * user + a handful of work items + the (copied) Anthropic key, so the operator
 * can be tested end-to-end without the 57x test-detritus that accumulated in the
 * old DB. The operator is a CODE SINGLETON (no row), so it is NOT seeded here.
 *
 * Run from apps/server:  bun run scripts/reseed-dev.ts
 *
 * It reads the Anthropic ai_keys row from the OLD db (passed as arg) and copies
 * the ciphertext verbatim — valid because FOLIO_MASTER_KEY is unchanged.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { nanoid } from 'nanoid';
import * as schema from '../src/db/schema.ts';
import { hashPassword, createSession } from '../src/lib/auth.ts';
import { seedProjectDefaults } from '../src/lib/seed-project-defaults.ts';

const DB_PATH = resolve(import.meta.dir, '../folio.db');
const OLD_BACKUP = process.argv[2]; // path to a backup DB to copy the ai_keys row from

async function main() {
  // 1. Capture the Anthropic key row from the OLD db BEFORE we move it.
  let anthropicKey: Record<string, unknown> | null = null;
  if (OLD_BACKUP && existsSync(OLD_BACKUP)) {
    const old = new Database(OLD_BACKUP, { readonly: true });
    anthropicKey =
      (old.query("SELECT * FROM ai_keys WHERE provider='anthropic' LIMIT 1").get() as Record<
        string,
        unknown
      >) ?? null;
    old.close();
    console.log('captured anthropic key from backup:', anthropicKey ? 'yes' : 'NONE');
  }

  // 2. Move the current folio.db aside (WAL too) so we migrate a fresh file.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) renameSync(p, p + '.reseed-old-' + Date.now());
  }

  // 3. Fresh DB + migrate.
  const sqlite = new Database(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../src/db/migrations') });
  console.log('fresh DB migrated at', DB_PATH);

  // 4. Owner user.
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: 'stefan@netdust.be',
    name: 'Stefan',
    passwordHash: await hashPassword('password123'),
  });
  await db.update(schema.users).set({ role: 'owner' }).where(eq(schema.users.id, userId));

  // 5. Workspace QA + grant.
  const workspaceId = nanoid();
  await db.insert(schema.workspaces).values({ id: workspaceId, slug: 'qa', name: 'QA' });
  await db.insert(schema.workspaceAccess).values({ userId, workspaceId });

  // 6. Project Demo + defaults (Todo / In Progress / Done statuses, Work Items table+view).
  const projectId = nanoid();
  await db.insert(schema.projects).values({
    id: projectId,
    workspaceId,
    slug: 'demo',
    name: 'Demo',
  });
  await seedProjectDefaults(db, projectId);

  // Resolve the seeded Work Items table id (work items must reference it).
  const table = await db.query.tables.findFirst({ where: eq(schema.tables.projectId, projectId) });
  if (!table) throw new Error('seedProjectDefaults did not create a table');

  // 7. A few work items, mostly Todo (so "change Demo task 2 to In Progress" is meaningful).
  for (let i = 1; i <= 5; i++) {
    await db.insert(schema.documents).values({
      id: nanoid(),
      workspaceId,
      projectId,
      tableId: table.id,
      type: 'work_item',
      slug: `demo-task-${i}`,
      title: `Demo task ${i}`,
      status: i === 1 ? 'in_progress' : 'todo',
      body: '',
      frontmatter: { priority: 'medium' },
      createdBy: userId,
      updatedBy: userId,
    });
  }

  // 8. Copy the Anthropic key (ciphertext valid under unchanged FOLIO_MASTER_KEY).
  if (anthropicKey) {
    await db.insert(schema.aiKeys).values({
      id: nanoid(),
      provider: 'anthropic',
      label: (anthropicKey.label as string) ?? 'default',
      encryptedKey: anthropicKey.encrypted_key as string,
      baseUrl: (anthropicKey.base_url as string) ?? null,
    });
    console.log('anthropic key copied into fresh DB');
  } else {
    console.log('WARNING: no anthropic key copied — operator turns will have no provider');
  }

  // 9. A session to log in via the browser (cookie folio_session = session.id).
  const session = await createSession(userId);
  console.log('\n=== RESEED COMPLETE ===');
  console.log('user:', userId, '(owner) stefan@netdust.be / password123');
  console.log('workspace: qa  project: demo  5 work items (task 1 = In Progress, rest Todo)');
  console.log('SESSION_COOKIE folio_session=' + session.id);
  sqlite.close();
}

main().catch((e) => {
  console.error('reseed failed:', e);
  process.exit(1);
});
