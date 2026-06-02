import { slugify } from '@folio/shared';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { documents, memberships, projects, workspaces } from '../db/schema.ts';
import { HTTPError } from './http.ts';
import { FOLIO_SKILL_BODY, SETUP_PROJECT_REF_BODY } from './system-skills.ts';

/** The single reserved library workspace. Underscore-prefixed slugs are a
 *  reserved namespace users cannot create (the workspace create/rename regex
 *  `^[a-z0-9-]+$` already blocks underscores; isReservedSlug is the explicit
 *  defense-in-depth so loosening that regex can never silently reopen the
 *  hijack — see Phase A threat model M2/M3). */
export const SYSTEM_WORKSPACE_SLUG = '__system';

/** True for any reserved (underscore-prefixed) workspace slug. */
export function isReservedSlug(slug: string): boolean {
  return slug.startsWith('_');
}

/**
 * Resolve the `__system` workspace, creating it if absent. Idempotent and
 * race-safe: the `findFirst` guard is TOCTOU-racy, so a concurrent double
 * bootstrap is caught at the `workspaces.slug` UNIQUE constraint and re-resolved
 * (fix #5) rather than crashing. Returns the workspace row.
 *
 * Provenance (M4): a pre-existing `__system` that carries ANY membership is a
 * hijack — we THROW, never adopt it (adopting a foreign membership would be a
 * silent instance-admin escalation). A clean, member-less `__system` is a prior
 * bootstrap and is accepted for ensure-structure.
 */
async function resolveSystemWorkspace(db: DB): Promise<{ id: string }> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
  });
  if (existing) {
    const member = await db.query.memberships.findFirst({
      where: eq(memberships.workspaceId, existing.id),
    });
    if (member) {
      throw new HTTPError(
        'SYSTEM_WORKSPACE_TAINTED',
        '__system carries an unexpected membership; refusing to bootstrap onto it',
        500,
      );
    }
    return { id: existing.id };
  }

  try {
    const id = nanoid();
    await db
      .insert(workspaces)
      .values({ id, slug: SYSTEM_WORKSPACE_SLUG, name: 'System Library' });
    return { id };
  } catch (err) {
    // Concurrent double-bootstrap: the UNIQUE constraint on workspaces.slug is
    // the real idempotency backstop. Re-resolve; re-throw anything else.
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      const reResolved = await db.query.workspaces.findFirst({
        where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
      });
      if (reResolved) {
        // The winner of the race created it member-less; re-verify provenance.
        const member = await db.query.memberships.findFirst({
          where: eq(memberships.workspaceId, reResolved.id),
        });
        if (member) {
          throw new HTTPError(
            'SYSTEM_WORKSPACE_TAINTED',
            '__system carries an unexpected membership; refusing to bootstrap onto it',
            500,
          );
        }
        return { id: reResolved.id };
      }
    }
    throw err;
  }
}

/** findFirst-by-(workspaceId, slug), else insert a bare project. Idempotent. */
async function ensureSystemProject(
  db: DB,
  workspaceId: string,
  slug: string,
  name: string,
): Promise<{ id: string }> {
  const existing = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, workspaceId), eq(projects.slug, slug)),
  });
  if (existing) return { id: existing.id };
  const id = nanoid();
  await db.insert(projects).values({ id, workspaceId, slug, name });
  return { id };
}

/** findFirst-by-(workspaceId, projectId, title), else insert a page doc. Idempotent. */
async function ensureSystemPage(
  db: DB,
  workspaceId: string,
  projectId: string,
  title: string,
  body: string,
): Promise<void> {
  const existing = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.projectId, projectId),
      eq(documents.title, title),
    ),
  });
  if (existing) return;
  await db.insert(documents).values({
    id: nanoid(),
    workspaceId,
    projectId, // non-null: CHECK (migration 0006) requires project_id for type 'page'
    type: 'page',
    title,
    slug: slugify(title),
    body,
    status: null,
    frontmatter: {},
    createdBy: null, // structure-only; no user actor at bootstrap
  });
}

/**
 * Create + seed the `__system` library workspace: the workspace itself, its
 * `Skills` and `Reference` projects, and the two content `page` docs (the
 * `folio` skill page; the setup-project reference page). Idempotent,
 * structure-only, provenance-asserting (M4), and grants NO membership (M8).
 *
 * The operator AGENT doc is intentionally NOT seeded here: it needs a user
 * actor for its token's `createdBy`, so it is created in `ensureOperatorAgent`
 * at owner-designation (Task 5).
 */
export async function bootstrapSystemWorkspace(db: DB): Promise<void> {
  const sys = await resolveSystemWorkspace(db);

  const skillsProject = await ensureSystemProject(db, sys.id, 'skills', 'Skills');
  const referenceProject = await ensureSystemProject(
    db,
    sys.id,
    'reference',
    'Reference',
  );

  await ensureSystemPage(db, sys.id, skillsProject.id, 'folio', FOLIO_SKILL_BODY);
  await ensureSystemPage(
    db,
    sys.id,
    referenceProject.id,
    'Set up a project',
    SETUP_PROJECT_REF_BODY,
  );
}
