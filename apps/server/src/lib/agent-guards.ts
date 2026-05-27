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
 * Called by both create_agent (proposed = create payload) and update_agent
 * (proposed = patch payload). Returns silently when no widening is attempted
 * or when the caller is unrestricted; throws when widening is detected.
 */
export async function assertAgentAllowListWidening(
  token: ApiToken | null,
  nextFrontmatter: Record<string, unknown> | undefined,
): Promise<void> {
  if (!token || !token.agentId) return;
  if (!nextFrontmatter) return;
  if (!('projects' in nextFrontmatter)) return;

  const nextProjects = nextFrontmatter['projects'];
  if (!Array.isArray(nextProjects)) return;

  const callingAgent = await db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
  const callingAllowList =
    (callingAgent?.frontmatter as { projects?: string[] } | undefined)?.projects ?? ['*'];

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
