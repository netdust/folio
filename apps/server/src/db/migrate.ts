import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from './client.ts';

console.log('Running migrations...');
migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete.');
process.exit(0);
