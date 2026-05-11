# Phase 1 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the REST API for Folio Core CRUD — documents, statuses, fields, views, plus the slug-scoped workspaces/projects refactor.

**Architecture:** Resource-per-file Hono routers mounted under `/api/v1/`. Scope resolution (`:wslug` → workspace, `:pslug` → project) happens once in `middleware/scope.ts`; handlers stay short. Every write goes through `lib/events.ts` inside a DB transaction so the `events` table is populated for the Phase 2 SSE channel. Pure logic (field-type inference, filter compilation, slugify) lives in `packages/shared` so the frontend can reuse it later. TDD per route via `bun test` with `:memory:` SQLite.

**Tech Stack:** Bun, Hono, Drizzle, SQLite (`bun:sqlite`), Zod, `@hono/zod-validator`, yaml, nanoid.

**Spec:** `docs/superpowers/specs/2026-05-11-phase-1-backend-design.md` — read it once before starting Task 1.

---

## Prep — Conventions for every task

1. Run from repo root: `/home/ntdst/Projects/folio`. All commands assume that cwd unless prefixed otherwise.
2. After every step that changes code, run only the tests relevant to that step. Run the whole suite at acceptance checkpoints (called out in tasks).
3. Each task ends with a commit. Commit message format: `phase-1: <what>`.
4. The active branch is `phase-1/backend`. Stay on it.
5. The plan assumes the `documents` table exists (it does — migration `0000_cool_katie_power.sql` ran in Phase 0.5). Verify with `ls apps/server/src/db/migrations` before Task 1.

---

## Task 1: Test harness + workspace test script

**Files:**
- Create: `apps/server/src/test/harness.ts`
- Modify: `package.json` (workspace root)
- Test: `apps/server/src/test/harness.test.ts`

- [ ] **Step 1: Confirm `bun test` runs against an empty file**

```bash
mkdir -p apps/server/src/test
cat > apps/server/src/test/sanity.test.ts <<'EOF'
import { test, expect } from 'bun:test';
test('bun test runs', () => { expect(1 + 1).toBe(2); });
EOF
cd apps/server && bun test src/test/sanity.test.ts && cd ..
rm apps/server/src/test/sanity.test.ts
```

Expected: 1 pass.

- [ ] **Step 2: Add root-level `test` script**

Edit `package.json` (repo root). Add to `"scripts"`:

```json
"test": "bun test"
```

Verify: `cat package.json | grep '"test"'` shows the new line.

- [ ] **Step 3: Write the failing harness test**

Create `apps/server/src/test/harness.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from './harness.ts';

test('makeTestApp returns a working app + seeded data', async () => {
  const { app, seed } = await makeTestApp();
  expect(seed.user.email).toBe('alice@test.local');
  expect(seed.workspace.slug).toBe('acme');
  expect(seed.project.slug).toBe('web');
  expect(seed.sessionCookie).toMatch(/^folio_session=/);

  // Cookie auth round-trips
  const res = await app.request('/api/v1/auth/me', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/server && bun test src/test/harness.test.ts`
Expected: FAIL with `Cannot find module './harness.ts'`.

- [ ] **Step 5: Implement harness**

Create `apps/server/src/test/harness.ts`:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { nanoid } from 'nanoid';
import { Hono } from 'hono';
import * as schema from '../db/schema.ts';
import { hashPassword, createSession } from '../lib/auth.ts';

export interface TestSeed {
  user: schema.User;
  workspace: schema.Workspace;
  project: schema.Project;
  sessionCookie: string;
}

export async function makeTestApp(): Promise<{
  app: Hono;
  db: ReturnType<typeof drizzle>;
  seed: TestSeed;
}> {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './apps/server/src/db/migrations' });

  // Swap the module-level db with our test db.
  // Done via a global override that client.ts checks (Step 6).
  (globalThis as Record<string, unknown>).__folioTestDb = db;

  const { app } = await import('../app.ts');

  // Seed
  const userId = nanoid();
  const passwordHash = await hashPassword('password123');
  await db.insert(schema.users).values({
    id: userId,
    email: 'alice@test.local',
    name: 'Alice',
    passwordHash,
  });

  const workspaceId = nanoid();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    slug: 'acme',
    name: 'Acme',
  });
  await db.insert(schema.memberships).values({
    workspaceId,
    userId,
    role: 'owner',
  });

  const projectId = nanoid();
  await db.insert(schema.projects).values({
    id: projectId,
    workspaceId,
    slug: 'web',
    name: 'Web',
  });

  const sessionId = await createSession(userId);

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));

  return {
    app,
    db,
    seed: {
      user: user!,
      workspace: workspace!,
      project: project!,
      sessionCookie: `folio_session=${sessionId}`,
    },
  };
}

// Local import alias to avoid pulling drizzle-orm/expressions at top level.
import { eq } from 'drizzle-orm';
```

- [ ] **Step 6: Make db/client.ts honor the test override**

Edit `apps/server/src/db/client.ts`. Replace the file with:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { env } from '../env.ts';
import * as schema from './schema.ts';

function realDb() {
  const sqlitePath = env.DATABASE_URL.replace(/^file:/, '');
  const sqlite = new Database(sqlitePath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
  return drizzle(sqlite, { schema });
}

const override = (globalThis as Record<string, unknown>).__folioTestDb as
  | ReturnType<typeof drizzle>
  | undefined;

export const db = override ?? realDb();
export { schema };
export type DB = typeof db;
```

- [ ] **Step 7: Run harness test to verify it passes**

Run: `cd apps/server && bun test src/test/harness.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/test/harness.ts apps/server/src/test/harness.test.ts \
        apps/server/src/db/client.ts package.json
git commit -m "phase-1: test harness with :memory: SQLite + cookie auth"
```

---

## Task 2: Shared pure modules — slug, error-codes, document-schema

**Files:**
- Create: `packages/shared/src/slug.ts`
- Create: `packages/shared/src/error-codes.ts`
- Create: `packages/shared/src/document-schema.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `apps/server/src/lib/slugify.ts`
- Test: `packages/shared/src/slug.test.ts`

- [ ] **Step 1: Write the failing slug test**

Create `packages/shared/src/slug.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { slugify } from './slug.ts';

test('lowercases and replaces spaces with hyphens', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});

test('strips diacritics', () => {
  expect(slugify('Café déjà-vu')).toBe('cafe-deja-vu');
});

test('collapses non-alphanumeric runs', () => {
  expect(slugify('foo!!  bar??')).toBe('foo-bar');
});

test('trims leading/trailing hyphens', () => {
  expect(slugify('---foo---')).toBe('foo');
});

test('caps at 64 chars', () => {
  expect(slugify('a'.repeat(100)).length).toBe(64);
});

