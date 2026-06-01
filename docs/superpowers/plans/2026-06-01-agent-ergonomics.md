# Agent Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent — Folio's expert/canary user — resolve documents by title in one call, orient in one call, and stop wading through comment noise.

**Architecture:** Three new things land in the shared tool registry (`agent-tools-registry.ts`, consumed identically by the MCP route + in-process runner + REST): a `titleQuery` option on the `listDocuments` service, two new tools (`find_documents`, `describe_workspace`), and a one-line de-noise plus description edits. New tools reuse the existing resolve-workspace → resolve-project → service-call → `textResult` pattern and the `resolveAgentProjects`/`intersectAgentProjects` allow-list helpers.

**Tech Stack:** Bun, Hono, Drizzle (SQLite), Zod, `bun test`. Spec: `docs/superpowers/specs/2026-06-01-agent-ergonomics-design.md`.

---

## File Structure

- **Modify** `apps/server/src/services/documents.ts` — add `titleQuery?: string` to `ListDocumentsOptions`; push a `LIKE` clause; add `comment` to the default-exclusion branch. Add a workspace-wide variant `findDocumentsInProjects`.
- **Modify** `apps/server/src/lib/agent-tools-registry.ts` — register `find_documents` + `describe_workspace`; edit `list_documents` / `update_document` descriptions.
- **Test** `apps/server/src/services/documents.test.ts` (or the existing list-documents test file) — titleQuery + de-noise.
- **Test** `apps/server/src/lib/agent-tools-registry.test.ts` (or the MCP tool test file) — the two new tools + allow-list enforcement + descriptions.

Exact test-file paths are resolved in Task 0.

---

### Task 0: Locate test files and confirm caller audit (backward-compat gate)

**Files:**
- Inspect only.

- [ ] **Step 1: Find the relevant test files**

Run:
```bash
cd apps/server && ls src/services/documents.test.ts src/lib/agent-tools-registry.test.ts 2>/dev/null; \
grep -rln "listDocuments\|list_documents" src --include=*.test.ts
```
Record which test file exercises `listDocuments` (service) and which exercises the `list_documents` MCP tool. Use those paths for Tasks 1–6. If a dedicated file does not exist, create `src/services/documents.list.test.ts` and `src/lib/agent-tools-registry.find.test.ts`.

- [ ] **Step 2: Backward-compat caller audit for the de-noise**

Run:
```bash
cd /home/ntdst/Projects/folio && grep -rn "listDocuments(" apps/server/src apps/web/src --include=*.ts --include=*.tsx | grep -v ".test."
grep -rn "type:.*comment\|'comment'\|\"comment\"" apps/web/src --include=*.ts --include=*.tsx | grep -i "list\|document" | grep -v ".test."
```
Expected: every caller either passes an explicit `type` (unaffected) or expects only authorable docs. **If any caller relies on `comment` rows appearing in the generic list, STOP** — record it here and resolve before Task 5:

```
Caller audit result (2026-06-01):
  Test files: service tests → src/services/documents.test.ts (+ documents.sort.test.ts);
              TOOL tests → src/lib/agent-tools.test.ts (NOT agent-tools-registry.test.ts).
              Tool-test harness: `const { db, seed } = await makeTestApp()`; seed.workspace slug
              'acme', seed.project slug 'web', seed.user. seedHumanPat(db, wsId, userId, scopes) +
              seedAgent(db, wsId, userId, {...}). Call: executeTool(token, seed.user.id, 'tool', args).
              Service-test seed: makeTestApp() + createDocument({...}) with seed.project.id.
  De-noise callers of listDocuments (non-test): routes/documents.ts:185 (REST list, passes ?type=
              through — default path now excludes comments, which is the intended improvement),
              agent-tools-registry.ts:432 (the MCP tool being improved).
  Web: comments consumed ONLY via the dedicated comments API + comment-row.tsx + ?types=comment_*
              events stream — NEVER from the generic document list.
  VERDICT: CLEAN — no caller relies on comment rows in the generic list. De-noise safe to proceed.
```

- [ ] **Step 3: Commit the audit note**

```bash
cd /home/ntdst/Projects/folio && git add docs/superpowers/plans/2026-06-01-agent-ergonomics.md && \
git commit -m "chore: record list_documents caller audit for de-noise gate"
```

---

### Task 1: Add `titleQuery` option to `listDocuments` (service)

**Files:**
- Modify: `apps/server/src/services/documents.ts:166-184` (interface), `:251-255` (clause site)
- Test: the service test file from Task 0

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { listDocuments } from './documents.ts';
// Assumes the file's existing seed helpers create a project with documents.
// Reuse the existing setup; this asserts the new titleQuery behavior.

