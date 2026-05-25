import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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
import { documents, events, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { agentFrontmatterSchema } from '../lib/agent-schema.ts';
import { triggerFrontmatterSchema } from '../lib/trigger-schema.ts';
import { parseMarkdown, serializeMarkdown } from '../lib/frontmatter.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
import { slugUniqueInDocuments } from '../lib/slug-unique.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const documentsRoute = new Hono<AuthContext & ScopeContext>();

async function validateStatus(tableId: string, status: string | null | undefined) {
  if (status == null) return;
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.tableId, tableId), eq(statuses.key, status)),
  });
  if (!row) throw new HTTPError('INVALID_STATUS', `status "${status}" not in registry`, 422);
}

function isMarkdownRequest(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.startsWith('text/markdown') || ct.startsWith('text/plain');
}

// "Auto-derived" = the slug was generated from the previous title at create
// time (or auto-disambiguated with `-N`). Strip a trailing `-<digits>` and
// compare to slugify(oldTitle). The `untitled` special case covers fresh docs
// where the create-time slug is literally `untitled`.
function isSlugAutoDerived(slug: string, oldTitle: string): boolean {
  if (slug === 'untitled') return true;
  const base = slug.replace(/-\d+$/, '');
  return base === slugify(oldTitle);
}

async function maybeRegenerateSlug(
  projectId: string,
  existing: { slug: string; title: string },
  nextTitle: string,
): Promise<string | null> {
  if (nextTitle === existing.title) return null;
  if (!isSlugAutoDerived(existing.slug, existing.title)) return null;
  const baseSlug = slugify(nextTitle) || 'doc';
  if (baseSlug === existing.slug.replace(/-\d+$/, '')) return null;
  return slugUniqueInDocuments(db, projectId, baseSlug);
}