test('empty input returns empty string', () => {
  expect(slugify('')).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test`
Expected: FAIL with `Cannot find module './slug.ts'`.

- [ ] **Step 3: Implement slug.ts**

Create `packages/shared/src/slug.ts`:

```ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
```

- [ ] **Step 4: Run slug tests to verify they pass**

Run: `cd packages/shared && bun test src/slug.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Add error-codes.ts**

Create `packages/shared/src/error-codes.ts`:

```ts
export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  STATUS_NOT_FOUND: 'STATUS_NOT_FOUND',
  FIELD_NOT_FOUND: 'FIELD_NOT_FOUND',
  VIEW_NOT_FOUND: 'VIEW_NOT_FOUND',
  SLUG_CONFLICT: 'SLUG_CONFLICT',
  STATUS_IN_USE: 'STATUS_IN_USE',
  INVALID_BODY: 'INVALID_BODY',
  INVALID_FILTER: 'INVALID_FILTER',
  INVALID_STATUS: 'INVALID_STATUS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

- [ ] **Step 6: Add document-schema.ts**

Create `packages/shared/src/document-schema.ts`:

```ts
import { z } from 'zod';

export const documentTypeEnum = z.enum(['work_item', 'page']);

export const documentCreateSchema = z.object({
  type: documentTypeEnum,
  title: z.string().min(1).max(500),
  body: z.string().default(''),
  frontmatter: z.record(z.unknown()).default({}),
  parentId: z.string().nullable().optional(),
});

export const documentPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: z.string().nullable().optional(),
  body: z.string().optional(),
  frontmatter: z.record(z.unknown()).optional(),
  parentId: z.string().nullable().optional(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
export type DocumentPatchInput = z.infer<typeof documentPatchSchema>;
```

- [ ] **Step 7: Extend FieldType + export new modules from index.ts**

Replace `packages/shared/src/index.ts` with:

```ts
export type DocumentType = 'work_item' | 'page';
export type ViewType = 'list' | 'kanban';
export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user_ref'
  | 'url'
  | 'document_ref';

export interface DocumentSummary {
  id: string;
  projectId: string;
  type: DocumentType;
  slug: string;
  title: string;
  status: string | null;
  frontmatter: Record<string, unknown>;
  updatedAt: number;
}

export { slugify } from './slug.ts';
export { ErrorCode, type ErrorCode as ErrorCodeType } from './error-codes.ts';
export * from './document-schema.ts';
```

Note: the existing `inferFieldType()` function is removed here; the full version arrives in Task 3.

- [ ] **Step 8: Delete server-side slugify**

```bash
rm apps/server/src/lib/slugify.ts
```

Update existing import in `apps/server/src/routes/workspaces.ts`. Change:
```ts
import { slugify } from '../lib/slugify.ts';
```
to:
```ts
import { slugify } from '@folio/shared';
```

Verify: `grep -r "lib/slugify" apps/server/src` returns nothing.

- [ ] **Step 9: Run all shared + server tests**

Run: `bun test`
Expected: All pass. Slug tests + harness test green; no regressions in existing auth/settings tests if they exist.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/slug.ts packages/shared/src/slug.test.ts \
        packages/shared/src/error-codes.ts packages/shared/src/document-schema.ts \
        packages/shared/src/index.ts apps/server/src/routes/workspaces.ts
git rm apps/server/src/lib/slugify.ts
git commit -m "phase-1: shared slug, error-codes, document-schema"
```

---

## Task 3: Shared `field-infer.ts`

**Files:**
- Create: `packages/shared/src/field-infer.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/field-infer.test.ts`

- [ ] **Step 1: Write the failing tests covering all 10 rules**

Create `packages/shared/src/field-infer.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { inferFieldType } from './field-infer.ts';

test('boolean true', () => { expect(inferFieldType(true)).toBe('boolean'); });
test('boolean false', () => { expect(inferFieldType(false)).toBe('boolean'); });

test('datetime ISO', () => {
  expect(inferFieldType('2026-05-11T14:30:00Z')).toBe('datetime');
  expect(inferFieldType('2026-05-11T14:30:00+02:00')).toBe('datetime');
});

test('date ISO', () => { expect(inferFieldType('2026-05-11')).toBe('date'); });

test('number', () => {
  expect(inferFieldType(42)).toBe('number');
  expect(inferFieldType(3.14)).toBe('number');
});

test('multi_select for string array', () => {
  expect(inferFieldType(['a', 'b'])).toBe('multi_select');
});

test('user_ref needs context match', () => {
  const ctx = { knownEmails: new Set(['x@y.com']) };
  expect(inferFieldType('x@y.com', ctx)).toBe('user_ref');
});

test('email without context falls through to string', () => {
  expect(inferFieldType('x@y.com')).toBe('string');
});

test('url http/https/mailto', () => {
  expect(inferFieldType('https://example.com')).toBe('url');
  expect(inferFieldType('mailto:x@y.com')).toBe('url');
});

test('document_ref wiki-link syntax', () => {
  expect(inferFieldType('[[some-doc]]')).toBe('document_ref');
});

test('text for multi-line string', () => {
  expect(inferFieldType('line one\nline two')).toBe('text');
});

test('string fallback', () => {
  expect(inferFieldType('plain')).toBe('string');
});

test('order: boolean wins over number for false', () => {
  expect(inferFieldType(false)).toBe('boolean');
});

test('order: datetime beats date when both could match', () => {
  expect(inferFieldType('2026-05-11T00:00:00Z')).toBe('datetime');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/field-infer.test.ts`
Expected: FAIL with `Cannot find module './field-infer.ts'`.

- [ ] **Step 3: Implement field-infer.ts**

Create `packages/shared/src/field-infer.ts`:

```ts
import type { FieldType } from './index.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/;
const DOCUMENT_REF_RE = /^\[\[[\w-]+\]\]$/;

export interface InferContext {
  knownEmails?: Set<string>;
  knownSlugs?: Set<string>;
}

export function inferFieldType(value: unknown, ctx: InferContext = {}): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return 'multi_select';
    return 'string';
  }
  if (typeof value !== 'string') return 'string';

  if (DATETIME_RE.test(value)) return 'datetime';
  if (DATE_RE.test(value)) return 'date';
  if (EMAIL_RE.test(value) && ctx.knownEmails?.has(value)) return 'user_ref';
  if (/^(https?:\/\/|mailto:)/.test(value)) return 'url';
  if (DOCUMENT_REF_RE.test(value)) return 'document_ref';
  if (value.includes('\n')) return 'text';
  return 'string';
}
```

- [ ] **Step 4: Re-export from index.ts**

Append to `packages/shared/src/index.ts`:

```ts
export { inferFieldType, type InferContext } from './field-infer.ts';
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/shared/src/field-infer.test.ts`
Expected: 14 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/field-infer.ts packages/shared/src/field-infer.test.ts \
        packages/shared/src/index.ts
git commit -m "phase-1: shared field-infer per briefing §7"
```

---

## Task 4: Shared `filter-compile.ts`

**Files:**
- Create: `packages/shared/src/filter-compile.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/filter-compile.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/filter-compile.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { filterCompile, FilterCompileError } from './filter-compile.ts';

test('scalar shorthand becomes $eq', () => {
  const ast = filterCompile({ status: 'todo' });
  expect(ast).toEqual({
    kind: 'and',
    clauses: [{ kind: 'cmp', key: 'status', op: '$eq', value: 'todo' }],
  });
});

test('$in operator', () => {
  const ast = filterCompile({ status: { $in: ['todo', 'done'] } });
  expect(ast.clauses[0]).toEqual({
    kind: 'cmp', key: 'status', op: '$in', value: ['todo', 'done'],
  });
});

test('multiple keys are AND-combined', () => {
  const ast = filterCompile({ status: 'todo', type: 'work_item' });
  expect(ast.clauses).toHaveLength(2);
});

test('$exists boolean', () => {
  const ast = filterCompile({ priority: { $exists: true } });
  expect(ast.clauses[0]).toEqual({
    kind: 'cmp', key: 'priority', op: '$exists', value: true,
  });
});

test('comparators $gt $gte $lt $lte $ne', () => {
  for (const op of ['$gt', '$gte', '$lt', '$lte', '$ne'] as const) {
    const ast = filterCompile({ count: { [op]: 5 } });
    expect(ast.clauses[0]).toEqual({ kind: 'cmp', key: 'count', op, value: 5 });
  }
});

test('throws on unknown operator', () => {
  expect(() => filterCompile({ x: { $bogus: 1 } as never })).toThrow(FilterCompileError);
});

test('throws on $in with non-array', () => {
  expect(() => filterCompile({ x: { $in: 'nope' as never } })).toThrow(FilterCompileError);
});

test('empty filter returns empty AND', () => {
  expect(filterCompile({})).toEqual({ kind: 'and', clauses: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/filter-compile.test.ts`
Expected: FAIL with `Cannot find module './filter-compile.ts'`.

- [ ] **Step 3: Implement filter-compile.ts**

Create `packages/shared/src/filter-compile.ts`:

```ts
export type Operator = '$eq' | '$ne' | '$in' | '$nin' | '$gt' | '$gte' | '$lt' | '$lte' | '$exists';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type FilterAST =
  | { kind: 'and'; clauses: FilterAST[] }
  | { kind: 'cmp'; key: string; op: Operator; value: JsonValue };

export type FilterInput = Record<string, JsonValue | Partial<Record<Operator, JsonValue>>>;

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterCompileError';
  }
}

const OPERATORS = new Set<Operator>([
  '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function filterCompile(input: FilterInput): FilterAST {
  const clauses: FilterAST[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (raw === null || !isPlainObject(raw)) {
      clauses.push({ kind: 'cmp', key, op: '$eq', value: raw as JsonValue });
      continue;
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) {
      throw new FilterCompileError(`empty operator object for key "${key}"`);
    }
    for (const [opKey, value] of entries) {
      if (!OPERATORS.has(opKey as Operator)) {
        throw new FilterCompileError(`unknown operator "${opKey}" for key "${key}"`);
      }
      const op = opKey as Operator;
      if ((op === '$in' || op === '$nin') && !Array.isArray(value)) {
        throw new FilterCompileError(`${op} requires an array for key "${key}"`);
      }
      if (op === '$exists' && typeof value !== 'boolean') {
        throw new FilterCompileError(`$exists requires a boolean for key "${key}"`);
      }
      clauses.push({ kind: 'cmp', key, op, value: value as JsonValue });
    }
  }
  return { kind: 'and', clauses };
}
```

- [ ] **Step 4: Re-export from index.ts**

Append to `packages/shared/src/index.ts`:

```ts
export {
  filterCompile,
  FilterCompileError,
  type FilterAST,
  type FilterInput,
  type Operator,
} from './filter-compile.ts';
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/shared/src/filter-compile.test.ts`
Expected: 12 pass (8 cases + 5 sub-cases in the $gt loop).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/filter-compile.ts packages/shared/src/filter-compile.test.ts \
        packages/shared/src/index.ts
git commit -m "phase-1: shared filter-compile (AND-only operators v1)"
```

---

## Task 5: HTTP envelope helpers

**Files:**
- Create: `apps/server/src/lib/http.ts`
- Test: `apps/server/src/lib/http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/http.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { jsonOk, jsonError, HTTPError, registerErrorHandler } from './http.ts';

test('jsonOk wraps in { data }', async () => {
  const app = new Hono();
  app.get('/x', (c) => jsonOk(c, { hello: 'world' }));
  const res = await app.request('/x');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { hello: 'world' } });
});

test('jsonError wraps in { error: { code, message } }', async () => {
  const app = new Hono();
  app.get('/x', (c) => jsonError(c, 'NOT_FOUND', 'nope', 404));
  const res = await app.request('/x');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'nope' } });
});

test('HTTPError thrown inside handler is rendered by registered error handler', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.get('/x', () => { throw new HTTPError('SLUG_CONFLICT', 'taken', 409); });
  const res = await app.request('/x');
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: { code: 'SLUG_CONFLICT', message: 'taken' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/http.test.ts`
Expected: FAIL with `Cannot find module './http.ts'`.

- [ ] **Step 3: Implement http.ts**

Create `apps/server/src/lib/http.ts`:

```ts
import type { Context, Hono } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';

export class HTTPError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: StatusCode,
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

export function jsonOk<T>(c: Context, data: T, status: StatusCode = 200) {
  return c.json({ data }, status);
}

export function jsonError(
  c: Context,
  code: string,
  message: string,
  status: StatusCode,
) {
  return c.json({ error: { code, message } }, status);
}

export function registerErrorHandler(app: Hono) {
  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      return jsonError(c, err.code, err.message, err.status);
    }
    console.error('[unhandled]', err);
    return jsonError(c, 'INTERNAL', 'internal error', 500);
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/lib/http.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/http.ts apps/server/src/lib/http.test.ts
git commit -m "phase-1: http envelope helpers + HTTPError"
```

---

## Task 6: Events emission helper

**Files:**
- Create: `apps/server/src/lib/events.ts`
- Test: `apps/server/src/lib/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/events.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events } from '../db/schema.ts';
import { emitEvent } from './events.ts';

test('emitEvent inserts row with correct fields', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    kind: 'document.created',
    actor: seed.user.id,
    payload: { slug: 'abc' },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('document.created');
  expect(rows[0]!.actor).toBe(seed.user.id);
  expect(rows[0]!.payload).toEqual({ slug: 'abc' });
});

test('emitEvent works inside a transaction', async () => {
  const { db, seed } = await makeTestApp();
  await db.transaction(async (tx) => {
    await emitEvent(tx, {
      workspaceId: seed.workspace.id,
      kind: 'workspace.updated',
      actor: seed.user.id,
    });
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/events.test.ts`
Expected: FAIL with `Cannot find module './events.ts'`.

- [ ] **Step 3: Implement events.ts**

Create `apps/server/src/lib/events.ts`:

```ts
import { nanoid } from 'nanoid';
import { events } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated';

export interface EmitArgs {
  workspaceId: string;
  projectId?: string;
  documentId?: string;
  kind: EventKind;
  actor: string;
  payload?: unknown;
}

// Drizzle transaction handles share the query API with DB; one shape works for both.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function emitEvent(tx: DBOrTx, args: EmitArgs): Promise<void> {
  await tx.insert(events).values({
    id: nanoid(),
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: (args.payload ?? {}) as unknown,
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/lib/events.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/events.ts apps/server/src/lib/events.test.ts
git commit -m "phase-1: events emission helper"
```

---

## Task 7: Slug uniqueness helper

**Files:**
- Create: `apps/server/src/lib/slug-unique.ts`
- Test: `apps/server/src/lib/slug-unique.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/slug-unique.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents } from '../db/schema.ts';
import { slugUniqueInDocuments, slugUniqueInProjects, slugUniqueInWorkspaces } from './slug-unique.ts';

test('returns base when free', async () => {
  const { db, seed } = await makeTestApp();
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world');
});

test('returns base-2 when base taken', async () => {
  const { db, seed } = await makeTestApp();
  await db.insert(documents).values({
    id: nanoid(),
    projectId: seed.project.id,
    type: 'work_item',
    slug: 'hello-world',
    title: 'Hello',
  });
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world-2');
});

test('returns base-3 when base and base-2 taken', async () => {
  const { db, seed } = await makeTestApp();
  for (const s of ['hello-world', 'hello-world-2']) {
    await db.insert(documents).values({
      id: nanoid(), projectId: seed.project.id, type: 'work_item', slug: s, title: 'x',
    });
  }
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world-3');
});

test('scoped to project', async () => {
  const { db, seed } = await makeTestApp();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item', slug: 'foo', title: 'x',
  });
  // A different project; same slug should still be free if we passed a different projectId.
  expect(await slugUniqueInDocuments(db, 'different-project-id', 'foo')).toBe('foo');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/slug-unique.test.ts`
Expected: FAIL with `Cannot find module './slug-unique.ts'`.

- [ ] **Step 3: Implement slug-unique.ts**

Create `apps/server/src/lib/slug-unique.ts`:

```ts
import { and, eq, like } from 'drizzle-orm';
import { documents, projects, workspaces } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

async function pickFree(taken: Set<string>, base: string): Promise<string> {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not find a free slug for base "${base}"`);
}

export async function slugUniqueInDocuments(
  tx: DBOrTx,
  projectId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: documents.slug })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), like(documents.slug, `${base}%`)));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}

