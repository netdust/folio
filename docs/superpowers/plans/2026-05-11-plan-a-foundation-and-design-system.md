# Plan A — Phase 0 Finish + Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open Phase 0 boxes and implement the visual design system so subsequent phases consume a finished foundation.

**Architecture:** Three layers. Tokens (CSS variables in `tokens.css`) feed Tailwind utility names; primitives in `components/ui/` consume only semantic Tailwind classes; the shell composes primitives into a three-zone layout. Hard `<button>` reset prevents user-agent border injection. shadcn primitives provide accessible dialogs/popovers/commands/toasts; everything else is bespoke and tiny.

**Tech Stack:** Bun · Hono · Drizzle · SQLite · React 18 · Vite · TanStack Router · TanStack Query · Tailwind 3 · shadcn/ui (selective install) · clsx + tailwind-merge · Lucide icons · Sonner toaster · Self-hosted Geist + Geist Mono fonts.

**Specs this implements:**
- `docs/superpowers/specs/2026-05-11-design-system-design.md` (entirety)
- Phase 0 unfinished items in `docs/PHASES.md` (the unticked checkboxes plus Phase 0.5)

**What this plan does NOT do:**
- Any Phase 1 feature work (documents/statuses/fields/views CRUD, list view, kanban, slideover editor). That's Plan B + Plan C.
- Frontend routes for `/w/$wslug/...` — those exist starting in Plan C.

---

## Pre-flight

Before starting, confirm you can run:

```bash
cd /home/ntdst/Projects/folio
bun install
git status
```

`git status` should be clean. If not, commit or stash first.

---

## Task 1: Drop folio.tar.gz from working tree

The repo root has a stray `folio.tar.gz` (43KB). It's already in `.gitignore` (Plan A precondition) but the file on disk should be removed.

**Files:**
- Delete: `folio.tar.gz`

- [ ] **Step 1: Delete the file**

```bash
rm folio.tar.gz
```

- [ ] **Step 2: Verify gone**

```bash
ls folio.tar.gz 2>&1 || echo "OK, removed"
```

Expected: `No such file or directory` then `OK, removed`.

- [ ] **Step 3: Verify .gitignore still ignores it**

```bash
grep folio.tar.gz .gitignore
```