function deriveTitleFromBody(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

type DocumentType = 'work_item' | 'page' | 'agent' | 'trigger';

interface ParsedMdInput {
  type: DocumentType;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  status: string | null;
}

// Keys promoted to first-class columns. Stripped from user-supplied
// frontmatter on every write path so the JSON column never holds a stale
// shadow that would override the column on the next .md export.
const RESERVED_FRONTMATTER_KEYS = ['type', 'title', 'status', 'last_touched_at'] as const;

function stripReservedFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if ((RESERVED_FRONTMATTER_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const DOCUMENT_TYPES: readonly DocumentType[] = ['work_item', 'page', 'agent', 'trigger'];

function parseMarkdownInput(raw: string, defaults?: { type?: DocumentType }): ParsedMdInput {
  const { frontmatter, body } = parseMarkdown(raw);
  const fmType = frontmatter.type;
  const type: DocumentType =
    typeof fmType === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(fmType)
      ? (fmType as DocumentType)
      : (defaults?.type ?? 'work_item');
  const title =
    deriveTitleFromBody(body) ??
    (typeof frontmatter.title === 'string' ? frontmatter.title : null) ??
    'Untitled';
  const status = typeof frontmatter.status === 'string' ? frontmatter.status : null;
  return { type, title, body, frontmatter: stripReservedFrontmatter(frontmatter), status };
}

documentsRoute.post('/', requireScope('documents:write'), async (c) => {
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
    const fmRest = stripReservedFrontmatter((v.frontmatter ?? {}) as Record<string, unknown>);
    input = { type: v.type, title: v.title, body: v.body, frontmatter: fmRest, status: fmStatus };
  }

  // Agents and triggers are project-scoped — they live alongside pages with
  // tableId=null. A table-scoped URL implies a table-bound resource, so reject
  // here before getTable(c) ever runs for these types.
  if (input.type === 'agent' || input.type === 'trigger') {
    if (c.req.param('tslug')) {
      throw new HTTPError(
        'INVALID_BODY',
        `${input.type} documents cannot be created on a table-scoped URL`,
        422,
      );
    }
    const schema = input.type === 'agent' ? agentFrontmatterSchema : triggerFrontmatterSchema;
    const r = schema.safeParse(input.frontmatter ?? {});
    if (!r.success) {
      const code = input.type === 'agent' ? 'INVALID_AGENT_FRONTMATTER' : 'INVALID_TRIGGER_FRONTMATTER';
      throw new HTTPError(code, r.error.message, 422);
    }
    // Replace with the parsed, default-applied version. Task 9 relies on this
    // so the auto-minted token's scopes can be derived from validated tools.
    input.frontmatter = r.data as Record<string, unknown>;
  }

  // work_items live inside a table; pages are project-scoped with tableId=null.
  const tableId = input.type === 'work_item' ? getTable(c).id : null;
  if (input.type === 'work_item') await validateStatus(tableId!, input.status);

  const id = nanoid();
  const baseSlug = slugify(input.title) || 'doc';
  const slug = await slugUniqueInDocuments(db, p.id, baseSlug);

  const row = {
    id,
    projectId: p.id,
    tableId,
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

  return jsonOk(c, row, 201);
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

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new HTTPError('INVALID_LIMIT', 'limit must be a positive integer ≤ 200', 422);
  }
  return Math.min(200, n);
}

documentsRoute.get('/', async (c) => {
  const p = getProject(c);
  const type = c.req.query('type');
  const limit = parseLimit(c.req.query('limit'), 50);
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
  // Scope work_item listings to the active table (default or explicit /t/:tslug).
  // Pages stay project-scoped with NULL tableId. With no type filter we don't
  // further constrain so callers can list everything in the project.
  if (type === 'work_item') {
    whereClauses.push(eq(documents.tableId, getTable(c).id));
  } else if (type === 'page') {
    whereClauses.push(isNull(documents.tableId));
  }
  // Flat filter params — kept simple here so the toolbar chips work without
  // having to encode/decode the full `?filter=` AST. The AST stays available
  // for the agent/MCP path that needs richer expressions.
  // Drop empty-string entries — chip-removal navigation can leave a stray
  // `?status=` in the URL and `status IN ('todo','')` would leak docs with an
  // empty status. Defensive filter at the entry point keeps both branches honest.
  const statusValues = (c.req.queries('status') ?? []).filter((s) => s.length > 0);
  if (statusValues.length === 1) {
    whereClauses.push(eq(documents.status, statusValues[0]!));
  } else if (statusValues.length > 1) {
    whereClauses.push(inArray(documents.status, statusValues));
  }
  const assignee = c.req.query('assignee');
  if (assignee) {
    // documents.frontmatter is JSON-encoded text; match the assignee key.
    whereClauses.push(sql`json_extract(${documents.frontmatter}, '$.assignee') = ${assignee}`);
  }
  const updatedSince = c.req.query('updated_since');
  if (updatedSince) {
    const ts = new Date(updatedSince);
    if (!Number.isNaN(ts.getTime())) {
      whereClauses.push(gte(documents.updatedAt, ts));
    }
  }
  // ?stale_for=14d → documents whose last_touched_at is NULL or older than N days ago.
  // Reject 0d (matches every touched row, hides bugs) and any non-Nd format
  // (silently ignoring "garbage" returns the unfiltered list).
  const staleFor = c.req.query('stale_for');
  if (staleFor) {
    const m = staleFor.match(/^(\d+)d$/);
    const days = m ? Number(m[1]) : NaN;
    if (!m || !Number.isFinite(days) || days < 1) {
      throw new HTTPError(
        'INVALID_STALE_FOR',
        'stale_for must be a positive integer followed by "d" (e.g. "7d")',
        422,
      );
    }
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const staleClause = or(
      isNull(documents.lastTouchedAt),
      lt(documents.lastTouchedAt, cutoff),
    );
    if (staleClause) whereClauses.push(staleClause);
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

documentsRoute.get('/:slugMd{[^/]+\\.md}', async (c) => {
  const p = getProject(c);
  const slugMd = c.req.param('slugMd');
  const slug = slugMd.slice(0, -3);
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  // Strip reserved keys from frontmatter at read time too, as defense in
  // depth: older rows written before stripReservedFrontmatter shipped may
  // carry shadow `type` / `title` / `status` / `last_touched_at` keys that
  // would otherwise override the canonical column values.
  const userFm = stripReservedFrontmatter(row.frontmatter ?? {});
  const fm: Record<string, unknown> = {
    ...userFm,
    // Columns (canonical source of truth) spread LAST so they win.
    type: row.type,
    title: row.title,
    ...(row.status ? { status: row.status } : {}),
    ...(row.lastTouchedAt ? { last_touched_at: row.lastTouchedAt.toISOString() } : {}),
  };
  const md = serializeMarkdown({ frontmatter: fm, body: row.body });
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `inline; filename="${slug}.md"`);
  return c.body(md);
});

documentsRoute.get('/:slug', async (c) => {
  const p = getProject(c);
  const slug = c.req.param('slug');
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  return jsonOk(c, row);
});

documentsRoute.patch('/:slug', requireScope('documents:write'), async (c) => {
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
    const parsed = parseMarkdownInput(raw, { type: existing.type as DocumentType });
    if (parsed.type !== existing.type) {
      throw new HTTPError('INVALID_BODY', 'document type cannot change', 422);
    }
    if (existing.type === 'work_item') {
      // existing.tableId is NULL only for pages; this branch is gated on
      // work_item, which in practice always has a tableId. The fallback to
      // getTable(c) guards against accidental misuse from a table-scoped mount
      // where the row's stored tableId is somehow absent.
      const tId = existing.tableId ?? getTable(c).id;
      await validateStatus(tId, parsed.status);
    }
    const nextSlug = await maybeRegenerateSlug(p.id, existing, parsed.title);
    const updated = {
      ...existing,
      title: parsed.title,
      ...(nextSlug ? { slug: nextSlug } : {}),
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
        payload: { changes: ['title', 'body', 'frontmatter', 'status', ...(nextSlug ? ['slug'] : [])] },
      });
    });
    return jsonOk(c, updated);
  }

  // JSON branch
  const json = await c.req.json();
  const parsed = documentPatchSchema.safeParse(json);
  if (!parsed.success) throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
  const patch = parsed.data;

  if (patch.status !== undefined && existing.type === 'work_item') {
    // Same shape as the markdown branch above: existing.tableId is NULL only
    // for pages, and this is gated on work_item. The fallback to getTable(c)
    // guards the table-scoped mount in case the stored tableId is absent.
    const tId = existing.tableId ?? getTable(c).id;
    await validateStatus(tId, patch.status);
  }

  // For agents/triggers, validate the PATCH payload itself (not the merged
  // result). Why: server-managed fields like api_token_id and last_fired_at
  // are stored in frontmatter and would fail .strict() if merged-validated.
  // The trigger schema is a ZodEffects (has .refine), so unwrap via
  // innerType() before .partial() — and skip the refine for partial patches.
  if (
    patch.frontmatter !== undefined &&
    (existing.type === 'agent' || existing.type === 'trigger')
  ) {
    const schema =
      existing.type === 'agent'
        ? agentFrontmatterSchema.partial()
        : triggerFrontmatterSchema.innerType().partial();
    const r = schema.safeParse(patch.frontmatter);
    if (!r.success) {
      const code =
        existing.type === 'agent' ? 'INVALID_AGENT_FRONTMATTER' : 'INVALID_TRIGGER_FRONTMATTER';
      throw new HTTPError(code, r.error.message, 422);
    }
  }

  const mergedFrontmatter = (() => {
    if (patch.frontmatter === undefined) return existing.frontmatter;
    const merged: Record<string, unknown> = { ...existing.frontmatter };
    for (const [k, v] of Object.entries(patch.frontmatter)) {
      if ((RESERVED_FRONTMATTER_KEYS as readonly string[]).includes(k)) continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    return merged;
  })();

  const nextSlug =
    patch.title !== undefined ? await maybeRegenerateSlug(p.id, existing, patch.title) : null;
  const updated = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(nextSlug ? { slug: nextSlug } : {}),
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
      payload: { changes: [...Object.keys(patch), ...(nextSlug ? ['slug'] : [])] },
    });
  });

  return jsonOk(c, updated);
});

