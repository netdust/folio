import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { slugify, documentCreateSchema, documentPatchSchema } from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { slugUniqueInDocuments } from '../lib/slug-unique.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const documentsRoute = new Hono<AuthContext & ScopeContext>();

async function validateStatus(projectId: string, status: string | null | undefined) {
  if (status == null) return;
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.projectId, projectId), eq(statuses.key, status)),
  });
  if (!row) throw new HTTPError('INVALID_STATUS', `status "${status}" not in registry`, 422);
}

documentsRoute.post('/', zValidator('json', documentCreateSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');

  const fmStatus = typeof input.frontmatter?.status === 'string' ? (input.frontmatter.status as string) : null;
  if (input.type === 'work_item') await validateStatus(p.id, fmStatus);

  const id = nanoid();
  const baseSlug = slugify(input.title) || 'doc';
  const slug = await slugUniqueInDocuments(db, p.id, baseSlug);

  // Strip status from frontmatter (it lives in the column).
  const { status: _ignored, ...frontmatterRest } = (input.frontmatter ?? {}) as Record<string, unknown>;

  const row = {
    id,
    projectId: p.id,
    type: input.type,
    slug,
    title: input.title,
    status: fmStatus,
    body: input.body,
    frontmatter: frontmatterRest,
    parentId: input.parentId ?? null,
    createdBy: user.id,
    updatedBy: user.id,
  };

  await db.transaction(async (tx) => {
    await tx.insert(documents).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, documentId: id, kind: 'document.created', actor: user.id,
      payload: { slug, type: input.type },
    });
  });

  return jsonOk(c, { document: row }, 201);
});

documentsRoute.get('/:slug', async (c) => {
  const p = getProject(c);
  const slug = c.req.param('slug');
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  return jsonOk(c, { document: row });
});

documentsRoute.patch('/:slug', zValidator('json', documentPatchSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const patch = c.req.valid('json');
  if (patch.status !== undefined && existing.type === 'work_item') {
    await validateStatus(p.id, patch.status);
  }

  const mergedFrontmatter = (() => {
    if (patch.frontmatter === undefined) return existing.frontmatter;
    const merged: Record<string, unknown> = { ...existing.frontmatter };
    for (const [k, v] of Object.entries(patch.frontmatter)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    return merged;
  })();

  const updated = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    frontmatter: mergedFrontmatter,
    ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    updatedBy: user.id,
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    await tx.update(documents).set(updated).where(eq(documents.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, documentId: existing.id,
      kind: 'document.updated', actor: user.id,
      payload: { changes: Object.keys(patch) },
    });
  });

  return jsonOk(c, { document: updated });
});

documentsRoute.delete('/:slug', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(documents).where(eq(documents.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, documentId: existing.id,
      kind: 'document.deleted', actor: user.id,
      payload: { id: existing.id, slug: existing.slug, type: existing.type, title: existing.title },
    });
  });
  return c.body(null, 204);
});

export { documentsRoute };