Expected: line `folio.tar.gz` is present.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "chore: remove stray folio.tar.gz from working tree"
```

---

## Task 2: Add `@/*` path alias to server tsconfig

Web has `paths: { "@/*": ["./src/*"] }`; server doesn't. Plan A and Plan B both want it.

**Files:**
- Modify: `apps/server/tsconfig.json`

- [ ] **Step 1: Read current tsconfig**

```bash
cat apps/server/tsconfig.json
```

Expected: shows config without a `paths` entry.

- [ ] **Step 2: Add the paths field**

Replace the file with:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "types": ["bun-types"],
    "outDir": "dist",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Sanity check by running typecheck**

```bash
cd apps/server && bunx tsc --noEmit && cd ../..
```

Expected: no output (passes).

- [ ] **Step 4: Commit**

```bash
git add apps/server/tsconfig.json
git commit -m "chore(server): add @/* path alias"
```

---

## Task 3: Split index.ts into app.ts + index.ts

Per design spec architecture: `app.ts` composes routes and middleware; `index.ts` is the Bun entrypoint that imports `app` and serves it. Keeps the entrypoint trivial for testing and the binary build.

**Files:**
- Create: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Create app.ts**

```typescript
// apps/server/src/app.ts
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { env } from './env.ts';
import { attachUser, type AuthContext } from './middleware/auth.ts';
import { auth } from './routes/auth.ts';
import { settingsRoute } from './routes/settings.ts';
import { documentsRoute, mcpRoute, viewsRoute } from './routes/stubs.ts';
import { tokensRoute } from './routes/tokens.ts';
import { workspacesRoute } from './routes/workspaces.ts';

export const app = new Hono<AuthContext>();

app.use('*', logger());
app.use('*', attachUser);

// --- API ---
const api = new Hono<AuthContext>();
api.route('/auth', auth);
api.route('/workspaces', workspacesRoute);
api.route('/documents', documentsRoute);
api.route('/views', viewsRoute);
api.route('/settings', settingsRoute);
api.route('/tokens', tokensRoute);
api.get('/health', (c) => c.json({ status: 'ok', version: '0.0.1' }));

app.route('/api', api);

// --- MCP (agent-facing surface) ---
app.route('/mcp', mcpRoute);

// --- Static SPA ---
if (env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ path: '../web/dist/index.html' }));
}
```

- [ ] **Step 2: Reduce index.ts to the entrypoint**

```typescript
// apps/server/src/index.ts
import { app } from './app.ts';
import { env } from './env.ts';

console.log(`[folio] listening on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
```

- [ ] **Step 3: Sanity check — server should start**

```bash
cd apps/server && timeout 3 bun run src/index.ts; echo "exit=$?"
```

Expected: prints `[folio] listening on http://localhost:3000`, then the timeout kills it. Exit code 124 is fine — that's the timeout firing, not a crash. Any other exit code or error = bug.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/index.ts
git commit -m "refactor(server): split index.ts into app.ts (composition) + index.ts (entry)"
```

---

## Task 4: Add error handler middleware

Returns `{ error: { code, message } }` envelope for any uncaught error or HTTPException, per Phase 1 spec §4.6.

**Files:**
- Create: `apps/server/src/middleware/error.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Create middleware/error.ts**

```typescript
// apps/server/src/middleware/error.ts
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';

interface FolioError {
  error: { code: string; message: string; details?: unknown };
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    const status = err.status;
    const body: FolioError = {
      error: {
        code: codeFromStatus(status),
        message: err.message || defaultMessage(status),
      },
    };
    return c.json(body, status);
  }
  console.error('[folio] unhandled error:', err);
  const body: FolioError = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
  };
  return c.json(body, 500);
}

function codeFromStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNPROCESSABLE';
    default:  return `HTTP_${status}`;
  }
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400: return 'Bad request.';
    case 401: return 'Unauthenticated.';
    case 403: return 'Forbidden.';
    case 404: return 'Not found.';
    case 409: return 'Conflict.';
    case 422: return 'Unprocessable entity.';
    default:  return 'Error.';
  }
}
```

- [ ] **Step 2: Wire it into app.ts**

In `apps/server/src/app.ts`, immediately after `export const app = new Hono<AuthContext>();`, add:

```typescript
import { onError } from './middleware/error.ts';

// ...

app.onError(onError);
```

Place the `import` line at the top of the import block, and the `app.onError(onError);` line right after `export const app = ...`.

- [ ] **Step 3: Smoke-test error envelope**

```bash
cd apps/server && timeout 3 bun run src/index.ts &
sleep 1
curl -s http://localhost:3000/api/workspaces | head -c 200
echo
kill %1 2>/dev/null; wait 2>/dev/null
cd ../..
```

Expected: a JSON response shaped like `{"error":"unauthenticated"}` — note this is `requireUser`'s direct response, not yet using `onError`. That's fine for now; the handler kicks in for thrown errors. Make a note for later.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/middleware/error.ts apps/server/src/app.ts
git commit -m "feat(server): error handler returns { error: { code, message } } envelope"
```

---

## Task 5: Add CORS middleware for dev

Vite dev server runs on `:5173` and proxies to the API on `:3000`. The proxy handles cross-origin for the SPA, but during agent + integration testing we want explicit dev-CORS.

**Files:**
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Install nothing — Hono has built-in CORS**

Verify: `grep cors apps/server/package.json` returns nothing (we don't need a new dep — `hono/cors` is built in).

- [ ] **Step 2: Add CORS to app.ts**

In `apps/server/src/app.ts`, add at the top of the imports:

```typescript
import { cors } from 'hono/cors';
```

Add the middleware **after** `app.onError(onError);` and **before** `app.use('*', logger());`:

```typescript
if (env.NODE_ENV !== 'production') {
  app.use('*', cors({
    origin: ['http://localhost:5173'],
    credentials: true,
  }));
}
```

- [ ] **Step 3: Smoke-test the OPTIONS preflight**

```bash
cd apps/server && timeout 3 bun run src/index.ts &
sleep 1
curl -s -I -X OPTIONS http://localhost:3000/api/auth/me \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" \
  2>&1 | grep -i "access-control"
kill %1 2>/dev/null; wait 2>/dev/null
cd ../..
```

Expected: response includes `Access-Control-Allow-Origin: http://localhost:5173`.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/app.ts
git commit -m "feat(server): dev-only CORS for vite proxy origin"
```

---

## Task 6: Rename `/api/health` to `/healthz`, reshape response

Per Phase 0 spec, the health route is `GET /healthz` returning `{ ok: true, version: ... }`. The current `/api/health` returns `{ status, version }`. Mount at the root level (no `/api` prefix) so reverse proxies can probe trivially.

**Files:**
- Create: `apps/server/src/routes/health.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Create health.ts**

```typescript
// apps/server/src/routes/health.ts
import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/healthz', (c) => c.json({ ok: true, version: '0.0.1' }));
```

- [ ] **Step 2: Modify app.ts**

In `apps/server/src/app.ts`:

1. Add to the import block: `import { healthRoute } from './routes/health.ts';`
2. Remove the inline `api.get('/health', ...)` line.
3. Add `app.route('/', healthRoute);` after `app.route('/mcp', mcpRoute);`.

The relevant section now reads:

```typescript
app.route('/api', api);
app.route('/mcp', mcpRoute);
app.route('/', healthRoute);
```

- [ ] **Step 3: Smoke-test**

```bash
cd apps/server && timeout 3 bun run src/index.ts &
sleep 1
curl -s http://localhost:3000/healthz
echo
kill %1 2>/dev/null; wait 2>/dev/null
cd ../..
```

Expected output: `{"ok":true,"version":"0.0.1"}`.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/health.ts apps/server/src/app.ts
git commit -m "feat(server): /healthz returns { ok: true, version } at root"
```

---

## Task 7: Generate initial migration

`apps/server/src/db/migrations/` doesn't exist. Drizzle Kit generates one from the schema diff. The Dockerfile assumes this directory exists.

**Files:**
- Generate: `apps/server/src/db/migrations/` (drizzle generates the contents)

- [ ] **Step 1: Read the drizzle config to confirm output path**

```bash
cat apps/server/drizzle.config.ts
```

Expected: `out: './src/db/migrations'` (or similar). If different, adjust the command in step 2.

- [ ] **Step 2: Generate the migration**

```bash
cd apps/server && bun run db:generate && cd ../..
```

Expected: drizzle-kit prints something like `✓ Your SQL migration file ➜ src/db/migrations/0000_xxx_yyy.sql` and creates `_journal.json` + `_meta/` under that directory.

- [ ] **Step 3: Verify the directory now exists**

```bash
ls apps/server/src/db/migrations/
```

Expected: one `.sql` file + `meta/_journal.json` (or `_journal.json` directly).

- [ ] **Step 4: Apply the migration to a clean dev DB**

```bash
cd apps/server && rm -f folio.db && bun run db:migrate && cd ../..
```

Expected: `Running migrations...` followed by `Migrations complete.` `apps/server/folio.db` now exists.

- [ ] **Step 5: Confirm the DB has the expected tables**

```bash
cd apps/server && bun -e "import { Database } from 'bun:sqlite'; const db = new Database('folio.db'); const tables = db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all(); console.log(tables.map(t => t.name).join(', '));" && cd ../..
```

Expected: a comma-separated list including `users, auth_sessions, workspaces, projects, documents, statuses, fields, views, api_tokens, ai_keys, events, magic_links, memberships, __drizzle_migrations`.

- [ ] **Step 6: Add folio.db to gitignore (already there) and commit migrations**

```bash
git add apps/server/src/db/migrations
git commit -m "feat(db): generate initial migration from schema"
```

---

## Task 8: Set up Bun test infrastructure

`bun test` should run anything matching `*.test.ts`. We'll write tests for the new theme/utility modules later. Verify the harness works on a trivial test.

**Files:**
- Create: `apps/server/src/__smoke.test.ts` (temp; deleted after step 4)

- [ ] **Step 1: Write a trivial test**

```typescript
// apps/server/src/__smoke.test.ts
import { describe, expect, test } from 'bun:test';

describe('bun test harness', () => {
  test('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run from the server directory**

```bash
cd apps/server && bun test src/__smoke.test.ts && cd ../..
```

Expected: `1 pass, 0 fail`.

- [ ] **Step 3: Delete the smoke test**

```bash
rm apps/server/src/__smoke.test.ts
```

- [ ] **Step 4: Add a root `test` script for convenience**

In root `package.json`, the `scripts` object — append a `test` entry. Read first:

```bash
cat package.json | head -20
```

Then edit so `scripts` includes:

```json
"test": "bun test"
```

The full scripts block ends up looking like:

```json
"scripts": {
  "dev": "bun run --filter '*' dev",
  "build": "bun run --filter '*' build",
  "build:binary": "bun run build && bun build apps/server/src/index.ts --compile --outfile dist/folio",
  "db:generate": "bun run --filter @folio/server db:generate",
  "db:migrate": "bun run --filter @folio/server db:migrate",
  "db:studio": "bun run --filter @folio/server db:studio",
  "test": "bun test",
  "lint": "biome check .",
  "format": "biome format --write ."
}
```

- [ ] **Step 5: Verify**

```bash
bun test
```

Expected: no test files found, so `0 pass, 0 fail` or a "no tests" message. As long as it doesn't crash, the harness is wired.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore: add root 'bun test' script"
```

---

## Task 9: Download Geist + Geist Mono fonts and self-host

CLAUDE.md mentions Geist; we use it via Google Fonts in mockups. For the real product we self-host to avoid the Google Fonts dependency in a self-hosted product (per design spec §16 deferred question 1).

**Files:**
- Create: `apps/web/public/fonts/Geist-{Light,Regular,Medium,SemiBold}.woff2`
- Create: `apps/web/public/fonts/GeistMono-Regular.woff2`
- Create: `apps/web/src/styles/fonts.css`

- [ ] **Step 1: Create the fonts directory**

```bash
mkdir -p apps/web/public/fonts
```

- [ ] **Step 2: Download the woff2 files from Vercel's geist-font repo**

The Geist project is MIT-licensed and the woff2 files are published in the `geist-font` npm package as well as the GitHub repo. Use curl:

```bash
cd apps/web/public/fonts

for weight in Light Regular Medium SemiBold; do
  curl -sL "https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-sans/Geist-${weight}.woff2" -o "Geist-${weight}.woff2"
done

curl -sL "https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-mono/GeistMono-Regular.woff2" -o "GeistMono-Regular.woff2"

ls -la
cd ../../../..
```

Expected: 5 woff2 files, each ~25-50KB.

- [ ] **Step 3: If any download is 0 bytes or HTML (a 404 page), the URL has moved.** Fallback: download from `https://github.com/vercel/geist-font/tree/main/packages/next/dist/fonts/` browsed manually, OR use the `geist` npm package's `dist/` files. Verify all 5 files have a size > 10000 bytes:

```bash
find apps/web/public/fonts -name "*.woff2" -size -10k -ls
```

Expected: no output (all files are large enough to be real fonts).

- [ ] **Step 4: Create fonts.css**

```css
/* apps/web/src/styles/fonts.css */
@font-face {
  font-family: 'Geist';
  src: url('/fonts/Geist-Light.woff2') format('woff2');
  font-weight: 300;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist';
  src: url('/fonts/Geist-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist';
  src: url('/fonts/Geist-Medium.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist';
  src: url('/fonts/Geist-SemiBold.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Mono';
  src: url('/fonts/GeistMono-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 5: Commit (large binary blobs included)**

```bash
git add apps/web/public/fonts apps/web/src/styles/fonts.css
git commit -m "feat(web): self-host Geist + Geist Mono fonts"
```

---

## Task 10: Write tokens.css

The single source of truth for color, type, spacing, radius, shadow, motion. Light theme on `:root`, dark on `.dark`. Per design spec §5.

**Files:**
- Create: `apps/web/src/styles/tokens.css`

- [ ] **Step 1: Write the file**

```css
/* apps/web/src/styles/tokens.css */

:root {
  /* --- Surfaces (light) --- */
  --color-shell:        #E3E3E5;
  --color-content:      #FCFCFC;
  --color-brand-2:      #F6F5F3;
  --color-card:         #F4F3F1;
  --color-border-light: #EAEAEA;
  --color-border-row:   #F4F3F1;

  /* --- Foreground (light) --- */
  --color-fg:            #000000;
  --color-fg-2:          rgba(0, 0, 0, 0.66);
  --color-fg-3:          rgba(0, 0, 0, 0.33);
  --color-fg-on-primary: #FFFFFF;

  /* --- Primary (light) --- */
  --color-primary:    #000000;
  --color-primary-fg: #FFFFFF;

  /* --- Semantic (foreground; shared across themes) --- */
  --color-success: #589F72;
  --color-danger:  #EA6B6B;
  --color-warning: #F0A442;
  --color-info:    #6EAFFF;

  /* --- Semantic backgrounds (light) --- */
  --color-bg-success: #DEFBE6;
  --color-bg-danger:  #FCF1F1;
  --color-bg-warning: #FDF4E7;
  --color-bg-info:    #F0F7FF;

  /* --- Typography --- */
  --font-sans: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;

  /* --- Spacing --- */
  --space-xs:  4px;
  --space-sm:  8px;
  --space-md:  16px;
  --space-lg:  24px;
  --space-xl:  32px;
  --space-xxl: 40px;
  --space-row: 10px;

  /* --- Radius --- */
  --radius-sm:   4px;
  --radius-md:   6px;
  --radius-lg:  10px;
  --radius-xl:  16px;
  --radius-pill: 999px;

  /* --- Depth (light) --- */
  --shadow-surface: 0 0 1px rgba(0, 0, 0, 0.25);
  --shadow-card:    0 0 1px rgba(0, 0, 0, 0.20);
  --shadow-popover: 0 8px 24px rgba(0, 0, 0, 0.12), 0 0 1px rgba(0, 0, 0, 0.18);

  /* --- Motion --- */
  --duration-fast:    120ms;
  --duration-default: 200ms;
  --duration-slow:    280ms;
  --ease-default:     cubic-bezier(0.16, 1, 0.3, 1);

  /* --- Focus ring --- */
  --ring: 0 0 0 2px var(--color-content), 0 0 0 4px var(--color-primary);
}

.dark {
  /* --- Surfaces (dark) --- */
  --color-shell:        #0a0a0b;
  --color-content:      #161618;
  --color-brand-2:      #1a1a1d;
  --color-card:         #1f1f22;
  --color-border-light: #26262a;
  --color-border-row:   #1f1f22;

  /* --- Foreground (dark) --- */
  --color-fg:            #f0f0f0;
  --color-fg-2:          rgba(240, 240, 240, 0.66);
  --color-fg-3:          rgba(240, 240, 240, 0.33);
  --color-fg-on-primary: #0a0a0b;

  /* --- Primary (dark inverts) --- */
  --color-primary:    #f0f0f0;
  --color-primary-fg: #0a0a0b;

  /* --- Semantic backgrounds (dark) --- */
  --color-bg-success: #1d2e26;
  --color-bg-danger:  #2e1d1d;
  --color-bg-warning: #2e2519;
  --color-bg-info:    #1a2434;

  /* --- Depth (dark) --- */
  --shadow-surface: 0 0 1px rgba(255, 255, 255, 0.10);
  --shadow-card:    0 0 1px rgba(255, 255, 255, 0.08);
  --shadow-popover: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 1px rgba(255, 255, 255, 0.15);
}

/* --- Reduced motion --- */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 80ms !important;
    transition-property: opacity !important;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/styles/tokens.css
git commit -m "feat(web): tokens.css — light + dark design tokens"
```

---

## Task 11: Replace globals.css with the new base layer

Drop the old paper/ink palette. Import tokens.css. Import fonts.css. Add the hard `<button>` reset that prevents user-agent border injection. Set base body styles from tokens.

**Files:**
- Modify: `apps/web/src/styles/globals.css`

- [ ] **Step 1: Replace the file**

```css
/* apps/web/src/styles/globals.css */
@import './fonts.css';
@import './tokens.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  /* Hard <button> reset — design spec §7.1 */
  button {
    background: none;
    border: 0;
    outline: 0;
    box-shadow: none;
    -webkit-appearance: none;
    appearance: none;
    font: inherit;
    color: inherit;
    padding: 0;
    margin: 0;
    cursor: pointer;
  }

  /* Universal focus-visible ring — design spec §5.9 */
  *:focus-visible {
    outline: none;
    box-shadow: var(--ring);
    border-radius: var(--radius-sm);
  }

  /* Body base */
  html {
    font-family: var(--font-sans);
    color: var(--color-fg);
    background: var(--color-shell);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    min-height: 100vh;
    font-size: 13px;
    line-height: 1.5;
  }

  /* Mono everywhere that wants it */
  code, .mono, [data-slug] {
    font-family: var(--font-mono);
  }
}
```

- [ ] **Step 2: Sanity check — `vite build` should pass**

```bash
cd apps/web && bun run build 2>&1 | tail -20 ; cd ../..
```

Expected: builds successfully. Any Tailwind warning about unknown classes will surface here.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/globals.css
git commit -m "feat(web): globals.css consumes tokens.css + hard button reset"
```

---

## Task 12: Rewrite tailwind.config.ts to use semantic tokens

Drop paper/ink/Fraunces. Add semantic utility names mapped to CSS variables. Keep darkMode `class` strategy.

**Files:**
- Modify: `apps/web/tailwind.config.ts`

- [ ] **Step 1: Replace the file**

```typescript
// apps/web/tailwind.config.ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        shell:      'var(--color-shell)',
        content:    'var(--color-content)',
        'brand-2':  'var(--color-brand-2)',
        card:       'var(--color-card)',
        'border-light': 'var(--color-border-light)',
        'border-row':   'var(--color-border-row)',

        fg:    'var(--color-fg)',
        'fg-2':'var(--color-fg-2)',
        'fg-3':'var(--color-fg-3)',
        'fg-on-primary': 'var(--color-fg-on-primary)',

        primary:    'var(--color-primary)',
        'primary-fg': 'var(--color-primary-fg)',

        success: 'var(--color-success)',
        danger:  'var(--color-danger)',
        warning: 'var(--color-warning)',
        info:    'var(--color-info)',

        'bg-success': 'var(--color-bg-success)',
        'bg-danger':  'var(--color-bg-danger)',
        'bg-warning': 'var(--color-bg-warning)',
        'bg-info':    'var(--color-bg-info)',
      },
      borderRadius: {
        sm:   'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        surface: 'var(--shadow-surface)',
        card:    'var(--shadow-card)',
        popover: 'var(--shadow-popover)',
      },
      transitionTimingFunction: {
        default: 'var(--ease-default)',
      },
      transitionDuration: {
        fast:    '120ms',
        default: '200ms',
        slow:    '280ms',
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 2: Sanity check — build**

```bash
cd apps/web && bun run build 2>&1 | tail -20 ; cd ../..
```

Expected: builds cleanly. If any feature file still uses `paper-XXX` or `ink-XXX` or `font-display`, the build complains. We'll fix those in Task 14.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tailwind.config.ts
git commit -m "feat(web): tailwind config maps semantic utilities to CSS vars"
```

---

## Task 13: cn() helper

Tiny utility every primitive imports. Wraps `clsx` + `tailwind-merge`. Already in deps.

**Files:**
- Create: `apps/web/src/components/ui/cn.ts`
- Create: `apps/web/src/components/ui/cn.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/ui/cn.test.ts
import { describe, expect, test } from 'bun:test';
import { cn } from './cn.ts';

describe('cn', () => {
  test('joins truthy strings', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  test('filters falsy', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
  test('merges conflicting tailwind utilities (later wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
  test('preserves non-conflicting classes', () => {
    expect(cn('text-fg bg-content', 'rounded-md')).toBe('text-fg bg-content rounded-md');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/web && bun test src/components/ui/cn.test.ts 2>&1 | tail -10 ; cd ../..
```

Expected: `Cannot find module './cn.ts'`.

- [ ] **Step 3: Write cn.ts**

```typescript
// apps/web/src/components/ui/cn.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Run again — expect pass**

```bash
cd apps/web && bun test src/components/ui/cn.test.ts && cd ../..
```

Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/cn.ts apps/web/src/components/ui/cn.test.ts
git commit -m "feat(ui): cn() helper for class merging"
```

---

## Task 14: Restyle existing pages off old paper/ink classes

`index.tsx` and `login.tsx` use `paper-XXX`, `ink-XXX`, `font-display` — all gone. Replace with semantic tokens. Drop the magic-link "consume" route mention.

**Files:**
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/login.tsx`

- [ ] **Step 1: Read existing __root.tsx**

```bash
cat apps/web/src/routes/__root.tsx
```

- [ ] **Step 2: Replace __root.tsx**

```tsx
// apps/web/src/routes/__root.tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-shell text-fg">
      <main className="mx-auto max-w-5xl px-8 py-12">
        <Outlet />
      </main>
      {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
    </div>
  ),
});
```

- [ ] **Step 3: Replace index.tsx (Phase 0 placeholder, restyled)**

```tsx
// apps/web/src/routes/index.tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { api } from '../lib/api.ts';

export const Route = createFileRoute('/')({
  component: HomePage,
});

interface Me {
  user: { id: string; email: string; name: string };
}

function HomePage() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/auth/me').catch(() => null),
    retry: false,
  });

  if (me.isPending) {
    return <p className="text-fg-3">Loading…</p>;
  }

  if (!me.data) {
    return (
      <section className="max-w-2xl">
        <h1 className="text-4xl font-medium tracking-tight">Markdown is the work.</h1>
        <p className="mt-6 text-lg text-fg-2">
          Folio is a lightweight project space for humans and agents. One markdown file
          is one work item. Pages live next to tasks. Your agents can read and write
          everything natively.
        </p>
        <div className="mt-10 flex gap-3">
          <Link
            to="/login"
            className="rounded-pill bg-primary px-5 py-2.5 text-sm text-primary-fg hover:opacity-90 transition-opacity duration-fast"
          >
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-3xl font-medium tracking-tight">
        Welcome back, {me.data.user.name}.
      </h1>
      <p className="mt-4 text-fg-2">
        Phase 0 stub. Workspace selection, projects, and the document grid land in Phase 1.
      </p>
      <div className="mt-8 rounded-lg border border-border-light p-6">
        <p className="font-mono text-sm text-fg-2">{me.data.user.email}</p>
        <p className="mt-2 font-mono text-xs text-fg-3">user_id: {me.data.user.id}</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Replace login.tsx**

```tsx
// apps/web/src/routes/login.tsx
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-3xl font-medium tracking-tight">Sign in</h1>
      <div className="mt-8 flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode('password')}
          className={`rounded-sm px-3 py-1.5 ${
            mode === 'password' ? 'bg-card text-fg' : 'text-fg-2 hover:bg-card'
          }`}
        >
          Password
        </button>
        <button
          type="button"
          onClick={() => setMode('magic')}
          className={`rounded-sm px-3 py-1.5 ${
            mode === 'magic' ? 'bg-card text-fg' : 'text-fg-2 hover:bg-card'
          }`}
        >
          Magic link
        </button>
      </div>
      <div className="mt-6">{mode === 'password' ? <PasswordForm /> : <MagicForm />}</div>
    </section>
  );
}

function PasswordForm() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/api/auth/login', { email, password }),
    onSuccess: () => navigate({ to: '/' }),
  });
  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <Field label="Password" type="password" value={password} onChange={setPassword} />
      <button
        type="button"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="w-full rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {m.error ? (
        <p className="text-sm text-danger">
          {m.error instanceof ApiError ? 'Invalid credentials.' : 'Something went wrong.'}
        </p>
      ) : null}
    </div>
  );
}

function MagicForm() {
  const [email, setEmail] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/api/auth/magic/request', { email }),
  });
  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <button
        type="button"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="w-full rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? 'Sending…' : 'Email me a link'}
      </button>
      {m.isSuccess ? (
        <p className="text-sm text-fg-2">
          Check your inbox. In dev, the link is printed to the server console.
        </p>
      ) : null}
    </div>
  );
}

function Field(props: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-wide text-fg-3">
        {props.label}
      </span>
      <input
        type={props.type}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border-light bg-transparent px-3 py-2 text-sm"
      />
    </label>
  );
}
```

- [ ] **Step 5: Build the web app — should succeed cleanly**

```bash
cd apps/web && bun run build 2>&1 | tail -10 ; cd ../..
```

Expected: build succeeds. No `paper-XXX` or `font-display` warnings.

- [ ] **Step 6: Visual check — run dev server and inspect**

```bash
bun run --filter @folio/web dev &
WEB_PID=$!
sleep 3
echo "Open http://localhost:5173 in a browser. Confirm:"
echo "  - Background is off-white (#FCFCFC), shell grey (#E3E3E5) at the very edges."
echo "  - 'Markdown is the work.' heading renders in Geist Medium."
echo "  - The 'Sign in' button is a black pill."
echo "  - Press Enter to continue once verified."
read -r
kill $WEB_PID 2>/dev/null; wait 2>/dev/null
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes
git commit -m "feat(web): restyle login + home to consume design tokens"
```

---

## Task 15: Theme switching infrastructure

`getTheme()` reads localStorage and `prefers-color-scheme`. `setTheme()` writes localStorage and toggles `.dark` on `<html>`. `useTheme()` hook for components. First-paint flash prevented by an inline script in `index.html`.

**Files:**
- Create: `apps/web/src/lib/theme.ts`
- Create: `apps/web/src/lib/theme.test.ts`
- Modify: `apps/web/index.html`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/theme.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { getResolvedTheme, setTheme, type Theme } from './theme.ts';

const STORAGE_KEY = 'folio:theme';

// Bun's DOM mock is partial; we set up a minimal stub.
const originalLocalStorage = globalThis.localStorage;
const originalMatchMedia = globalThis.matchMedia;
const originalDocument = globalThis.document;

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  globalThis.matchMedia = (q: string) => ({
    matches: q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }) as MediaQueryList;
  // minimal documentElement
  globalThis.document = {
    documentElement: { classList: new Set<string>() } as unknown as HTMLElement,
  } as unknown as Document;
  // patch classList.add/remove/contains
  const cls = (globalThis.document.documentElement.classList as unknown as Set<string>);
  (globalThis.document.documentElement.classList as unknown as { add: (s: string) => void }).add =
    (s: string) => { cls.add(s); };
  (globalThis.document.documentElement.classList as unknown as { remove: (s: string) => void }).remove =
    (s: string) => { cls.delete(s); };
  (globalThis.document.documentElement.classList as unknown as { contains: (s: string) => boolean }).contains =
    (s: string) => cls.has(s);
});

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
  globalThis.matchMedia = originalMatchMedia;
  globalThis.document = originalDocument;
});

describe('theme', () => {
  test('default is system, resolves to dark when media matches dark', () => {
    expect(getResolvedTheme()).toBe('dark');
  });

  test('setTheme(light) writes localStorage and removes .dark class', () => {
    document.documentElement.classList.add('dark');
    setTheme('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('setTheme(dark) writes localStorage and adds .dark class', () => {
    setTheme('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('setTheme(system) clears localStorage and resolves from media query', () => {
    setTheme('dark');
    setTheme('system');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
    // matchMedia stub returns matches=true for 'dark' query, so resolved is dark
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('all three values are valid Theme', () => {
    const themes: Theme[] = ['light', 'dark', 'system'];
    expect(themes.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test — should fail**

```bash
cd apps/web && bun test src/lib/theme.test.ts 2>&1 | tail -10 ; cd ../..
```

Expected: `Cannot find module './theme.ts'`.

- [ ] **Step 3: Write theme.ts**

```typescript
// apps/web/src/lib/theme.ts
const STORAGE_KEY = 'folio:theme';

