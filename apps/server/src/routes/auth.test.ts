import { and, eq } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import { memberships, users, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';
import { makeBareTestDb } from '../test/harness.ts';

test('first registration is rejected when bootstrap registration is off (M1)', async () => {
  const { app, db } = await makeBareTestDb(); // zero users, flag default false
  const res = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('REGISTRATION_CLOSED');
  // the user must NOT have been created
  const created = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
  expect(created).toBeUndefined();
});

test('first registration becomes __system owner when the flag is on (M1)', async () => {
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    expect(res.status).toBe(200);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    expect(sys).toBeDefined();
    const owner = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    const firstUser = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
    expect(owner!.userId).toBe(firstUser!.id);
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});

test('a SECOND registration never grants __system ownership (M1)', async () => {
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    const second = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'second@x.com', password: 'password123', name: 'Second' }),
    });
    expect(second.status).toBe(200);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const secondUser = await db.query.users.findFirst({ where: eq(users.email, 'second@x.com') });
    const ownerMems = await db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    // exactly one owner, and it is NOT the second user
    expect(ownerMems.length).toBe(1);
    expect(ownerMems[0]!.userId).not.toBe(secondUser!.id);
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});

test('first registration that SUCCEEDS persists the user + one owner; rollback-on-throw is the inverse (review fix #3)', async () => {
  // The compensating delete (auth.ts) removes the just-created user if
  // bootstrap/designate throws, so a mid-failure can't leave an orphaned user
  // that permanently flips isFirstUser=false + EMAIL_TAKEN. A first-user
  // designation throw isn't cleanly inducible in-harness (a tainted __system
  // needs a membership → a user → isFirstUser=false; transient DB faults aren't
  // simulable), so we assert the SUCCESS-path invariant here (user persists, one
  // owner) and unit-test the reachable designation-throw cases (tainted __system,
  // concurrent race) in system-workspace.test.ts.
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    const ok = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    expect(ok.status).toBe(200);
    const user = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
    expect(user).toBeDefined(); // persisted on success (rollback only on throw)
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const owners = await db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    expect(owners.length).toBe(1);
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});
