import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { app } from './app.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';

// Auto-apply pending migrations on boot. Keeps dev DB in sync with the
// schema without requiring a manual `bun run db:migrate` after every pull.
// Cheap when no migrations are pending; drizzle's __drizzle_migrations
// table tracks state.
migrate(db, { migrationsFolder: './src/db/migrations' });

console.log(`[folio] listening on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