export type Theme = 'light' | 'dark' | 'system';

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

export function getResolvedTheme(): 'light' | 'dark' {
  const stored = getStoredTheme();
  if (stored === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return stored;
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyResolvedTheme();
}

export function applyResolvedTheme(): void {
  const resolved = getResolvedTheme();
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
```

- [ ] **Step 4: Run test — should pass**

```bash
cd apps/web && bun test src/lib/theme.test.ts && cd ../..
```

Expected: `5 pass, 0 fail`.

- [ ] **Step 5: Inline bootstrap snippet in index.html**

Read current:

```bash
cat apps/web/index.html
```

Replace with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Folio</title>
    <script>
      // First-paint theme bootstrap. Reads folio:theme from localStorage and applies
      // .dark to <html> before React mounts, preventing the light-flash on dark theme.
      (function () {
        try {
          var s = localStorage.getItem('folio:theme');
          var resolved =
            s === 'light' ? 'light'
            : s === 'dark' ? 'dark'
            : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
          if (resolved === 'dark') document.documentElement.classList.add('dark');
        } catch (e) { /* localStorage unavailable; default light */ }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Smoke check — toggle via devtools**

```bash
bun run --filter @folio/web dev &
WEB_PID=$!
sleep 3
echo "Open http://localhost:5173 — confirm light theme (off-white background)."
echo "In the browser console run: localStorage.setItem('folio:theme', 'dark'); location.reload();"
echo "Confirm dark theme applies on reload with no flash."
echo "Press Enter when done."
read -r
kill $WEB_PID 2>/dev/null; wait 2>/dev/null
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts apps/web/index.html
git commit -m "feat(web): theme switching + first-paint bootstrap"
```

---

## Task 16: Button primitive

Bespoke. Variants: primary | secondary | ghost | danger. Sizes: sm | md | lg. Shape: rounded-pill. Per design spec §8.1.

**Files:**
- Create: `apps/web/src/components/ui/button.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/button.tsx
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:   'bg-primary text-primary-fg hover:opacity-90',
  secondary: 'bg-card text-fg hover:brightness-95',
  ghost:     'text-fg-2 hover:bg-card hover:text-fg',
  danger:    'bg-danger text-fg-on-primary hover:opacity-90',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-6 px-3 text-xs gap-1.5',
  md: 'h-7 px-3.5 text-xs gap-1.5',
  lg: 'h-8 px-4 text-sm gap-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-pill font-medium',
        'transition-opacity duration-fast ease-default',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {loading ? <Spinner /> : children}
    </button>
  );
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: no output (passes).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/button.tsx
git commit -m "feat(ui): Button primitive — 4 variants × 3 sizes"
```

---

## Task 17: IconButton primitive

For square icon-only buttons. Three sizes: 26 / 32 / 40 px. No background; per design spec §8.2.

**Files:**
- Create: `apps/web/src/components/ui/icon-button.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/icon-button.tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.ts';

type Size = 'sm' | 'md' | 'lg';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  active?: boolean;
  label: string; // for accessibility — always required
  children: ReactNode;
}

