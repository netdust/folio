/**
 * Canonical author-reference helpers (G1-G3 / F11 follow-up).
 *
 * Comment frontmatter stores authors as `user:<id>` or `agent:<id>` since
 * migration 0008. Display surfaces want a human name (member.name or
 * agent.slug); equality checks against the current session need to handle
 * both id and slug shapes (the current session always has the slug
 * available via useWorkspaceAgents).
 *
 * All web-side author rendering and "is this me?" comparisons go through
 * these helpers so the id/slug ambiguity doesn't leak into call sites.
 */

export interface AgentRef {
  id: string;
  slug: string;
}

export interface MemberRef {
  id: string;
  name: string;
}

/** Parse `kind:value` strings; returns null on a missing or malformed prefix. */
export function parseAuthorRef(author: string): { kind: 'user' | 'agent'; value: string } | null {
  const colon = author.indexOf(':');
  if (colon === -1) return null;
  const kind = author.slice(0, colon);
  const value = author.slice(colon + 1);
  if (!value) return null;
  if (kind === 'user' || kind === 'agent') {
    return { kind, value };
  }
  return null;
}

/**
 * Human-readable display for any author string.
 * - `user:<id>` → member.name (or the raw id if no member match)
 * - `agent:<id>` → agent.slug (or the raw id if no agent match — covers
 *    legacy unbackfilled rows + agents deleted since)
 * - `agent:<slug>` → returned as-is (legacy pre-F11 rows that the backfill
 *    couldn't resolve)
 * - anything else → returned as-is
 */
export function authorDisplayName(
  author: string,
  agents: AgentRef[],
  members: MemberRef[],
): string {
  const ref = parseAuthorRef(author);
  if (!ref) return author;
  if (ref.kind === 'user') {
    const m = members.find((m) => m.id === ref.value);
    return m ? m.name : ref.value;
  }
  // agent
  const a = agents.find((a) => a.id === ref.value || a.slug === ref.value);
  return a ? a.slug : ref.value;
}

/**
 * Resolve the agent slug an author belongs to, regardless of whether the
 * stored form is id-canonical or legacy slug.
 *
 * - `agent:<id>` with id present in agents → that agent's slug.
 * - `agent:<slug>` with slug present in agents → that slug (back-compat).
 * - `agent:<unknown>` → null. Callers (ApprovalButtons, comment-row) MUST
 *    handle the null case explicitly: agents that vanished get an
 *    "original agent removed" affordance, not a phantom @<id> button.
 *    H17 dropped a prior heuristic that returned the raw suffix when it
 *    "looked slug-shaped" — that produced approve/reject buttons targeting
 *    non-existent agents AND inconsistently rejected long/digit-leading
 *    slugs.
 * - non-agent author → null.
 */
export function authorAgentSlug(author: string, agents: AgentRef[]): string | null {
  const ref = parseAuthorRef(author);
  if (!ref || ref.kind !== 'agent') return null;
  const a = agents.find((a) => a.id === ref.value || a.slug === ref.value);
  return a ? a.slug : null;
}

/**
 * Does the given author string identify the current session's actor?
 * Accepts either id or slug for agents (back-compat with pre-0008 rows).
 */
export function authorMatchesCurrent(
  author: string,
  currentUserId: string | null,
  currentAgent: AgentRef | null,
): boolean {
  const ref = parseAuthorRef(author);
  if (!ref) return false;
  if (ref.kind === 'user') return currentUserId !== null && ref.value === currentUserId;
  if (!currentAgent) return false;
  return ref.value === currentAgent.id || ref.value === currentAgent.slug;
}
