import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { env } from '../env.ts';
import * as schema from './schema.ts';

const sqlitePath = env.DATABASE_URL.replace(/^file:/, '');

const sqlite = new Database(sqlitePath);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec('PRAGMA synchronous = NORMAL');

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;