export async function slugUniqueInProjects(
  tx: DBOrTx,
  workspaceId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), like(projects.slug, `${base}%`)));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}

export async function slugUniqueInWorkspaces(
  tx: DBOrTx,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(like(workspaces.slug, `${base}%`));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/lib/slug-unique.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/slug-unique.ts apps/server/src/lib/slug-unique.test.ts
git commit -m "phase-1: slug-unique helpers for documents/projects/workspaces"
```

---

## Task 8: Filter AST → Drizzle adapter

**Files:**
- Create: `apps/server/src/lib/filter-to-drizzle.ts`
- Test: `apps/server/src/lib/filter-to-drizzle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/filter-to-drizzle.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { filterCompile } from '@folio/shared';
import { makeTestApp } from '../test/harness.ts';
import { documents } from '../db/schema.ts';
import { compileFilterToWhere } from './filter-to-drizzle.ts';

async function seedDocs(db: Awaited<ReturnType<typeof makeTestApp>>['db'], projectId: string) {
  for (const d of [
    { type: 'work_item' as const, slug: 'a', title: 'A', status: 'todo', frontmatter: { priority: 'high' } },
    { type: 'work_item' as const, slug: 'b', title: 'B', status: 'done', frontmatter: { priority: 'low' } },
    { type: 'page' as const, slug: 'c', title: 'C', status: null, frontmatter: {} },
  ]) {
    await db.insert(documents).values({ id: nanoid(), projectId, ...d });
  }
}

test('column $eq', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id);
  const where = compileFilterToWhere(filterCompile({ type: 'work_item' }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('frontmatter $eq via json_extract', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id);
  const where = compileFilterToWhere(filterCompile({ priority: 'high' }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug)).toEqual(['a']);
});

test('$in on column', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id);
  const where = compileFilterToWhere(filterCompile({ status: { $in: ['todo', 'done'] } }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('$exists on frontmatter', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id);
  const where = compileFilterToWhere(filterCompile({ priority: { $exists: true } }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('empty AST returns no-op (selects all)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id);
  const where = compileFilterToWhere(filterCompile({}), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/filter-to-drizzle.test.ts`
Expected: FAIL with `Cannot find module './filter-to-drizzle.ts'`.

- [ ] **Step 3: Implement filter-to-drizzle.ts**

Create `apps/server/src/lib/filter-to-drizzle.ts`:

```ts
import {
  and, eq, ne, gt, gte, lt, lte, inArray, notInArray, isNull, isNotNull, sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FilterAST } from '@folio/shared';
import { documents } from '../db/schema.ts';

const COLUMN_KEYS = new Set(['type', 'status', 'title', 'slug', 'parent_id', 'parentId']);

function columnFor(key: string) {
  switch (key) {
    case 'type': return documents.type;
    case 'status': return documents.status;
    case 'title': return documents.title;
    case 'slug': return documents.slug;
    case 'parent_id':
    case 'parentId': return documents.parentId;
    default: return null;
  }
}

function fmExpr(key: string) {
  return sql`json_extract(${documents.frontmatter}, ${'$.' + key})`;
}

function cmpToSql(key: string, op: string, value: unknown): SQL {
  const isColumn = COLUMN_KEYS.has(key);
  const lhs = isColumn ? columnFor(key)! : fmExpr(key);
  switch (op) {
    case '$eq':  return eq(lhs as never, value as never);
    case '$ne':  return ne(lhs as never, value as never);
    case '$gt':  return gt(lhs as never, value as never);
    case '$gte': return gte(lhs as never, value as never);
    case '$lt':  return lt(lhs as never, value as never);
    case '$lte': return lte(lhs as never, value as never);
    case '$in':  return inArray(lhs as never, value as never[]);
    case '$nin': return notInArray(lhs as never, value as never[]);
    case '$exists':
      return (value as boolean) ? isNotNull(lhs as never) : isNull(lhs as never);
    default: throw new Error(`unhandled operator ${op}`);
  }
}

export function compileFilterToWhere(
  ast: FilterAST,
  _table: typeof documents,
): SQL | undefined {
  if (ast.kind === 'cmp') return cmpToSql(ast.key, ast.op, ast.value);
  if (ast.clauses.length === 0) return undefined;
  const parts = ast.clauses.map((c) => {
    if (c.kind === 'cmp') return cmpToSql(c.key, c.op, c.value);
    return compileFilterToWhere(c, documents);
  });
  return and(...(parts.filter(Boolean) as SQL[]));
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/lib/filter-to-drizzle.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/filter-to-drizzle.ts apps/server/src/lib/filter-to-drizzle.test.ts
git commit -m "phase-1: filter AST → drizzle where adapter"
```

---

## Task 9: Scope middleware

**Files:**
- Create: `apps/server/src/middleware/scope.ts`
- Test: `apps/server/src/middleware/scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/middleware/scope.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { makeTestApp } from '../test/harness.ts';
import { requireUser, attachUser, type AuthContext } from './auth.ts';
import { resolveWorkspace, resolveProject, getWorkspace, getProject, getRole, type ScopeContext } from './scope.ts';

test('resolveWorkspace 404 on unknown slug', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  app.use('*', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/nope', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(404);
});

test('resolveWorkspace 403 when not member', async () => {
  const { db, seed } = await makeTestApp();
  const { workspaces } = await import('../db/schema.ts');
  const { nanoid } = await import('nanoid');
  await db.insert(workspaces).values({ id: nanoid(), slug: 'other', name: 'Other' });
  const app = new Hono<AuthContext & ScopeContext>();
  app.use('*', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/other', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(403);
});

test('resolveWorkspace attaches workspace + role', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  app.use('*', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ name: getWorkspace(c).name, role: getRole(c) }));
  const res = await app.request('/acme', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: 'Acme', role: 'owner' });
});

test('resolveProject loads project scoped to workspace', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  app.use('/:wslug/p/:pslug/*', attachUser, requireUser, resolveWorkspace, resolveProject);
  app.get('/:wslug/p/:pslug', (c) => c.json({ slug: getProject(c).slug }));
  const res = await app.request('/acme/p/web', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'web' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/middleware/scope.test.ts`
Expected: FAIL with `Cannot find module './scope.ts'`.

- [ ] **Step 3: Implement scope.ts**

Create `apps/server/src/middleware/scope.ts`:

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, projects, workspaces } from '../db/schema.ts';
import type { Workspace, Project } from '../db/schema.ts';
import type { AuthContext } from './auth.ts';
import { HTTPError } from '../lib/http.ts';

export type Role = 'owner' | 'admin' | 'member';

export interface ScopeContext {
  Variables: {
    workspace?: Workspace;
    project?: Project;
    role?: Role;
  };
}

export const resolveWorkspace: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const wslug = c.req.param('wslug');
  if (!wslug) throw new HTTPError('WORKSPACE_NOT_FOUND', 'missing :wslug', 404);

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, wslug) });
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', `workspace "${wslug}" not found`, 404);

  const user = c.get('user');
  if (!user) throw new HTTPError('UNAUTHENTICATED', 'login required', 401);

  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, user.id)),
  });
  if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);

  c.set('workspace', ws);
  c.set('role', m.role as Role);
  return next();
};

export const resolveProject: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const ws = c.get('workspace');
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', 'resolveWorkspace must run first', 500);
  const pslug = c.req.param('pslug');
  if (!pslug) throw new HTTPError('PROJECT_NOT_FOUND', 'missing :pslug', 404);
  const p = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, pslug)),
  });
  if (!p) throw new HTTPError('PROJECT_NOT_FOUND', `project "${pslug}" not found`, 404);
  c.set('project', p);
  return next();
};

export function getWorkspace(c: Context<AuthContext & ScopeContext>): Workspace {
  const ws = c.get('workspace');
  if (!ws) throw new Error('workspace not attached');
  return ws;
}

export function getProject(c: Context<AuthContext & ScopeContext>): Project {
  const p = c.get('project');
  if (!p) throw new Error('project not attached');
  return p;
}

export function getRole(c: Context<AuthContext & ScopeContext>): Role {
  const r = c.get('role');
  if (!r) throw new Error('role not attached');
  return r;
}
```

- [ ] **Step 4: Wire HTTPError into app.ts globally (precondition for the test)**

The test relies on `HTTPError` thrown in middleware being caught. Edit `apps/server/src/app.ts` — replace the `app.onError(onError);` line with:

```ts
import { registerErrorHandler } from './lib/http.ts';
// ...
registerErrorHandler(app);
```

And delete the existing `apps/server/src/middleware/error.ts` import line.

Verify: `grep "onError" apps/server/src/app.ts` returns nothing.

- [ ] **Step 5: Run tests**

Run: `cd apps/server && bun test src/middleware/scope.test.ts`
Expected: 4 pass.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: All previous tests still pass. No regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/middleware/scope.ts apps/server/src/middleware/scope.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: scope middleware + global HTTPError handler"
```

---

## Task 10: Migration — `views.order` + `views.is_default`; extend `fields.type` enum

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0001_views_order_default.sql`

- [ ] **Step 1: Edit schema.ts — `views` table**

Find the `views` table in `apps/server/src/db/schema.ts` (around line 204) and add two columns after `visibleFields`:

```ts
visibleFields: text('visible_fields', { mode: 'json' }).$type<string[]>().notNull().default([]),
order: integer('order').notNull().default(0),
isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
createdAt: ...
```

- [ ] **Step 2: Edit schema.ts — `fields.type` enum expansion**

Find the `fields` table (around line 146) and replace the `type` line with:

```ts
type: text('type', {
  enum: [
    'string', 'text', 'number', 'boolean', 'date', 'datetime',
    'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  ],
}).notNull(),
```

- [ ] **Step 3: Generate the migration**

Run: `bun --filter=server db:generate`
Expected: A new file under `apps/server/src/db/migrations/`.

If the generated filename differs from `0001_views_order_default.sql`, rename it to that name and update `apps/server/src/db/migrations/meta/_journal.json` accordingly (the journal references the file by its `tag`).

- [ ] **Step 4: Inspect the generated SQL**

`cat apps/server/src/db/migrations/0001_*.sql`
Expected content: two `ALTER TABLE views ADD COLUMN` statements. No statement for `fields` (the enum is TypeScript-only).

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: All pass. The test harness re-applies migrations per `:memory:` DB.

- [ ] **Step 6: Apply the migration to the dev DB (optional, for manual sanity)**

Run: `bun --filter=server db:migrate`
Expected: migration applies cleanly.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-1: migration — views.order + is_default; extend fields.type enum"
```

---

## Task 11: Wire `/api/v1` mount + scope router skeleton

**Files:**
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Replace app.ts wiring**

Replace `apps/server/src/app.ts` with:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { env } from './env.ts';
import { registerErrorHandler } from './lib/http.ts';
import { attachUser, requireUser, type AuthContext } from './middleware/auth.ts';
import { resolveWorkspace, resolveProject, type ScopeContext } from './middleware/scope.ts';
import { auth } from './routes/auth.ts';
import { healthRoute } from './routes/health.ts';
import { settingsRoute } from './routes/settings.ts';
import { tokensRoute } from './routes/tokens.ts';
import { workspacesRoute } from './routes/workspaces.ts';

export const app = new Hono<AuthContext & ScopeContext>();
registerErrorHandler(app);

if (env.NODE_ENV !== 'production') {
  app.use('*', cors({ origin: ['http://localhost:5173'], credentials: true }));
}
app.use('*', logger());
app.use('*', attachUser);

// --- /api/v1 ---
const v1 = new Hono<AuthContext & ScopeContext>();
v1.route('/auth', auth);
v1.route('/workspaces', workspacesRoute);

const wScope = new Hono<AuthContext & ScopeContext>();
wScope.use('*', requireUser, resolveWorkspace);
wScope.route('/settings', settingsRoute);
wScope.route('/tokens', tokensRoute);

const pScope = new Hono<AuthContext & ScopeContext>();
pScope.use('*', resolveProject);
// documents/statuses/fields/views routers mounted in later tasks.

wScope.route('/p/:pslug', pScope);
v1.route('/w/:wslug', wScope);
app.route('/api/v1', v1);

// --- health (unversioned) ---
app.route('/', healthRoute);

// --- static SPA (prod) ---
if (env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ path: '../web/dist/index.html' }));
}
```

- [ ] **Step 2: Delete the stale stubs file**

```bash
rm apps/server/src/routes/stubs.ts
```

- [ ] **Step 3: Delete middleware/error.ts (replaced by registerErrorHandler)**

```bash
rm apps/server/src/middleware/error.ts 2>/dev/null || true
```

Verify: `grep -r "middleware/error" apps/server/src` returns nothing.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: All pass. Existing auth + harness + middleware tests still green.

- [ ] **Step 5: Boot the server to sanity-check the wiring**

Run: `bun --filter=server dev &` then `curl -i http://localhost:3000/healthz`
Expected: 200 OK with `{ "ok": true, ... }` envelope. Then `kill %1`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/app.ts
git rm apps/server/src/routes/stubs.ts apps/server/src/middleware/error.ts
git commit -m "phase-1: mount /api/v1 with scope router skeleton"
```

---

## Task 12: Workspaces route — slug-scoped CRUD

**Files:**
- Modify: `apps/server/src/routes/workspaces.ts` (rewrite)
- Test: `apps/server/src/routes/workspaces.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/routes/workspaces.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

test('GET /api/v1/workspaces lists user workspaces', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].workspace.slug).toBe('acme');
  expect(body.data[0].role).toBe('owner');
});

test('GET /api/v1/workspaces 401 without cookie', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces');
  expect(res.status).toBe(401);
});

test('POST /api/v1/workspaces creates with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Place' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.workspace.slug).toMatch(/^new-place/);
});

test('POST with explicit slug; second use is 409', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Foo', slug: 'taken' }),
  });
  const dupe = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bar', slug: 'taken' }),
  });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

