#!/usr/bin/env bun
/**
 * Demo seed — drives the public API to create a realistic agency setup:
 *   Workspace "Netdust" with 3 projects (Folio, Stride, Client Website).
 *   Each project gets ~10 work items spread across statuses, frontmatter
 *   variety (priority, assignee, labels, due_date), plus 4-6 wiki pages
 *   with parent/child structure and markdown content.
 *
 * Usage:
 *   API must be running on $API (default http://localhost:3001).
 *   bun run scripts/seed-demo.ts
 *
 * Env overrides:
 *   API=http://localhost:3001
 *   EMAIL=stefan@netdust.be
 *   PASSWORD=demo-password-1
 *   NAME="Stefan Vandermeulen"
 */

const API = process.env.API ?? 'http://localhost:3001';
const EMAIL = process.env.EMAIL ?? 'stefan@netdust.be';
const PASSWORD = process.env.PASSWORD ?? 'demo-password-1';
const NAME = process.env.NAME ?? 'Stefan';

let cookie = '';

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('json') ? res.json() : res.text();
}

async function register() {
  try {
    await api('POST', '/api/v1/auth/register', { email: EMAIL, password: PASSWORD, name: NAME });
    console.log(`✓ Registered ${EMAIL}`);
  } catch (err) {
    if (String(err).includes('EMAIL_TAKEN') || String(err).includes('already registered')) {
      await api('POST', '/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
      console.log(`✓ Logged in ${EMAIL}`);
    } else {
      throw err;
    }
  }
}

async function createWorkspace(name: string, slug: string) {
  await api('POST', '/api/v1/workspaces', { name, slug });
  console.log(`  ✓ Workspace: ${name} (/w/${slug})`);
}

async function createProject(wslug: string, name: string, pslug: string) {
  await api('POST', `/api/v1/w/${wslug}/projects`, { name, slug: pslug });
  console.log(`    ✓ Project: ${name} (/p/${pslug})`);
}

interface WorkItem {
  title: string;
  status?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
}

async function createWorkItem(wslug: string, pslug: string, item: WorkItem): Promise<string> {
  const fm = item.status
    ? { ...(item.frontmatter ?? {}), status: item.status }
    : item.frontmatter;
  const res = await api('POST', `/api/v1/w/${wslug}/p/${pslug}/documents`, {
    type: 'work_item',
    title: item.title,
    ...(item.body !== undefined ? { body: item.body } : {}),
    ...(fm ? { frontmatter: fm } : {}),
  });
  return res.data.slug;
}

interface Page {
  title: string;
  body?: string;
  parentSlug?: string;
  frontmatter?: Record<string, unknown>;
}

async function createPage(wslug: string, pslug: string, page: Page, slugToId: Map<string, string>): Promise<string> {
  const payload: Record<string, unknown> = {
    type: 'page',
    title: page.title,
    ...(page.body !== undefined ? { body: page.body } : {}),
    ...(page.frontmatter ? { frontmatter: page.frontmatter } : {}),
  };
  if (page.parentSlug) {
    const parentId = slugToId.get(page.parentSlug);
    if (!parentId) throw new Error(`Parent page not found: ${page.parentSlug}`);
    payload.parentId = parentId;
  }
  const res = await api('POST', `/api/v1/w/${wslug}/p/${pslug}/documents`, payload);
  slugToId.set(res.data.slug, res.data.id);
  return res.data.slug;
}

// ---------------------------------------------------------------------------

const WSLUG = 'netdust';

const STANDARD_FIELDS: Array<{
  key: string;
  type: string;
  label: string;
  options?: string[];
  order: number;
}> = [
  { key: 'priority',  type: 'select',       label: 'Priority', options: ['low', 'medium', 'high'], order: 10 },
  { key: 'assignee',  type: 'string',       label: 'Assignee', order: 20 },
  { key: 'labels',    type: 'multi_select', label: 'Labels',   options: [
    'security', 'phase-2', 'phase-1.5', 'phase-1', 'phase-1.1',
    'agents', 'ux', 'design', 'bugfix', 'testing', 'docs', 'auth',
    'lms', 'crm', 'integration', 'caching', 'billing', 'ops',
    'internal-tool', 'feature', 'kickoff', 'scaffolding', 'blocked',
    'frontend', 'content', 'form', 'i18n', 'combell', 'seo', 'launch', 'search',
    'migration',
  ], order: 30 },
  { key: 'due_date',  type: 'date',         label: 'Due',      order: 40 },
];

const PROJECTS = [
  {
    name: 'Folio',
    slug: 'folio',
    workItems: [
      { title: 'Implement BYOK encryption for AI keys', status: 'in_progress', frontmatter: { priority: 'high', assignee: 'stefan@netdust.be', labels: ['security', 'phase-2'], due_date: '2026-06-10' }, body: 'libsodium-encrypted at rest with server master secret from `FOLIO_MASTER_KEY`.\n\n## Acceptance\n\n- [ ] Anthropic key storage\n- [ ] OpenAI key storage\n- [x] Ollama (no key needed) passthrough' },
      { title: 'Wire MCP server endpoint', status: 'todo', frontmatter: { priority: 'high', labels: ['agents', 'phase-2'], due_date: '2026-06-15' }, body: 'Agents are first-class users. Need a documented MCP endpoint with scoped token auth.\n\n```ts\nconst server = new McpServer({ name: "folio", version: "1.0.0" });\nserver.tool("create-document", schema, handler);\n```' },
      { title: 'Cmd-K palette: add "Switch theme" command', status: 'done', frontmatter: { priority: 'low', assignee: 'stefan@netdust.be', labels: ['ux'] }, body: 'Done — shipped in phase-1.5.' },
      { title: 'Kanban drag-and-drop status update', status: 'done', frontmatter: { priority: 'high', labels: ['phase-1'] } },
      { title: 'Slideover Alt+M raw markdown toggle', status: 'done', frontmatter: { priority: 'medium', labels: ['ux', 'phase-1.5'] } },
      { title: 'Filter chip popover fix (forwardRef)', status: 'done', frontmatter: { priority: 'high', labels: ['bugfix', 'phase-1.5'] }, body: 'ChipAdd was a plain function component, not a forwardRef. Radix\'s `<PopoverTrigger asChild>` couldn\'t attach its ref.' },
      { title: 'sqlite-fts5 search (Phase 1.1)', status: 'backlog', frontmatter: { priority: 'medium', labels: ['phase-1.1', 'search'], due_date: '2026-07-01' }, body: '> Out of scope for v1. Track for 1.1.\n\nFull-text search with snippets.' },
      { title: 'Email magic-link verification flow', status: 'backlog', frontmatter: { priority: 'low', labels: ['auth'] } },
      { title: 'Document the REST API in docs/API.md', status: 'todo', frontmatter: { priority: 'medium', assignee: 'stefan@netdust.be', labels: ['docs'], due_date: '2026-06-05' }, body: 'Write as you build. Every route, every error code.' },
      { title: 'Optimistic UI rollback on 4xx', status: 'in_progress', frontmatter: { priority: 'high', labels: ['ux'], due_date: '2026-05-30' }, body: 'Mutations update the UI immediately. Failures roll back with a toast.' },
      { title: 'Wire 10 skipped manual-QA scenarios', status: 'done', frontmatter: { priority: 'medium', labels: ['testing', 'phase-1.5'] }, body: 'All 13 scenarios now have real Playwright coverage. No more `test.skip`.' },
    ],
    pages: [
      { title: 'Welcome to Folio', body: '# Welcome to Folio\n\nFolio is a markdown-native, agent-friendly alternative to Plane / Linear / Notion task tools.\n\n## The Wedge\n\n1. **Markdown is the source-of-truth surface.**\n2. **Agents are first-class users.**\n3. **The UX is keyboard-fast.**\n\nStart with [[architecture]] or [[roadmap]].' },
      { title: 'Architecture', slug: 'architecture', body: '# Architecture\n\nOne binary. SQLite. Hono on the back, React + TanStack Router on the front.\n\n## Rules\n\n- One binary deploy\n- No sidecar services\n- Frontmatter is the schema\n- Every write emits an event\n- BYOK only — server never holds a default key' },
      { title: 'Data model', body: '# Data model\n\nOnly `title`, `status`, `body` are columns on `documents`. Everything else lives in `documents.frontmatter` (JSON column).\n\nThe UI infers field types from values; users pin types explicitly per-project via the `fields` table.', parentSlug: 'architecture' },
      { title: 'Auth & sessions', body: '# Auth & sessions\n\nHand-rolled session auth — no NextAuth, no Auth0.\n\n- Email + password\n- Magic-link option\n- HTTP-only session cookie\n- SameSite=Lax', parentSlug: 'architecture' },
      { title: 'Roadmap', slug: 'roadmap', body: '# Roadmap\n\n- [x] Phase 0 — scaffolding\n- [x] Phase 1 — CRUD + views\n- [x] Phase 1.5 — UX polish\n- [ ] Phase 2 — AI / BYOK\n- [ ] Phase 3 — MCP + agent API\n- [ ] Phase 4 — packaging (single binary, Docker)' },
      { title: 'Decisions log', body: '# Decisions log\n\nLocked architectural + product decisions with reasoning.\n\n- **Stack**: Bun + Hono + SQLite + React (locked)\n- **License**: MIT\n- **Multi-tenancy**: out of scope. One instance = one team.\n- **Search**: not in v1. sqlite-fts5 in v1.1.' },
    ],
  },
  {
    name: 'Stride',
    slug: 'stride',
    workItems: [
      { title: 'Migrate LMS to LearnDash 4.x', status: 'in_progress', frontmatter: { priority: 'high', assignee: 'stefan@netdust.be', labels: ['lms', 'migration'], due_date: '2026-06-20' }, body: 'Bedrock + LearnDash. Test on DDEV before staging.' },
      { title: 'FluentCRM segmentation by course progress', status: 'todo', frontmatter: { priority: 'medium', labels: ['crm', 'integration'] }, body: 'Auto-tag users when they complete a course.' },
      { title: 'Add Vue.js cohort SCORM tracking', status: 'in_progress', frontmatter: { priority: 'medium', assignee: 'stefan@netdust.be', labels: ['lms'], due_date: '2026-06-12' } },
      { title: 'Fix Redis cache invalidation for course lookups', status: 'done', frontmatter: { priority: 'high', labels: ['bugfix', 'caching'] }, body: '> Never flush Redis globally — LMS cache exclusions get destroyed by `wp cache flush`. Surgical invalidation only.' },
      { title: 'Quarterly invoice batch automation', status: 'todo', frontmatter: { priority: 'high', assignee: 'stefan@netdust.be', labels: ['billing'], due_date: '2026-06-30' } },
      { title: 'Domain renewal: stride.be', status: 'backlog', frontmatter: { priority: 'low', due_date: '2026-08-01', labels: ['ops'] } },
      { title: 'Replace ntdst-assistant with new build', status: 'in_progress', frontmatter: { priority: 'medium', labels: ['internal-tool'] } },
      { title: 'Pre-launch security audit', status: 'todo', frontmatter: { priority: 'high', labels: ['security'], due_date: '2026-06-25' } },
      { title: 'Course catalog page redesign', status: 'done', frontmatter: { priority: 'medium', labels: ['design', 'ux'] } },
      { title: 'Student progress dashboard', status: 'backlog', frontmatter: { priority: 'medium', labels: ['feature'] } },
    ],
    pages: [
      { title: 'Stride overview', body: '# Stride\n\nA LearnDash-based LMS for Belgian vocational education partners.\n\nSee [[ops-runbook]] for production incidents.' },
      { title: 'Ops runbook', slug: 'ops-runbook', body: '# Ops runbook\n\n## Hosting\n\nHetzner VPS via Ploi. Combell for legacy sites.\n\n## Backups\n\nSynology NAS + Hetzner Object Storage (S3-compatible).\n\n## Never\n\n- Flush Redis globally\n- Deploy to prod without explicit "production" confirmation' },
      { title: 'Deploy checklist', body: '# Deploy checklist\n\n- [ ] Tests passing on DDEV\n- [ ] Composer install on staging\n- [ ] Stage smoke-test pass\n- [ ] Explicit "production" sign-off\n- [ ] Deploy via /deploy\n- [ ] Post-deploy smoke check', parentSlug: 'ops-runbook' },
      { title: 'Client contacts', body: '# Client contacts\n\nKept private — see 1Password vault entry "Stride / clients".' },
    ],
  },
  {
    name: 'Client Website',
    slug: 'client-website',
    workItems: [
      { title: 'Discovery call notes', status: 'done', frontmatter: { priority: 'medium', labels: ['kickoff'], due_date: '2026-05-10' }, body: '## Goals\n\n- Re-platform from Wix to Statamic\n- Add multilingual support (NL/FR)\n- Integrate FluentForms for inquiries\n\n## Constraints\n\n- Budget: €8k\n- Launch: end of June' },
      { title: 'Statamic Peak scaffold', status: 'done', frontmatter: { priority: 'high', labels: ['scaffolding'] } },
      { title: 'Brand assets from client', status: 'in_progress', frontmatter: { priority: 'high', assignee: 'stefan@netdust.be', labels: ['blocked'], due_date: '2026-05-28' }, body: '> Blocked on client delivery. Logo PSD still pending.' },
      { title: 'Homepage hero block', status: 'in_progress', frontmatter: { priority: 'high', labels: ['design', 'frontend'] } },
      { title: 'About page', status: 'todo', frontmatter: { priority: 'medium', labels: ['content'] } },
      { title: 'Contact form (FluentForms)', status: 'todo', frontmatter: { priority: 'medium', labels: ['form', 'integration'] } },
      { title: 'NL ↔ FR translation pass', status: 'backlog', frontmatter: { priority: 'medium', labels: ['i18n'], due_date: '2026-06-15' } },
      { title: 'Hosting setup on Combell', status: 'todo', frontmatter: { priority: 'medium', labels: ['ops', 'combell'] } },
      { title: 'SEO baseline (titles, OG, schema.org)', status: 'backlog', frontmatter: { priority: 'low', labels: ['seo'] } },
      { title: 'Pre-launch checklist review with client', status: 'backlog', frontmatter: { priority: 'high', labels: ['launch'], due_date: '2026-06-22' } },
    ],
    pages: [
      { title: 'Project brief', body: '# Project brief\n\nRe-platform a small business website from Wix → Statamic. NL/FR bilingual.\n\nBudget: €8k. Timeline: 6 weeks.\n\nSee [[milestones]] for sprint breakdown.' },
      { title: 'Milestones', slug: 'milestones', body: '# Milestones\n\n1. Discovery + design — **2026-05-20** ✓\n2. Build + content — **2026-06-10**\n3. Translation pass — **2026-06-18**\n4. Launch — **2026-06-22**' },
      { title: 'Sprint 1 — Discovery & design', body: '# Sprint 1\n\n- Kickoff call ✓\n- Design system\n- Wireframes\n- Client sign-off', parentSlug: 'milestones' },
      { title: 'Sprint 2 — Build & content', body: '# Sprint 2\n\n- Statamic Peak scaffold ✓\n- Page builder blocks\n- Content migration from Wix\n- Forms integration', parentSlug: 'milestones' },
      { title: 'Sprint 3 — Translation & launch', body: '# Sprint 3\n\n- NL → FR pass\n- Final review\n- DNS cutover\n- Post-launch monitoring', parentSlug: 'milestones' },
    ],
  },
];

async function main() {
  console.log(`[seed] API=${API}, user=${EMAIL}`);
  await register();

  await createWorkspace('Netdust', WSLUG);

  for (const p of PROJECTS) {
    await createProject(WSLUG, p.name, p.slug);

    const tablesRes = await api('GET', `/api/v1/w/${WSLUG}/p/${p.slug}/tables`);
    const defaultTable = tablesRes.data.find((t: { slug: string }) => t.slug === 'work-items');
    if (!defaultTable) {
      throw new Error(`Project ${p.slug}: no default table was created. seedProjectDefaults must have failed.`);
    }
    console.log(`      • default table: ${defaultTable.slug}`);

    for (const f of STANDARD_FIELDS) {
      await api('POST', `/api/v1/w/${WSLUG}/p/${p.slug}/fields`, f);
    }
    console.log(`      • ${STANDARD_FIELDS.length} fields registered`);

    for (const item of p.workItems) {
      await createWorkItem(WSLUG, p.slug, item);
    }
    console.log(`      • ${p.workItems.length} work items`);

    const slugToId = new Map<string, string>();
    for (const page of p.pages) {
      await createPage(WSLUG, p.slug, page, slugToId);
    }
    console.log(`      • ${p.pages.length} wiki pages`);
  }

  console.log('\n✅ Seed complete.\n');
  console.log(`   Visit:   http://localhost:5173/login`);
  console.log(`   Email:   ${EMAIL}`);
  console.log(`   Pass:    ${PASSWORD}`);
  console.log(`   Then:    /w/${WSLUG}/p/folio/work-items`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
