import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { users } from '../db/schema.ts';
import { makeBareTestDb } from '../test/harness.ts';
import { userRole } from './access.ts';
import { hashPassword } from './auth.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  designateInstanceOwner,
  findSystemOwnerId,
  grantOwner,
  isReservedSlug,
  requireInstanceAdmin,
  requireInstanceOwner,
  runBootTasks,
} from './system-workspace.ts';

async function seedUser(
  db: Awaited<ReturnType<typeof makeBareTestDb>>['db'],
  email: string,
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<string> {
  const id = nanoid();
  await db.insert(users).values({
    id,
    email,
    name: email,
    role,
    passwordHash: await hashPassword('password123'),
  });
  return id;
}

describe('reserved slug', () => {
  test('the system workspace slug is the reserved underscore-prefixed constant', () => {
    expect(SYSTEM_WORKSPACE_SLUG).toBe('__system');
    expect(isReservedSlug(SYSTEM_WORKSPACE_SLUG)).toBe(true);
  });
  test('any underscore-prefixed slug is reserved', () => {
    expect(isReservedSlug('__anything')).toBe(true);
    expect(isReservedSlug('_x')).toBe(true);
  });
  test('normal slugs are not reserved', () => {
    expect(isReservedSlug('acme')).toBe(false);
    expect(isReservedSlug('web-2')).toBe(false);
    expect(isReservedSlug('')).toBe(false);
  });
});

describe('instance-admin / instance-owner gates (read users.role)', () => {
  test('requireInstanceAdmin passes owner + admin, rejects member', async () => {
    const { db } = await makeBareTestDb();
    const owner = await seedUser(db, 'owner@x.com', 'owner');
    const admin = await seedUser(db, 'admin@x.com', 'admin');
    const member = await seedUser(db, 'member@x.com', 'member');
    expect(await requireInstanceAdmin(db, owner)).toBe('owner');
    expect(await requireInstanceAdmin(db, admin)).toBe('admin');
    await expect(requireInstanceAdmin(db, member)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('requireInstanceOwner passes ONLY owner — an admin is rejected', async () => {
    const { db } = await makeBareTestDb();
    const owner = await seedUser(db, 'owner@x.com', 'owner');
    const admin = await seedUser(db, 'admin@x.com', 'admin');
    expect(await requireInstanceOwner(db, owner)).toBe('owner');
    await expect(requireInstanceOwner(db, admin)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('findSystemOwnerId (single users.role=owner)', () => {
  test('returns the owning user id, or undefined when no owner exists', async () => {
    const { db } = await makeBareTestDb();
    expect(await findSystemOwnerId(db)).toBeUndefined();
    const owner = await seedUser(db, 'owner@x.com', 'owner');
    expect(await findSystemOwnerId(db)).toBe(owner);
  });
});

describe('grantOwner (sets users.role=owner)', () => {
  test('grants owner to an existing user and returns the id, idempotent', async () => {
    const { db } = await makeBareTestDb();
    const a = await seedUser(db, 'a@x.com');
    expect(await userRole(db, a)).toBe('member');
    expect(await grantOwner(db, 'a@x.com')).toBe(a);
    expect(await userRole(db, a)).toBe('owner');
    // re-run is a no-op (already owner)
    expect(await grantOwner(db, 'a@x.com')).toBe(a);
    expect(await userRole(db, a)).toBe('owner');
  });

  test('throws INSTANCE_OWNER_NOT_FOUND for an unknown email', async () => {
    const { db } = await makeBareTestDb();
    await expect(grantOwner(db, 'nobody@x.com')).rejects.toMatchObject({
      code: 'INSTANCE_OWNER_NOT_FOUND',
    });
  });
});

describe('designateInstanceOwner (backfill-authoritative)', () => {
  // (a) fresh: no owner + env=alice → alice becomes owner.
  test('(a) fresh instance: grants owner to the env user', async () => {
    const { db } = await makeBareTestDb();
    const alice = await seedUser(db, 'alice@x.com');
    await designateInstanceOwner(db, 'alice@x.com');
    expect(await userRole(db, alice)).toBe('owner');
    await expect(requireInstanceOwner(db, alice)).resolves.toBe('owner');
  });

  // (b) migrated: owner=bob already + env unset path is exercised via runBootTasks;
  // here we assert designate is a no-op when the existing owner IS the email.
  test('(d) existing owner IS the email → idempotent no-op', async () => {
    const { db } = await makeBareTestDb();
    const bob = await seedUser(db, 'bob@x.com', 'owner');
    await expect(designateInstanceOwner(db, 'bob@x.com')).resolves.toBeUndefined();
    expect(await userRole(db, bob)).toBe('owner');
    // still exactly one owner
    expect(await findSystemOwnerId(db)).toBe(bob);
  });

  // (c) migrated: owner=bob + env=carol (different) → CONFLICT, no silent first-wins.
  test('(c) existing owner DIFFERS from the email → throws INSTANCE_OWNER_CONFLICT', async () => {
    const { db } = await makeBareTestDb();
    const bob = await seedUser(db, 'bob@x.com', 'owner');
    await seedUser(db, 'carol@x.com');
    await expect(designateInstanceOwner(db, 'carol@x.com')).rejects.toMatchObject({
      code: 'INSTANCE_OWNER_CONFLICT',
    });
    // bob stays the owner; carol was NOT promoted.
    expect(await userRole(db, bob)).toBe('owner');
    expect(await findSystemOwnerId(db)).toBe(bob);
  });
});

describe('runBootTasks (boot wiring)', () => {
  // (a) fresh + env=alice → alice owner.
  test('designates the env owner on a fresh instance', async () => {
    const { db } = await makeBareTestDb();
    const alice = await seedUser(db, 'alice@x.com');
    await runBootTasks(db, { FOLIO_INSTANCE_OWNER: 'alice@x.com' });
    expect(await userRole(db, alice)).toBe('owner');
    await expect(requireInstanceOwner(db, alice)).resolves.toBe('owner');
  });

  // (b) migrated owner=bob + env unset → bob stays.
  test('leaves the existing owner untouched when no owner env is set', async () => {
    const { db } = await makeBareTestDb();
    const bob = await seedUser(db, 'bob@x.com', 'owner');
    await runBootTasks(db, { FOLIO_INSTANCE_OWNER: undefined });
    expect(await userRole(db, bob)).toBe('owner');
    expect(await findSystemOwnerId(db)).toBe(bob);
  });

  test('does NOT crash when FOLIO_INSTANCE_OWNER points to a missing user', async () => {
    const { db } = await makeBareTestDb();
    await expect(
      runBootTasks(db, { FOLIO_INSTANCE_OWNER: 'nobody@x.com' }),
    ).resolves.toBeUndefined();
    expect(await findSystemOwnerId(db)).toBeUndefined();
  });
});
