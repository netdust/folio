import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  documentCreateSchema,
  documentPatchSchema,
} from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, events, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { ACTIVITY_NOTE_MAX } from '../lib/activity-limits.ts';
import { parseMarkdown, serializeMarkdown } from '../lib/frontmatter.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getAssignee,
  listDocuments,
  updateDocument,
  stripReservedFrontmatter,
  type DocumentType,
} from '../services/documents.ts';
import { findBacklinks } from '../services/backlinks.ts';

const documentsRoute = new Hono<AuthContext & ScopeContext>();

function isMarkdownRequest(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.startsWith('text/markdown') || ct.startsWith('text/plain');
}

function deriveTitleFromBody(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

interface ParsedMdInput {
  type: DocumentType;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  status: string | null;
}

// F10 fix (post-C.1 review) — `agent_run` is in the DocumentType union
// (widened in C-1) but was missing from this set, so parseMarkdownInput
// silently coerced `type: agent_run` in user-submitted markdown to
// `work_item`, polluting work_items frontmatter inference with
// run-shaped fields (tokens_in, chain_id, agent_slug). Include it so
// the type is recognized; the PATCH/POST handlers reject it with a
// clean 422 (see the agent_run guards below).
const DOCUMENT_TYPES: readonly DocumentType[] = ['work_item', 'page', 'agent', 'trigger', 'agent_run'];

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
    // BUG-019 — wrap so malformed/empty bodies surface as 422 INVALID_BODY.
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HTTPError('INVALID_BODY', 'JSON body required', 422);
    }
    const parsed = documentCreateSchema.safeParse(json);
    if (!parsed.success) {
      throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
    }
    const v = parsed.data;
    const fmStatus = typeof v.frontmatter?.status === 'string' ? v.frontmatter.status : null;
    const fmRest = stripReservedFrontmatter((v.frontmatter ?? {}) as Record<string, unknown>);
    input = { type: v.type, title: v.title, body: v.body, frontmatter: fmRest, status: fmStatus };
  }

  // Phase 2.5: agents and triggers are workspace-scoped. The project-level
  // endpoint rejects them with a pointer to the right URL.
  if (input.type === 'agent' || input.type === 'trigger') {
    const wslug = c.req.param('wslug');
    throw new HTTPError(
      'INVALID_DOCUMENT_SCOPE',
      `${input.type} documents are workspace-scoped; use POST /api/v1/w/${wslug}/documents`,
      422,
    );
  }

  // Only resolve the table when we're creating a work_item — agents/triggers
  // are project-scoped and rejecting a table-scoped URL is the service's job.
  const table = input.type === 'work_item' ? getTable(c) : null;

  const { document, agentTokenPlaintext } = await createDocument({
    workspace: ws,
    project: p,
    table,
    actor: user,
    token: c.get('token'),
    isTableScopedUrl: Boolean(c.req.param('tslug')),
    input,
  });

  const responseData = agentTokenPlaintext
    ? { ...document, agent_token: agentTokenPlaintext }
    : document;
  return jsonOk(c, responseData, 201);
});

documentsRoute.get('/', async (c) => {
  const p = getProject(c);
  const type = c.req.query('type');
  const limitRaw = c.req.query('limit');
  const cursorRaw = c.req.query('cursor');
  const filterRaw = c.req.query('filter');

  // Phase 2.5: agent/trigger listing is workspace-level.
  if (type === 'agent' || type === 'trigger') {
    const wslug = c.req.param('wslug');
    throw new HTTPError(
      'UNSUPPORTED_TYPE_FILTER',
      `${type} is workspace-scoped; use GET /api/v1/w/${wslug}/documents?type=${type}`,
      400,
    );
  }

  // C1 (Phase-3 shake-out): reject explicit `type=agent_run` early with a clean
  // 422. agent_run rows are runner-owned (system_prompt/provider/tokens) and
  // are read via the /runs endpoints, never enumerated through generic
  // documents. listDocuments also rejects this (defense in depth) — this route
  // guard mirrors the agent/trigger guard above so the error is consistent.
  if (type === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned; list via the /runs endpoints, not the generic document endpoint',
      422,
    );
  }

  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new HTTPError('INVALID_LIMIT', 'limit must be a positive integer ≤ 200', 422);
    }
  }

  let filter: unknown = undefined;
  if (filterRaw) {
    try {
      filter = JSON.parse(filterRaw);
    } catch {
      throw new HTTPError('INVALID_FILTER', 'filter must be valid JSON', 422);
    }
  }

  // The route owns the table-scoping decision: when a table-scoped URL is in
  // play the service must constrain to that table for work_items. Pages and
  // type-less listings stay project-scoped.
  let activeTableId: string | null = null;
  if (type === 'work_item') {
    activeTableId = getTable(c).id;
  }

  const result = await listDocuments({
    projectId: p.id,
    activeTableId,
    type,
    limit: limitRaw !== undefined ? Math.min(200, Number(limitRaw)) : 50,
    cursor: cursorRaw,
    filter,
    statusValues: c.req.queries('status') ?? [],
    assignee: c.req.query('assignee') ?? undefined,
    updatedSince: c.req.query('updated_since') ?? undefined,
    staleFor: c.req.query('stale_for') ?? undefined,
    sort: c.req.query('sort') ?? undefined,
    dir: c.req.query('dir') ?? undefined,
  });

  return c.json({ data: result.data, nextCursor: result.nextCursor });
});