test('GET /api/v1/workspaces/:wslug returns workspace + role', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces/acme', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.workspace.slug).toBe('acme');
  expect(body.data.role).toBe('owner');
});

test('PATCH /api/v1/workspaces/:wslug renames (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces/acme', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme Inc' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.workspace.name).toBe('Acme Inc');
});

test('DELETE /api/v1/workspaces/:wslug 204 (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces/acme', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/workspaces.test.ts`
Expected: most fail (404 or wrong shape) — current route uses old envelope and old URL structure.

- [ ] **Step 3: Rewrite workspaces.ts**

Replace `apps/server/src/routes/workspaces.ts` with:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { memberships, workspaces } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { slugUniqueInWorkspaces } from '../lib/slug-unique.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';
import { resolveWorkspace, getWorkspace, getRole, type ScopeContext } from '../middleware/scope.ts';

const workspacesRoute = new Hono<AuthContext & ScopeContext>();

workspacesRoute.use('*', requireUser);

// --- collection ---

workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, user.id));
  return jsonOk(c, rows);
});

workspacesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const { name, slug: explicit } = c.req.valid('json');
    const id = nanoid();

    const baseSlug = explicit ?? slugify(name);
    let slug = baseSlug;
    if (explicit) {
      const existing = await db.query.workspaces.findFirst({
        where: eq(workspaces.slug, explicit),
      });
      if (existing) throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken`, 409);
    } else {
      slug = await slugUniqueInWorkspaces(db, baseSlug || 'workspace');
    }

    await db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id, slug, name });
      await tx.insert(memberships).values({ workspaceId: id, userId: user.id, role: 'owner' });
      await emitEvent(tx, {
        workspaceId: id, kind: 'workspace.created', actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { workspace: { id, slug, name } }, 201);
  },
);

// --- item (slug-scoped via resolveWorkspace) ---

const item = new Hono<AuthContext & ScopeContext>();
item.use('*', resolveWorkspace);

item.get('/', (c) => jsonOk(c, { workspace: getWorkspace(c), role: getRole(c) }));

item.patch(
  '/',
  zValidator('json', z.object({ name: z.string().min(1).max(80) })),
  async (c) => {
    if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
    const ws = getWorkspace(c);
    const { name } = c.req.valid('json');
    const user = getUser(c);
    await db.transaction(async (tx) => {
      await tx.update(workspaces).set({ name }).where(eq(workspaces.id, ws.id));
      await emitEvent(tx, {
        workspaceId: ws.id, kind: 'workspace.updated', actor: user.id,
        payload: { changes: ['name'] },
      });
    });
    return jsonOk(c, { workspace: { ...ws, name } });
  },
);

