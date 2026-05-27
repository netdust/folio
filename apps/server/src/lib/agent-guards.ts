/**
 * Shared authorization guards for agent-CRUD across HTTP and MCP entrypoints.
 *
 * Both `routes/workspace-documents.ts` (HTTP) and `routes/mcp.ts`
 * (create_agent / update_agent / delete_agent) must enforce the same three
 * invariants:
 *
 *  1. The acting token carries the `agents:write` scope.
 *  2. An agent-bound token cannot widen any agent's `frontmatter.projects`
 *     allow-list past its own (applied on create AND update).
 *  3. An agent-bound token cannot delete itself.
 *
 * The guards live here (not in the route file) so both entrypoints share
 * one implementation — historically the MCP path had them and the HTTP path
 * did not, which let any `documents:write` token mint / widen / delete agents.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type ApiToken, documents } from '../db/schema.ts';
import { HTTPError } from './http.ts';

/**
 * Reject if the token cannot write to the target type. Routes already check
 * `documents:write` / `documents:delete` upstream; this only adds the
 * `agents:write` requirement for `type=agent` writes.
 */
export function assertAgentScope(
  type: 'agent' | 'trigger',
  token: ApiToken | null,
  op: 'write' | 'delete',
): void {
  if (type !== 'agent') return;
  if (!token) return; // session-authenticated requests bypass scope checks
  if (!token.scopes.includes('agents:write')) {
    throw new HTTPError(
      'FORBIDDEN_SCOPE',
      `token missing required scope: agents:write (needed to ${op} agents)`,
      403,
    );
  }
}

/**
 * For agent-bound tokens, ensure the proposed `frontmatter.projects` does not
 * widen the target beyond the caller's own allow-list. Human PATs (no
 * agent_id) are unrestricted in v1 — Phase 3+ adds per-PAT narrowing UI.
 *
 * G4: the `op` parameter distinguishes create vs patch semantics for the
 * missing-`projects` case:
 *   - 'create' → missing means Zod's `.default(['*'])` will fill wildcard
 *     downstream, which IS widening — fail closed by treating absent as '*'.
 *   - 'patch'  → missing means "don't touch projects" — true no-op.
 *
 * G13: if the calling agent row is missing or malformed, fail closed (treat
 * as no projects) rather than fail open (the prior `?? ['*']` default).
 */
export async function assertAgentAllowListWidening(
  token: ApiToken | null,
  nextFrontmatter: Record<string, unknown> | undefined,
  op: 'create' | 'patch',
): Promise<void> {
  if (!token || !token.agentId) return;

  const hasProjectsKey =
    nextFrontmatter !== undefined && 'projects' in nextFrontmatter;

  // For PATCH: absent projects means no change. Skip.
  if (!hasProjectsKey && op === 'patch') return;

  // For CREATE: absent projects triggers Zod's `.default(['*'])` downstream.
  // Treat as a widening request to wildcard.
  const nextProjects = hasProjectsKey
    ? (nextFrontmatter as Record<string, unknown>)['projects']
    : ['*'];

  // If a caller passes projects as something non-array (e.g. null, string),
  // Zod parse will reject downstream. Skip widening check — let the schema
  // surface the validation error.
  if (!Array.isArray(nextProjects)) return;

  const callingAgent = await db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
  const callingProjectsRaw = (callingAgent?.frontmatter as { projects?: unknown } | undefined)
    ?.projects;
  // Fail closed: if the calling agent row is gone or malformed, treat as
  // zero allow-list. The pre-fix default-to-wildcard was a security smell.
  const callingAllowList: string[] = Array.isArray(callingProjectsRaw)
    ? (callingProjectsRaw.filter((p) => typeof p === 'string') as string[])
    : [];

  if (callingAllowList.includes('*')) return; // caller is unrestricted

  if ((nextProjects as unknown[]).includes('*')) {
    throw new HTTPError(
      'ALLOW_LIST_WIDENING_FORBIDDEN',
      "cannot widen target agent's allow-list beyond calling agent's own",
      403,
    );
  }
  for (const pid of nextProjects as unknown[]) {
    if (typeof pid !== 'string') continue;
    if (!callingAllowList.includes(pid)) {
      throw new HTTPError(
        'ALLOW_LIST_WIDENING_FORBIDDEN',
        "cannot widen target agent's allow-list beyond calling agent's own",
        403,
      );
    }
  }
}

/**
 * Reject self-delete from an agent-bound token. No-op for human PATs and
 * session auth.
 */
export function assertNotSelfDelete(
  token: ApiToken | null,
  targetDocumentId: string,
): void {
  if (!token || !token.agentId) return;
  if (token.agentId === targetDocumentId) {
    throw new HTTPError(
      'CANNOT_DELETE_SELF',
      'agent cannot delete itself',
      403,
    );
  }
}
