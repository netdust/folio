/**
 * Canonical author-reference parsing — shared between web + server.
 *
 * Comment frontmatter stores authors as `user:<id>` or `agent:<id>` (the
 * canonical form post-migration 0008). UI surfaces want the human slug;
 * server-side guards compare against the bare id; markdown export wants a
 * human label. All three flows go through the helpers here so the
 * colon-split rule, the prefix vocabulary, and the back-compat for
 * pre-migration `agent:<slug>` rows live in exactly one place.
 *
 * S6 promoted this from apps/web/src/lib/author-ref.ts so the server's
 * mention-parser, comment-schema regex, and authorString all share one
 * source of truth instead of three drifting hand-coded copies.
 */

export const AUTHOR_KINDS = ['user', 'agent'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/** Regex shape: `<kind>:<value>` where kind ∈ {user, agent} and value is non-empty. */
export const AUTHOR_REF_RE = /^(user|agent):.+$/;

export interface AgentRef {
  id: string;
  slug: string;
}

export interface MemberRef {
  id: string;
  name: string;
}

/** Parse `kind:value` strings; null on missing/malformed prefix or empty value. */
export function parseAuthorRef(author: string): { kind: AuthorKind; value: string } | null {
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
 * - `agent:<slug>` → returned as-is (legacy pre-0008 rows that the backfill
 *    couldn't temporally resolve)
 * - anything else → returned as-is
 */
export function authorDisplayName(
  author: string,
  agents: readonly AgentRef[],
  members: readonly MemberRef[],
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
 * stored form is id-canonical or legacy slug. Returns null when the agent
 * doesn't exist in the provided list (callers MUST handle null — no
 * phantom-slug fallback).
 */
export function authorAgentSlug(
  author: string,
  agents: readonly AgentRef[],
): string | null {
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

/**
 * Construct the canonical author string for a context.
 * - Session/PAT user → "user:<id>"
 * - Agent → "agent:<id>"
 * Caller MUST provide agentId for agents — slugs are mutable.
 */
export function authorString(
  ctx:
    | { type: 'user'; userId: string }
    | { type: 'agent'; agentId: string },
): string {
  if (ctx.type === 'user') return `user:${ctx.userId}`;
  return `agent:${ctx.agentId}`;
}

/**
 * Strip the `kind:` prefix from a target. Used by mention-parser when
 * emitting bus events that carry a bare slug. Returns the suffix
 * regardless of whether the prefix was `user:` or `agent:`; for inputs
 * without a colon, returns the input unchanged.
 */
export function stripAuthorPrefix(target: string): string {
  const colon = target.indexOf(':');
  if (colon === -1) return target;
  return target.slice(colon + 1);
}