item.delete('/', async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const ws = getWorkspace(c);
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  return c.body(null, 204);
});

workspacesRoute.route('/:wslug', item);

export { workspacesRoute };
```

- [ ] **Step 4: Run tests until green**

Run: `cd apps/server && bun test src/routes/workspaces.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/workspaces.ts apps/server/src/routes/workspaces.test.ts
git commit -m "phase-1: workspaces — slug-scoped CRUD + envelope"
```

---

## Task 13: Projects route — split out, slug-scoped

**Files:**
- Create: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/app.ts` (mount projectsRoute)
- Test: `apps/server/src/routes/projects.test.ts`

This task only wires CRUD + emits `project.created`. The default seeding (4 statuses + 2 views) is added in Task 16 once those resources have their tables in code paths.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/routes/projects.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

test('GET /w/:wslug/projects lists projects in workspace', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.map((p: { slug: string }) => p.slug)).toEqual(['web']);
});

test('POST /w/:wslug/projects with explicit slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile', slug: 'mobile' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.project.slug).toBe('mobile');
});

test('POST 409 on duplicate slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web Again', slug: 'web' }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('SLUG_CONFLICT');
});

test('POST derives unique slug when omitted', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.project.slug).toBe('web-2');
});

test('GET /w/:wslug/projects/:pslug returns the project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.project.slug).toBe('web');
});

test('PATCH /w/:wslug/projects/:pslug renames', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Webapp' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.project.name).toBe('Webapp');
});

test('DELETE /w/:wslug/projects/:pslug (owner) returns 204', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET unknown project → 404 PROJECT_NOT_FOUND', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/nope', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('PROJECT_NOT_FOUND');
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/projects.test.ts`
Expected: all 8 fail (route doesn't exist).

- [ ] **Step 3: Implement projects.ts**

Create `apps/server/src/routes/projects.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { slugUniqueInProjects } from '../lib/slug-unique.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import {
  resolveProject, getProject, getWorkspace, getRole, type ScopeContext,
} from '../middleware/scope.ts';

const projectsRoute = new Hono<AuthContext & ScopeContext>();

// Mounted under wScope, which has already run resolveWorkspace + requireUser.

projectsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  const rows = await db.query.projects.findMany({
    where: eq(projects.workspaceId, ws.id),
  });
  return jsonOk(c, rows);
});

projectsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
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
      if (existing) throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken in this workspace`, 409);
    } else {
      slug = await slugUniqueInProjects(db, ws.id, slug || 'project');
    }

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({ id, workspaceId: ws.id, slug, name, icon: icon ?? null });
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: id, kind: 'project.created', actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { project: { id, workspaceId: ws.id, slug, name, icon: icon ?? null } }, 201);
  },
);

const item = new Hono<AuthContext & ScopeContext>();
item.use('*', resolveProject);

item.get('/', (c) => jsonOk(c, { project: getProject(c) }));

item.patch(
  '/',
  zValidator('json', z.object({
    name: z.string().min(1).max(80).optional(),
    icon: z.string().max(32).nullable().optional(),
  })),
  async (c) => {
    const p = getProject(c);
    const ws = getWorkspace(c);
    const user = getUser(c);
    const patch = c.req.valid('json');
    await db.transaction(async (tx) => {
      await tx.update(projects).set(patch).where(eq(projects.id, p.id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'project.updated', actor: user.id,
        payload: { changes: Object.keys(patch) },
      });
    });
    return jsonOk(c, { project: { ...p, ...patch } });
  },
);

item.delete('/', async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const p = getProject(c);
  await db.delete(projects).where(eq(projects.id, p.id));
  return c.body(null, 204);
});

projectsRoute.route('/:pslug', item);

export { projectsRoute };
```

- [ ] **Step 4: Mount in app.ts**

In `apps/server/src/app.ts`, find the `wScope` declaration and add:

```ts
import { projectsRoute } from './routes/projects.ts';
// ...
wScope.route('/projects', projectsRoute);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && bun test src/routes/projects.test.ts`
Expected: 8 pass.

- [ ] **Step 6: Run full suite**

Run: `bun test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: projects route — slug-scoped CRUD"
```

---

## Task 14: Statuses route

**Files:**
- Create: `apps/server/src/routes/statuses.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/statuses.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/routes/statuses.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents, statuses } from '../db/schema.ts';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, body: object) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET / returns empty list initially', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/statuses', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST / creates a status', async () => {
  const { app, seed } = await makeTestApp();
  const res = await createStatus(app, seed.sessionCookie, {
    key: 'todo', name: 'Todo', category: 'unstarted', order: 10,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.status.key).toBe('todo');
});

test('POST duplicate key → 409 SLUG_CONFLICT', async () => {
  const { app, seed } = await makeTestApp();
  await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const dupe = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo 2' });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

test('PATCH /:id renames key + cascades to documents', async () => {
  const { app, db, seed } = await makeTestApp();
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item',
    slug: 'a', title: 'A', status: 'todo',
  });
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'todo-2' }),
  });
  expect(res.status).toBe(200);
  const docs = await db.select().from(documents);
  expect(docs[0]!.status).toBe('todo-2');
});

test('DELETE /:id 409 when status in use', async () => {
  const { app, db, seed } = await makeTestApp();
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item',
    slug: 'a', title: 'A', status: 'todo',
  });
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('STATUS_IN_USE');
});

test('DELETE /:id 204 when unused', async () => {
  const { app, seed } = await makeTestApp();
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/statuses.test.ts`
Expected: all 6 fail.

- [ ] **Step 3: Implement statuses.ts**

Create `apps/server/src/routes/statuses.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const statusesRoute = new Hono<AuthContext & ScopeContext>();

const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

statusesRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.statuses.findMany({
    where: eq(statuses.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  return jsonOk(c, rows);
});

statusesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
      name: z.string().min(1).max(80),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const ws = getWorkspace(c);
    const input = c.req.valid('json');
    const existing = await db.query.statuses.findFirst({
      where: and(eq(statuses.projectId, p.id), eq(statuses.key, input.key)),
    });
    if (existing) throw new HTTPError('SLUG_CONFLICT', `status "${input.key}" exists`, 409);

    const id = nanoid();
    const row = {
      id,
      projectId: p.id,
      key: input.key,
      name: input.name,
      color: input.color ?? '#9ca3af',
      category: input.category ?? 'unstarted',
      order: input.order ?? 0,
    };
    await db.transaction(async (tx) => {
      await tx.insert(statuses).values(row);
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'status.created', actor: user.id,
        payload: { id, key: input.key },
      });
    });
    return jsonOk(c, { status: row }, 201);
  },
);

statusesRoute.patch(
  '/:id',
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
      name: z.string().min(1).max(80).optional(),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const row = await db.query.statuses.findFirst({
      where: and(eq(statuses.projectId, p.id), eq(statuses.id, id)),
    });
    if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);
    const patch = c.req.valid('json');

    await db.transaction(async (tx) => {
      if (patch.key && patch.key !== row.key) {
        await tx.update(documents)
          .set({ status: patch.key })
          .where(and(eq(documents.projectId, p.id), eq(documents.status, row.key)));
      }
      await tx.update(statuses).set(patch).where(eq(statuses.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'status.updated', actor: user.id,
        payload: { id, changes: Object.keys(patch) },
      });
    });

    return jsonOk(c, { status: { ...row, ...patch } });
  },
);

statusesRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.projectId, p.id), eq(statuses.id, id)),
  });
  if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);

  const [usage] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.projectId, p.id), eq(documents.status, row.key)));
  if ((usage?.n ?? 0) > 0) {
    throw new HTTPError('STATUS_IN_USE', `status "${row.key}" is used by ${usage!.n} document(s)`, 409);
  }

  await db.transaction(async (tx) => {
    await tx.delete(statuses).where(eq(statuses.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'status.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { statusesRoute };
```

- [ ] **Step 4: Mount in app.ts**

In `apps/server/src/app.ts`, add to imports + `pScope`:

```ts
import { statusesRoute } from './routes/statuses.ts';
// ...
pScope.route('/statuses', statusesRoute);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && bun test src/routes/statuses.test.ts`
Expected: 6 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/statuses.ts apps/server/src/routes/statuses.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: statuses route — CRUD + rename-cascade + safe delete"
```

---

## Task 15: Fields route

**Files:**
- Create: `apps/server/src/routes/fields.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/fields.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/routes/fields.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/fields';

test('GET / empty initially', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST creates a select field with options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select', options: ['low', 'med', 'high'] }),
  });
  expect(res.status).toBe(201);
});

test('POST 422 when select has no options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

test('POST 422 when text has options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'note', type: 'text', options: ['x'] }),
  });
  expect(res.status).toBe(422);
});

test('PATCH type change preserves row', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.field.type).toBe('text');
});

test('DELETE drops the pin', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const res = await app.request(`${path}/${field.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/fields.test.ts`
Expected: all 6 fail.

- [ ] **Step 3: Implement fields.ts**

Create `apps/server/src/routes/fields.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { fields } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const fieldsRoute = new Hono<AuthContext & ScopeContext>();

const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
] as const;

const baseSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(FIELD_TYPES),
  label: z.string().max(80).optional(),
  options: z.array(z.string()).optional(),
  order: z.number().int().optional(),
});

function validateOptions(type: string, options: string[] | undefined): void {
  const needs = type === 'select' || type === 'multi_select';
  if (needs && (!options || options.length === 0)) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" requires non-empty options`, 422);
  }
  if (!needs && options !== undefined) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" does not allow options`, 422);
  }
}

fieldsRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.fields.findMany({
    where: eq(fields.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  return jsonOk(c, rows);
});

fieldsRoute.post('/', zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  validateOptions(input.type, input.options);

  const existing = await db.query.fields.findFirst({
    where: and(eq(fields.projectId, p.id), eq(fields.key, input.key)),
  });
  if (existing) throw new HTTPError('SLUG_CONFLICT', `field "${input.key}" exists`, 409);

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    key: input.key,
    type: input.type,
    label: input.label ?? null,
    options: input.options ?? null,
    order: input.order ?? 0,
  };
  await db.transaction(async (tx) => {
    await tx.insert(fields).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'field.created', actor: user.id,
      payload: { id, key: input.key, type: input.type },
    });
  });
  return jsonOk(c, { field: row }, 201);
});

fieldsRoute.patch(
  '/:id',
  zValidator('json', baseSchema.partial()),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const row = await db.query.fields.findFirst({
      where: and(eq(fields.projectId, p.id), eq(fields.id, id)),
    });
    if (!row) throw new HTTPError('FIELD_NOT_FOUND', `field "${id}" not found`, 404);
    const patch = c.req.valid('json');
    const finalType = patch.type ?? row.type;
    const finalOptions =
      patch.options !== undefined ? patch.options : (row.options ?? undefined);
    validateOptions(finalType, finalOptions ?? undefined);

    await db.transaction(async (tx) => {
      await tx.update(fields).set(patch).where(eq(fields.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'field.updated', actor: user.id,
        payload: { id, changes: Object.keys(patch) },
      });
    });
    return jsonOk(c, { field: { ...row, ...patch } });
  },
);

fieldsRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.fields.findFirst({
    where: and(eq(fields.projectId, p.id), eq(fields.id, id)),
  });
  if (!row) throw new HTTPError('FIELD_NOT_FOUND', `field "${id}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(fields).where(eq(fields.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'field.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { fieldsRoute };
```

- [ ] **Step 4: Mount in app.ts**

```ts
import { fieldsRoute } from './routes/fields.ts';
// ...
pScope.route('/fields', fieldsRoute);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && bun test src/routes/fields.test.ts`
Expected: 6 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/fields.ts apps/server/src/routes/fields.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: fields route — CRUD + options validation"
```

---

## Task 16: Views route + default seeding helper

**Files:**
- Create: `apps/server/src/routes/views.ts`
- Create: `apps/server/src/lib/seed-project-defaults.ts`
- Modify: `apps/server/src/routes/projects.ts` (call the seeder on create)
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/views.test.ts`
- Test: `apps/server/src/lib/seed-project-defaults.test.ts`

- [ ] **Step 1: Write failing tests for the seeder**

Create `apps/server/src/lib/seed-project-defaults.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { statuses, views, projects } from '../db/schema.ts';
import { seedProjectDefaults } from './seed-project-defaults.ts';

test('seedProjectDefaults inserts 4 statuses and 2 views', async () => {
  const { db, seed } = await makeTestApp();
  // Use a fresh project to avoid clashing with the harness-seeded one.
  const newProjectId = nanoid();
  await db.insert(projects).values({
    id: newProjectId, workspaceId: seed.workspace.id, slug: 'fresh', name: 'Fresh',
  });
  await db.transaction(async (tx) => {
    await seedProjectDefaults(tx, newProjectId);
  });
  const s = await db.select().from(statuses).where(eq(statuses.projectId, newProjectId));
  const v = await db.select().from(views).where(eq(views.projectId, newProjectId));
  expect(s.map((r) => r.key).sort()).toEqual(['backlog', 'done', 'in_progress', 'todo']);
  expect(v).toHaveLength(2);
  expect(v.find((r) => r.name === 'All work items')!.isDefault).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/seed-project-defaults.test.ts`
Expected: FAIL with `Cannot find module './seed-project-defaults.ts'`.

- [ ] **Step 3: Implement the seeder**

Create `apps/server/src/lib/seed-project-defaults.ts`:

```ts
import { nanoid } from 'nanoid';
import { statuses, views } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function seedProjectDefaults(tx: DBOrTx, projectId: string): Promise<void> {
  const statusRows = [
    { key: 'backlog',     name: 'Backlog',     category: 'backlog'   as const, color: '#94a3b8', order: 0  },
    { key: 'todo',        name: 'Todo',        category: 'unstarted' as const, color: '#3b82f6', order: 10 },
    { key: 'in_progress', name: 'In Progress', category: 'started'   as const, color: '#f59e0b', order: 20 },
    { key: 'done',        name: 'Done',        category: 'completed' as const, color: '#10b981', order: 30 },
  ];
  for (const s of statusRows) {
    await tx.insert(statuses).values({ id: nanoid(), projectId, ...s });
  }
  await tx.insert(views).values({
    id: nanoid(),
    projectId,
    name: 'All work items',
    type: 'list',
    filters: { type: { $eq: 'work_item' } },
    sort: [{ key: 'updated_at', dir: 'desc' }],
    visibleFields: ['status', 'priority'],
    isDefault: true,
    order: 0,
  });
  await tx.insert(views).values({
    id: nanoid(),
    projectId,
    name: 'Board',
    type: 'kanban',
    filters: { type: { $eq: 'work_item' } },
    sort: [],
    groupBy: 'status',
    visibleFields: ['priority', 'assignee'],
    isDefault: false,
    order: 10,
  });
}
```

- [ ] **Step 4: Run seeder test**

Run: `cd apps/server && bun test src/lib/seed-project-defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Call the seeder from projects POST**

Edit `apps/server/src/routes/projects.ts`. Add import:

```ts
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
```

In the POST handler, inside the transaction, after `tx.insert(projects)` and before `emitEvent`, add:

```ts
await seedProjectDefaults(tx, id);
```

- [ ] **Step 6: Update projects test to assert seeding**

Edit `apps/server/src/routes/projects.test.ts`. Add at the bottom:

```ts
test('POST seeds 4 statuses and 2 views', async () => {
  const { app, db, seed } = await makeTestApp();
  const { statuses, views } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const create = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile' }),
  });
  const { data: { project } } = await create.json();
  const s = await db.select().from(statuses).where(eq(statuses.projectId, project.id));
  const v = await db.select().from(views).where(eq(views.projectId, project.id));
  expect(s).toHaveLength(4);
  expect(v).toHaveLength(2);
});
```

- [ ] **Step 7: Write the views route tests**

Create `apps/server/src/routes/views.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/views';

test('GET / returns empty initially (harness-seeded project has none)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST creates a list view with filters', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mine', type: 'list',
      filters: { assignee: 'alice@test.local' },
    }),
  });
  expect(res.status).toBe(201);
});

test('POST 422 INVALID_FILTER on bad operator', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad', type: 'list',
      filters: { x: { $bogus: 1 } },
    }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_FILTER');
});

test('PATCH /:id renames', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', type: 'list' }),
  });
  const { data: { view } } = await create.json();
  const res = await app.request(`${path}/${view.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Y' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.view.name).toBe('Y');
});

test('DELETE /:id 204', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Z', type: 'list' }),
  });
  const { data: { view } } = await create.json();
  const res = await app.request(`${path}/${view.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
```

Note: the "GET / returns empty" test uses the harness's `web` project (not auto-seeded). The seeder only runs through POST. New tests using `web` see an empty view set. The "POST seeds" test in step 6 covers seeding.

- [ ] **Step 8: Implement views.ts**

Create `apps/server/src/routes/views.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { filterCompile, FilterCompileError } from '@folio/shared';
import { db } from '../db/client.ts';
import { views } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const viewsRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['list', 'kanban']),
  filters: z.record(z.unknown()).optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  groupBy: z.string().nullable().optional(),
  visibleFields: z.array(z.string()).optional(),
  order: z.number().int().optional(),
  isDefault: z.boolean().optional(),
});

function validateFilters(input: unknown): void {
  if (!input || typeof input !== 'object') return;
  try {
    filterCompile(input as Parameters<typeof filterCompile>[0]);
  } catch (e) {
    if (e instanceof FilterCompileError) {
      throw new HTTPError('INVALID_FILTER', e.message, 422);
    }
    throw e;
  }
}

viewsRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.views.findMany({
    where: eq(views.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  return jsonOk(c, rows);
});

viewsRoute.post('/', zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  validateFilters(input.filters);

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    name: input.name,
    type: input.type,
    filters: (input.filters ?? {}) as unknown,
    sort: (input.sort ?? []) as unknown,
    groupBy: input.groupBy ?? null,
    visibleFields: input.visibleFields ?? [],
    order: input.order ?? 0,
    isDefault: input.isDefault ?? false,
  };
  await db.transaction(async (tx) => {
    await tx.insert(views).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.created', actor: user.id,
      payload: { id, name: input.name },
    });
  });
  return jsonOk(c, { view: row }, 201);
});

viewsRoute.patch('/:id', zValidator('json', baseSchema.partial()), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.views.findFirst({
    where: and(eq(views.projectId, p.id), eq(views.id, id)),
  });
  if (!row) throw new HTTPError('VIEW_NOT_FOUND', `view "${id}" not found`, 404);
  const patch = c.req.valid('json');
  if (patch.filters !== undefined) validateFilters(patch.filters);

  await db.transaction(async (tx) => {
    await tx.update(views).set(patch).where(eq(views.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.updated', actor: user.id,
      payload: { id, changes: Object.keys(patch) },
    });
  });
  return jsonOk(c, { view: { ...row, ...patch } });
});

viewsRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.views.findFirst({
    where: and(eq(views.projectId, p.id), eq(views.id, id)),
  });
  if (!row) throw new HTTPError('VIEW_NOT_FOUND', `view "${id}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(views).where(eq(views.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.deleted', actor: user.id,
      payload: { id, name: row.name },
    });
  });
  return c.body(null, 204);
});

export { viewsRoute };
```

- [ ] **Step 9: Mount in app.ts**

```ts
import { viewsRoute } from './routes/views.ts';
// ...
pScope.route('/views', viewsRoute);
```

- [ ] **Step 10: Run tests**

Run: `cd apps/server && bun test src/routes/views.test.ts src/routes/projects.test.ts src/lib/seed-project-defaults.test.ts`
Expected: 5 + 9 + 1 = 15 pass.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/routes/views.ts apps/server/src/routes/views.test.ts \
        apps/server/src/lib/seed-project-defaults.ts apps/server/src/lib/seed-project-defaults.test.ts \
        apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: views route + project default seeding"
```

---

## Task 17: Documents route — JSON CRUD (no MD ingest yet)

**Files:**
- Create: `apps/server/src/routes/documents.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/documents.test.ts`

- [ ] **Step 1: Write the failing tests for JSON CRUD**

Create `apps/server/src/routes/documents.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/documents';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, key: string) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: key }),
  });
}

test('POST /documents JSON creates work_item with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Fix the bug' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.document.slug).toBe('fix-the-bug');
  expect(body.data.document.type).toBe('work_item');
});

test('POST 422 INVALID_STATUS when status not in registry', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'X',
      frontmatter: { status: 'nope' },
    }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_STATUS');
});

test('POST with valid status persists status column', async () => {
  const { app, seed } = await makeTestApp();
  await createStatus(app, seed.sessionCookie, 'todo');
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Y', frontmatter: { status: 'todo' } }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.status).toBe('todo');
});

test('GET /documents/:slug returns the doc', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'A doc' }),
  });
  const res = await app.request(`${path}/a-doc`, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data.document.title).toBe('A doc');
});

test('GET unknown slug 404 DOCUMENT_NOT_FOUND', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${path}/nope`, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('PATCH JSON merges frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'M',
      frontmatter: { priority: 'high', tag: 'a' },
    }),
  });
  const patch = await app.request(`${path}/m`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { priority: 'urgent', tag: null } }),
  });
  expect(patch.status).toBe(200);
  const body = await patch.json();
  expect(body.data.document.frontmatter.priority).toBe('urgent');
  expect(body.data.document.frontmatter.tag).toBeUndefined();
});

test('DELETE returns 204', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Del' }),
  });
  const res = await app.request(`${path}/del`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST duplicate title gets unique slug suffix', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Same' }),
  });
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Same' }),
  });
  expect((await res.json()).data.document.slug).toBe('same-2');
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: all fail (no route).

- [ ] **Step 3: Implement documents.ts (JSON-only path for now; MD ingest in Task 18)**

Create `apps/server/src/routes/documents.ts`:

```ts
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
```

- [ ] **Step 4: Mount in app.ts**

```ts
import { documentsRoute } from './routes/documents.ts';
// ...
pScope.route('/documents', documentsRoute);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: 8 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts \
        apps/server/src/app.ts
git commit -m "phase-1: documents route — JSON CRUD"
```

---

## Task 18: Documents — `text/markdown` ingest on POST and PATCH

**Files:**
- Modify: `apps/server/src/routes/documents.ts`
- Modify: `apps/server/src/routes/documents.test.ts`

- [ ] **Step 1: Add failing MD-ingest tests**

Append to `apps/server/src/routes/documents.test.ts`:

```ts
test('POST text/markdown creates from raw MD with H1 title', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: work_item
priority: high
---

# Markdown Title

Body here.
`,
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.document.title).toBe('Markdown Title');
  expect(body.data.document.frontmatter.priority).toBe('high');
});

test('POST text/markdown without H1 falls back to frontmatter.title', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
title: From Frontmatter
type: page
---

Body
`,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.title).toBe('From Frontmatter');
});

test('POST text/markdown with no title at all gets "Untitled"', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `body only`,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.title).toBe('Untitled');
});

test('PATCH text/markdown replaces whole document', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Original', frontmatter: { keep: 'me' },
    }),
  });
  const res = await app.request(`${path}/original`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: work_item
priority: critical
---

# Renamed

New body.
`,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.document.title).toBe('Renamed');
  expect(body.data.document.frontmatter.priority).toBe('critical');
  expect(body.data.document.frontmatter.keep).toBeUndefined(); // replaced, not merged
});

test('PATCH text/markdown changing type is rejected', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Stay' }),
  });
  const res = await app.request(`${path}/stay`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: page
---
# Stay
`,
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: the 5 new tests fail; existing ones still pass.

- [ ] **Step 3: Add MD-branch handlers**

Edit `apps/server/src/routes/documents.ts`. Add at the top of imports:

```ts
import { parseMarkdown } from '../lib/frontmatter.ts';
```

Add a helper near the top of the file (after `validateStatus`):

```ts
function isMarkdownRequest(c: Parameters<typeof documentsRoute.post>[2]): boolean {
  const ct = c.req.header('content-type') ?? '';
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
```

Replace the POST handler with a branching version. Find the current `documentsRoute.post('/', ...)` block and replace it with:

```ts
documentsRoute.post('/', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);

  let input: ParsedMdInput;
  if (isMarkdownRequest(c)) {
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
```

Replace the PATCH handler similarly. Find `documentsRoute.patch('/:slug', ...)` and replace with:

```ts
documentsRoute.patch('/:slug', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  if (isMarkdownRequest(c)) {
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
```

Remove the now-unused `zValidator` and `documentCreateSchema`/`documentPatchSchema` imports if they linted unused.

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: 13 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts
git commit -m "phase-1: documents — text/markdown ingest on POST and PATCH"
```

---

## Task 19: Documents — list with filters + cursor pagination

**Files:**
- Modify: `apps/server/src/routes/documents.ts`
- Modify: `apps/server/src/routes/documents.test.ts`

- [ ] **Step 1: Add failing list tests**

Append to `apps/server/src/routes/documents.test.ts`:

```ts
test('GET /documents lists with no filter', async () => {
  const { app, seed } = await makeTestApp();
  for (const t of ['A', 'B', 'C']) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title: t }),
    });
  }
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(3);
});

test('GET filters by type', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'W' }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'page', title: 'P' }),
  });
  const res = await app.request(`${path}?type=page`, { headers: { Cookie: seed.sessionCookie } });
  expect((await res.json()).data).toHaveLength(1);
});

test('GET applies a filter AST via ?filter=', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'X', frontmatter: { priority: 'high' } }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Y', frontmatter: { priority: 'low' } }),
  });
  const filter = encodeURIComponent(JSON.stringify({ priority: 'high' }));
  const res = await app.request(`${path}?filter=${filter}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].title).toBe('X');
});

test('GET 422 INVALID_FILTER on bad operator', async () => {
  const { app, seed } = await makeTestApp();
  const filter = encodeURIComponent(JSON.stringify({ x: { $bogus: 1 } }));
  const res = await app.request(`${path}?filter=${filter}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_FILTER');
});

