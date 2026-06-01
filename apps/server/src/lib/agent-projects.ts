/**
 * S1: Single source of truth for "what projects can this agent see?"
 *
 * Three read paths all need the same answer:
 *   - bearer middleware (`requireResource`) — gates per-request project access.
 *   - SSE replay/live (`routes/events.ts`) — filters the event stream.
 *   - comment mention resolution (`services/comments.ts::loadWorkspaceAgents`)
 *     — filters which agents `parseMentions` is allowed to resolve to.
 *
 * Before S1 these three places each parsed `agent.frontmatter.projects`
 * independently. G11 caught that two of them used `ids[0] === '*'` (positional)
 * while a third used `.includes('*')` (any position); a hand-edited
 * `['proj-1', '*']` therefore behaved as wildcard on one path and as a literal
 * project id on the others. Fail-closed semantics need ONE function.
 *
 * Vocabulary:
 *   - `['*']` (or any list containing '*') → workspace-wide. Returned as
 *     literal `['*']` so callers can branch on `.includes('*')` cheaply.
 *   - `[]` → explicitly no access (intentional config).
 *   - `[id1, id2, ...]` → exactly those project ids.
 *   - missing / non-array → legacy pre-2.5 agent → treat as `['*']` for
 *     backward compatibility. New agents go through the Zod schema which
 *     requires the field, so this branch only fires for hand-edited
 *     frontmatter or unmigrated rows.
 */

import type { Document } from '../db/schema.ts';

/**
 * Extract the canonical allow-list from an agent document.
 * Always returns a non-null array; callers branch on `.includes('*')`.
 */
export function resolveAgentProjects(agent: Pick<Document, 'frontmatter'>): string[] {
  const fm = agent.frontmatter as { projects?: unknown } | null | undefined;
  const raw = fm?.projects;
  if (!Array.isArray(raw)) return ['*'];
  const list = raw.filter((x): x is string => typeof x === 'string');
  // Any '*' anywhere collapses to ['*']. Two reasons:
  //   1. Downstream callers do `.includes('*')` cheaply.
  //   2. Matches the Zod refine on writes: '*' MUST be alone — but the refine
  //      only runs on API writes, so hand-edited rows can carry mixed lists.
  //      Collapsing makes the read path independent of write-path validation.
  if (list.includes('*')) return ['*'];
  return list;
}

/**
 * Intersect an agent's allow-list with an optional token-level narrowing.
 *
 * - `null` on the token side means "inherit from agent" — distinct from `[]`
 *   (no projects). Confusing the two is the most likely bug here.
 * - `'*'` on the agent side means "all workspace projects"; intersecting with
 *   a concrete token list returns that concrete list.
 * - The token can only narrow, never broaden. Tokens listing project ids the
 *   agent doesn't have are silently dropped — the broadening attempt fails
 *   closed at the intersection step.
 *
 * Returns the effective list (still wildcard-aware: `.includes('*')` means
 * full access).
 */
export function intersectAgentProjects(
  agentList: string[],
  tokenList: string[] | null,
): string[] {
  if (tokenList === null) return agentList;
  if (agentList.includes('*')) return tokenList;
  return agentList.filter((id) => tokenList.includes(id));
}

/**
 * Map an authenticated caller to the project set the delegate ceiling clamps
 * against (mitigation D5). Owners/admins have full project access → null
 * (wildcard; `intersectAgentProjects` treats null as "no narrowing"). A regular
 * member is clamped to their EXPLICIT project membership list — never wildcard,
 * so a member can never borrow an agent's broader project reach. An empty
 * membership list stays [] (deny), never coerced to wildcard (mitigation D9).
 */
export function callerProjectsFor(actor: {
  role: 'owner' | 'admin' | 'member';
  projectIds: string[];
}): string[] | null {
  if (actor.role === 'owner' || actor.role === 'admin') return null;
  return actor.projectIds;
}