test('listDocuments titleQuery matches title substring, case-insensitive', async () => {
  const projectId = await seedProjectWithDocs([
    { title: 'Hosting setup on Combell', type: 'work_item' },
    { title: 'Homepage hero block', type: 'work_item' },
  ]);
  const hit = await listDocuments({ projectId, titleQuery: 'combell' });
  expect(hit.data.map((d) => d.title)).toEqual(['Hosting setup on Combell']);

  const miss = await listDocuments({ projectId, titleQuery: 'zzz-nope' });
  expect(miss.data).toEqual([]);
});
```
(Replace `seedProjectWithDocs` with the file's actual seed helper found in Task 0.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "titleQuery"`
Expected: FAIL — `titleQuery` not yet honored (returns all rows, so the miss assertion fails).

- [ ] **Step 3: Add the option to the interface**

In `apps/server/src/services/documents.ts`, inside `ListDocumentsOptions` (after `assignee?: string;` ~line 179):
```ts
  /** Case-insensitive substring match on documents.title (LIKE). */
  titleQuery?: string;
```

- [ ] **Step 4: Push the LIKE clause**

In `listDocuments`, immediately after the `assignee` block (after line 255, before the `updatedSince` block):
```ts
  if (opts.titleQuery && opts.titleQuery.trim().length > 0) {
    const pattern = `%${opts.titleQuery.trim().replace(/[%_\\]/g, '\\$&')}%`;
    whereClauses.push(sql`${documents.title} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`);
  }
```
(`sql` is already imported in this file — it is used by the `assignee` clause above.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "titleQuery"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/services/documents.ts apps/server/src/services/documents.test.ts && \
git commit -m "feat: titleQuery option on listDocuments (case-insensitive LIKE)"
```

---

### Task 2: De-noise — exclude `comment` from the default listing

**Files:**
- Modify: `apps/server/src/services/documents.ts:232`
- Test: the service test file from Task 0

- [ ] **Step 1: Write the failing test**

```ts
test('listDocuments with no type excludes comment and agent_run', async () => {
  const projectId = await seedProjectWithDocs([
    { title: 'Real work item', type: 'work_item' },
    { title: 'A page', type: 'page' },
    { title: 'c-abc', type: 'comment' },
  ]);
  const res = await listDocuments({ projectId });
  const types = new Set(res.data.map((d) => d.type));
  expect(types.has('comment')).toBe(false);
  expect(types.has('work_item')).toBe(true);
  expect(types.has('page')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "excludes comment"`
Expected: FAIL — comment row currently appears.

- [ ] **Step 3: Add the exclusion**

In `apps/server/src/services/documents.ts`, in the `else` branch at line 232, immediately after `whereClauses.push(ne(documents.type, 'agent_run'));`:
```ts
    // Comments are reply-thread rows surfaced via list_comments, not authorable
    // documents — exclude from the generic default listing (agent-ergonomics).
    whereClauses.push(ne(documents.type, 'comment'));
```
(`ne` is already imported — used on the line above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "excludes comment"`
Expected: PASS.

- [ ] **Step 5: Run the full documents service test file (regression)**

Run: `cd apps/server && bun test src/services/documents.test.ts`
Expected: PASS (confirms no existing test depended on comments in the default list — backs the Task 0 audit).

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/services/documents.ts apps/server/src/services/documents.test.ts && \
git commit -m "feat: exclude comment rows from default listDocuments listing"
```

---

### Task 3: Workspace-wide allow-listed finder (service)

**Files:**
- Modify: `apps/server/src/services/documents.ts` (add exported function near `listDocuments`)
- Test: the service test file from Task 0

- [ ] **Step 1: Write the failing test**

```ts
import { findDocumentsInProjects } from './documents.ts';

test('findDocumentsInProjects searches only the given project ids', async () => {
  const pA = await seedProjectWithDocs([{ title: 'Combell hosting', type: 'work_item' }]);
  const pB = await seedProjectWithDocs([{ title: 'Combell billing', type: 'work_item' }]);
  const res = await findDocumentsInProjects({
    projectIds: [pA],
    titleQuery: 'combell',
    limit: 25,
  });
  expect(res.map((d) => d.projectId)).toEqual([pA]); // pB excluded
  expect(res[0]!.title).toBe('Combell hosting');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "findDocumentsInProjects"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement the function**

In `apps/server/src/services/documents.ts`, after `listDocuments`:
```ts
export interface FindDocumentsOptions {
  projectIds: string[]; // already resolved to the caller's allow-listed set
  titleQuery: string;
  /** Restrict to authorable types; defaults to work_item + page. */
  types?: ('work_item' | 'page')[];
  limit?: number;
}

/**
 * Workspace-wide title search across an EXPLICIT project-id allow-list.
 * Callers (find_documents) resolve the allow-list first; this function never
 * widens it. agent_run + comment are always excluded.
 */
export async function findDocumentsInProjects(
  opts: FindDocumentsOptions,
): Promise<Document[]> {
  if (opts.projectIds.length === 0) return [];
  const limit = Math.min(200, opts.limit ?? 25);
  const q = opts.titleQuery.trim();
  if (q.length === 0) return [];
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const allowedTypes = opts.types ?? ['work_item', 'page'];

  const rows = await db.query.documents.findMany({
    where: and(
      inArray(documents.projectId, opts.projectIds),
      inArray(documents.type, allowedTypes),
      sql`${documents.title} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    ),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
    limit,
  });
  return rows;
}
```
(`and`, `inArray`, `sql`, `db`, `documents` are all already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/documents.test.ts -t "findDocumentsInProjects"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/services/documents.ts apps/server/src/services/documents.test.ts && \
git commit -m "feat: findDocumentsInProjects — workspace-wide title search over an explicit project allow-list"
```

---

### Task 4: Register `find_documents` tool (allow-list enforced)

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (new `registerTool` block, near `list_documents` ~line 451)
- Test: the registry test file from Task 0

- [ ] **Step 1: Write the failing tests (behavior + security)**

```ts
// In the registry/MCP tool test file. Reuse existing helpers that build a
// ToolContext with a human PAT and with an agent-bound token.

test('find_documents resolves a title workspace-wide with project_slug in results', async () => {
  // seed: workspace `w`, projects `pa`/`pb`, a work_item titled "Combell setup" in pa
  const res = await callTool('find_documents', { workspace_slug: 'w', query: 'combell' }, humanCtx);
  const out = JSON.parse(res.content[0].text);
  expect(out.documents).toHaveLength(1);
  expect(out.documents[0]).toMatchObject({ title: 'Combell setup', project_slug: 'pa' });
});

test('find_documents does NOT return docs from a non-allow-listed project (agent token)', async () => {
  // agentCtx token allow-listed for `pa` only; "Combell" docs exist in BOTH pa and pb
  const res = await callTool('find_documents', { workspace_slug: 'w', query: 'combell' }, agentCtx);
  const out = JSON.parse(res.content[0].text);
  const slugs = out.documents.map((d: { project_slug: string }) => d.project_slug);
  expect(slugs).not.toContain('pb');
});
```
(Replace `callTool`/`humanCtx`/`agentCtx` with the file's actual harness from Task 0.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "find_documents"`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Register the tool**

In `apps/server/src/lib/agent-tools-registry.ts`, after the `list_documents` block (after line 451). Add `findDocumentsInProjects` to the existing `../services/documents.ts` import:
```ts
  registerTool({
    name: 'find_documents',
    description:
      'Resolve a title to a document. Case-insensitive substring match on title, workspace-wide by default (narrow with project_slug). Use this when you have a title but not a slug — do NOT page through list_documents.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        query: { type: 'string' },
        project_slug: { type: 'string' },
        type: { type: 'string', enum: ['work_item', 'page'] },
        limit: { type: 'number' },
      },
      required: ['workspace_slug', 'query'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        query: z.string(),
        project_slug: z.string().optional(),
        type: z.enum(['work_item', 'page']).optional(),
        limit: z.number().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const query = requireString(args, 'query');
      const typeArg = optionalString(args, 'type') as 'work_item' | 'page' | undefined;
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 25;

      // Resolve the allow-listed project id set for this token.
      let projectIds: string[];
      const projectSlug = optionalString(args, 'project_slug');
      if (projectSlug) {
        // resolveProjectInWorkspace enforces the agent allow-list (throws if not allowed).
        const p = await resolveProjectInWorkspace(ws, token, args);
        projectIds = [p.id];
      } else {
        const all = await db.query.projects.findMany({
          where: eq(projects.workspaceId, ws.id),
        });
        if (!token.agentId) {
          projectIds = all.map((p) => p.id);
        } else {
          const agent = await db.query.documents.findFirst({
            where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
          });
          const agentProjects = agent ? resolveAgentProjects(agent) : ['*'];
          const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
          projectIds = effective.includes('*')
            ? all.map((p) => p.id)
            : all.filter((p) => effective.includes(p.id)).map((p) => p.id);
        }
      }

      const rows = await findDocumentsInProjects({
        projectIds,
        titleQuery: query,
        types: typeArg ? [typeArg] : undefined,
        limit,
      });

      // Map project ids → slugs for the result rows (find spans projects).
      const idToSlug = new Map(
        (
          await db.query.projects.findMany({ where: eq(projects.workspaceId, ws.id) })
        ).map((p) => [p.id, p.slug]),
      );
      return textResult({
        documents: rows.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          type: d.type,
          status: d.status,
          project_slug: d.projectId ? (idToSlug.get(d.projectId) ?? null) : null,
          updated_at: d.updatedAt,
        })),
      });
    },
  });
```
Update the import at the top (the `../services/documents.ts` block, lines 67–76):
```ts
  findDocumentsInProjects,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "find_documents"`
Expected: PASS (both behavior and the allow-list security test).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-tools-registry.test.ts && \
git commit -m "feat: find_documents MCP tool — workspace-wide title lookup, allow-list enforced"
```

---

### Task 5: Register `describe_workspace` tool (minimal v1)

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (new block after `find_documents`)
- Test: the registry test file from Task 0

- [ ] **Step 1: Write the failing tests (shape + security)**

```ts
test('describe_workspace returns projects → tables → status keys', async () => {
  const res = await callTool('describe_workspace', { workspace_slug: 'w' }, humanCtx);
  const out = JSON.parse(res.content[0].text);
  expect(out.workspace.slug).toBe('w');
  const pa = out.projects.find((p: { slug: string }) => p.slug === 'pa');
  expect(pa.tables[0].statuses.map((s: { key: string }) => s.key)).toContain('todo');
});

test('describe_workspace omits non-allow-listed projects (agent token)', async () => {
  // agentCtx allow-listed for `pa` only
  const res = await callTool('describe_workspace', { workspace_slug: 'w' }, agentCtx);
  const out = JSON.parse(res.content[0].text);
  expect(out.projects.map((p: { slug: string }) => p.slug)).toEqual(['pa']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "describe_workspace"`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Register the tool**

In `apps/server/src/lib/agent-tools-registry.ts`, after the `find_documents` block:
```ts
  registerTool({
    name: 'describe_workspace',
    description:
      "One-call orientation: every allow-listed project, its tables, and each table's status keys. Call this first to learn the workspace shape.",
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    schema: z.object({ workspace_slug: z.string() }).strict(),
    handler: async (_args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, _args);
      const all = await db.query.projects.findMany({
        where: eq(projects.workspaceId, ws.id),
      });

      let visible = all;
      if (token.agentId) {
        const agent = await db.query.documents.findFirst({
          where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
        });
        const agentProjects = agent ? resolveAgentProjects(agent) : ['*'];
        const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
        visible = effective.includes('*') ? all : all.filter((p) => effective.includes(p.id));
      }

      const projectsOut = [];
      for (const p of visible) {
        const tbls = await db.query.tables.findMany({
          where: eq(tablesTable.projectId, p.id),
          orderBy: (t, { asc }) => [asc(t.order)],
        });
        const tablesOut = [];
        for (const t of tbls) {
          const statuses = await listStatuses(t.id);
          tablesOut.push({
            slug: t.slug,
            statuses: statuses.map((s) => ({ key: s.key, name: s.name, category: s.category })),
          });
        }
        projectsOut.push({ slug: p.slug, name: p.name, tables: tablesOut });
      }

      return textResult({
        workspace: { slug: ws.slug, name: ws.name },
        projects: projectsOut,
      });
    },
  });
```
(`tablesTable`, `listStatuses`, `db`, `projects`, `documents`, `resolveAgentProjects`, `intersectAgentProjects` are all already imported.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "describe_workspace"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-tools-registry.test.ts && \
git commit -m "feat: describe_workspace MCP tool (minimal: projects → tables → status keys)"
```

---

### Task 6: Tighten `list_documents` + `update_document` descriptions

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts:390` and `:612-613`
- Test: the registry test file from Task 0

- [ ] **Step 1: Write the failing test**

```ts
import { listToolDefs } from './agent-tools.ts';

test('tool descriptions teach the new ergonomics', () => {
  const defs = listToolDefs();
  const byName = Object.fromEntries(defs.map((d) => [d.name, d.description]));
  expect(byName['list_documents']).toContain('list_comments');
  expect(byName['update_document']).toContain('list_statuses');
  expect(byName['find_documents']).toContain('do NOT page through');
});
```
(Confirm `listToolDefs` is the right accessor in Task 0; it is imported by `routes/mcp.ts:29`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "teach the new ergonomics"`
Expected: FAIL — `list_documents` / `update_document` strings not yet present.

- [ ] **Step 3: Edit the `list_documents` description (line 390)**

Replace:
```ts
    description: 'List documents in a project. Optional type filter and pagination.',
```
with:
```ts
    description:
      'List documents in a project. Returns work_item + page only. Comments → list_comments; runs → list_runs. Optional type filter and pagination.',
```

- [ ] **Step 4: Edit the `update_document` description (lines 612-613)**

Replace:
```ts
    description:
      'Patch a document. Supplied frontmatter is shallow-merged into the existing frontmatter (null values delete keys). Reserved keys (type, title, status, last_touched_at) live as columns and are ignored when present in frontmatter.',
```
with:
```ts
    description:
      'Patch a document. Supplied frontmatter is shallow-merged into the existing frontmatter (null values delete keys). Reserved keys (type, title, status, last_touched_at) live as columns and are ignored when present in frontmatter. Discover valid status keys via list_statuses.',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts -t "teach the new ergonomics"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-tools-registry.test.ts && \
git commit -m "docs: tighten list_documents + update_document tool descriptions"
```

---

### Task 7: Full verification + live MCP re-test

**Files:**
- Inspect only.

- [ ] **Step 1: Full server suite**

Run: `cd apps/server && bun test`
Expected: PASS, count = prior baseline + the new tests. (Run from inside `apps/server` — root-cwd inflates failures per the known init cascade.)

- [ ] **Step 2: Shared + web suites (de-noise touches the shared service the web list consumes)**

Run:
```bash
cd /home/ntdst/Projects/folio/packages/shared && bun test
cd /home/ntdst/Projects/folio/apps/web && npx vitest run
```
Expected: both PASS.

- [ ] **Step 3: Typecheck each app (no root tsconfig)**

Run:
```bash
cd /home/ntdst/Projects/folio/apps/server && bun x tsc --noEmit
cd /home/ntdst/Projects/folio/apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio/packages/shared && bun x tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Live MCP re-test (the original Combell flow)**

With the dev server running, via the connected Folio MCP tools:
- `find_documents({ workspace_slug: "netdust", query: "combell" })` → resolves in ONE call, result carries `project_slug: "client-website"`.
- `describe_workspace({ workspace_slug: "netdust" })` → `client-website` table shows status keys including `done`.
- `list_documents({ workspace_slug: "netdust", project_slug: "client-website" })` → NO `type: "comment"` rows.

Record results here:
```
find_documents:     ____
describe_workspace: ____
list_documents:     ____
```

- [ ] **Step 5: Final commit if any verification fixups were needed**

```bash
cd /home/ntdst/Projects/folio && git add -A && git commit -m "chore: agent-ergonomics verification fixups" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- find_documents (Item 1) → Tasks 1, 3, 4. ✓ (titleQuery, workspace-wide allow-listed finder, tool + `project_slug` in results + security test)
- describe_workspace minimal (Item 2) → Task 5. ✓ (projects → tables → status keys; non-allow-listed omitted)
- list_documents de-noise (Item 3) → Task 2, with the caller audit gate in Task 0. ✓
- description tightening (Item 4) → Task 6 (list_documents, update_document) + Task 4 (find_documents description) + Task 5 (describe_workspace description). ✓
- Allow-list enforcement (security-critical) → explicit failing security tests in Tasks 4 & 5. ✓
- Out-of-scope (FTS5, fuzzy, body search, describe_workspace growth, skill doc) → no tasks touch them. ✓
- Verification (server/shared/web/tsc + live re-test) → Task 7. ✓

**Placeholder scan:** No TBD/TODO. The only deliberately-blank fields are the audit-result and live-re-test record lines, which the executor fills in. Test-harness helper names (`callTool`, `humanCtx`, `seedProjectWithDocs`) are flagged for Task 0 resolution rather than invented — acceptable because Task 0 pins them before use.

**Type consistency:** `findDocumentsInProjects({ projectIds, titleQuery, types?, limit? })` is defined in Task 3 and called identically in Task 4. `titleQuery` option name matches between Task 1 (interface) and Task 3. `ListDocumentsOptions.titleQuery` and the tool's `query` arg are distinct names by design (the tool's `query` maps to the service's `titleQuery`) — consistent within each layer. ✓
