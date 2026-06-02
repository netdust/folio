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
 * Provenance invariant for `__system` (M4): the library workspace may carry AT
 * MOST ONE membership, and that membership must be the instance OWNER. Anything
 * else is a hijack — a foreign membership, a non-owner role, or a second member
 * — and we THROW (never adopt; adopting a foreign membership would be a silent
 * instance-admin escalation).
 *
 * This is the single source of truth for the rule (review fix #1/#7): a clean
 * bootstrap has ZERO memberships; a designated instance has EXACTLY ONE `owner`
 * (the one `grantOwner` itself creates). The earlier "ANY membership = tainted"
 * rule was wrong — it tripped on the legitimate owner on every restart after the
 * first designation, breaking idempotency (M8) and the self-heal-on-boot
 * contract. Distinguishing the one legitimate owner from a foreign membership is
 * exactly what makes bootstrap safe to re-run forever.
 */
async function assertSystemProvenance(db: DB, workspaceId: string): Promise<void> {
  const members = await db.query.memberships.findMany({
    where: eq(memberships.workspaceId, workspaceId),
  });
  if (members.length === 0) return; // clean, member-less → a prior bootstrap
  const tainted =
    members.length > 1 || members.some((m) => m.role !== 'owner');
  if (tainted) {
    throw new HTTPError(
      'SYSTEM_WORKSPACE_TAINTED',
      '__system carries an unexpected membership; refusing to bootstrap onto it',
      500,
    );
  }
  // Exactly one `owner` membership: the legitimate instance owner. Accept.
}

/**
 * Resolve the `__system` workspace, creating it if absent. Idempotent and
 * race-safe: the `findFirst` guard is TOCTOU-racy, so a concurrent double
 * bootstrap is absorbed by an `onConflictDoNothing` on the `workspaces.slug`
 * UNIQUE constraint (review fix #10 — replaces the brittle err.message
 * string-match with the codebase's established onConflict idiom) and re-resolved.
 * Provenance (M4) is asserted via `assertSystemProvenance` — once, regardless of
 * which path created the row.
 */
async function resolveSystemWorkspace(db: DB): Promise<{ id: string }> {
  // onConflictDoNothing makes a concurrent double-bootstrap a no-op on the loser
  // (the UNIQUE on workspaces.slug is the real backstop), then we re-resolve.
  await db
    .insert(workspaces)
    .values({ id: nanoid(), slug: SYSTEM_WORKSPACE_SLUG, name: 'System Library' })
    .onConflictDoNothing({ target: workspaces.slug });

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
  });
  if (!ws) {
    // Unreachable in practice (we just inserted-or-found it); fail loud rather
    // than return a phantom id.
    throw new HTTPError(
      'SYSTEM_WORKSPACE_MISSING',
      '__system could not be resolved after insert',
      500,
    );
  }
  await assertSystemProvenance(db, ws.id);
  return { id: ws.id };
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
  //
  // SEED-ONCE (review fix #6, known limitation): this early-returns on an
  // existing page and NEVER reconciles the body. A later deploy that ships an
  // updated FOLIO_SKILL_BODY / SETUP_PROJECT_REF_BODY does NOT propagate to the
  // already-seeded page — the operator keeps reading the old content. This is the
  // DESIGNED M8 contract (seed exactly one of each, never update); in-place
  // content upgrade of library docs is Phase D (the curation UI). Do NOT mistake
  // this for an upgrade path.
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
 *
 * Two deliberate divergences from the production `POST /workspaces` path:
 *  - These structure inserts use raw `db.insert` and emit NO events (they do
 *    NOT go through `txWithEvents` — the every-write-emits-event convergence
 *    point). This is intentional: bootstrap is a one-time, structure-only boot
 *    path with no live SSE consumer and no reactor in `__system`, so there is
 *    nothing to desync. (The operator agent — the one seeded write with a
 *    potential consumer — DOES emit `document.created`/`agent.created` because
 *    it goes through `createDocument`.)
 *  - `__system` gets NO builtin triggers (unlike user workspaces, which call
 *    `seedBuiltinTriggers`): the system library is not a reacting workspace.
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
 * Resolve the `__system` workspace id by slug (Phase B B2 — cross-workspace
 * execution resolves library agents against `__system`). Mirrors
 * `requireSystemWorkspace`: an absent `__system` is a programming error
 * (bootstrap must have run first) → throws the same SYSTEM_WORKSPACE_MISSING
 * (500).
 *
 * DELIBERATELY NOT memoized: a single indexed findFirst on the UNIQUE
 * `workspaces.slug` column is cheap, and a per-process id cache would leak
 * across the in-memory test DBs that `__resetDbForTests()` swaps in
 * (cross-test contamination). The plan explicitly permits skipping the cache
 * — this is that choice.
 */
