# Netdust Starter Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Folio's foundation (Bun + Hono + Drizzle + bun:sqlite + Vite/React + TanStack Router + auth + workspaces + BYOK + API tokens + the full design system) into a private starter repo with a generic name, evolving independently from Folio (fork-and-forget model).

**Architecture:** The starter is a snapshot of Folio at commit `88f1abf` (Phase 0.5 complete) minus the document-centric domain layer (documents/statuses/fields/views tables, frontmatter parsing, document/view/MCP route stubs, document-related shared types). All product strings (`Folio`, `@folio/*`, `folio:theme`, etc.) parameterize to environment placeholders ready for sed-replacement on first use. The starter ships with a working dev loop (`bun install && bun dev` → login page renders + `/dev/design-system` catalog works) and a one-liner setup script that prompts for the new app's name and rewrites the placeholders.

**Tech Stack:** Same as Folio — Bun · Hono · Drizzle · bun:sqlite · React 18 · Vite · TanStack Router · TanStack Query · Tailwind 3 · Radix UI · Sonner · cmdk · Geist + Geist Mono · libsodium · Zod.

**Specs this implements:** *(none — this plan is itself the spec for a one-off extraction)*

**What this plan does NOT do:**
- Build a `create-netdust-app` CLI (was option C in extraction-strategy decision; user picked option A: fork-and-forget).
- Touch the running Folio repo. Folio stays at `phase-0.5/design-system` HEAD. The starter is a brand-new sibling repo.
- Rename Folio. Folio remains Folio.
- Open-source the starter. It's private.

---

## Pre-flight

- Folio's HEAD is `88f1abf phase-0.5: design system complete` on branch `phase-0.5/design-system`. The starter is extracted from a clean checkout of this commit.
- Choose a name for the starter. The plan uses `netdust-starter` throughout — search-replace if you pick something different (e.g., `bun-stack`, `studio-starter`).
- Decide a parent directory for the new repo. The plan assumes `~/Projects/netdust-starter`.

---

## Task 1: Create the starter directory by copying Folio at HEAD

Goal: get a working copy of Folio's tree at `~/Projects/netdust-starter/` without `.git` (we'll init fresh in Task 2).

**Files:**
- Create: `~/Projects/netdust-starter/` (directory)

- [ ] **Step 1: Verify Folio is at the expected HEAD and clean**

```bash
cd /home/ntdst/Projects/folio
git rev-parse HEAD
git status
```

Expected: HEAD prints `88f1abf...` (or whatever was the Phase 0.5 final commit at extraction time). Working tree clean.

- [ ] **Step 2: Copy via `cp -r` excluding heavyweight + repo-state directories**

```bash
mkdir -p ~/Projects/netdust-starter
cd /home/ntdst/Projects/folio
rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' --exclude='*.tar.gz' ./ ~/Projects/netdust-starter/
```

Expected: rsync prints nothing on success. ~/Projects/netdust-starter/ now mirrors Folio without git history, deps, builds, or local DB.

- [ ] **Step 3: Sanity check the copy**

```bash
ls ~/Projects/netdust-starter
ls ~/Projects/netdust-starter/apps/server/src
ls ~/Projects/netdust-starter/apps/web/src
```

Expected: matches Folio's layout (apps, packages, docker, docs, scripts, CLAUDE.md, package.json, etc.). `node_modules` absent.

---

## Task 2: Initialize fresh git repo and make the first commit

The starter forks from Folio at extraction time but does **not** inherit Folio's commit history. Anyone cloning it should see a single "initial scaffold" commit, not 38+ Phase 0/0.5 commits referencing Folio-internal naming.

**Files:**
- Create: `~/Projects/netdust-starter/.git/`

- [ ] **Step 1: Initialize empty git repo**

```bash
cd ~/Projects/netdust-starter
git init -b main
```

Expected: `Initialized empty Git repository in ~/Projects/netdust-starter/.git/`

- [ ] **Step 2: Confirm `.gitignore` is in place (copied from Folio)**

```bash
cat .gitignore | head -10
```

Expected: includes `node_modules`, `dist`, `*.db`, etc.

- [ ] **Step 3: Stage everything and verify scope**

```bash
git add -A
git status --short | head -20
git status --short | wc -l
```

