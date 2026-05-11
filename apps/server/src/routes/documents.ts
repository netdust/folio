import { and, desc, eq, lt, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import {
  slugify,
  documentCreateSchema,
  documentPatchSchema,
  filterCompile,
  FilterCompileError,
} from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { parseMarkdown } from '../lib/frontmatter.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
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

function isMarkdownRequest(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.startsWith('text/markdown') || ct.startsWith('text/plain');
}

function deriveTitleFromBody(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

interface ParsedMdInput {
  type: 'work_item' | 'page';
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  status: string | null;
}

function parseMarkdownInput(raw: string, defaults?: { type?: 'work_item' | 'page' }): ParsedMdInput {
  const { frontmatter, body } = parseMarkdown(raw);
  const fmType = frontmatter.type;
  const type: 'work_item' | 'page' =
    fmType === 'work_item' || fmType === 'page' ? fmType : (defaults?.type ?? 'work_item');
  const title =
    deriveTitleFromBody(body) ??
    (typeof frontmatter.title === 'string' ? frontmatter.title : null) ??
    'Untitled';
  const status = typeof frontmatter.status === 'string' ? frontmatter.status : null;
  const { type: _t, title: _ti, status: _s, ...rest } = frontmatter;
  return { type, title, body, frontmatter: rest, status };
}

documentsRoute.post('/', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);

  let input: ParsedMdInput;
  if (isMarkdownRequest(c.req.raw)) {
    const raw = await c.req.text();
    input = parseMarkdownInput(raw);
  } else {
    const json = await c.req.json();
    const parsed = documentCreateSchema.safeParse(json);
    if (!parsed.success) {
      throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
    }
    const v = parsed.data;
    const fmStatus = typeof v.frontmatter?.status === 'string' ? v.frontmatter.status : null;
    const { status: _, ...fmRest } = (v.frontmatter ?? {}) as Record<string, unknown>;
    input = { type: v.type, title: v.title, body: v.body, frontmatter: fmRest, status: fmStatus };
  }

  if (input.type === 'work_item') await validateStatus(p.id, input.status);

  const id = nanoid();
  const baseSlug = slugify(input.title) || 'doc';
  const slug = await slugUniqueInDocuments(db, p.id, baseSlug);

  const row = {
    id,
    projectId: p.id,
    type: input.type,
    slug,
    title: input.title,
    status: input.status,
    body: input.body,
    frontmatter: input.frontmatter,
    parentId: null as string | null,
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

function encodeCursor(updatedAt: number, id: string): string {
  return Buffer.from(`${updatedAt}:${id}`).toString('base64');
}

function decodeCursor(s: string): { updatedAt: number; id: string } | null {
  try {
    const raw = Buffer.from(s, 'base64').toString('utf8');
    const [t, id] = raw.split(':');
    const updatedAt = Number(t);
    if (!Number.isFinite(updatedAt) || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

documentsRoute.get('/', async (c) => {
  const p = getProject(c);
  const type = c.req.query('type');
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
  const cursorRaw = c.req.query('cursor');
  const filterRaw = c.req.query('filter');

  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  let filterWhere: ReturnType<typeof compileFilterToWhere> = undefined;
  if (filterRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(filterRaw);
    } catch {
      throw new HTTPError('INVALID_FILTER', 'filter must be valid JSON', 422);
    }
    try {
      const ast = filterCompile(parsed as Parameters<typeof filterCompile>[0]);
      filterWhere = compileFilterToWhere(ast, documents);
    } catch (e) {
      if (e instanceof FilterCompileError) throw new HTTPError('INVALID_FILTER', e.message, 422);
      throw e;
    }
  }

  const whereClauses = [eq(documents.projectId, p.id)];
  if (type === 'work_item' || type === 'page') {
    whereClauses.push(eq(documents.type, type));
  }
  if (filterWhere) whereClauses.push(filterWhere);
  if (cursor) {
    const ts = new Date(cursor.updatedAt);
    whereClauses.push(
      or(
        lt(documents.updatedAt, ts),
        and(eq(documents.updatedAt, ts), lt(documents.id, cursor.id)) as never,
      ) as never,
    );
  }

  const rows = await db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.updatedAt.getTime(), last.id) : null;

  return c.json({ data: page, nextCursor });
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

documentsRoute.patch('/:slug', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  if (isMarkdownRequest(c.req.raw)) {
    const raw = await c.req.text();
    const parsed = parseMarkdownInput(raw, { type: existing.type as 'work_item' | 'page' });
    if (parsed.type !== existing.type) {
      throw new HTTPError('INVALID_BODY', 'document type cannot change', 422);
    }
    if (existing.type === 'work_item') await validateStatus(p.id, parsed.status);
    const updated = {
      ...existing,
      title: parsed.title,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      status: parsed.status,
      updatedBy: user.id,
      updatedAt: new Date(),
    };
    await db.transaction(async (tx) => {
      await tx.update(documents).set(updated).where(eq(documents.id, existing.id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, documentId: existing.id,
        kind: 'document.updated', actor: user.id,
        payload: { changes: ['title', 'body', 'frontmatter', 'status'] },
      });
    });
    return jsonOk(c, { document: updated });
  }

  // JSON branch
  const json = await c.req.json();
  const parsed = documentPatchSchema.safeParse(json);
  if (!parsed.success) throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
  const patch = parsed.data;

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
