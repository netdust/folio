// Tier-A tests for lib/auth.ts session validation + password verify.
// Closes audit H9: the expiry branch (auth.ts:34) has no coverage at any layer
// (no wire test can hit it without a past-dated session). Cites the session-
// validation convergence in lib/auth.ts.
//
// readSession has three return points the wire normally never exercises:
//   line 33  `if (!row) return null`        — no such session
//   line 34  expiry guard (THE H9 GAP)      — exercised here
//   line 36  `return user ?? null`          — orphaned session (row present,
//                                             user gone) exercised here
//
// FK note: auth_sessions.user_id is a FK to users.id with onDelete:cascade, and
// the test harness runs `PRAGMA foreign_keys = ON`. So (a) a session row cannot
// be inserted for a user that doesn't exist (the insert throws), and (b) DELETING
// the user cascade-deletes its sessions — which would land readSession on line 33,
// NOT the line-36 `?? null` branch this test means to cover. To genuinely reach
// line 36 we seed an ORPHANED session (row present, user absent) by toggling FK
// enforcement OFF for that single insert, then back ON. Verified: with the FK on,
// readSession then finds the row, passes the expiry check, gets `undefined` from
// the users lookup, and returns null via `?? null` — and mutating that `?? null`
// to `(user ?? {})` makes this test go RED (proving it reaches line 36, not 33).
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { authSessions, users } from '../db/schema.ts';
import { hashPassword, readSession, verifyPassword } from './auth.ts';
import { makeBareTestDb } from '../test/harness.ts';

describe('readSession expiry', () => {
  test('an expired session returns null, a future-dated session returns the user', async () => {
    const { db } = await makeBareTestDb();
    const userId = nanoid();
    await db.insert(users).values({ id: userId, email: `${userId}@x.com`, name: 'U' });

    // Positive control (mandatory): a VALID future-dated session must resolve to
    // the user. If THIS is null, the db proxy isn't seeing the harness inserts and
    // the whole suite is vacuously green — every readSession would return null for
    // the wrong reason, making the expiry assertion below meaningless.
    const validSid = 'valid-session-id';
    await db
      .insert(authSessions)
      .values({ id: validSid, userId, expiresAt: new Date(Date.now() + 60_000) });
    const live = await readSession(validSid);
    expect(live).not.toBeNull();
    expect(live?.id).toBe(userId);

    // The guard under test (auth.ts:34): an already-expired session is refused.
    const expiredSid = 'expired-session-id';
    await db
      .insert(authSessions)
      .values({ id: expiredSid, userId, expiresAt: new Date(Date.now() - 1000) });
    expect(await readSession(expiredSid)).toBeNull();
  });
});

describe('readSession deleted-user', () => {
  test('a valid session whose user row is gone returns null (the ?? null guard)', async () => {
    const { db } = await makeBareTestDb();
    // Seed an ORPHANED session: a present, unexpired session row whose userId has
    // no users row. Done by toggling FK enforcement off for this one insert (a
    // cascade-delete of the user would instead remove the session and route us to
    // line 33 — not the line-36 branch we're asserting). $client is the underlying
    // bun:sqlite connection the harness drizzle-wraps.
    const sqlite = (db as unknown as { $client: { exec: (s: string) => void } }).$client;
    const sid = 'valid-session-ghost';
    sqlite.exec('PRAGMA foreign_keys = OFF');
    await db
      .insert(authSessions)
      .values({ id: sid, userId: 'ghost-user', expiresAt: new Date(Date.now() + 60_000) });
    sqlite.exec('PRAGMA foreign_keys = ON');

    // Sanity: the row really is present (so readSession passes line 33 + the expiry
    // check and reaches the users lookup). This protects against a silent false
    // green where the insert didn't land and we hit line 33 instead of line 36.
    const row = await db.query.authSessions.findFirst({ where: eq(authSessions.id, sid) });
    expect(row).toBeDefined();

    expect(await readSession(sid)).toBeNull();
  });
});

describe('verifyPassword', () => {
  test('wrong password is rejected, correct password accepted', async () => {
    const hash = await hashPassword('right-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
    expect(await verifyPassword('right-password', hash)).toBe(true);
  });
});