const sizeClasses: Record<Size, string> = {
  sm: 'h-[26px] w-[26px] rounded-sm',
  md: 'h-8 w-8 rounded-md',
  lg: 'h-10 w-10 rounded-md',
};

export function IconButton({
  size = 'md',
  active = false,
  label,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid place-items-center',
        'text-fg-3 hover:text-fg-2 hover:bg-card',
        'transition-colors duration-fast ease-default',
        active && 'text-fg bg-card',
        sizeClasses[size],
        className,
      )}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/icon-button.tsx
git commit -m "feat(ui): IconButton primitive (sm/md/lg, no background)"
```

---

## Task 18: Pill primitive (status pills)

Dot + label, inline-flex, font-size 12px. Variants from `statuses.category`. Per design spec §8.3.

**Files:**
- Create: `apps/web/src/components/ui/pill.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/pill.tsx
import { cn } from './cn.ts';

type Category = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

interface PillProps {
  category: Category;
  label: string;
  className?: string;
}

const dotColor: Record<Category, string> = {
  backlog:   'bg-fg-3',
  unstarted: 'bg-info',
  started:   'bg-warning',
  completed: 'bg-success',
  cancelled: 'bg-fg-3',
};

const textColor: Record<Category, string> = {
  backlog:   'text-fg-3',
  unstarted: 'text-info',
  started:   'text-warning',
  completed: 'text-success',
  cancelled: 'text-fg-3 line-through',
};