Expected: ~80-90 files staged (matches Folio's `git ls-files | wc -l` at extraction time). No `.env`, no DB files, no node_modules.

- [ ] **Step 4: Commit the snapshot — this is the only commit that will exist before extraction work**

```bash
git commit -m "chore: initial snapshot from Folio @ 88f1abf"
```

Expected: a single commit lands. `git log --oneline | wc -l` prints `1`.

---

## Task 3: Drop the Folio-specific schema tables

Goal: in `apps/server/src/db/schema.ts`, remove the four tables that constitute Folio's document-centric domain layer. The starter keeps the generic infrastructure tables: users, authSessions, magicLinks, workspaces, memberships, projects, apiTokens, aiKeys, events.

**Files:**
- Modify: `apps/server/src/db/schema.ts` — delete `documents`, `statuses`, `fields`, `views` tables and their indexes.

- [ ] **Step 1: Read the current schema and locate the four blocks to delete**

```bash
grep -n "^export const \(documents\|statuses\|fields\|views\) = sqliteTable" apps/server/src/db/schema.ts
```

Expected line numbers (approximate, based on the audit): `documents` at ~168, `statuses` at ~123, `fields` at ~146, `views` at ~204.

- [ ] **Step 2: Delete the four table blocks**

Open `apps/server/src/db/schema.ts` in an editor and delete each table's full `export const X = sqliteTable(...)` block, including its trailing index definitions (if any) and the closing `);`. The order in the file is statuses → fields → documents → views. Be careful: `documents.frontmatter` is `text({ mode: 'json' })` — make sure you don't leave a dangling JSON-mode reference in the imports.

After deletion, verify these blocks are gone:

```bash
grep -E "^export const (documents|statuses|fields|views) = sqliteTable" apps/server/src/db/schema.ts
```

Expected: no output.

- [ ] **Step 3: Verify the remaining tables are intact**

```bash
grep -E "^export const \w+ = sqliteTable" apps/server/src/db/schema.ts
```

Expected, in order: `users`, `authSessions`, `magicLinks`, `workspaces`, `memberships`, `projects`, `apiTokens`, `aiKeys`, `events`. Nine tables.

- [ ] **Step 4: Run a typecheck — it will fail (other files import the deleted symbols)**

```bash
cd apps/server && bunx tsc --noEmit 2>&1 | head -25; cd ../..
```

Expected: errors pointing at `routes/stubs.ts`, `lib/frontmatter.ts`, and `packages/shared/src/index.ts`. We'll fix those in Tasks 4, 5, 6.

- [ ] **Step 5: Do NOT commit yet** — typecheck is broken. Tasks 4-6 land together as one logical group.

---

## Task 4: Delete `routes/stubs.ts` and unwire from `app.ts`

`stubs.ts` exists only to register `/documents`, `/views`, and `/mcp` route placeholders. In the starter, those routes don't exist; the file is dead weight.

**Files:**
- Delete: `apps/server/src/routes/stubs.ts`
- Modify: `apps/server/src/app.ts` — remove the import and the two `app.route()` calls that reference `documentsRoute`, `viewsRoute`, `mcpRoute`.

- [ ] **Step 1: Delete the stubs file**

```bash
rm apps/server/src/routes/stubs.ts
```

- [ ] **Step 2: Read current app.ts**

```bash
cat apps/server/src/app.ts
```

Note: the stubs file exports three names — `documentsRoute`, `mcpRoute`, `viewsRoute` — all imported from `./routes/stubs.ts` and mounted at `/api/documents`, `/api/views`, `/mcp`.

- [ ] **Step 3: Edit app.ts to remove the import and route mounts**

Remove these lines:

```typescript
import { documentsRoute, mcpRoute, viewsRoute } from './routes/stubs.ts';
```

```typescript
api.route('/documents', documentsRoute);
api.route('/views', viewsRoute);
```

```typescript
// --- MCP (agent-facing surface) ---
app.route('/mcp', mcpRoute);
```

After editing, `app.ts` still imports auth, settings, tokens, workspaces, health. The API surface is `/api/auth`, `/api/workspaces`, `/api/settings`, `/api/tokens`, plus `/healthz` at root.

- [ ] **Step 4: Verify scope**

```bash
grep -E "stubs|documentsRoute|viewsRoute|mcpRoute" apps/server/src/app.ts
```

Expected: no output.

- [ ] **Step 5: Do NOT commit yet** — typecheck still failing on `lib/frontmatter.ts` and `packages/shared/src/index.ts`.

---

## Task 5: Delete `lib/frontmatter.ts` and unwire any importers

The frontmatter parser is the bridge between Drizzle rows and Folio's markdown body field. With `documents` gone, frontmatter handling has no purpose.

**Files:**
- Delete: `apps/server/src/lib/frontmatter.ts`

- [ ] **Step 1: Confirm no remaining importer**

```bash
grep -rln "from.*lib/frontmatter\|from.*\./frontmatter" apps/server/src/ 2>/dev/null
```

Expected: no output (stubs.ts was the only importer; deleted in Task 4).

- [ ] **Step 2: Delete the file**

```bash
rm apps/server/src/lib/frontmatter.ts
```

- [ ] **Step 3: Verify scope**

```bash
ls apps/server/src/lib/
```

Expected: `auth.ts`, `crypto.ts`, `email.ts`, `slugify.ts`. Four files. (`slugify.ts` stays — slug generation is generic, not document-specific.)

- [ ] **Step 4: Do NOT commit yet.**

---

## Task 6: Replace `packages/shared/src/index.ts` with a minimal generic version

The current `packages/shared/src/index.ts` exports `DocumentType`, `ViewType`, `FieldType`, `inferFieldType`, and `DocumentSummary` — all document-centric. The starter needs a placeholder shared package that the workspace builds happily but contains no domain types.

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Read current contents to confirm what's being replaced**

```bash
cat packages/shared/src/index.ts | head -40
```

- [ ] **Step 2: Replace with a minimal placeholder**

```typescript
/**
 * Shared types and utilities used by both server and web.
 *
 * Add app-specific types here as the project grows. This file is a placeholder
 * so the @app/shared workspace package builds; it contains no domain types.
 */

export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';
```

Keep `AiProvider` because it's used by the settings route (BYOK feature, which is kept).

- [ ] **Step 3: Confirm the shared package still has a valid `package.json`**

```bash
cat packages/shared/package.json
```

Expected: still exists, still named `@folio/shared`. We'll rename in Task 10.

- [ ] **Step 4: Run typecheck — should now pass**

```bash
cd apps/server && bunx tsc --noEmit && cd ../..
```

Expected: exit 0, no output.

```bash
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: exit 0, no output. (The web app doesn't import `DocumentType` directly — it only references the shared package for types that have been removed-but-unused.)

If the web typecheck fails on missing shared exports, grep the web app for `from '@folio/shared'` and decide per-import whether to delete the call site (it referenced document-specific behavior) or replace with a local placeholder. Most likely outcome: zero web imports of those removed types, since Phase 0.5 didn't wire any feature work yet.

- [ ] **Step 5: Commit Tasks 3-6 as one logical change**

```bash
git add -A
git commit -m "feat: drop Folio document-centric domain layer

Removes the documents/statuses/fields/views tables, frontmatter parser,
stub routes (documents/views/mcp), and document-shaped shared types.
What remains: users + sessions + magic-link, workspaces + memberships,
projects (generic container), AI keys, API tokens, events, plus the
full design system and build pipeline."
```

---

## Task 7: Regenerate the migration from the trimmed schema

The committed migration (`0000_cool_katie_power.sql`) was generated from Folio's full schema. It will create tables we no longer want.

**Files:**
- Delete: `apps/server/src/db/migrations/` (entire directory)
- Generate: `apps/server/src/db/migrations/0000_*.sql` (new content via drizzle-kit)

- [ ] **Step 1: Delete the old migration directory**

```bash
rm -rf apps/server/src/db/migrations
```

- [ ] **Step 2: Install deps (we're in a fresh repo with no node_modules yet)**

```bash
cd ~/Projects/netdust-starter
bun install 2>&1 | tail -5
```

Expected: workspace installs cleanly. ~280 packages.

- [ ] **Step 3: Generate the migration from the trimmed schema**

```bash
cd apps/server && bun run db:generate 2>&1 | tail -10; cd ../..
```

Expected: `drizzle-kit generate` reports **9 tables** (vs Folio's 13): users, auth_sessions, magic_links, workspaces, memberships, projects, api_tokens, ai_keys, events. Writes a new `0000_*.sql` file.

- [ ] **Step 4: Apply it to a clean dev DB**

```bash
cd apps/server && rm -f folio.db folio.db-shm folio.db-wal && SESSION_SECRET=$(printf 'a%.0s' {1..40}) FOLIO_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./folio.db bun run db:migrate 2>&1 | tail -5; cd ../..
```

Expected: `Running migrations...` → `Migrations complete.` Exit 0.

(Note: env var names are still `FOLIO_MASTER_KEY` etc. — they'll be renamed in Task 9. We use the old names here because env.ts hasn't been edited yet.)

- [ ] **Step 5: Confirm the table list matches the trimmed schema**

```bash
cd apps/server && bun -e "import { Database } from 'bun:sqlite'; const db = new Database('folio.db'); const tables = db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all(); console.log(tables.map(t => t.name).join(', '));" && cd ../..
```

Expected: `__drizzle_migrations, ai_keys, api_tokens, auth_sessions, events, magic_links, memberships, projects, users, workspaces`. Ten entries (9 schema tables + the internal migrations table). No `documents`, `statuses`, `fields`, `views`.

- [ ] **Step 6: Delete the dev DB before commit (it's gitignored anyway, but be tidy)**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/migrations
git commit -m "feat(db): regenerate initial migration from trimmed schema"
```

---

## Task 8: Remove the `/dev/design-system` route's mockup data references

The catalog route at `apps/web/src/routes/dev.design-system.tsx` is **the** killer demo for the design system — keep it. But it currently uses Folio-flavored mockup data: "Galerie Sint-Jan", "Exhibitions", "galerie-sint-jan / exhibitions · 14 work items", etc.

For a starter, the demo data should be **generic** so new projects don't see a stale art-gallery example before they've touched anything.

**Files:**
- Modify: `apps/web/src/routes/dev.design-system.tsx`

- [ ] **Step 1: Search for Folio-flavored strings**

```bash
grep -nE "Galerie|exhibitions|Spring '26|sint-jan|Stefan Vermaercke|spring-26-artists|Ana Vermeulen|Marc De Bruyne|Confirm artists" apps/web/src/routes/dev.design-system.tsx
```

Expected: ~15-20 hits across the ShellPreview, badges/avatars rows, and the right-panel sample content.

- [ ] **Step 2: Replace the ShellPreview mockup data with generic placeholders**

In `apps/web/src/routes/dev.design-system.tsx`, the `ShellPreview` function and the rows that feed badges/avatars/right-panel reference specific Folio domain data. Replace verbatim:

| From | To |
|------|-----|
| `mark: 'F', label: 'Folio'` | `mark: 'A', label: 'App'` |
| `mark: 'G', name: 'Galerie Sint-Jan'` | `mark: 'W', name: 'Default workspace'` |
| `'Switch workspace clicked.'` | `'Switch workspace clicked.'` (unchanged — generic) |
| `title="Exhibitions"` | `title="Items"` |
| `subMeta="galerie-sint-jan / exhibitions · 14 work items"` | `subMeta="workspace / project · 0 items"` |
| `<FrameTab active>All work items</FrameTab>` | `<FrameTab active>All</FrameTab>` |
| `<FrameTab>Up next</FrameTab>` | `<FrameTab>Recent</FrameTab>` |
| `'Stefan Vermaercke'` (in user prop) | `'You'` |
| `'Confirm artists for Spring '26 group show'` | `'Sample item title'` |
| `'work_item · spring-26-artists'` | `'item · sample-slug'` |
| Avatar names `Stefan Vermaercke`, `Ana Vermeulen`, `Marc De Bruyne` | Keep these — they exercise the deterministic-tone hash with three distinct names. |
| Badge label words `'curation', 'deadline', 'research', 'logistics', 'press'` | Keep — they're abstract enough and demonstrate the labelTone() hash producing four different tones. |
| `'List view content lands in Plan C (Phase 1 frontend).'` | `'Add your first feature here.'` |
| `'For now, primitives render here so designers can review them in context.'` | `'Primitives render in context so you can review the visual system without writing any feature code first.'` |
| `'Right panel content lands in Plan C. For now it shows the locked tab chrome.'` | `'Right panel content goes here. The chrome is locked in via tokens.'` |

- [ ] **Step 3: Verify no Folio-flavored strings remain**

```bash
grep -nE "Galerie|sint-jan|Spring '26|Confirm artists|Plan C|Phase 1|spring-26-artists|exhibitions" apps/web/src/routes/dev.design-system.tsx
```

Expected: no output.

- [ ] **Step 4: Build to confirm typecheck still clean**

```bash
cd apps/web && bun run build 2>&1 | tail -5; cd ../..
```

Expected: builds cleanly, ~258 modules.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dev.design-system.tsx
git commit -m "feat(web): generic ShellPreview mockup data in design-system catalog"
```

---

## Task 9: Rename `FOLIO_MASTER_KEY` env var to a generic name

The env var is referenced in `apps/server/src/env.ts`, `apps/server/src/lib/crypto.ts`, the Dockerfile, `docs/INSTALL.md` (if present), and the CLAUDE.md/README. The starter should ship with a generic key name that the user renames again on first use.

**Decision:** rename to `APP_MASTER_KEY`. It's neutral, matches the rest of the env-var convention in env.ts, and clearly signals "you should rename this".

**Files:**
- Modify: `apps/server/src/env.ts`
- Modify: `apps/server/src/lib/crypto.ts`
- Modify: `docker/Dockerfile`
- Modify: `docs/INSTALL.md` (if it references the var)
- Modify: any other file that references `FOLIO_MASTER_KEY`

- [ ] **Step 1: Find every reference**

```bash
grep -rn "FOLIO_MASTER_KEY" --include="*.ts" --include="*.md" --include="Dockerfile" --include="*.tsx" --include="*.json"
```

Expected: ~5-10 matches across env.ts, crypto.ts, Dockerfile, CLAUDE.md, INSTALL.md (if present), and possibly the env var schema in env.ts.

- [ ] **Step 2: Replace every occurrence**

```bash
grep -rl "FOLIO_MASTER_KEY" --include="*.ts" --include="*.md" --include="Dockerfile" --include="*.tsx" --include="*.json" | xargs sed -i 's/FOLIO_MASTER_KEY/APP_MASTER_KEY/g'
```

- [ ] **Step 3: Verify**

```bash
grep -rn "FOLIO_MASTER_KEY" 2>/dev/null
grep -rn "APP_MASTER_KEY" 2>/dev/null | head -10
```

Expected: first grep empty, second grep shows the renamed references.

- [ ] **Step 4: Typecheck**

```bash
cd apps/server && bunx tsc --noEmit && cd ../..
```

Expected: clean.

- [ ] **Step 5: Run the server briefly to confirm env validation still works**

```bash
cd apps/server && SESSION_SECRET=$(printf 'a%.0s' {1..40}) APP_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./folio.db NODE_ENV=development PORT=3099 timeout 3 bun run src/index.ts 2>&1 | head -5; cd ../..
```

Expected: `[folio] listening on http://localhost:3099` prints (the brand string still says "folio" — fixed in Task 10).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: rename FOLIO_MASTER_KEY env var to APP_MASTER_KEY"
```

---

## Task 10: Rename workspace packages from `@folio/*` to `@app/*`

The starter uses `@app/server`, `@app/web`, `@app/shared` as workspace package names. Generic, not lockstep with Folio.

**Files:**
- Modify: `apps/server/package.json` — `name` field
- Modify: `apps/web/package.json` — `name` field + any `@folio/shared` dependency reference
- Modify: `packages/shared/package.json` — `name` field
- Modify: `package.json` (root) — `name` field + any `--filter` script references
- Modify: any TypeScript files that `import` from `@folio/shared`

- [ ] **Step 1: Find every reference**

```bash
grep -rn "@folio/" --include="*.json" --include="*.ts" --include="*.tsx" --include="*.md"
```

Expected: hits in the three app/package.json files, the root package.json (under scripts like `bun run --filter @folio/server db:generate`), and possibly in import lines in TS files.

- [ ] **Step 2: Replace via sed**

```bash
grep -rl "@folio/" --include="*.json" --include="*.ts" --include="*.tsx" --include="*.md" | xargs sed -i 's|@folio/|@app/|g'
```

- [ ] **Step 3: Verify**

```bash
grep -rn "@folio/" 2>/dev/null
```

Expected: no output.

- [ ] **Step 4: Reinstall deps so Bun re-resolves workspace links under the new names**

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules bun.lock
bun install 2>&1 | tail -5
```

Expected: clean install, no resolution errors.

- [ ] **Step 5: Typecheck both apps**

```bash
cd apps/server && bunx tsc --noEmit && cd ../..
cd apps/web && bunx tsc --noEmit && cd ../..
```

Expected: both exit 0 clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: rename workspace packages from @folio/* to @app/*"
```

---

## Task 11: Rename localStorage keys from `folio:*` to `app:*`

Two keys: `folio:theme` and `folio:rail-collapsed`. These are namespaced to the product; the starter should use a generic prefix.

**Decision:** rename to `app:theme` and `app:rail-collapsed`. (Users will likely customize again — this is a starter, not a final product.)

**Files:**
- Modify: `apps/web/src/lib/theme.ts` — `STORAGE_KEY`
- Modify: `apps/web/src/lib/theme.test.ts` — `STORAGE_KEY` constant
- Modify: `apps/web/index.html` — inline bootstrap script reads `folio:theme`
- Modify: `apps/web/src/components/shell/rail.tsx` — `STORAGE_KEY`

- [ ] **Step 1: Find every reference**

```bash
grep -rn "folio:theme\|folio:rail-collapsed" --include="*.ts" --include="*.tsx" --include="*.html"
```

Expected: 4-5 hits.

- [ ] **Step 2: Replace**

```bash
grep -rl "folio:theme\|folio:rail-collapsed" --include="*.ts" --include="*.tsx" --include="*.html" | xargs sed -i -e 's|folio:theme|app:theme|g' -e 's|folio:rail-collapsed|app:rail-collapsed|g'
```

- [ ] **Step 3: Verify**

```bash
grep -rn "folio:theme\|folio:rail-collapsed" 2>/dev/null
grep -rn "'app:theme'\|'app:rail-collapsed'" --include="*.ts" --include="*.tsx" --include="*.html"
```

Expected: first grep empty, second grep shows ~5 hits.

- [ ] **Step 4: Run the theme test to confirm renaming didn't break anything**

```bash
cd apps/web && bun test src/lib/theme.test.ts; cd ../..
```

Expected: `5 pass, 0 fail`.

- [ ] **Step 5: Build to verify the HTML bootstrap still wires correctly**

```bash
cd apps/web && bun run build 2>&1 | tail -8; cd ../..
```

Expected: clean build. Verify dist/index.html shows `app:theme`:

```bash
grep "app:theme" apps/web/dist/index.html
```

Expected: one match in the inline bootstrap script.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: rename localStorage keys from folio:* to app:*"
```

---

## Task 11b: Rename `apps/server/folio.db` default DB filename to `app.db`

The default DATABASE_URL in env.ts (or its fallback in drizzle.config.ts) likely points at `folio.db`. Switch to `app.db` so the starter doesn't ship with a Folio-branded filename.

**Files:**
- Modify: `apps/server/src/env.ts` (or wherever DATABASE_URL's default lives — search to confirm)
- Modify: `apps/server/drizzle.config.ts` (default URL fallback)
- Modify: `.gitignore` — `folio.db*` entries → `app.db*`

- [ ] **Step 1: Find every reference**

```bash
grep -rn "folio\.db" --include="*.ts" --include="*.json" --include=".gitignore" --include="Dockerfile" --include="*.md"
```

- [ ] **Step 2: Replace**

```bash
grep -rl "folio\.db" --include="*.ts" --include="*.json" --include="Dockerfile" --include="*.md" | xargs sed -i 's|folio\.db|app.db|g'
sed -i 's|folio\.db|app.db|g' .gitignore
```

- [ ] **Step 3: Verify**

```bash
grep -rn "folio\.db" 2>/dev/null
```

Expected: no output.

- [ ] **Step 4: Reapply migrations to a fresh DB at the new path to confirm**

```bash
cd apps/server && rm -f folio.db app.db && SESSION_SECRET=$(printf 'a%.0s' {1..40}) APP_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./app.db bun run db:migrate 2>&1 | tail -3 && ls *.db; cd ../..
```

Expected: `Migrations complete.` and `app.db` exists.

- [ ] **Step 5: Clean up dev DB and commit**

```bash
rm -f apps/server/app.db apps/server/app.db-shm apps/server/app.db-wal
git add -A
git commit -m "chore: rename default DB filename from folio.db to app.db"
```

---

## Task 12: Rename the log brand string in server startup

`apps/server/src/index.ts` logs `[folio] listening on http://localhost:${env.PORT}`. The starter should log a generic `[app]` brand.

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Read current**

```bash
cat apps/server/src/index.ts
```

- [ ] **Step 2: Replace `[folio]` with `[app]`**

```bash
sed -i 's|\[folio\]|[app]|g' apps/server/src/index.ts
```

- [ ] **Step 3: Verify**

```bash
grep "\\[app\\]" apps/server/src/index.ts
```

Expected: one match in the console.log.

- [ ] **Step 4: Run briefly to confirm**

```bash
cd apps/server && SESSION_SECRET=$(printf 'a%.0s' {1..40}) APP_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./app.db NODE_ENV=development PORT=3099 timeout 3 bun run src/index.ts 2>&1 | head -3; cd ../..
```

Expected: `[app] listening on http://localhost:3099`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "chore: rename log brand from [folio] to [app]"
```

---

## Task 13: Rewrite `CLAUDE.md` for the starter

Folio's `CLAUDE.md` is product-specific: it describes Folio's wedge, the markdown-native value proposition, the document/page distinction. None of that is generic.

Write a fresh `CLAUDE.md` for the starter that documents the foundation only: tech stack, repo layout, architectural rules, conventions, build commands. Drop the product-positioning sections entirely.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the current Folio CLAUDE.md to see what to keep**

```bash
wc -l CLAUDE.md
head -30 CLAUDE.md
```

- [ ] **Step 2: Write the starter's CLAUDE.md**

Replace the entire file contents with:

```markdown
# CLAUDE.md — App Starter

You are working in a starter scaffold extracted from Folio. The foundation is opinionated; the product on top is up to you. Read this file at the start of every session.

---

## What This Is

A starter for self-hosted, agent-friendly single-binary apps. Bun + Hono + Drizzle + SQLite on the backend; React + Vite + TanStack Router with a polished design system on the frontend. Auth, multi-tenant workspaces, BYOK AI keys, and scoped API tokens are all wired and ready to use. Add your domain layer on top.

## Tech Stack (Locked — Do Not Re-Litigate)

| Layer | Choice |
|-------|--------|
| Runtime | Bun (latest stable) |
| Backend | Hono |
| ORM | Drizzle |
| DB | SQLite (Postgres-compatible later via env toggle) |
| Frontend | React + Vite + TanStack Router |
| Styling | Tailwind 3 + semantic tokens via CSS variables |
| Primitives | Bespoke (Button, IconButton, Pill, Badge, Chip, Avatar, Kbd) + Radix (Dialog, Sheet, Popover) + cmdk + Sonner |
| Tests | Bun test (unit), Playwright (e2e, when needed) |
| Lint/format | Biome |
| Auth | Hand-rolled session auth + magic links |
| Encryption | libsodium (for BYOK AI keys) |
| License | (set per project) |

## Architectural Rules (Non-Negotiable)

1. **One binary.** `bun build --compile` produces a single executable that serves the API + static React bundle. A working install = `./app` + a SQLite file + a reverse proxy.
2. **No sidecar services.** No Redis, no separate worker, no Postgres-required. Use SQLite for queues if needed.
3. **Every write should emit an event.** The `events` table + SSE channel is ready; route handlers should insert into it on mutation. (Pattern, not enforced.)
4. **BYOK only for AI features.** The server never holds a default AI key. Keys are libsodium-encrypted at rest with `APP_MASTER_KEY`.
5. **Self-hostable means installable in one command.** `docker run -v ./data:/data -p 3000:3000 app:latest` or `./app` from the binary. No external services required.

## Repo Layout

\`\`\`
app-starter/
├── apps/
│   ├── server/                 # Hono backend (Bun)
│   └── web/                    # React SPA (Vite)
├── packages/
│   └── shared/                 # Types shared between server + web
├── docker/
│   └── Dockerfile
├── scripts/
│   └── build.ts                # bun compile single binary
├── docs/
│   └── INSTALL.md
├── CLAUDE.md                   # This file
├── package.json                # Workspace root
└── bun.lock
\`\`\`

## Conventions

- **TypeScript everywhere.** `strict: true`. No `any` — use `unknown` and narrow.
- **Naming.** Files `kebab-case.ts`. Types/components `PascalCase`. Functions/vars `camelCase`. DB columns `snake_case`.
- **IDs.** UUIDv7 (time-ordered) via `crypto.randomUUID()` or a uuid7 lib. Stored as `text` in SQLite.
- **Errors.** Throw `HTTPException` from Hono. Server returns `{ error: { code, message } }` (configured by `middleware/error.ts`).
- **Validation.** Zod schemas at API boundaries.
- **Imports.** Absolute via `@/` aliases inside each app.
- **No default exports** except for routers and React route components.
- **Commit messages.** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Atomic commits.

## What's Already Wired

- Users: register, login, logout, /me, magic-link request + consume.
- Workspaces: list, create, membership-on-create.
- API tokens: create, list, revoke, scoped permissions.
- AI keys: encrypted with libsodium per-workspace, never returned in plain.
- Health: `GET /healthz` → `{ ok: true, version: '0.0.1' }`.
- Design system: visit `/dev/design-system` in dev to see every primitive + shell layout.
- Theme: light/dark/system with first-paint bootstrap, no flash.

## What's NOT Wired (Add per project)

- Domain tables. Add to `apps/server/src/db/schema.ts`, then `bun run db:generate && bun run db:migrate`.
- Domain routes. Add files under `apps/server/src/routes/`, mount in `apps/server/src/app.ts`.
- Domain UI. Add files under `apps/web/src/routes/` (file-based routing via TanStack Router).
- Email sending. `lib/email.ts` exists but is a stub — wire it to SMTP/Resend/SES when needed.

## Build & Run

\`\`\`bash
bun install                       # Install all workspace deps
bun dev                           # Run server + Vite dev together
bun --filter=@app/server dev      # Backend only
bun --filter=@app/web dev         # Frontend only
bun --filter=@app/server db:generate   # Generate Drizzle migration from schema diff
bun --filter=@app/server db:migrate    # Apply pending migrations
bun --filter=@app/server db:studio     # Open Drizzle Studio
bun test                          # All unit tests
bun run build                     # Build React → embed → bun compile single binary
docker build -f docker/Dockerfile -t app:dev .
\`\`\`

## First Steps on a New Project

1. Rename `@app/*` workspace packages to `@yourapp/*` (search-replace across `package.json` files and TS imports).
2. Set the brand string in `apps/server/src/index.ts` (`[app] listening on ...` → `[yourapp]`).
3. Customize `apps/web/index.html` `<title>`.
4. Decide on the AI provider: keep BYOK (default) or hard-wire a key.
5. Drop the design-system mockup data in `apps/web/src/routes/dev.design-system.tsx` once you've reviewed it.
6. Update this `CLAUDE.md` to describe what *your* app does — replace the "What This Is" section.
7. Generate a fresh license file appropriate for your project.

## Decisions Already Made — Do Not Re-Litigate

- Stack: see table above.
- Auth: email-password + magic-link. No SSO/OIDC by default.
- Status field: per-project configurable (not hard-coded states) — pattern only, no enforcement.
- AI cost model: BYOK only. Server never holds a default key.
- Multi-tenancy: out of scope for a single instance. Workspaces are inside an instance.
```

- [ ] **Step 3: Verify the file is in place**

```bash
head -5 CLAUDE.md
wc -l CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md for the starter"
```

---

## Task 14: Delete or rewrite Folio-specific docs

Folio carries a fat `docs/` directory: `FOLIO-BRIEFING.md`, `PHASES.md`, `superpowers/specs/...`, `superpowers/plans/...`. None of this is useful in a starter.

**Files:**
- Delete: `docs/FOLIO-BRIEFING.md`
- Delete: `docs/PHASES.md`
- Delete: `docs/superpowers/` (entire directory — brainstorm, specs, plans all Folio-internal)
- Keep: `docs/INSTALL.md` (if it exists; if it references Folio, edit it)
- Keep: `docs/API.md` (if it exists; if it references Folio, edit it)

- [ ] **Step 1: Inventory what's in docs/**

```bash
find docs -type f | sort
```

- [ ] **Step 2: Delete Folio-internal docs**

```bash
rm -f docs/FOLIO-BRIEFING.md docs/PHASES.md
rm -rf docs/superpowers
```

- [ ] **Step 3: Check remaining files for Folio references**

```bash
ls docs/ 2>/dev/null && grep -rln "Folio\|folio" docs/ 2>/dev/null
```

If `INSTALL.md` or `API.md` exists and references Folio, replace those references with "app" or the generic placeholder. Re-grep until empty.

- [ ] **Step 4: Verify**

```bash
grep -rln "Folio\|folio" docs/ 2>/dev/null
ls docs/
```

Expected: first grep returns no output. Second shows a minimal docs/ — maybe just an INSTALL.md, or empty.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: remove Folio-internal docs"
```

---

## Task 15: Scrub remaining `Folio`/`folio` references everywhere

After Tasks 9-14, the obvious places are clean. There may be incidental references in comments, test descriptions, README, or git history (the commit messages already mention Folio in Task 1's commit — leave them; they're a historical signal that the starter forked from Folio).

**Files:** any remaining file that mentions Folio.

- [ ] **Step 1: Find every reference, case-insensitively, excluding generated artifacts**

```bash
grep -rni "folio" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json" --include="*.html" --include="*.css" --include="Dockerfile" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```

- [ ] **Step 2: Decide per-occurrence**

For each hit, decide:
- **Replace with "app"** if the reference describes the product running (e.g., a log message, page title).
- **Replace with "the starter"** if the reference describes this project's identity (e.g., a comment explaining a decision).
- **Leave** if it's in a commit message in git history (which can't be edited anyway in this plan).

Run sed manually per-file as needed. Resist bulk-replacing — case-insensitive sed across the repo will mangle things like the word `Folio` in package-lock entries (if any survive after `bun.lock` regen).

- [ ] **Step 3: Final scrub check**

```bash
grep -rni "folio" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json" --include="*.html" --include="*.css" --include="Dockerfile" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```

Expected: ideally empty, or only intentional references (e.g., a comment "forked from Folio at <date>" as historical context — keep one such marker in `CLAUDE.md` or `README.md`).

- [ ] **Step 4: Commit (only if there were changes)**

```bash
git status
# if dirty:
git add -A && git commit -m "chore: scrub remaining Folio references"
```

---

## Task 16: Add a minimal README to the starter

A starter without a README is unfriendly. One page max — quick start + pointer to CLAUDE.md.

**Files:**
- Create or overwrite: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# App Starter

A starter scaffold for self-hosted, agent-friendly single-binary apps. Forked from [Folio](https://github.com/...) at extraction time and evolves independently.

## What's Included

- **Backend:** Bun + Hono + Drizzle + bun:sqlite. Auth (sessions + magic-link), multi-tenant workspaces, BYOK AI keys, scoped API tokens, audit events.
- **Frontend:** React + Vite + TanStack Router. Self-hosted Geist + Geist Mono, semantic-token design system (light + dark), bespoke primitives + Radix dialogs + cmdk + Sonner.
- **Build:** Single `bun build --compile` produces a `~100MB` standalone binary that serves the API + the React bundle.

## Quick Start

```bash
bun install
cp .env.example .env  # if .env.example exists; otherwise set the four vars below in your shell
# Required env vars:
#   SESSION_SECRET=<32+ char random string>
#   APP_MASTER_KEY=<64 hex chars (32 bytes)>
#   DATABASE_URL=file:./app.db
#   PORT=3000
bun --filter=@app/server db:migrate
bun dev
```

Visit:
- http://localhost:5173 — login page
- http://localhost:5173/dev/design-system — primitive catalog (dev-only)

## Customizing for Your App

See `CLAUDE.md` § First Steps on a New Project.

## License

(set per project)
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Task 17: Add a `.env.example` file

Currently env vars are documented only in `env.ts` and the README. A `.env.example` is the convention; it speeds up first-run.

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Write `.env.example`**

```bash
# Required: session-cookie secret. 32+ chars.
SESSION_SECRET=change-me-to-32-or-more-random-chars

# Required: master key for libsodium encryption of stored AI keys.
# Generate: openssl rand -hex 32
APP_MASTER_KEY=

# Required: SQLite path. Use file:./app.db for local dev.
DATABASE_URL=file:./app.db

# Optional: server port. Default 3000.
PORT=3000

# Optional: NODE_ENV. development | production.
NODE_ENV=development
```

- [ ] **Step 2: Verify `.gitignore` doesn't accidentally ignore `.env.example`**

```bash
git check-ignore -v .env.example
```

Expected: not ignored (exit 1, no output). If it IS ignored, `.gitignore` is using a too-broad `.env*` pattern — narrow it to `.env` and `.env.local` only.

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "docs: add .env.example"
```

---

## Task 18: Final verification — full clean build + tests pass

Goal: prove the starter is in a working state from the perspective of someone who just cloned it.

**Files:** *(none — verification only)*

- [ ] **Step 1: Clean slate**

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules bun.lock apps/web/dist apps/server/dist dist apps/server/app.db apps/server/app.db-shm apps/server/app.db-wal
```

- [ ] **Step 2: Fresh install**

```bash
bun install 2>&1 | tail -5
```

Expected: clean install, ~280 packages.

- [ ] **Step 3: Both apps typecheck**

```bash
cd apps/server && bunx tsc --noEmit && echo "server OK"; cd ../web && bunx tsc --noEmit && echo "web OK"; cd ../..
```

Expected: both print OK, no error output.

- [ ] **Step 4: Migration applies cleanly to an empty DB**

```bash
cd apps/server && SESSION_SECRET=$(printf 'a%.0s' {1..40}) APP_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./app.db bun run db:migrate 2>&1 | tail -3; cd ../..
```

Expected: `Running migrations...` → `Migrations complete.`

- [ ] **Step 5: All unit tests pass**

```bash
bun test 2>&1 | tail -5
```

Expected: 9 pass, 0 fail (cn × 4 + theme × 5 — same as Folio at extraction time).

- [ ] **Step 6: Server starts cleanly**

```bash
cd apps/server && SESSION_SECRET=$(printf 'a%.0s' {1..40}) APP_MASTER_KEY=$(printf 'ab%.0s' {1..32}) DATABASE_URL=file:./app.db NODE_ENV=development PORT=3099 timeout 3 bun run src/index.ts 2>&1 | head -3; cd ../..
```

Expected: `[app] listening on http://localhost:3099`.

- [ ] **Step 7: Web app builds**

```bash
cd apps/web && bun run build 2>&1 | tail -8; cd ../..
```

Expected: clean build, ~258 modules, ~384KB JS / ~19KB CSS.

- [ ] **Step 8: Single binary compiles**

```bash
bun run build:binary 2>&1 | tail -5
ls -la dist/app dist/folio 2>/dev/null
```

Note: the `build:binary` script in `package.json` outputs to `dist/folio` per Folio's setup. After Task 9-12's renames, decide whether the binary path should also rename. If so, edit the script:

```bash
sed -i 's|--outfile dist/folio|--outfile dist/app|g' package.json
bun run build:binary
ls -la dist/app
```

Expected: `dist/app` is ~100MB ELF.

- [ ] **Step 9: Clean up build artifacts before final commit (they're gitignored, but tidy)**

```bash
rm -rf dist apps/web/dist apps/server/dist apps/server/app.db apps/server/app.db-shm apps/server/app.db-wal
```

- [ ] **Step 10: Final commit if step 8's sed renamed the binary path**

```bash
git status
# if dirty:
git add package.json && git commit -m "chore: rename binary output path from dist/folio to dist/app"
```

---

## Task 19: Push to a private remote

The starter is private. Push to GitHub/GitLab/Gitea under whichever org you use for client work.

**Files:** *(none — git operation)*

- [ ] **Step 1: Choose remote URL**

User decides: `git@github.com:netdust-be/app-starter.git` or similar. Plan placeholder: `<YOUR-PRIVATE-REMOTE-URL>`.

- [ ] **Step 2: Create the empty remote repo** via GitHub UI / `gh repo create --private` / GitLab UI. Don't initialize with README, .gitignore, or license — those exist locally.

- [ ] **Step 3: Add remote and push**

```bash
cd ~/Projects/netdust-starter
git remote add origin <YOUR-PRIVATE-REMOTE-URL>
git push -u origin main
```

Expected: every commit from the extraction pushes to `origin/main`. Pushing requires user confirmation since it's a network operation visible to others (per global working rules § "Executing actions with care").

---

## Task 20: Document the extraction back in Folio's resume notes

The Folio repo should record that the starter exists, where it lives, and that future starter changes are independent (fork-and-forget).

**Files:**
- Modify: `~/.claude/projects/-home-ntdst-Projects-folio/memory/MEMORY.md`
- Create: `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_starter-extraction.md`

- [ ] **Step 1: Write the starter-extraction memory file**

```markdown
---
name: Netdust starter extracted from Folio
description: Folio's foundation extracted to a separate private starter repo on 2026-05-XX. Fork-and-forget — no upstream sync.
type: project
---

The starter lives at `~/Projects/netdust-starter/` and pushes to `<remote-url>`. It snapshotted from Folio commit `88f1abf` (Phase 0.5 complete). Future Folio work does NOT propagate to the starter; future starter improvements do NOT propagate to Folio. They evolve independently.

**Why:** User picked fork-and-forget over living-parent rebases or generator CLI — simpler, matches how most starters work.

**How to apply:** When starting a new project from the starter:
1. `git clone <remote-url> ~/Projects/<new-app-name>`
2. Remove the `origin` remote and re-point.
3. Search-replace `@app/*` → `@<new-app-name>/*` across `package.json` + TS imports.
4. Edit `[app]` log brand in `apps/server/src/index.ts`.
5. Update `<title>` in `apps/web/index.html`.
6. Rewrite the "What This Is" section in `CLAUDE.md`.
7. Drop or refresh the design-system mockup data in `apps/web/src/routes/dev.design-system.tsx`.
8. Set a license.

**What changed vs Folio:** dropped `documents`/`statuses`/`fields`/`views` tables + `routes/stubs.ts` + `lib/frontmatter.ts` + shared document types. Renamed `FOLIO_MASTER_KEY` → `APP_MASTER_KEY`, `@folio/*` → `@app/*`, `folio:theme` → `app:theme`, `folio:rail-collapsed` → `app:rail-collapsed`, `[folio]` log → `[app]`, `folio.db` → `app.db`, `dist/folio` → `dist/app`. Replaced CLAUDE.md, README, and docs with starter-flavored versions.
```

- [ ] **Step 2: Add a one-line pointer in MEMORY.md**

Append to MEMORY.md:

```markdown
- [Starter extracted from Folio](project_starter-extraction.md) — Foundation lives independently at ~/Projects/netdust-starter; fork-and-forget.
```

- [ ] **Step 3: Commit Folio's memory store**

Memory files live outside the Folio repo (under `~/.claude/`), so no Folio-repo commit happens for this step. The user's global memory tooling handles persistence.

---

## Plan complete

After Task 20, the project state is:
- `~/Projects/netdust-starter/` exists as a self-contained private repo on `main`.
- Snapshot is from Folio `88f1abf` minus the document-centric domain layer.
- All Folio-specific strings have been parameterized to generic `app`/`@app` placeholders.
- README, `.env.example`, and a rewritten `CLAUDE.md` ship with the starter.
- A single binary compiles, all 9 tests pass, both apps typecheck and build.
- Folio's auto-memory records the extraction so future sessions know the starter exists.

Folio itself is unchanged on disk (the only edits in this plan are to the starter repo).
