import { slugify } from '@folio/shared';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { documents, memberships, projects, users, workspaces } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { createDocument } from '../services/documents.ts';
import { HTTPError } from './http.ts';
import {
  FOLIO_SKILL_BODY,
  OPERATOR_AGENT_TITLE,
  OPERATOR_PROMPT,
  OPERATOR_TOOLS,
  SETUP_PROJECT_REF_BODY,
} from './system-skills.ts';

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
  // Idempotency keys on title (not the DB unique column slug). Safe for the
  // seeded set: the two fixed titles slugify to distinct slugs in distinct
  // projects, so title-uniqueness implies slug-uniqueness here. A future caller
  // passing two titles that slugify identically into one project would miss this
  // guard and hit the (project_id, slug) UNIQUE on insert — fail-loud, not silent.
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

/**
 * Resolve the __system workspace by slug for the post-bootstrap steps. Unlike
 * `resolveSystemWorkspace` (which CREATES + asserts provenance at bootstrap),
 * this asserts the workspace already exists — the caller bootstraps first. An
 * absent __system here is a programming error (bootstrap was skipped).
 */
async function requireSystemWorkspace(db: DB) {
  const sys = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
  });
  if (!sys) {
    throw new HTTPError(
      'SYSTEM_WORKSPACE_MISSING',
      '__system not found; bootstrapSystemWorkspace must run before owner designation',
      500,
    );
  }
  return sys;
}

/**
 * Grant the `__system` workspace `owner` membership to the user with `email`.
 *
 * First-wins idempotent (fix #2): if `__system` ALREADY has an `owner`
 * membership we no-op — a re-grant for a different email is IGNORED, never
 * replacing the existing owner (the owner is the instance admin; silently
 * swapping it would be an escalation). Independent of `ensureOperatorAgent`:
 * neither hides behind the other's early-return, so a re-run after a mid-failure
 * repairs whichever step is missing.
 *
 * Throws INSTANCE_OWNER_NOT_FOUND (404) when no user has that email.
 */
export async function grantOwner(db: DB, email: string): Promise<void> {
  const sys = await requireSystemWorkspace(db);

  const existingOwner = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, sys.id), eq(memberships.role, 'owner')),
  });
  if (existingOwner) return; // first-wins; do NOT replace

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    throw new HTTPError(
      'INSTANCE_OWNER_NOT_FOUND',
      `no user with email ${email}`,
      404,
    );
  }

  await db
    .insert(memberships)
    .values({ workspaceId: sys.id, userId: user.id, role: 'owner' });
}

/**
 * Seed the operator AGENT into `__system`, idempotently and INDEPENDENTLY of
 * `grantOwner` (fix #2). The operator is identified by being THE agent document
 * in `__system` (workspaceId=__system, type='agent') — NOT a magic slug. If one
 * already exists we no-op.
 *
 * Otherwise the agent doc is created via `createDocument`, which (for
 * type='agent') auto-mints + inserts its bearer token (scopes = tools→scopes,
 * workspaceId = __system). We do NOT hand-roll the token; the returned plaintext
 * is discarded (only the hash persists). `actorUserId` supplies the agent doc's
 * `createdBy` actor — it must be an existing user.
 */
export async function ensureOperatorAgent(
  db: DB,
  actorUserId: string,
): Promise<void> {
  const sys = await requireSystemWorkspace(db);

  const existingAgent = await db.query.documents.findFirst({
    where: and(eq(documents.workspaceId, sys.id), eq(documents.type, 'agent')),
  });
  if (existingAgent) return; // idempotent: the operator already exists

  const actor = await db.query.users.findFirst({ where: eq(users.id, actorUserId) });
  if (!actor) {
    throw new HTTPError(
      'OPERATOR_ACTOR_NOT_FOUND',
      `no user with id ${actorUserId} to act as the operator's creator`,
      500,
    );
  }

  await createDocument({
    workspace: sys,
    project: null, // agent ⇒ project_id IS NULL (createDocument enforces)
    table: null,
    actor,
    token: null,
    input: {
      type: 'agent',
      title: OPERATOR_AGENT_TITLE,
      body: OPERATOR_PROMPT,
      status: null,
      frontmatter: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6', // required for API providers (agentFrontmatterSchema)
        tools: [...OPERATOR_TOOLS],
        projects: ['*'],
        requires_approval: false,
      },
    },
  });
}

/**
 * Designate the instance owner: a thin orchestrator over the two independently
 * idempotent steps. Grants owner, then seeds the operator agent. Because each
 * step is independently idempotent, a re-run after ANY mid-failure repairs the
 * missing piece (e.g. owner inserted but agent seed threw → re-run no-ops the
 * grant and seeds the agent).
 */
export async function designateInstanceOwner(db: DB, email: string): Promise<void> {
  await grantOwner(db, email);

  const owner = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!owner) {
    // grantOwner just succeeded (or no-op'd onto a pre-existing owner). If the
    // email no longer resolves, the pre-existing owner was designated under a
    // different email; resolve the actor from the membership instead.
    const sys = await requireSystemWorkspace(db);
    const ownerMembership = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, sys.id), eq(memberships.role, 'owner')),
    });
    if (!ownerMembership) {
      throw new HTTPError(
        'INSTANCE_OWNER_NOT_FOUND',
        `no owner resolvable for ${email}`,
        404,
      );
    }
    await ensureOperatorAgent(db, ownerMembership.userId);
    return;
  }

  await ensureOperatorAgent(db, owner.id);
}

/**
 * Boot-time orchestrator (M4/M5/M8): always bootstraps the `__system` library
 * workspace, then — only when `FOLIO_INSTANCE_OWNER` is set AND that user
 * already exists — designates the instance owner (grants owner membership +
 * seeds the operator agent).
 *
 * A misconfigured owner email must NOT take the server down: if the email is
 * unset we skip designation; if it is set but no such user exists we log a
 * clear warning and skip — never crash boot. This function ALWAYS does the real
 * work (no test self-skip); `index.ts` gates the call to non-test so importing
 * the module in tests does not trigger a real bootstrap.
 */
export async function runBootTasks(
  db: DB,
  env: Pick<Env, 'FOLIO_INSTANCE_OWNER'>,
): Promise<void> {
  await bootstrapSystemWorkspace(db);

  const ownerEmail = env.FOLIO_INSTANCE_OWNER;
  if (!ownerEmail) return; // M8: no owner configured → bootstrap only

  // Pre-check the user exists so a misconfigured email is a warning, not a
  // crash — and so we never swallow a genuine (non-not-found) designate error.
  const user = await db.query.users.findFirst({
    where: eq(users.email, ownerEmail),
  });
  if (!user) {
    console.warn(
      `[folio] FOLIO_INSTANCE_OWNER ${ownerEmail} not found; skipping owner designation`,
    );
    return;
  }

  await designateInstanceOwner(db, ownerEmail);
}