export function Pill({ category, label, className }: PillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', textColor[category], className)}>
      <span className={cn('h-[7px] w-[7px] rounded-full', dotColor[category])} />
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/pill.tsx
git commit -m "feat(ui): Pill primitive — status with dot + label"
```

---

## Task 19: Badge primitive

Padding 2px 8px, rounded-sm, 10px/500. Variants: high | medium | low | label (color hash for label). Per design spec §8.4.

**Files:**
- Create: `apps/web/src/components/ui/badge.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/badge.tsx
import { cn } from './cn.ts';

type Variant = 'high' | 'medium' | 'low' | 'label';
type LabelTone = 'success' | 'danger' | 'warning' | 'info';

interface BadgeProps {
  variant: Variant;
  tone?: LabelTone; // only used when variant='label'
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<Exclude<Variant, 'label'>, string> = {
  high:   'bg-bg-danger text-danger',
  medium: 'bg-card text-fg-2',
  low:    'bg-card text-fg-3',
};

const labelClasses: Record<LabelTone, string> = {
  success: 'bg-bg-success text-success',
  danger:  'bg-bg-danger text-danger',
  warning: 'bg-bg-warning text-warning',
  info:    'bg-bg-info text-info',
};

export function Badge({ variant, tone, children, className }: BadgeProps) {
  const cls = variant === 'label' ? labelClasses[tone ?? 'info'] : variantClasses[variant];
  return (
    <span
      className={cn(
        'inline-block px-2 py-0.5 rounded-sm text-[10px] font-medium',
        cls,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Deterministic tone hash for free-form label strings. */
export function labelTone(label: string): LabelTone {
  const tones: LabelTone[] = ['success', 'danger', 'warning', 'info'];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash << 5) - hash + label.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % tones.length;
  return tones[idx] ?? 'info';
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/badge.tsx
git commit -m "feat(ui): Badge primitive — priority + label variants"
```

---

## Task 20: Chip primitive (filter chips)

Active filter chip + dashed "+ Filter" affordance. Per design spec §8.5.

**Files:**
- Create: `apps/web/src/components/ui/chip.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/chip.tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.ts';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  filterKey: string;
  value: ReactNode;
}

export function Chip({ filterKey, value, className, ...rest }: ChipProps) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill bg-card px-2.5 py-0.5 text-xs',
        'hover:brightness-95 transition duration-fast ease-default',
        className,
      )}
    >
      <span className="text-fg-3">{filterKey}</span>
      <span className="font-medium text-fg">{value}</span>
    </button>
  );
}

interface ChipAddProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
}

export function ChipAdd({ label = '+ Filter', className, ...rest }: ChipAddProps) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center rounded-pill border border-dashed border-fg-3',
        'px-2.5 py-0.5 text-xs text-fg-2',
        'hover:text-fg hover:border-fg-2 transition-colors duration-fast',
        className,
      )}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/chip.tsx
git commit -m "feat(ui): Chip + ChipAdd primitives"
```

---

## Task 21: Avatar primitive

Round, 18/22/32px, deterministic accent. Per design spec §8.6.

**Files:**
- Create: `apps/web/src/components/ui/avatar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/avatar.tsx
import { cn } from './cn.ts';

type Size = 'xs' | 'sm' | 'md';

interface AvatarProps {
  name: string;
  size?: Size;
  className?: string;
}

const sizeClasses: Record<Size, string> = {
  xs: 'h-[18px] w-[18px] text-[9px]',
  sm: 'h-[22px] w-[22px] text-[10px]',
  md: 'h-8 w-8 text-xs',
};

const toneClasses = [
  'bg-primary text-primary-fg',
  'bg-warning text-white',
  'bg-success text-white',
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}

function toneFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return toneClasses[Math.abs(hash) % toneClasses.length] ?? toneClasses[0];
}

export function Avatar({ name, size = 'sm', className }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-grid place-items-center rounded-full font-medium',
        sizeClasses[size],
        toneFor(name),
        className,
      )}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/avatar.tsx
git commit -m "feat(ui): Avatar primitive — initials + deterministic tone"
```

---

## Task 22: Kbd primitive

Inline keyboard hint. Tiny.

**Files:**
- Create: `apps/web/src/components/ui/kbd.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/kbd.tsx
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center rounded-sm bg-card px-1.5 py-0.5',
        'font-mono text-[10px] text-fg-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/kbd.tsx
git commit -m "feat(ui): Kbd primitive"
```

---

## Task 23: Install shadcn primitives — Dialog, Sheet, Popover

These come from `@radix-ui/react-*` packages plus shadcn's wrapper conventions. We add them by hand (no shadcn CLI; lighter touch).

**Files:**
- Modify: `apps/web/package.json` (add deps)
- Create: `apps/web/src/components/ui/dialog.tsx`
- Create: `apps/web/src/components/ui/sheet.tsx`
- Create: `apps/web/src/components/ui/popover.tsx`

- [ ] **Step 1: Install Radix packages**

```bash
cd apps/web && bun add @radix-ui/react-dialog @radix-ui/react-popover && cd ../..
```

Expected: packages installed, lockfile updated.

- [ ] **Step 2: Create dialog.tsx**

```tsx
// apps/web/src/components/ui/dialog.tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export function DialogContent({ children, className }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-40 bg-black/30',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-[440px] max-w-[92vw] rounded-lg bg-content shadow-popover',
          'p-6',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
          className,
        )}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Title className={cn('text-base font-medium tracking-tight', className)}>
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Description className={cn('mt-2 text-sm text-fg-2', className)}>
      {children}
    </DialogPrimitive.Description>
  );
}
```

- [ ] **Step 3: Create sheet.tsx — 800px slideover**

```tsx
// apps/web/src/components/ui/sheet.tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

interface SheetContentProps {
  children: ReactNode;
  className?: string;
  /** Width in px. Defaults to 800 (document slideover). */
  width?: number;
}