export async function getSystemWorkspaceId(db: DB): Promise<string> {
  const sys = await requireSystemWorkspace(db);
  return sys.id;
}

/**
 * Grant the `__system` workspace `owner` membership to the user with `email`,
 * and return the resolved instance-owner's user id (whether this call granted it
 * or a prior one did — review fix #8: the caller reuses this id instead of
 * re-querying).
 *
 * First-wins idempotent (fix #2): if `__system` ALREADY has an `owner`
 * membership we no-op and return ITS userId — a re-grant for a different email is
 * IGNORED, never replacing the existing owner (the owner is the instance admin;
 * silently swapping it would be an escalation). Independent of
 * `ensureOperatorAgent`: neither hides behind the other's early-return, so a
 * re-run after a mid-failure repairs whichever step is missing.
 *
 * NOT self-serializing: `grantOwner` is lock-free and assumes its sole caller
 * (`designateInstanceOwner`) holds the process-wide `withDesignationLock` (review
 * fix #5) — that mutex, not a DB transaction, is what prevents two concurrent
 * grants from both passing the "no owner yet" check and inserting two owner rows
 * (the memberships PK (workspace_id, user_id) would allow two DIFFERENT users to
 * both become owner). Do NOT call `grantOwner` concurrently outside that lock.
 *
 * Throws INSTANCE_OWNER_NOT_FOUND (404) when no user has that email.
 */
/**
 * Process-wide serialization for the owner-designation path (review fix #5).
 * Folio is a single binary / single process (one shared bun:sqlite connection),
 * so two concurrent designations interleave at their `await` points on the SAME
 * connection — a DB write lock can't serialize them (no second connection to
 * contend), and the memberships PK (workspace_id, user_id) lets two DIFFERENT
 * users both become owner (and the operator-agent seed could double too). A tiny
 * in-process promise-chain mutex fully closes the race for the single-process
 * deployment Folio targets: the second designation waits, sees the first owner +
 * agent, and no-ops. (Multi-process would need a DB constraint — out of scope:
 * Folio is one process by architecture.) The whole grant+seed pair runs under
 * ONE lock acquisition so the agent seed can't race either.
 */
let designationLock: Promise<unknown> = Promise.resolve();
function withDesignationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = designationLock.then(fn, fn);
  // Keep the chain alive but swallow errors on the lock itself so one failed
  // designation doesn't poison the next caller's turn.
  designationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function grantOwner(db: DB, email: string): Promise<string> {
  const sys = await requireSystemWorkspace(db);

  const existingOwner = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, sys.id), eq(memberships.role, 'owner')),
  });
  if (existingOwner) return existingOwner.userId; // first-wins; do NOT replace

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
  return user.id;
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

  try {
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
  } catch (err) {
    // Race-safe (review fix #5): the findFirst guard above is TOCTOU, and
    // createDocument is opaque (own tx, no onConflict hook). If a concurrent
    // designate already seeded the operator, the second createDocument trips the
    // documents (workspace_id, type, slug) UNIQUE — treat that as "already
    // seeded" (idempotent no-op), re-throw anything else.
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: documents.workspace_id')
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Designate the instance owner: a thin orchestrator over the two independently
 * idempotent steps. Grants owner, then seeds the operator agent with the
 * resolved owner as the actor. Because each step is independently idempotent, a
 * re-run after ANY mid-failure repairs the missing piece (e.g. owner inserted but
 * agent seed threw → re-run no-ops the grant and seeds the agent).
 *
 * Review fix #8: `grantOwner` returns the resolved owner userId, so we pass it
 * straight to `ensureOperatorAgent` — no second user lookup, no membership-
 * fallback branch (the previous fallback was unreachable from the one production
 * caller, which pre-checks the user exists).
 */
export async function designateInstanceOwner(db: DB, email: string): Promise<void> {
  // One lock acquisition for the whole grant+seed pair (review fix #5) so two
  // concurrent designations on a fresh instance can't insert two owners or two
  // operator agents. See withDesignationLock.
  await withDesignationLock(async () => {
    const ownerUserId = await grantOwner(db, email);
    await ensureOperatorAgent(db, ownerUserId);
  });
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