documentsRoute.get('/:slugMd{[^/]+\\.md}', async (c) => {
  const p = getProject(c);
  const slugMd = c.req.param('slugMd');
  const slug = slugMd.slice(0, -3);
  const row = await getDocument(p.id, slug);
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  // R2 fix (post-review-of-review) — agent_run rows are runner-owned
  // and contain operator-sensitive frontmatter (system_prompt, chain_id,
  // tokens_in/out, provider). Bundle 4 hardened WRITE paths but left
  // generic-document READ paths open. A `documents:read` bearer could
  // dump the system_prompt by knowing/enumerating a run slug. Reject
  // with the same code Sub-phase D's /runs/:id read will own.
  if (row.type === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned; read via the /runs endpoints (Sub-phase D), not the generic document endpoint',
      422,
    );
  }

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
  const row = await getDocument(p.id, slug);
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  // R2 — same agent_run guard as the markdown-GET variant above.
  if (row.type === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned; read via the /runs endpoints (Sub-phase D), not the generic document endpoint',
      422,
    );
  }
  return jsonOk(c, row);
});

// GET /:slug/backlinks — query-time backlinks: documents whose frontmatter
// wiki-links (`[[slug]]`) point at this doc, as either a single relation
// string or an element of a multi-relation array. Nothing is stored in
// reverse, so backlinks can never drift from the source-of-truth frontmatter.
documentsRoute.get('/:slug/backlinks', requireScope('documents:read'), async (c) => {
  const ws = getWorkspace(c);
  const p = getProject(c);
  const slug = c.req.param('slug');

  const target = await getDocument(p.id, slug);
  if (!target) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const data = await findBacklinks({ workspaceId: ws.id, projectId: p.id, slug });
  return jsonOk(c, data);
});