export function SheetContent({ children, className, width = 800 }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-40 bg-black/10',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        style={{ width: `min(${width}px, 100vw)` }}
        className={cn(
          'fixed right-0 top-0 z-50 h-screen bg-content shadow-popover',
          'flex flex-col',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
          'duration-slow ease-default',
          className,
        )}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
```

- [ ] **Step 4: Create popover.tsx**

```tsx
// apps/web/src/components/ui/popover.tsx
import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

interface PopoverContentProps {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

export function PopoverContent({
  children,
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg bg-content shadow-popover p-1.5',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
```

- [ ] **Step 5: Install `tailwindcss-animate` for the animation utility classes**

```bash
cd apps/web && bun add -D tailwindcss-animate && cd ../..
```

Edit `apps/web/tailwind.config.ts`. Add to the import block at the top:

```typescript
import tailwindcssAnimate from 'tailwindcss-animate';
```

Change the `plugins: []` line to:

```typescript
plugins: [tailwindcssAnimate],
```

- [ ] **Step 6: Typecheck + build**

```bash
cd apps/web && bunx tsc --noEmit && bun run build 2>&1 | tail -5 ; cd ../..
```

Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json apps/web/bun.lockb apps/web/tailwind.config.ts apps/web/src/components/ui/dialog.tsx apps/web/src/components/ui/sheet.tsx apps/web/src/components/ui/popover.tsx
git commit -m "feat(ui): Dialog + Sheet + Popover primitives via radix-ui"
```

---

## Task 24: Toast primitive (Sonner)

Sonner is the simplest toaster that does what we want (auto-stack, accessibility, dismissible). Wrap it with theming.

**Files:**
- Modify: `apps/web/package.json` (add sonner)
- Create: `apps/web/src/components/ui/toast.tsx`

- [ ] **Step 1: Install sonner**

```bash
cd apps/web && bun add sonner && cd ../..
```

- [ ] **Step 2: Create toast.tsx**

```tsx
// apps/web/src/components/ui/toast.tsx
import { Toaster as SonnerToaster, toast } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      visibleToasts={3}
      duration={3500}
      toastOptions={{
        className: 'bg-content shadow-popover rounded-lg p-3 text-sm text-fg',
        descriptionClassName: 'text-fg-2',
        unstyled: false,
      }}
    />
  );
}

export { toast };
```

- [ ] **Step 3: Mount Toaster in __root.tsx**

Modify `apps/web/src/routes/__root.tsx`:

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Toaster } from '../components/ui/toast.tsx';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-shell text-fg">
      <main className="mx-auto max-w-5xl px-8 py-12">
        <Outlet />
      </main>
      <Toaster />
      {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
    </div>
  ),
});
```

- [ ] **Step 4: Typecheck + build**

```bash
cd apps/web && bunx tsc --noEmit && bun run build 2>&1 | tail -5 ; cd ../..
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/bun.lockb apps/web/src/components/ui/toast.tsx apps/web/src/routes/__root.tsx
git commit -m "feat(ui): Toaster via sonner, mounted in __root"
```

---

## Task 25: Command primitive (Cmd-K palette base)

`cmdk` is the same library shadcn uses. Wraps it with our theming. The full Cmd-K behavior lands in Phase 4; we ship the primitive now so the slash menu in Phase 1 can reuse it.

**Files:**
- Modify: `apps/web/package.json` (add cmdk)
- Create: `apps/web/src/components/ui/command.tsx`

- [ ] **Step 1: Install cmdk**

```bash
cd apps/web && bun add cmdk && cd ../..
```

- [ ] **Step 2: Create command.tsx**

```tsx
// apps/web/src/components/ui/command.tsx
import { Command as CommandPrimitive } from 'cmdk';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.ts';

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex flex-col overflow-hidden rounded-lg bg-content', className)}
      {...props}
    />
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <CommandPrimitive.Input
      className={cn(
        'border-b border-border-light bg-transparent px-3 py-2.5 text-sm',
        'focus:outline-none placeholder:text-fg-3',
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn('max-h-[320px] overflow-auto p-1.5', className)} {...props} />;
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-sm text-fg-3" {...props} />;
}

interface CommandGroupProps extends ComponentProps<typeof CommandPrimitive.Group> {
  heading?: ReactNode;
}

export function CommandGroup({ className, heading, ...props }: CommandGroupProps) {
  return (
    <CommandPrimitive.Group
      heading={
        heading ? (
          <span className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-3">
            {heading}
          </span>
        ) : undefined
      }
      className={cn('text-sm text-fg', className)}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5',
        'cursor-pointer aria-selected:bg-card',
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 3: Typecheck + build**

```bash
cd apps/web && bunx tsc --noEmit && bun run build 2>&1 | tail -5 ; cd ../..
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/bun.lockb apps/web/src/components/ui/command.tsx
git commit -m "feat(ui): Command primitive via cmdk (Cmd-K palette base)"
```

---

## Task 26: Shell — three-zone layout container

The outer frame: shell-grey bg, 6px padding, 6px gap, flex row containing rail + main + optional right panel. Per design spec §7.

**Files:**
- Create: `apps/web/src/components/shell/shell.tsx`

- [ ] **Step 1: Write shell.tsx**

```tsx
// apps/web/src/components/shell/shell.tsx
import type { ReactNode } from 'react';

interface ShellProps {
  rail: ReactNode;
  main: ReactNode;
  panel?: ReactNode;
}

export function Shell({ rail, main, panel }: ShellProps) {
  return (
    <div className="flex h-screen gap-1.5 bg-shell p-1.5">
      {rail}
      <div className="flex-1 min-w-0">{main}</div>
      {panel}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/shell.tsx
git commit -m "feat(shell): three-zone Shell container"
```

---

## Task 27: Rail — expanded (200px) + collapsed (64px) navigation

Reads collapse preference from localStorage. Renders icon+label rows when expanded, icon-only with active dot when collapsed. Per design spec §7.1.

**Files:**
- Create: `apps/web/src/components/shell/rail.tsx`

- [ ] **Step 1: Write rail.tsx**

```tsx
// apps/web/src/components/shell/rail.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

const STORAGE_KEY = 'folio:rail-collapsed';

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  href?: string;
  kbd?: string;
  active?: boolean;
  onClick?: () => void;
}

interface RailProps {
  brand: { mark: string; label: string };
  workspace: { mark: string; name: string; onSwitch?: () => void };
  primary: NavItem[];
  tools?: NavItem[];
  account?: NavItem[];
  user: { name: string };
}

export function useRailCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === '1';
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  return [collapsed, setCollapsed];
}

export function Rail({ brand, workspace, primary, tools, account, user }: RailProps) {
  const [collapsed] = useRailCollapsed();
  return collapsed
    ? <RailCollapsed brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} />
    : <RailExpanded brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} />;
}

function RailExpanded({ brand, workspace, primary, tools, account, user }: RailProps) {
  return (
    <aside className="flex w-[200px] flex-col rounded-xl bg-content shadow-surface px-3 py-3.5">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-2 mb-2">
        <Mark>{brand.mark}</Mark>
        <span className="text-sm font-medium tracking-tight">{brand.label}</span>
      </div>

      {/* Workspace */}
      <button
        type="button"
        onClick={workspace.onSwitch}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 mb-2 hover:bg-card transition-colors duration-fast"
      >
        <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
          {workspace.mark}
        </span>
        <span className="text-sm font-medium flex-1 text-left truncate">{workspace.name}</span>
        <span className="text-fg-3 text-[11px]">▾</span>
      </button>

      <Divider />
      <NavList items={primary} expanded />

      {tools && tools.length > 0 ? (
        <>
          <Divider />
          <NavList items={tools} expanded />
        </>
      ) : null}

      <div className="flex-1" />

      {account && account.length > 0 ? <NavList items={account} expanded /> : null}

      <div className="flex items-center gap-2 px-2 pt-1.5">
        <span className="inline-grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium">
          {initials(user.name)}
        </span>
        <span className="text-xs font-medium truncate">{user.name}</span>
      </div>
    </aside>
  );
}

function RailCollapsed({ brand, workspace, primary, tools, account, user }: RailProps) {
  return (
    <aside className="flex w-16 flex-col items-center rounded-xl bg-content shadow-surface py-3.5">
      <Mark>{brand.mark}</Mark>
      <button
        type="button"
        onClick={workspace.onSwitch}
        title={workspace.name}
        className="mt-3.5 mb-2 inline-grid h-[30px] w-[30px] place-items-center rounded bg-primary text-primary-fg text-xs font-semibold"
      >
        {workspace.mark}
      </button>
      <Divider tiny />
      <NavList items={primary} expanded={false} />
      {tools && tools.length > 0 ? (
        <>
          <Divider tiny />
          <NavList items={tools} expanded={false} />
        </>
      ) : null}
      <div className="flex-1" />
      {account && account.length > 0 ? <NavList items={account} expanded={false} /> : null}
      <span
        title={user.name}
        className="mt-1.5 inline-grid h-[30px] w-[30px] place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium"
      >
        {initials(user.name)}
      </span>
    </aside>
  );
}

function NavList({ items, expanded }: { items: NavItem[]; expanded: boolean }) {
  return (
    <div className={expanded ? 'flex flex-col' : 'flex flex-col items-center'}>
      {items.map((item) => (expanded
        ? (
          <button
            type="button"
            key={item.id}
            onClick={item.onClick}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-2 mb-0.5 transition-colors duration-fast',
              item.active ? 'bg-black/[0.06] dark:bg-white/[0.08] text-fg' : 'text-fg-3 hover:text-fg-2 hover:bg-card',
            )}
          >
            <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>
            <span className="text-sm font-medium flex-1 text-left">{item.label}</span>
            {item.kbd ? <span className="text-[10px] font-mono text-fg-3 bg-card rounded-sm px-1.5 py-0.5">{item.kbd}</span> : null}
          </button>
        )
        : (
          <button
            type="button"
            key={item.id}
            onClick={item.onClick}
            title={item.label}
            className={cn(
              'relative inline-grid h-10 w-10 place-items-center transition-colors duration-fast',
              item.active ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>
            {item.active ? <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-fg" /> : null}
          </button>
        )
      ))}
    </div>
  );
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-grid h-7 w-7 place-items-center rounded bg-primary text-primary-fg text-sm font-semibold tracking-tight">
      {children}
    </span>
  );
}

function Divider({ tiny = false }: { tiny?: boolean }) {
  return (
    <div className={cn('bg-border-light my-1.5', tiny ? 'h-px w-7 self-center' : 'h-px mx-1')} />
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/rail.tsx
git commit -m "feat(shell): Rail — expanded (200px) and collapsed (64px) modes"
```

---

## Task 28: MainFrame — constant header + tabs + toolbar + content slot

Per design spec §7.2. Layout-only; views provide the content.

**Files:**
- Create: `apps/web/src/components/shell/main-frame.tsx`

- [ ] **Step 1: Write main-frame.tsx**

```tsx
// apps/web/src/components/shell/main-frame.tsx
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

interface MainFrameProps {
  title: ReactNode;
  subMeta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function MainFrame({
  title,
  subMeta,
  actions,
  tabs,
  toolbar,
  children,
  className,
}: MainFrameProps) {
  return (
    <section
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-xl bg-content shadow-surface',
        className,
      )}
    >
      <div className="flex items-center px-[22px] pt-4">
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium tracking-tight">{title}</div>
          {subMeta ? (
            <div className="mt-0.5 font-mono text-[11px] text-fg-3 truncate">{subMeta}</div>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {tabs ? <div className="flex gap-1 px-[22px] pt-3">{tabs}</div> : null}
      {toolbar ? (
        <div className="flex items-center gap-1.5 border-b border-border-light px-[22px] py-2.5">
          {toolbar}
        </div>
      ) : null}
      <div className="flex-1 min-h-0 overflow-auto px-[22px] py-2">{children}</div>
    </section>
  );
}

interface TabProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function FrameTab({ active = false, onClick, children }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-sm px-2.5 py-1 text-[11px] transition-colors duration-fast',
        active ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
      )}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/main-frame.tsx
git commit -m "feat(shell): MainFrame — constant header+tabs+toolbar+content layout"
```

---

## Task 29: RightPanel — 320px collapsible with Context/Events/AI tabs

Per design spec §7.3. Tab content is content-supplied; the panel only owns the chrome.

**Files:**
- Create: `apps/web/src/components/shell/right-panel.tsx`

- [ ] **Step 1: Write right-panel.tsx**

```tsx
// apps/web/src/components/shell/right-panel.tsx
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

export type PanelTab = 'context' | 'events' | 'ai';

interface RightPanelProps {
  open: boolean;
  activeTab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  showAiTab: boolean;
  children: ReactNode;
}

export function RightPanel({
  open,
  activeTab,
  onTabChange,
  showAiTab,
  children,
}: RightPanelProps) {
  if (!open) return null;
  return (
    <aside className="flex w-[320px] flex-col overflow-hidden rounded-xl bg-content shadow-surface">
      <div className="flex gap-1 border-b border-border-light px-4 pt-3">
        <PanelTabButton active={activeTab === 'context'} onClick={() => onTabChange('context')}>
          Context
        </PanelTabButton>
        <PanelTabButton active={activeTab === 'events'} onClick={() => onTabChange('events')}>
          Events
        </PanelTabButton>
        {showAiTab ? (
          <PanelTabButton active={activeTab === 'ai'} onClick={() => onTabChange('ai')}>
            AI
          </PanelTabButton>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto px-4 py-3.5">{children}</div>
    </aside>
  );
}

function PanelTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 px-2.5 py-1.5 text-[11px] transition-colors duration-fast',
        active
          ? 'border-primary text-fg font-medium'
          : 'border-transparent text-fg-3 hover:text-fg-2',
      )}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/right-panel.tsx
git commit -m "feat(shell): RightPanel — 320px with Context/Events/AI tabs"
```

---

## Task 30: WorkspaceSwitcher — popover anchored to W avatar

Per design spec §7.4. Phase 1 wires it to real workspaces; for now it accepts props and renders the popover.

**Files:**
- Create: `apps/web/src/components/shell/workspace-switcher.tsx`

- [ ] **Step 1: Write workspace-switcher.tsx**

```tsx
// apps/web/src/components/shell/workspace-switcher.tsx
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { cn } from '../ui/cn.ts';
import type { ReactNode } from 'react';

interface Workspace {
  id: string;
  slug: string;
  name: string;
  mark: string;
  active?: boolean;
}

interface WorkspaceSwitcherProps {
  trigger: ReactNode;
  workspaces: Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onOpenSettings?: () => void;
}

export function WorkspaceSwitcher({
  trigger,
  workspaces,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenSettings,
}: WorkspaceSwitcherProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[320px] max-h-[480px] flex flex-col" align="start">
        <div className="flex-1 overflow-auto py-1">
          {workspaces.map((ws) => (
            <button
              type="button"
              key={ws.id}
              onClick={() => onSelectWorkspace(ws.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                'hover:bg-card transition-colors duration-fast',
                ws.active && 'bg-card',
              )}
            >
              <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
                {ws.mark}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{ws.name}</div>
                <div className="text-[10px] font-mono text-fg-3 truncate">{ws.slug}</div>
              </div>
              {ws.active ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
            </button>
          ))}
        </div>
        <div className="border-t border-border-light p-1">
          {onCreateWorkspace ? (
            <button
              type="button"
              onClick={onCreateWorkspace}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              + Create workspace
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              Workspace settings
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/workspace-switcher.tsx
git commit -m "feat(shell): WorkspaceSwitcher popover"
```

---

## Task 31: RailCollapseToggle — small button to flip the rail

Lives somewhere accessible. Settings page in Phase 1 — for now, expose it in `/dev/design-system` only.

**Files:**
- Create: `apps/web/src/components/shell/rail-collapse-toggle.tsx`

- [ ] **Step 1: Write rail-collapse-toggle.tsx**

```tsx
// apps/web/src/components/shell/rail-collapse-toggle.tsx
import { useRailCollapsed } from './rail.tsx';
import { Button } from '../ui/button.tsx';

export function RailCollapseToggle() {
  const [collapsed, setCollapsed] = useRailCollapsed();
  return (
    <Button variant="secondary" size="sm" onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? 'Expand rail' : 'Collapse rail'}
    </Button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/rail-collapse-toggle.tsx
git commit -m "feat(shell): RailCollapseToggle"
```

---

## Task 32: ThemeToggle — three-state switch (light/dark/system)

Used by `/dev/design-system` and Phase 1 settings.

**Files:**
- Create: `apps/web/src/components/ui/theme-toggle.tsx`

- [ ] **Step 1: Write theme-toggle.tsx**

```tsx
// apps/web/src/components/ui/theme-toggle.tsx
import { useEffect, useState } from 'react';
import { getStoredTheme, setTheme as applyTheme, type Theme } from '../../lib/theme.ts';
import { cn } from './cn.ts';

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>('system');
  useEffect(() => { setLocal(getStoredTheme()); }, []);
  const choose = (t: Theme) => { setLocal(t); applyTheme(t); };

  return (
    <div className="inline-flex items-center gap-0 rounded p-0.5 bg-card">
      {(['light', 'system', 'dark'] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => choose(t)}
          className={cn(
            'rounded-sm px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-fast',
            theme === t ? 'bg-content text-fg shadow-card' : 'text-fg-2 hover:text-fg',
          )}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/theme-toggle.tsx
git commit -m "feat(ui): ThemeToggle three-state switch"
```

---

## Task 33: /dev/design-system route — visual catalog

Renders every primitive + the shell in both themes. Dev-only.

**Files:**
- Create: `apps/web/src/routes/dev.design-system.tsx`

- [ ] **Step 1: Write the route**

```tsx
// apps/web/src/routes/dev.design-system.tsx
import { createFileRoute, notFound } from '@tanstack/react-router';
import { Button } from '../components/ui/button.tsx';
import { IconButton } from '../components/ui/icon-button.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Badge, labelTone } from '../components/ui/badge.tsx';
import { Chip, ChipAdd } from '../components/ui/chip.tsx';
import { Avatar } from '../components/ui/avatar.tsx';
import { Kbd } from '../components/ui/kbd.tsx';
import { ThemeToggle } from '../components/ui/theme-toggle.tsx';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog.tsx';
import { Sheet, SheetTrigger, SheetContent } from '../components/ui/sheet.tsx';
import { toast } from '../components/ui/toast.tsx';
import { Shell } from '../components/shell/shell.tsx';
import { Rail } from '../components/shell/rail.tsx';
import { MainFrame, FrameTab } from '../components/shell/main-frame.tsx';
import { RightPanel } from '../components/shell/right-panel.tsx';
import { RailCollapseToggle } from '../components/shell/rail-collapse-toggle.tsx';
import { useState } from 'react';

export const Route = createFileRoute('/dev/design-system')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: DesignSystem,
});

function DesignSystem() {
  return (
    <div className="min-h-screen bg-shell text-fg px-8 py-10">
      <header className="mx-auto max-w-5xl flex items-center gap-4 mb-10">
        <h1 className="text-2xl font-medium tracking-tight">Design system</h1>
        <span className="font-mono text-[11px] text-fg-3">dev only · v0</span>
        <span className="flex-1" />
        <ThemeToggle />
      </header>

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
      </Section>

      <Section title="Icon buttons">
        <Row>
          <IconButton size="sm" label="Edit"><Icon path="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /></IconButton>
          <IconButton size="md" label="Close"><Icon path="M18 6L6 18M6 6l12 12" /></IconButton>
          <IconButton size="lg" label="Search"><Icon path="M21 21l-4.35-4.35M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" /></IconButton>
          <IconButton size="md" label="Active" active><Icon path="M5 13l4 4L19 7" /></IconButton>
        </Row>
      </Section>

      <Section title="Status pills">
        <Row>
          <Pill category="backlog" label="Backlog" />
          <Pill category="unstarted" label="Todo" />
          <Pill category="started" label="In progress" />
          <Pill category="completed" label="Done" />
          <Pill category="cancelled" label="Cancelled" />
        </Row>
      </Section>

      <Section title="Badges">
        <Row>
          <Badge variant="high">High</Badge>
          <Badge variant="medium">Medium</Badge>
          <Badge variant="low">Low</Badge>
        </Row>
        <Row>
          {['curation', 'deadline', 'research', 'logistics', 'press'].map((l) => (
            <Badge key={l} variant="label" tone={labelTone(l)}>{l}</Badge>
          ))}
        </Row>
      </Section>

      <Section title="Chips">
        <Row>
          <Chip filterKey="status" value="is not Done" />
          <Chip filterKey="assignee" value="anyone" />
          <ChipAdd />
        </Row>
      </Section>

      <Section title="Avatars">
        <Row>
          <Avatar name="Stefan Vermaercke" size="xs" />
          <Avatar name="Ana Vermeulen" size="sm" />
          <Avatar name="Marc De Bruyne" size="md" />
        </Row>
      </Section>

      <Section title="Keyboard hints">
        <Row>
          <Kbd>⌘K</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd>⌘\</Kbd>
          <Kbd>⌘⇧C</Kbd>
        </Row>
      </Section>

      <Section title="Toast">
        <Row>
          <Button variant="secondary" onClick={() => toast.success('Saved.')}>Success</Button>
          <Button variant="secondary" onClick={() => toast.error('Failed to update — rolled back.')}>Error</Button>
          <Button variant="secondary" onClick={() => toast('Copied as Markdown.')}>Plain</Button>
        </Row>
      </Section>

      <Section title="Dialog">
        <Row>
          <Dialog>
            <DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger>
            <DialogContent>
              <DialogTitle>Confirm delete</DialogTitle>
              <DialogDescription>This action cannot be undone.</DialogDescription>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Delete</Button>
              </div>
            </DialogContent>
          </Dialog>
        </Row>
      </Section>

      <Section title="Sheet (800px slideover)">
        <Row>
          <Sheet>
            <SheetTrigger asChild><Button>Open sheet</Button></SheetTrigger>
            <SheetContent>
              <div className="p-6">
                <h2 className="text-xl font-medium tracking-tight">Document slideover preview</h2>
                <p className="mt-2 text-sm text-fg-2">800px wide. Closes on Esc or click-outside.</p>
              </div>
            </SheetContent>
          </Sheet>
        </Row>
      </Section>

      <Section title="Shell preview (try collapsing the rail)">
        <ShellPreview />
      </Section>
    </div>
  );
}

function ShellPreview() {
  const [panelOpen, setPanelOpen] = useState(false);
  const navIcon = (path: string) => <Icon path={path} />;
  return (
    <div className="h-[480px] -mx-4">
      <Shell
        rail={
          <Rail
            brand={{ mark: 'F', label: 'Folio' }}
            workspace={{ mark: 'G', name: 'Galerie Sint-Jan', onSwitch: () => toast('Switch workspace clicked.') }}
            primary={[
              { id: 'home',  label: 'Home',       icon: navIcon('M3 12l9-9 9 9M5 10v10h14V10') },
              { id: 'work',  label: 'Work items', icon: navIcon('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'), active: true },
              { id: 'board', label: 'Board',      icon: navIcon('M3 3h18v18H3zM9 3v18M15 3v18') },
              { id: 'wiki',  label: 'Wiki',       icon: navIcon('M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z') },
            ]}
            tools={[
              { id: 'search', label: 'Search', kbd: '⌘K', icon: navIcon('M21 21l-4.35-4.35M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z') },
            ]}
            account={[
              { id: 'settings', label: 'Settings', icon: navIcon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z') },
            ]}
            user={{ name: 'Stefan Vermaercke' }}
          />
        }
        main={
          <MainFrame
            title="Exhibitions"
            subMeta="galerie-sint-jan / exhibitions · 14 work items"
            actions={
              <>
                <Button variant="secondary" size="md" onClick={() => setPanelOpen((v) => !v)}>
                  {panelOpen ? 'Hide panel' : 'Show panel'}
                </Button>
                <Button variant="primary" size="md">+ New</Button>
                <RailCollapseToggle />
              </>
            }
            tabs={
              <>
                <FrameTab active>All work items</FrameTab>
                <FrameTab>Board</FrameTab>
                <FrameTab>Up next</FrameTab>
              </>
            }
            toolbar={
              <>
                <Chip filterKey="status" value="is not Done" />
                <ChipAdd />
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-fg-3">sorted by updated_at ↓</span>
              </>
            }
          >
            <div className="space-y-2 py-2 text-sm">
              <p className="text-fg-2">List view content lands in Plan C (Phase 1 frontend).</p>
              <p className="text-fg-3 text-xs">For now, primitives render here so designers can review them in context.</p>
            </div>
          </MainFrame>
        }
        panel={
          <RightPanel open={panelOpen} activeTab="context" onTabChange={() => {}} showAiTab={false}>
            <div className="space-y-3 text-sm">
              <div className="text-[15px] font-medium">Confirm artists for Spring '26 group show</div>
              <div className="font-mono text-[10px] text-fg-3">work_item · spring-26-artists</div>
              <Pill category="started" label="In progress" />
              <p className="text-fg-2">Right panel content lands in Plan C. For now it shows the locked tab chrome.</p>
            </div>
          </RightPanel>
        }
      />
    </div>
  );
}

// Helpers
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-5xl mb-10">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-fg-3 mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center flex-wrap gap-2.5">{children}</div>;
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path.split('M').filter(Boolean).map((p, i) => (
        <path key={i} d={`M${p}`} />
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Build + run dev**

```bash
cd apps/web && bun run build 2>&1 | tail -5 ; cd ../..
```

Expected: builds cleanly.

```bash
bun run --filter @folio/web dev &
WEB_PID=$!
sleep 3
echo "Open http://localhost:5173/dev/design-system in a browser."
echo "Check:"
echo "  1. All button variants render with the correct styles (no chunky pill on icon-buttons)."
echo "  2. Theme toggle (top-right) flips light/dark with no flash."
echo "  3. Dialog opens centered with backdrop."
echo "  4. Sheet opens from the right at 800px wide."
echo "  5. Toasts appear bottom-right and dismiss after ~3.5s."
echo "  6. Shell preview at the bottom shows rail + main + (toggle) right panel."
echo "  7. 'Collapse rail' button shrinks the rail to 64px icon-only with active dot."
echo "  8. Rail preference persists after page refresh."
echo "Press Enter when done."
read -r
kill $WEB_PID 2>/dev/null; wait 2>/dev/null
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/dev.design-system.tsx
git commit -m "feat(web): /dev/design-system catalog renders every primitive in context"
```

---

## Task 34: Lighthouse accessibility audit on /dev/design-system

Per design spec §14 acceptance criterion 7: Lighthouse a11y ≥ 95.

**Files:** *(none — verification only)*

- [ ] **Step 1: Run dev server**

```bash
bun run --filter @folio/web dev &
WEB_PID=$!
sleep 3
```

- [ ] **Step 2: Run Lighthouse via Chrome devtools manually**

Open `http://localhost:5173/dev/design-system` in Chrome. Open devtools → Lighthouse panel → Mode: Navigation → Categories: Accessibility only → analyze.

Expected: Accessibility score **≥ 95**.

- [ ] **Step 3: If score < 95**

Read the audit. Common fixes:
- Buttons without `aria-label` — IconButton already requires `label`; verify all uses pass it.
- Insufficient contrast on `text-fg-3` — design spec §11 acknowledges this; ensure tertiary text isn't used for critical info.
- Missing `lang` on `<html>` — verify index.html has `<html lang="en">`.

Fix each issue, re-run, commit fixes (one commit per fix). If genuinely stuck, write the issue + score into the spec's §17 deferred questions and proceed — don't block the plan on a single percent point.

- [ ] **Step 4: Stop server**

```bash
kill $WEB_PID 2>/dev/null; wait 2>/dev/null
```

- [ ] **Step 5: Commit a note recording the achieved score**

```bash
# If no source code changed, this is a no-op commit. Skip if so.
# Otherwise:
git add -u
git commit -m "fix(ui): address Lighthouse a11y findings on /dev/design-system"
```

---

## Task 35: Smoke-test the build pipeline

Verify `bun run build` produces a clean web bundle. Compile the single binary if we have the bandwidth.

**Files:** *(none — verification only)*

- [ ] **Step 1: Clean build**

```bash
rm -rf apps/web/dist apps/server/dist dist
bun install
bun run build
```

Expected: web builds; server has a `build` script that outputs to `apps/server/dist`. Both succeed.

- [ ] **Step 2: Sanity check the built web bundle**

```bash
ls apps/web/dist
cat apps/web/dist/index.html | head -25
```

Expected: index.html exists; the inline theme bootstrap script is present.

- [ ] **Step 3 (optional): Compile single binary**

```bash
bun run build:binary
ls -la dist/folio
```

Expected: `dist/folio` exists and is ~50-80MB. If `bun build --compile` errors out about platform (you're on macOS but binary target is linux), prepend with `--target=bun-darwin-arm64` or just try without `--target`. Acceptable to skip if not on linux locally; the Docker build will verify in CI later.

- [ ] **Step 4: No commit needed unless config changed**

---

## Task 36: Update CLAUDE.md and PHASES.md

Document that Phase 0.5 is done. Tick boxes.

**Files:**
- Modify: `docs/PHASES.md`

- [ ] **Step 1: Open PHASES.md and tick Phase 0.5 boxes**

In `docs/PHASES.md`, find the Phase 0.5 section. Change each `- [ ]` for items that are now done to `- [x]`:

Specifically, the acceptance criteria items in §Phase 0.5:
- `tokens.css` exists with all values from spec §5, light + dark.
- `tailwind.config.ts` maps every token to a semantic utility name; no raw hex appears in any feature file.
- Geist + Geist Mono self-hosted in `apps/web/public/fonts/`; `@font-face` declarations in `fonts.css`.
- Hard `<button>` reset shipped (background / border / outline / box-shadow / appearance all zeroed) so no chunky pill buttons appear.
- Bespoke primitives in `components/ui/`: `Button`, `IconButton`, `Pill`, `Badge`, `Chip`, `Avatar`, `Kbd`. Each renders correctly in both themes with working `:focus-visible`.
- shadcn primitives installed and themed via Tailwind tokens: `Dialog`, `Sheet`, `Popover`, `Command`, `Toast`.
- Shell components composed in `components/shell/`: `Shell`, `Rail` (expanded + collapsed), `MainFrame`, `RightPanel`, `WorkspaceSwitcher`.
- Theme bootstrap snippet in `index.html` prevents first-paint flash.
- `localStorage` persistence for theme + rail collapsed/expanded preference.
- Dev-only `/dev/design-system` route renders every primitive and the shell in both themes.
- Login + home pages re-styled to consume the new tokens (sanity check existing scaffold against the system).
- Lighthouse accessibility audit on `/dev/design-system` passes ≥ 95.
- Mockups in `.superpowers/brainstorm/` match what the implementation renders.

All become `- [x]` if you've completed each step honestly.

- [ ] **Step 2: Also tick the Phase 0 boxes that Plan A completed**

In the Phase 0 section, tick:
- `Path aliases: @/ in each app, @folio/shared for the shared package` (Task 2)
- `Hono app skeleton: app.ts composes routes, index.ts is the Bun entrypoint` (Task 3)
- `Logger middleware, error handler, CORS for dev` (Tasks 4, 5)
- `Health route GET /healthz returns { ok: true, version: ... }` (Task 6)
- `Initial migration generated and applied` (Task 7)

- [ ] **Step 3: Commit the final phase 0.5 marker**

```bash
git add docs/PHASES.md
git commit -m "phase-0.5: design system complete"
```

---

## Plan A complete

After Task 36, the project state is:
- All Phase 0 backend gaps closed (app.ts split, error handler, CORS, healthz, migrations).
- Design system fully implemented and visually verified on `/dev/design-system`.
- Login + home pages restyled to consume the new tokens.
- Theme switching with persistence + first-paint bootstrap.
- All primitives + shell components ready to be consumed by Plan B (Phase 1 backend) and Plan C (Phase 1 frontend).

Suggested next step: open Plan B (Phase 1 backend) — but write it first via the `superpowers:writing-plans` skill, since Plan B's tasks depend on the open-question outcomes (e.g., did Lighthouse pass, are there a11y notes to thread into Phase 1 forms?).
