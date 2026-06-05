import { SYSTEM_WORKSPACE_SLUG } from '@folio/shared';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { userRole } from './access.ts';
import { seedInstanceSkills } from './instance-skills.ts';
import { HTTPError } from './http.ts';

/** Reserved (underscore-prefixed) workspace slugs cannot be user-created. The
 *  workspace create/rename regex `^[a-z0-9-]+$` already blocks underscores;
 *  `isReservedSlug` is the explicit defense-in-depth so loosening that regex can
 *  never silently reopen the hijack. `SYSTEM_WORKSPACE_SLUG` lives in
 *  `@folio/shared` (one source for server + web) and is re-exported here so
 *  existing server importers keep their `from '.../lib/system-workspace'` path —
 *  it is still referenced by reserved-slug checks and the Task-20 teardown
 *  migration (the single-team model has NO `__system` workspace at runtime). */
export { SYSTEM_WORKSPACE_SLUG };

/** True for any reserved (underscore-prefixed) workspace slug. */
export function isReservedSlug(slug: string): boolean {
  return slug.startsWith('_');
}

/** An instance role (users.role) that may administer the instance. */
export type InstanceAdminRole = 'owner' | 'admin';

/**
 * The SINGLE instance-admin gate (CR#6). A user may administer instance-level
 * surfaces (mint a reach=null token, list/revoke instance tokens) iff their
 * INSTANCE role (`users.role`) is owner or admin. Returns that role (callers use
 * it as the scope ceiling for a reach=null mint); throws 403 otherwise. Both the
 * A7 token-mint reach gate and the instance-token routes route through this so
 * the instance-admin boundary lives in one place.
 *
 * Post-tenancy: the source of the role is `users.role` via `userRole`, NOT a
 * `__system` membership. One instance = one team; roles live on the user.
 */
export async function requireInstanceAdmin(
  db: DB,
  userId: string,
): Promise<InstanceAdminRole> {
  const role = await userRole(db, userId);
  if (role !== 'owner' && role !== 'admin') {
    throw new HTTPError(
      'FORBIDDEN',
      'instance administration requires owner or admin',
      403,
    );
  }
  return role;
}

/**
 * The instance-OWNER gate. Stricter than `requireInstanceAdmin`: only the single
 * instance owner (`users.role === 'owner'`) passes; an admin is rejected.
 * Reads `users.role` via `userRole`.
 */
export async function requireInstanceOwner(db: DB, userId: string): Promise<'owner'> {
  const role = await userRole(db, userId);
  if (role !== 'owner') {
    throw new HTTPError(
      'FORBIDDEN',
      'this action requires the instance owner',
      403,
    );
  }
  return 'owner';
}

/**
 * The single instance OWNER's user id. A designated instance has exactly one
 * user with `role='owner'`. Returns undefined if no owner exists yet
 * (pre-designation). Used by the workspace-create path to assign authorship when
 * the request carries the user-less operator token.
 */
export async function findSystemOwnerId(db: DB): Promise<string | undefined> {
  const owner = await db.query.users.findFirst({
    where: eq(users.role, 'owner'),
  });
  return owner?.id;
}

/**
 * Grant instance ownership to the user with `email`: set `users.role='owner'`
 * and return the resolved user id. Idempotent (setting role='owner' on the same
 * user twice is a no-op). No `memberships` write — the single-team model has no
 * `__system` workspace; the instance role lives on the user row.
 *
 * Throws INSTANCE_OWNER_NOT_FOUND (404) when no user has that email.
 */
export async function grantOwner(db: DB, email: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    throw new HTTPError(
      'INSTANCE_OWNER_NOT_FOUND',
      `no user with email ${email}`,
      404,
    );
  }
  if (user.role !== 'owner') {
    await db.update(users).set({ role: 'owner' }).where(eq(users.id, user.id));
  }
  return user.id;
}

/**
 * Designate the instance owner (backfill-authoritative). The single team has at
 * most one `users.role='owner'`:
 *   - NO owner yet + `email` resolves to a user → grant that user owner.
 *   - An owner EXISTS and it is a DIFFERENT user than `email` → THROW
 *     INSTANCE_OWNER_CONFLICT (409). No silent first-wins: a misconfigured /
 *     hostile env must not be able to point at an existing instance's owner slot.
 *   - The existing owner IS `email` (same user) → no-op (idempotent).
 *
 * No operator seed: the operator is a code singleton (lib/operator.ts).
 */
export async function designateInstanceOwner(db: DB, email: string): Promise<void> {
  const currentOwner = await db.query.users.findFirst({
    where: eq(users.role, 'owner'),
  });

  if (!currentOwner) {
    // Fresh / migrated instance with no owner yet → grant it to `email`.
    await grantOwner(db, email);
    return;
  }

  if (currentOwner.email === email) return; // already the owner — idempotent no-op

  throw new HTTPError(
    'INSTANCE_OWNER_CONFLICT',
    `instance owner is already ${currentOwner.email}; refusing to designate ${email}`,
    409,
  );
}

/**
 * Boot-time orchestrator: seed the instance skill library (idempotent), then —
 * only when `FOLIO_INSTANCE_OWNER` is set AND that user already exists —
 * designate the instance owner.
 *
 * A misconfigured owner email must NOT take the server down: if the email is
 * unset we skip designation; if it is set but no such user exists we log a clear
 * warning and skip — never crash boot. (A genuine owner CONFLICT, however, is a
 * real misconfiguration and is allowed to surface.) This function ALWAYS does
 * the real work (no test self-skip); `index.ts` gates the call to non-test so
 * importing the module in tests does not trigger a real boot.
 */
export async function runBootTasks(
  db: DB,
  env: Pick<Env, 'FOLIO_INSTANCE_OWNER'>,
): Promise<void> {
  await seedInstanceSkills(db);

  const ownerEmail = env.FOLIO_INSTANCE_OWNER;
  if (!ownerEmail) return; // no owner configured → seed only

  // Pre-check the user exists so a misconfigured email is a warning, not a
  // crash — and so we never swallow a genuine (non-not-found) designate error.
  const user = await db.query.users.findFirst({
    where: eq(users.email, ownerEmail),
  });
  if (!user) {
    console.warn(
      `[folio] FOLIO_INSTANCE_OWNER ${ownerEmail} not found; skipping owner designation`,
    );
    return;
  }

  await designateInstanceOwner(db, ownerEmail);
}
