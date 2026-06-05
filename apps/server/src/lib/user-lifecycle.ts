import { count, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { apiTokens, documents, users } from '../db/schema.ts';
import { HTTPError } from './http.ts';

// Drizzle transaction handles share the query API with DB; one shape works for
// both, so these helpers run inside or outside a transaction.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Refuse to drop the LAST instance owner below one. The single definition of the
 * last-owner invariant, shared by the role-change (demote) and user-delete paths
 * so the guard can't drift. Call INSIDE the same transaction as the mutating
 * write so the count and the write are atomic (no TOCTOU: two concurrent
 * owner-removals can't both read count=2 and both proceed).
 *
 * `kind` only flavors the error message ('demote' / 'delete').
 */
export async function assertNotLastOwner(tx: DBOrTx, kind: 'demote' | 'delete'): Promise<void> {
  const [{ n: ownerCount } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(users)
    .where(eq(users.role, 'owner'));
  if (ownerCount <= 1) {
    throw new HTTPError('LAST_OWNER', `cannot ${kind} the only instance owner`, 409);
  }
}

/**
 * Hard-delete a user and everything that authenticates as / was minted by them,
 * in FK-safe order. Co-located with the schema so the RESTRICT-vs-CASCADE
 * knowledge lives in ONE reviewable unit: if a future FK is added against
 * users.id, this is the one place to handle it.
 *
 * Order is load-bearing under `PRAGMA foreign_keys = ON`:
 *  1. NULL documents.created_by / updated_by — RESTRICT FKs; the user delete
 *     would THROW otherwise. Authored documents are preserved (author ref cleared).
 *  2. DELETE api_tokens the user MINTED — RESTRICT FK on created_by; also a
 *     nulled-owner live token would be an orphaned credential. (Agent-bound
 *     tokens already cascade via their agentId.)
 *  3. DELETE the user — CASCADEs auth_sessions + workspace_access + project_access.
 *
 * Caller MUST run this inside a transaction (pass the tx handle) so a mid-way
 * throw rolls everything back.
 */
export function deleteUserCascade(tx: DBOrTx, userId: string): void {
  tx.update(documents).set({ createdBy: null }).where(eq(documents.createdBy, userId)).run();
  tx.update(documents).set({ updatedBy: null }).where(eq(documents.updatedBy, userId)).run();
  tx.delete(apiTokens).where(eq(apiTokens.createdBy, userId)).run();
  tx.delete(users).where(eq(users.id, userId)).run();
}