documentsRoute.delete('/:slug', requireScope('documents:delete'), async (c) => {
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

// POST /:slug/activity { note } — emits activity.logged + bumps lastTouchedAt.
// Note cap is 2000 chars: enough for a few paragraphs of operational context
// ("called the client, follow up Tue"), small enough that an agent loop can't
// balloon events.payload and saturate GET /events.
const ACTIVITY_NOTE_MAX = 2000;

documentsRoute.post('/:slug/activity', requireScope('documents:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  let body: { note?: unknown };
  try { body = (await c.req.json()) as { note?: unknown }; }
  catch { throw new HTTPError('INVALID_BODY', 'JSON body required', 400); }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw new HTTPError('INVALID_NOTE', 'note is required', 422);
  if (note.length > ACTIVITY_NOTE_MAX) {
    throw new HTTPError(
      'NOTE_TOO_LONG',
      `note must be ${ACTIVITY_NOTE_MAX} characters or fewer`,
      422,
    );
  }

  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const now = new Date();
  await db.transaction(async (tx) => {
    // Bump updatedAt as well as lastTouchedAt so the doc surfaces in the
    // list's `updated_at desc` sort — that's the user's mental model when
    // they log activity: "I just worked on this, it should be at the top."
    await tx
      .update(documents)
      .set({ lastTouchedAt: now, updatedAt: now })
      .where(eq(documents.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, documentId: existing.id,
      kind: 'activity.logged', actor: user.id, payload: { note },
    });
  });

  return c.json({ data: { lastTouchedAt: now.toISOString() } }, 201);
});

// GET /:slug/events — newest-first events for the given document.
documentsRoute.get('/:slug/events', async (c) => {
  const p = getProject(c);
  const slug = c.req.param('slug');
  const limit = parseLimit(c.req.query('limit'), 50);

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!doc) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const rows = await db
    .select()
    .from(events)
    .where(eq(events.documentId, doc.id))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit);

  // Public shape only — internal columns (workspaceId, projectId, documentId)
  // are not part of the API contract and shouldn't leak to agent tokens.
  const data = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: r.actor,
    payload: r.payload,
    createdAt: r.createdAt,
  }));
  return c.json({ data });
});

export { documentsRoute };
