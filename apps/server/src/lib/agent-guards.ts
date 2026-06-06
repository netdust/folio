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
import { type ApiToken, type Document, documents } from '../db/schema.ts';
import { HTTPError } from './http.ts';
import { OPERATOR_AGENT_ID, getOperatorDocument } from './operator.ts';

/**
 * Resolve the CALLING agent's doc for the widening guards. The operator is a
 * code singleton: its token carries the synthetic OPERATOR_AGENT_ID (no row), so
 * a raw findFirst returns undefined → the guards' fail-closed fallback ([] allow-
 * list / [] tools) would mis-deny the operator from granting ANY project/tool to
 * a child agent — even though its real definition is projects:['*'] + full tools.
 * Resolve the sentinel to its code-singleton doc; a real-but-missing agent still
 * returns undefined (the guards keep their fail-closed handling for that case).
 * (architecture shake-out: extends the resolveAgentDocForToken convergence —
 * implemented locally because agent-tools-registry.ts imports THIS file, so
 * importing its helper back would cycle.)
 */
async function resolveCallingAgent(token: ApiToken): Promise<Document | undefined> {
  if (token.agentId === OPERATOR_AGENT_ID) return getOperatorDocument();
  if (!token.agentId) return undefined; // not agent-bound — guards fail-closed on undefined
  return db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
}

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
 * widen the target beyond the caller's own allow-list. Human PATs (no agent_id)
 * have no agent allow-list to widen, so this WRITE guard doesn't apply to them.
 * (Distinct from the per-PAT *read*-visibility narrowing in events.ts/runs.ts,
 * which DOES bound a human PAT's project reach — CR-7/CR-9.)
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

  const callingAgent = await resolveCallingAgent(token);
  const callingProjectsRaw = (callingAgent?.frontmatter as { projects?: unknown } | undefined)
    ?.projects;

  // H16: distinguish "calling agent has malformed/missing projects" from
  // "calling agent legitimately has a narrow allow-list." The pre-G13
  // behavior defaulted malformed to ['*'] (fail-open — security smell).
  // G13 corrected to [] (fail-closed) — correct, but the
  // ALLOW_LIST_WIDENING_FORBIDDEN error code misleads an operator
  // debugging a corrupted-row case. Surface a distinct error so the
  // remediation path (re-import / hand-edit the agent's frontmatter) is
  // obvious.
  if (callingProjectsRaw !== undefined && !Array.isArray(callingProjectsRaw)) {
    throw new HTTPError(
      'CALLING_AGENT_INVALID_PROJECTS',
      "calling agent's frontmatter.projects is malformed (not an array); fix the agent row before retrying",
      500,
    );
  }
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
 * For agent-bound tokens, ensure the proposed `frontmatter.tools` is a subset
 * of the calling agent's own tools. Closes a scope-escalation hole: without
 * this check, an agent-bound token with `agents:write` + a narrow toolset
 * could mint a child with broader tools, and the child token (whose scopes
 * are derived from tools via `toolsToScopes`) would inherit powers the parent
 * never had. (Found by Phase 2.6 shake-out.)
 *
 * Symmetry with `assertAgentAllowListWidening`:
 *   - Sessions + human PATs bypass (no agentId).
 *   - On PATCH, missing `tools` means "no change" — no-op.
 *   - On CREATE, missing `tools` is a Zod schema error upstream — no-op here.
 *   - Calling-agent malformed/missing `tools` field → fail closed (treat as []).
 */
export async function assertAgentToolsWidening(
  token: ApiToken | null,
  nextFrontmatter: Record<string, unknown> | undefined,
  op: 'create' | 'patch',
): Promise<void> {
  if (!token || !token.agentId) return;

  const hasToolsKey =
    nextFrontmatter !== undefined && 'tools' in nextFrontmatter;
  if (!hasToolsKey) return; // create: Zod rejects; patch: no-op

  const nextTools = (nextFrontmatter as Record<string, unknown>)['tools'];
  if (!Array.isArray(nextTools)) return; // let Zod surface the type error

  const callingAgent = await resolveCallingAgent(token);
  const callingToolsRaw = (callingAgent?.frontmatter as { tools?: unknown } | undefined)
    ?.tools;

  if (callingToolsRaw !== undefined && !Array.isArray(callingToolsRaw)) {
    throw new HTTPError(
      'CALLING_AGENT_INVALID_TOOLS',
      "calling agent's frontmatter.tools is malformed (not an array); fix the agent row before retrying",
      500,
    );
  }
  const callingTools: string[] = Array.isArray(callingToolsRaw)
    ? (callingToolsRaw.filter((t) => typeof t === 'string') as string[])
    : [];

  // Empty caller toolset → child can only be empty too. Subset of [] is [].
  for (const tool of nextTools as unknown[]) {
    if (typeof tool !== 'string') continue;
    if (!callingTools.includes(tool)) {
      throw new HTTPError(
        'TOOLS_WIDENING_FORBIDDEN',
        "cannot grant target agent tools beyond calling agent's own",
        403,
      );
    }
  }
  // `op` is unused for tools — kept for signature symmetry with the projects
  // guard so all four call sites use the same shape.
  void op;
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

/**
 * Round 7 #19 — mirror round-6's MCP gate on the HTTP surface.
 *
 * Agent CRUD on HTTP (`POST/PATCH/DELETE /api/v1/w/:wslug/documents` with
 * `type=agent`) is an auth-grant mutation: it mints, modifies, or revokes an
 * `agent_token` bearer credential. A stolen human PAT carrying `agents:write`
 * could mint a new agent with arbitrary scopes and pivot through it — the
 * exact privilege-escalation shape round 6 closed on MCP.
 *
 * Legitimate callers:
 *   - Session callers (no token) — workspace admin managing agents via the UI.
 *   - Agent-bound bearers (`token.agentId` set) — agent self-management /
 *     parent spawning a child. Width-guards still apply.
 *
 * Rejected:
 *   - Human PATs (token present, `token.agentId === null`) — `agents:write`
 *     was the only gate before round 7; that gate is insufficient when the
 *     PAT itself is the credential being escalated against.
 */
export function assertNotHumanPatForAgentLifecycle(
  type: 'agent' | 'trigger',
  token: ApiToken | null,
): void {
  if (type !== 'agent') return;
  if (!token) return; // session-authenticated
  if (token.agentId) return; // agent-bound bearer
  throw new HTTPError(
    'HUMAN_PAT_AGENT_LIFECYCLE_HTTP',
    'agent lifecycle requires session auth or an agent-bound bearer; human PATs are rejected',
    403,
  );
}
