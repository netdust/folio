/**
 * Phase 4 (drop-workspace-tenancy), Task 17 — the collapsed agent resolver.
 *
 * Replaces the dual-workspace `{run-ws, __system}` lookup (the old
 * `resolveAgentForRun` in system-workspace.ts). In the single-team model there
 * is no tenancy boundary, so a custom agent resolves by slug INSTANCE-WIDE.
 * Confidentiality between projects is enforced downstream by the project ceiling
 * (invariant 3: `agent ∩ token ∩ caller` via `intersectAgentProjects`) and the
 * caller-bounded authority clamp — NOT by a workspace wall here.
 *
 * The OPERATOR is resolved from CODE, never a `documents` row (OQ-1 d): if the
 * slug names the operator, the resolver returns a synthetic agent-shaped Document
 * materialized from `operator.ts` constants. A user-created row bearing the
 * operator slug can therefore never BE the operator — combined with
 * `isReservedSlug('_operator')` blocking its creation, identity is unspoofable
 * (spec §4.5). NOTE: the operator's runnable surface (its token provisioning)
 * lands with the cockpit chat (D10) — this resolver returns its IDENTITY so
 * trigger/mention resolution + anti-impersonation hold; a full operator run is
 * cockpit-gated.
 */

import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { documents, type Document } from '../db/schema.ts';
import { getOperatorDocument, isOperator } from './operator.ts';

/**
 * Resolve an agent by slug for a run/trigger/mention. Operator → code singleton
 * (`getOperatorDocument`, never a row — anti-impersonation). Custom agent → the
 * instance-wide `documents` row of type 'agent' with that slug (no workspace
 * predicate — single-team model). Returns undefined if no such agent exists (a
 * speculative slug just doesn't fire). NOTE: an operator run is refused at
 * `createRun` (its run path is cockpit-gated); the resolver returns its identity
 * so trigger/mention resolution + anti-impersonation hold.
 */
export async function resolveAgentForRun(
  db: DB,
  slug: string,
): Promise<Document | undefined> {
  if (isOperator(slug)) return getOperatorDocument();
  return db.query.documents.findFirst({
    where: and(eq(documents.slug, slug), eq(documents.type, 'agent')),
  });
}