documentsRoute.patch('/:slug', requireScope('documents:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await getDocument(p.id, slug);
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  // Resolve a fallback table only when needed (work_item update where the
  // stored tableId might be absent on legacy rows). c.get('table') is null
  // when this route runs in a /p/:pslug context without a default table seed.
  const fallbackTable = c.get('table') ?? null;

  if (isMarkdownRequest(c.req.raw)) {
    // The markdown branch is NOT MCP-relevant: it does a WHOLESALE frontmatter
    // replacement (the JSON PATCH path merges). Keeping it inline avoids
    // bifurcating the service signature; the route owns this semantic.
    //
    // H6: comments must go through PATCH /comments/:slug (which enforces
    // author-only, kind-immutable, edited_at, and soft-delete semantics).
    // The service-layer guard in updateDocument blocks the JSON path; this
    // markdown path bypasses updateDocument entirely, so it needs the same
    // rejection inline.
    //
    // H22: defense-in-depth — agents/triggers must not be reachable through
    // the project-scoped markdown PATCH either. Phase 2.5 enforces
    // projectId=null on agent/trigger inserts, so getDocument(p.id, slug)
    // shouldn't find them today — but a future schema drift or hand-edit
    // could re-expose this path. Cheap to guard.
    if (existing.type === 'comment') {
      throw new HTTPError(
        'COMMENT_REQUIRES_COMMENT_TOOL',
        "comment documents must be updated via PATCH /comments/:slug (or MCP update_comment), not the generic document endpoint",
        422,
      );
    }
    if (existing.type === 'agent' || existing.type === 'trigger') {
      throw new HTTPError(
        'INVALID_DOCUMENT_SCOPE',
        `${existing.type} documents must be mutated through /api/v1/w/:wslug/documents (workspace-scoped), not the project-scoped markdown PATCH`,
        422,
      );
    }
    // F3 fix (post-C.1 review) — agent_run rows are runner-owned. The
    // state machine, error_reason enum, sanitizer, and agent.run.*
    // event emission all live in services/agent-runs.ts::transitionRun.
    // A markdown PATCH here would wholesale-replace frontmatter,
    // bypassing all of those mitigations. Reject.
    if (existing.type === 'agent_run') {
      throw new HTTPError(
        'AGENT_RUN_REQUIRES_RUNNER_PATH',
        'agent_run documents are runner-owned and mutate only via the runner / approve / cancel endpoints (Sub-phase D), not the generic markdown PATCH',
        422,
      );
    }
    const raw = await c.req.text();
    const parsed = parseMarkdownInput(raw, { type: existing.type as DocumentType });
    if (parsed.type !== existing.type) {
      throw new HTTPError('INVALID_BODY', 'document type cannot change', 422);
    }
    if (existing.type === 'work_item') {
      const tId = existing.tableId ?? fallbackTable?.id;
      if (tId && parsed.status != null) {
        const sRow = await db.query.statuses.findFirst({
          where: and(eq(statuses.tableId, tId), eq(statuses.key, parsed.status)),
        });
        if (!sRow) {
          throw new HTTPError('INVALID_STATUS', `status "${parsed.status}" not in registry`, 422);
        }
      }
    }
    // Slugs are immutable for ALL document types (Phase 3.x) — a retitle
    // changes the title only, never the slug, so [[slug]] relation links and
    // backlinks stay valid. No rename cascade. See services/documents.ts.
    const nextSlug: string | null = null;
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
    await txWithEvents(db, async (tx) => {
      await tx.update(documents).set(updated).where(eq(documents.id, existing.id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, documentId: existing.id,
        kind: 'document.updated', actor: user.id,
        payload: { changes: ['title', 'body', 'frontmatter', 'status', ...(nextSlug ? ['slug'] : [])] },
      });
      if (existing.type === 'work_item') {
        const prevAssignee = getAssignee(existing.frontmatter);
        const nextAssignee = getAssignee(updated.frontmatter);
        if (nextAssignee && nextAssignee.startsWith('agent:') && prevAssignee !== nextAssignee) {
          const agentSlug = nextAssignee.slice('agent:'.length);
          // S2: include agent_id as the immutable handle. See
          // services/documents.ts for full rationale.
          const agentRow = await tx.query.documents.findFirst({
            where: and(
              eq(documents.workspaceId, ws.id),
              eq(documents.type, 'agent'),
              eq(documents.slug, agentSlug),
            ),
          });
          await emitEvent(tx, {
            workspaceId: ws.id, projectId: p.id, documentId: existing.id,
            kind: 'agent.task.assigned', actor: user.id,
            payload: { slug: updated.slug, agent: agentSlug, agent_id: agentRow?.id ?? null },
          });
        }
      }
    });
    return jsonOk(c, updated);
  }

  // BUG-019 — wrap so malformed/empty bodies surface as 422 INVALID_BODY.
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HTTPError('INVALID_BODY', 'JSON body required', 422);
  }
  const parsed = documentPatchSchema.safeParse(json);
  if (!parsed.success) throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
  const updated = await updateDocument({
    workspace: ws,
    project: p,
    fallbackTable,
    actor: user,
    existing,
    patch: parsed.data,
  });
  return jsonOk(c, updated);
});

documentsRoute.delete('/:slug', requireScope('documents:delete'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await getDocument(p.id, slug);
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  await deleteDocument({ workspace: ws, project: p, actor: user, existing });
  return c.body(null, 204);
});

// POST /:slug/activity { note } — emits activity.logged + bumps lastTouchedAt.

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

  const existing = await getDocument(p.id, slug);
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const now = new Date();
  await txWithEvents(db, async (tx) => {
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
  const limitRaw = c.req.query('limit');
  let limit = 50;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new HTTPError('INVALID_LIMIT', 'limit must be a positive integer ≤ 200', 422);
    }
    limit = Math.min(200, n);
  }

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
