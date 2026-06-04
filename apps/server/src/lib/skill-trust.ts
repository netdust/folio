import { eq } from 'drizzle-orm';
import type { ApiToken, User } from '../db/schema.ts';
import { instanceSkills } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

/**
 * Skill-blessing separation of duties (T8). Authoring a skill is open; flipping
 * `trusted` is restricted to: a session user (no token), OR the system-origin
 * operator token (createdBy IS NULL — unforgeable: POST /tokens always stamps a
 * human createdBy). An MCP admin PAT (createdBy = a human) is excluded by
 * construction, so the externally-reachable agent cannot self-bless a planted skill.
 */
export function canBlessSkill(
  token: Pick<ApiToken, 'createdBy'> | null,
  sessionUser: Pick<User, 'id'> | null,
): boolean {
  if (sessionUser && !token) return true;
  if (token && token.createdBy === null) return true;
  return false;
}

export interface SetSkillTrustArgs {
  slug: string;
  trusted: boolean;
  /** The bearer token for the request, or null for a session-auth caller. */
  token: Pick<ApiToken, 'createdBy'> | null;
  /** The hydrated session user, or null on the token path. */
  sessionUser: Pick<User, 'id'> | null;
  /** Audit actor string for the emitted event. */
  actor: string;
}

/**
 * Flip the `trusted` TYPED COLUMN on an instance skill — the ONLY path that may
 * change it (invariant 11). Because `trusted` is a column, no body/frontmatter
 * write (import, restore, update_skill) can set it: the forging path is closed
 * STRUCTURALLY, not by stripping. T8 gate enforced via canBlessSkill; everything
 * else throws so the tool/route layer surfaces it as a refusal.
 *
 * NOTE (Phase 4): the prior `skill.trust.changed` event was emitted scoped to
 * `__system` (which is being torn down). It had no consumer; the emit is dropped
 * with the `__system` teardown (consistent with the `user.role.changed` decision).
 * The trust flip is still the single sanctioned mutator of the column.
 */
export async function setSkillTrust(db: DB, args: SetSkillTrustArgs): Promise<void> {
  const { slug, trusted, token, sessionUser } = args;
  if (!canBlessSkill(token, sessionUser)) {
    throw new Error('forbidden: skill blessing requires a session user or the system operator');
  }

  const skill = await db.query.instanceSkills.findFirst({
    where: eq(instanceSkills.name, slug),
  });
  if (!skill) throw new Error('skill not found');

  await db
    .update(instanceSkills)
    .set({ trusted })
    .where(eq(instanceSkills.id, skill.id));
}
