import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../db/schema.ts';
import { instanceSettings } from '../db/schema.ts';
import { getOperatorModelSetting, setOperatorModelSetting } from './instance-settings.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

test('round-trips the operator model setting (unset → null → set → read)', async () => {
  const db = makeDb();
  expect(await getOperatorModelSetting(db)).toBeNull();
  await setOperatorModelSetting(db, {
    provider: 'ollama',
    model: 'llama3.1:8b',
    aiKeyLabel: 'default',
  });
  expect(await getOperatorModelSetting(db)).toEqual({
    provider: 'ollama',
    model: 'llama3.1:8b',
    aiKeyLabel: 'default',
  });
});

test('setOperatorModelSetting upserts (second set overwrites)', async () => {
  const db = makeDb();
  await setOperatorModelSetting(db, { provider: 'ollama', model: 'a', aiKeyLabel: 'default' });
  await setOperatorModelSetting(db, { provider: 'anthropic', model: 'claude-sonnet-4-6', aiKeyLabel: 'default' });
  expect(await getOperatorModelSetting(db)).toEqual({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    aiKeyLabel: 'default',
  });
});

test('a malformed value row degrades to null (mitigation 7 — tolerant read)', async () => {
  const db = makeDb();
  // A valid-JSON-but-wrong-shape value: a corrupt/hand-edited row must NOT crash
  // the consumer (getOperatorDefinition) — it degrades to null → the default.
  db.insert(instanceSettings)
    .values({ key: 'operator_model', value: 'not-an-object' as unknown as Record<string, unknown> })
    .run();
  expect(await getOperatorModelSetting(db)).toBeNull();
});

test('an unknown provider in the row degrades to null (closed-enum guard, mitigation 6)', async () => {
  const db = makeDb();
  db.insert(instanceSettings)
    .values({ key: 'operator_model', value: { provider: 'evilcorp', model: 'x', aiKeyLabel: 'default' } })
    .run();
  expect(await getOperatorModelSetting(db)).toBeNull();
});
