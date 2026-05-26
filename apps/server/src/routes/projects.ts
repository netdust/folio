import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, projects } from '../db/schema.ts';
import { emitEvent } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
import { slugUniqueInProjects } from '../lib/slug-unique.ts';
import { listProjects } from '../services/projects.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import {
  type ScopeContext,
  getProject,
  getRole,
  getWorkspace,
} from '../middleware/scope.ts';

const projectsRoute = new Hono<AuthContext & ScopeContext>();

// Mounted under wScope, which has already run resolveWorkspace + requireUser.

projectsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  return jsonOk(c, await listProjects(ws.id));
});

projectsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      slug: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      icon: z.string().max(32).optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const ws = getWorkspace(c);
    const { name, slug: explicit, icon } = c.req.valid('json');
    const id = nanoid();

    let slug = explicit ?? slugify(name);
    if (explicit) {
      const existing = await db.query.projects.findFirst({
        where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, explicit)),
      });
      if (existing)
        throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken in this workspace`, 409);
    } else {
      slug = await slugUniqueInProjects(db, ws.id, slug || 'project');
    }

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({ id, workspaceId: ws.id, slug, name, icon: icon ?? null });
      await seedProjectDefaults(tx, id);
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: id,
        kind: 'project.created',
        actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { id, workspaceId: ws.id, slug, name, icon: icon ?? null }, 201);
  },
);

// --- item (mounted under `/api/v1/w/:wslug/p/:pslug`; pScope already runs resolveProject) ---

const projectItemRoute = new Hono<AuthContext & ScopeContext>();

projectItemRoute.get('/', (c) => jsonOk(c, getProject(c)));

projectItemRoute.patch(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80).optional(),
      icon: z.string().max(32).nullable().optional(),
    }),
  ),
  async (c) => {
    const p = getProject(c);
    const ws = getWorkspace(c);
    const user = getUser(c);
    const patch = c.req.valid('json');
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(projects).set({ ...patch, updatedAt: now }).where(eq(projects.id, p.id));
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p.id,
        kind: 'project.updated',
        actor: user.id,
        payload: { changes: Object.keys(patch) },
      });
    });
    return jsonOk(c, { ...p, ...patch, updatedAt: now });
  },
);

projectItemRoute.delete('/', async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const p = getProject(c);
  const ws = getWorkspace(c);

  // Phase 2.5: application-level cascade. frontmatter.projects lives inside a
  // JSON column, so SQLite's FK system cannot scrub references when a project
  // is deleted. Do it transactionally so either (a) both the project delete
  // and every frontmatter scrub commit, or (b) neither does — no half-state.
  await db.transaction(async (tx) => {
    const wsAgents = await tx.query.documents.findMany({
      where: and(
        eq(documents.workspaceId, ws.id),
        inArray(documents.type, ['agent', 'trigger']),
      ),
    });
    const stale = wsAgents.filter((d) => {
      const projs = (d.frontmatter as { projects?: unknown }).projects;
      return Array.isArray(projs) && projs.includes(p.id);
    });
    for (const doc of stale) {
      const fm = doc.frontmatter as Record<string, unknown>;
      const projs = (fm.projects as string[]).filter((id) => id !== p.id);
      await tx
        .update(documents)
        .set({ frontmatter: { ...fm, projects: projs }, updatedAt: new Date() })
        .where(eq(documents.id, doc.id));
    }

    await tx.delete(projects).where(eq(projects.id, p.id));
  });

  return c.body(null, 204);
});

export { projectsRoute, projectItemRoute };
