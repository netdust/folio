import { and, eq } from 'drizzle-orm';
import type { ApiToken, User } from '../db/schema.ts';
import { documents, projects } from '../db/schema.ts';
import type { DB } from '../db/client.ts';
import { emitEvent, txWithEvents } from './events.ts';
import { getSystemWorkspaceId } from './system-workspace.ts';

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
 * Flip the `trusted` flag on a __system skills page — the ONLY path that may
 * change it (normal create/update_document writes to a __system skills page
 * strip `trusted`; see services/documents.ts). T8 gate is enforced via
 * canBlessSkill; everything else throws so the tool/route layer surfaces it as
 * a refusal. Emits `skill.trust.changed` through the single event path.
 */
export async function setSkillTrust(db: DB, args: SetSkillTrustArgs): Promise<void> {
  const { slug, trusted, token, sessionUser, actor } = args;
  if (!canBlessSkill(token, sessionUser)) {
    throw new Error('forbidden: skill blessing requires a session user or the system operator');
  }

  const systemId = await getSystemWorkspaceId(db);
  const skillsProject = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, systemId), eq(projects.slug, 'skills')),
  });
  if (!skillsProject) throw new Error('skills library not found');

  const doc = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, systemId),
      eq(documents.projectId, skillsProject.id),
      eq(documents.slug, slug),
      eq(documents.type, 'page'),
    ),
  });
  if (!doc) throw new Error('skill not found');

  const existingFm = (doc.frontmatter ?? {}) as Record<string, unknown>;
  const nextFm = { ...existingFm, trusted };

  await txWithEvents(db, async (tx) => {
    await tx
      .update(documents)
      .set({ frontmatter: nextFm, updatedAt: new Date() })
      .where(eq(documents.id, doc.id));
    await emitEvent(tx, {
      workspaceId: systemId,
      projectId: skillsProject.id,
      documentId: doc.id,
      kind: 'skill.trust.changed',
      actor,
      payload: { slug, trusted },
    });
  });
}