test('GET respects limit and returns nextCursor', async () => {
  const { app, seed } = await makeTestApp();
  for (let i = 0; i < 5; i++) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title: `T${i}` }),
    });
  }
  const res = await app.request(`${path}?limit=2`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(2);
  expect(typeof body.nextCursor).toBe('string');
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: 5 new fail (GET / not defined yet).

- [ ] **Step 3: Add GET list handler**

Edit `apps/server/src/routes/documents.ts`. Add imports:

```ts
import { desc, lt, or, and as drizzleAnd } from 'drizzle-orm';
import { filterCompile, FilterCompileError } from '@folio/shared';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
```

Add (above `documentsRoute.post('/', ...)`):

```ts
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
  } catch { return null; }
}

documentsRoute.get('/', async (c) => {
  const p = getProject(c);
  const type = c.req.query('type');
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
  const cursorRaw = c.req.query('cursor');
  const filterRaw = c.req.query('filter');

  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  let filterWhere = undefined as ReturnType<typeof compileFilterToWhere>;
  if (filterRaw) {
    let parsed: unknown;
    try { parsed = JSON.parse(filterRaw); }
    catch { throw new HTTPError('INVALID_FILTER', 'filter must be valid JSON', 422); }
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
        drizzleAnd(eq(documents.updatedAt, ts), lt(documents.id, cursor.id)) as never,
      ) as never,
    );
  }

  const rows = await db
    .select()
    .from(documents)
    .where(drizzleAnd(...whereClauses))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(last.updatedAt.getTime(), last.id)
    : null;

  return c.json({ data: page, nextCursor });
});
```

Note: list responses include `nextCursor` at the top level, alongside `data`, per spec §5 pagination shape.

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: 18 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts
git commit -m "phase-1: documents — GET / with filters + cursor pagination"
```

---

## Task 20: Documents — `:slug.md` raw markdown serializer

**Files:**
- Modify: `apps/server/src/routes/documents.ts`
- Modify: `apps/server/src/routes/documents.test.ts`

- [ ] **Step 1: Add failing test for `.md` endpoint**

Append to `apps/server/src/routes/documents.test.ts`:

```ts
test('GET /documents/:slug.md returns raw markdown with frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Round Trip',
      frontmatter: { priority: 'high', tag: 'a' },
    }),
  });
  const res = await app.request(`${path}/round-trip.md`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
  const text = await res.text();
  expect(text).toMatch(/^---\n/);
  expect(text).toMatch(/title: Round Trip/);
  expect(text).toMatch(/priority: high/);
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: the `.md` test fails (route hits `:slug` and returns JSON for slug "round-trip.md").

- [ ] **Step 3: Add the `.md` route — must be declared BEFORE the `:slug` route**

Edit `apps/server/src/routes/documents.ts`. Add imports:

```ts
import { serializeMarkdown } from '../lib/frontmatter.ts';
```

Add the handler immediately above `documentsRoute.get('/:slug', ...)`:

```ts
documentsRoute.get('/:slug{[^.]+}.md', async (c) => {
  const p = getProject(c);
  const slug = c.req.param('slug');
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const fm: Record<string, unknown> = {
    type: row.type,
    title: row.title,
    ...(row.status ? { status: row.status } : {}),
    ...row.frontmatter,
  };
  const md = serializeMarkdown({ frontmatter: fm, body: row.body });
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `inline; filename="${slug}.md"`);
  return c.body(md);
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/routes/documents.test.ts`
Expected: 19 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts
git commit -m "phase-1: documents — :slug.md raw markdown endpoint"
```

---

## Task 21: Migrate existing routes to the envelope

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Modify: `apps/server/src/routes/settings.ts`
- Modify: `apps/server/src/routes/tokens.ts`
- Modify: `apps/server/src/routes/health.ts`

The frontend is not consuming these yet; this is mechanical cleanup so every response has the same shape.

- [ ] **Step 1: Read all four files first**

```bash
cat apps/server/src/routes/auth.ts apps/server/src/routes/settings.ts apps/server/src/routes/tokens.ts apps/server/src/routes/health.ts | head -200
```

- [ ] **Step 2: Replace ad-hoc shapes with `jsonOk` / `HTTPError`**

For each of those four files:
- Add `import { jsonOk, HTTPError } from '../lib/http.ts';`
- Replace `c.json({ data... })` with `jsonOk(c, ...)`.
- Replace `c.json({ error: 'msg' }, 4xx)` with `throw new HTTPError('<CODE>', 'msg', 4xx)`.
- Use codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `INVALID_BODY` (422), `NOT_FOUND` (404).

If a route returned `{ token: '...' }` etc, the new shape is `{ data: { token: '...' } }`. Update by callsite — there is no current caller in the codebase (verified before this task; the frontend hasn't shipped these yet).

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: All pass. Auth + settings + tokens tests (if they exist) still green.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/src/routes/settings.ts \
        apps/server/src/routes/tokens.ts apps/server/src/routes/health.ts
git commit -m "phase-1: migrate existing routes to { data } / { error } envelope"
```

---

## Task 22: Phase 1 acceptance test

**Files:**
- Create: `apps/server/src/__e2e__/phase-1-roundtrip.test.ts`

- [ ] **Step 1: Write the acceptance test**

Create `apps/server/src/__e2e__/phase-1-roundtrip.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events } from '../db/schema.ts';

test('Phase 1 happy path: workspace → project → MD document → patch → :slug.md round-trip', async () => {
  const { app, db, seed } = await makeTestApp();
  const H = { Cookie: seed.sessionCookie };

  // 1. The harness already creates workspace "acme" + project "web".
  //    Create a fresh project via POST so default seeding runs.
  const proj = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phase One', slug: 'p1' }),
  });
  expect(proj.status).toBe(201);

  // Verify 4 default statuses + 2 default views were seeded.
  const projData = (await proj.json()).data.project;
  const { statuses, views } = await import('../db/schema.ts');
  const seededStatuses = await db.select().from(statuses).where(eq(statuses.projectId, projData.id));
  const seededViews = await db.select().from(views).where(eq(views.projectId, projData.id));
  expect(seededStatuses).toHaveLength(4);
  expect(seededViews).toHaveLength(2);

  // 2. POST text/markdown document with frontmatter
  const md = `---
type: work_item
status: in_progress
priority: high
---

# Phase One Document

Body content.
`;
  const create = await app.request('/api/v1/w/acme/p/p1/documents', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'text/markdown' },
    body: md,
  });
  expect(create.status).toBe(201);
  const doc = (await create.json()).data.document;
  expect(doc.status).toBe('in_progress');
  expect(doc.title).toBe('Phase One Document');

  // 3. PATCH JSON to change frontmatter.priority — preserves other keys
  const patch = await app.request(`/api/v1/w/acme/p/p1/documents/${doc.slug}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { priority: 'urgent' } }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.document.frontmatter.priority).toBe('urgent');

  // 4. GET :slug.md and assert round-trip
  const rt = await app.request(`/api/v1/w/acme/p/p1/documents/${doc.slug}.md`, { headers: H });
  expect(rt.status).toBe(200);
  const text = await rt.text();
  expect(text).toMatch(/priority: urgent/);
  expect(text).toMatch(/status: in_progress/);
  expect(text).toMatch(/^# Phase One Document/m);

  // 5. Events table populated
  const all = await db.select().from(events);
  const kinds = all.map((r) => r.kind);
  expect(kinds).toContain('project.created');
  expect(kinds).toContain('document.created');
  expect(kinds).toContain('document.updated');
});
```

- [ ] **Step 2: Run the acceptance test**

Run: `cd apps/server && bun test src/__e2e__/phase-1-roundtrip.test.ts`
Expected: 1 pass.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: All pass. Approximate count: ~80–90 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/__e2e__/phase-1-roundtrip.test.ts
git commit -m "phase-1: e2e acceptance — MD round-trip + events log"
```

---

## Task 23: Update PHASES.md + sanity-check the README

**Files:**
- Modify: `docs/PHASES.md`

- [ ] **Step 1: Tick the Phase 0 carry-over rows under "Workspaces & projects" and "Frontend foundation"**

Find these lines in `docs/PHASES.md` (around lines 44–57) and check the boxes that are now true:

- Line 44 — `[ ] routes/workspaces.ts: CRUD, slug uniqueness, owner membership on create` → `[x]` (note: now slug-scoped via separate router; remove the `*` annotation)
- Line 45 — `[ ] routes/projects.ts: CRUD scoped to workspace, slug unique per workspace` → `[x]`

- [ ] **Step 2: Tick the Phase 1 boxes under "Documents API" and "Statuses, fields, views"**

Find lines 109–124 and check:

- Line 111 — `routes/documents.ts: list (with filters), get, create, patch, delete` → `[x]`
- Line 112 — `Accept both JSON body and Content-Type: text/markdown` → `[x]`
- Line 113 — `lib/md.ts: parse/serialize markdown ↔ { frontmatter, body }` → `[x]` (note: lives at `apps/server/src/lib/frontmatter.ts`, not `lib/md.ts`; annotate inline)
- Line 114 — `lib/slug.ts: title → slug with per-project dedup` → `[x]` (note: pure slugify in `packages/shared/src/slug.ts`; dedup in `apps/server/src/lib/slug-unique.ts`)
- Line 115 — `GET .../:slug.md returns raw MD with frontmatter` → `[x]`
- Line 116 — `Validate status against project statuses table for work items` → `[x]`
- Line 120 — `routes/statuses.ts: CRUD; auto-seed 4 defaults` → `[x]`
- Line 121 — `routes/fields.ts: CRUD for type-pinned frontmatter fields` → `[x]`
- Line 122 — `lib/field-infer.ts: inference rules from FOLIO-BRIEFING.md §7` → `[x]` (lives in `packages/shared/src/field-infer.ts`)
- Line 123 — `routes/views.ts: CRUD; auto-seed two defaults per project` → `[x]`
- Line 124 — `lib/filter-compile.ts: ViewConfig → Drizzle where()` → `[x]` (lives in `packages/shared/src/filter-compile.ts` + adapter in `apps/server/src/lib/filter-to-drizzle.ts`)

Frontend lines 126–156 stay unchecked — those are a separate spec.

- [ ] **Step 3: Run final full-suite verification**

Run: `bun test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add docs/PHASES.md
git commit -m "phase-1: tick backend boxes in PHASES.md"
```

---

## Self-Review (run after writing the plan, before handing off)

### Spec coverage

Walk every numbered section of `docs/superpowers/specs/2026-05-11-phase-1-backend-design.md`:

- §3 file structure → Tasks 1–22 collectively create every listed file.
- §4 URL surface → Workspaces (T12), Projects (T13), Documents (T17/18/19/20), Statuses (T14), Fields (T15), Views (T16) all mounted via T11. Existing routes (auth/settings/tokens) envelope-migrated in T21.
- §5 envelope → T5 helpers; T11 registers globally; T21 migrates existing routes.
- §6 scope middleware → T9.
- §7 documents API → T17 (JSON CRUD), T18 (MD ingest), T19 (list + cursor), T20 (.md endpoint).
- §8 statuses/fields/views → T14/T15/T16.
- §9 shared helpers → slug (T2), error-codes (T2), document-schema (T2), field-infer (T3), filter-compile (T4).
- §10 server lib → http (T5), events (T6), slug-unique (T7), filter-to-drizzle (T8), seed-project-defaults (T16).
- §11 migration → T10.
- §12 auth/role → resolveWorkspace + getRole checks in T9/T12/T13.
- §13 tests → tests live alongside their feature tasks; acceptance test in T22.
- §14 acceptance criteria → T22 covers (1)–(5); T23 covers (6).
- §15 open questions → cursor pagination shape addressed in T19 with explicit OR clause; migrator vs in-memory addressed in T1 (works as-is).

No gaps.

### Placeholder scan

- No "TBD"/"TODO"/"implement later" — checked.
- No "add appropriate error handling" — every error case has an exact `HTTPError(code, message, status)`.
- No "similar to Task N" — every code block is full.
- No undefined types — `HTTPError`, `ScopeContext`, `FilterAST`, `EventKind`, `DocumentCreateInput`, etc. each defined in their introducing task.

### Type consistency

- `slugify` named the same way everywhere (T2 onward).
- `emitEvent` signature stable across T6/T12/T13/T14/T15/T16/T17/T18/T19/T20.
- `getProject` / `getWorkspace` / `getRole` defined in T9, used by T12+.
- `documentCreateSchema` / `documentPatchSchema` defined in T2, consumed in T17 and (replaced by inline parsing) in T18.
- `parseMarkdown` / `serializeMarkdown` already exist in `apps/server/src/lib/frontmatter.ts` — imported in T18 (POST/PATCH) and T20 (.md GET). Filename is `frontmatter.ts`, NOT `md.ts` — flagged in T23.
- `seedProjectDefaults` signature: `(tx, projectId)` — same in T16 definition and projects.ts call site.

All consistent.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-phase-1-backend.md`.
