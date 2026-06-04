import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { requireInstanceAdmin, requireInstanceOwner } from './system-workspace.ts';

async function mk(db: any, role: 'owner' | 'admin' | 'member') {
  const id = nanoid();
  await db.insert(schema.users).values({ id, email: `${role}-${id}@t`, name: role, role });
  return id;
}

describe('instance gates read users.role', () => {
  test('requireInstanceAdmin: owner+admin pass, member 403', async () => {
    const { db } = await makeBareTestDb();
    const o = await mk(db, 'owner'), a = await mk(db, 'admin'), m = await mk(db, 'member');
    expect(await requireInstanceAdmin(db, o)).toBe('owner');
    expect(await requireInstanceAdmin(db, a)).toBe('admin');
    await expect(requireInstanceAdmin(db, m)).rejects.toThrow();
  });
  test('requireInstanceOwner: only owner passes', async () => {
    const { db } = await makeBareTestDb();
    const o = await mk(db, 'owner'), a = await mk(db, 'admin');
    expect(await requireInstanceOwner(db, o)).toBe('owner');
    await expect(requireInstanceOwner(db, a)).rejects.toThrow();
  });
});
