# Phase 1 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase 1 web UI on top of the existing REST API: onboarding (workspace + project create), routing scaffold, list view, slideover with Milkdown body + CodeMirror raw-MD toggle, kanban with dnd-kit, wiki tree, filter chips, copy-as-MD, minimal Cmd-K. End state: a new user can sign up, create a workspace + project, run a realistic work session, and round-trip a document through raw markdown without loss.

**Architecture:** TanStack Router file-based routes nested as `/w/$wslug/p/$pslug/{work-items,board,wiki}`. The document slideover is a sibling component to each view, summoned by a `?doc=<slug>` search param so URL state survives view-tab switches. TanStack Query owns server state; mutations go through one canonical `useOptimisticPatch` helper that snapshots → applies → on-error rolls back. Per-resource API modules under `lib/api/` are the only places that know URL shapes. Components import hooks, never URLs. The slideover keeps `frontmatter` and `body` as separate pieces of state — saves send JSON, not serialized MD, because we don't round-trip through the parser on every keystroke.

**Tech Stack:** React 18, TanStack Router, TanStack Query, Tailwind (already configured), radix Sheet/Popover/Dialog (already installed), cmdk (already installed), sonner (already installed), Milkdown (new), CodeMirror 6 (new), dnd-kit (new), Vitest + @testing-library/react + jsdom (new dev deps).

**Spec:** `docs/superpowers/specs/2026-05-11-phase-1-core-crud-design.md` — read it once before starting Task 1. Specifically §5 (frontend), §6 (testing & acceptance), §7 (file structure), §8 (implementation order).

---

## Prep — Conventions for every task

1. Run from repo root: `/home/ntdst/Projects/folio`. All commands assume that cwd unless prefixed otherwise.
2. After every step that changes code, run only the tests relevant to that step. Run the whole suite (`bun test`) at the acceptance checkpoints called out in tasks.
3. Each task ends with a commit. Commit message format: `phase-1: <what>`.
4. The active branch is `phase-1/frontend`. Stay on it. Do NOT commit to main.
5. The plan assumes the design system primitives in `apps/web/src/components/{shell,ui}/` exist and are stable. Verify with `ls apps/web/src/components/ui` before Task 1 — you should see `button.tsx`, `pill.tsx`, `chip.tsx`, `badge.tsx`, `avatar.tsx`, `kbd.tsx`, `icon-button.tsx`, `dialog.tsx`, `sheet.tsx`, `popover.tsx`, `command.tsx`, `toast.tsx`, `theme-toggle.tsx`, `cn.ts`.
6. The backend (`apps/server/`) is shipped and stable. If a Phase 1 frontend task uncovers a missing field or behavior on an endpoint, file it in a follow-up task at the bottom of this plan — don't sneak server changes into a frontend task.
7. Frontend tests use Vitest, not `bun:test`. Bun runs Vitest via its node-compat shim; the existing web `tsconfig.json` already excludes `*.test.ts` from `tsc`. Test files end in `.test.tsx` and live next to the source.
8. Path aliases: components import from `../components/...`, hooks from `../lib/api/...`. The web tsconfig has `@/*` mapped to `apps/web/src/*` but the existing codebase uses relative paths — match the existing style.

---

## File Structure

This plan creates or modifies the following files. Each row is a clear responsibility boundary; see the spec §7 for the bigger picture.

### Routes (TanStack file-based)

| File | Responsibility |
|---|---|
| `apps/web/src/routes/__root.tsx` | Modify — add `beforeLoad` auth gate (redirect to /login on 401); Toaster region |
| `apps/web/src/routes/index.tsx` | Modify — workspace picker (replaces welcome page) |
| `apps/web/src/routes/w.$wslug.tsx` | New — workspace layout (rail + outlet) |
| `apps/web/src/routes/w.$wslug.index.tsx` | New — project picker / empty state |
| `apps/web/src/routes/w.$wslug.p.$pslug.tsx` | New — project layout (frame + tabs + slideover host) |
| `apps/web/src/routes/w.$wslug.p.$pslug.index.tsx` | New — redirect to work-items |
| `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` | New — list view route |
| `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx` | New — kanban route |
| `apps/web/src/routes/w.$wslug.p.$pslug.wiki.tsx` | New — wiki tree route |

### API client layer

| File | Responsibility |
|---|---|
| `apps/web/src/lib/api/client.ts` | Move — current `lib/api.ts` content; thin fetch wrapper |
| `apps/web/src/lib/api/errors.ts` | New — `formatApiError`, `apiErrorCode`, global 401 redirect |
| `apps/web/src/lib/api/optimistic.ts` | New — `useOptimisticPatch` canonical mutation helper |
| `apps/web/src/lib/api/auth.ts` | New — `useMe`, login/logout/magic mutation hooks |
| `apps/web/src/lib/api/workspaces.ts` | New — CRUD hooks + key factory |
| `apps/web/src/lib/api/projects.ts` | New — CRUD hooks + key factory |
| `apps/web/src/lib/api/documents.ts` | New — list/get/create/patch/delete + `patchMd` + key factory |
| `apps/web/src/lib/api/statuses.ts` | New — read-only hooks for Phase 1 (defaults are seeded server-side) |
| `apps/web/src/lib/api/fields.ts` | New — read-only hooks for Phase 1 |
| `apps/web/src/lib/api/views.ts` | New — read-only hooks for Phase 1 |
| `apps/web/src/lib/api/index.ts` | New — barrel re-export |

### Components — onboarding & shell

| File | Responsibility |
|---|---|
| `apps/web/src/components/workspace-picker.tsx` | New — list workspaces, empty state, create button |
| `apps/web/src/components/onboarding/workspace-create.tsx` | New — Sheet form (name + slug + AI provider stub) |
| `apps/web/src/components/onboarding/project-create.tsx` | New — Sheet form (name + slug) |
| `apps/web/src/components/project-picker.tsx` | New — list projects in a workspace |

### Components — inline editing

| File | Responsibility |
|---|---|
| `apps/web/src/components/inline/inline-edit.tsx` | New — display ↔ input; Enter commits, Esc reverts |
| `apps/web/src/components/inline/inline-select.tsx` | New — display ↔ popover; click commits |

### Components — views

| File | Responsibility |
|---|---|
| `apps/web/src/components/views/list-view.tsx` | New — flat row render of documents |
| `apps/web/src/components/views/list-row.tsx` | New — single row (title + status + frontmatter cells) |
| `apps/web/src/components/views/kanban-view.tsx` | New — columns grouped by status |
| `apps/web/src/components/views/wiki-tree.tsx` | New — tree by parent_id |
| `apps/web/src/components/views/empty-state.tsx` | New — shared empty state |
| `apps/web/src/components/views/row-context-menu.tsx` | New — right-click "Copy as Markdown" |

### Components — slideover & editor

| File | Responsibility |
|---|---|
| `apps/web/src/components/slideover/document-slideover.tsx` | New — reads `?doc=`, fetches, hosts editor |
| `apps/web/src/components/slideover/frontmatter-form.tsx` | New — labeled inputs above body |
| `apps/web/src/components/slideover/field-renderer.tsx` | New — dispatch by inferred/pinned type |
| `apps/web/src/components/slideover/body-editor.tsx` | New — Milkdown wrapper |
| `apps/web/src/components/slideover/raw-md-editor.tsx` | New — CodeMirror wrapper |
| `apps/web/src/components/slideover/mode-toggle.tsx` | New — rich ⇌ raw switch |
| `apps/web/src/components/slideover/slash-menu.tsx` | New — Milkdown slash plugin items |

### Components — filter + kanban

| File | Responsibility |
|---|---|
| `apps/web/src/components/filter/filter-bar.tsx` | New — chip row above list |
| `apps/web/src/components/filter/filter-chip.tsx` | New — single applied filter |
| `apps/web/src/components/filter/filter-add.tsx` | New — "+ Filter" popover |
| `apps/web/src/components/kanban/kanban-card.tsx` | New — single draggable card |
| `apps/web/src/components/kanban/kanban-column.tsx` | New — droppable column |

### Components — command palette

| File | Responsibility |
|---|---|
| `apps/web/src/components/command-palette.tsx` | New — Cmd-K root |
| `apps/web/src/lib/command-registry.ts` | New — action registry (id, label, run) |

### Misc lib

| File | Responsibility |
|---|---|
| `apps/web/src/lib/debounce.ts` | New — small debounce util for body edits |
| `apps/web/src/styles/editor.css` | New — Milkdown class overrides via design tokens |

### Manual QA

| File | Responsibility |
|---|---|
| `apps/web/tests/manual-qa-phase-1.md` | New — the 14-scenario checklist from spec §6.3 |

---

## Task 1: Vitest setup + dev dependencies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/test-setup.ts`
- Create: `apps/web/src/test-smoke.test.tsx`

- [ ] **Step 1: Add Vitest + testing-library dev deps**

```bash
bun add --filter @folio/web -d vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react @types/node
```

Expected: `apps/web/package.json` gets new `devDependencies` entries. The `@vitejs/plugin-react` is already a dep but harmless if re-added.

- [ ] **Step 2: Add `test` script**

Edit `apps/web/package.json` `scripts`:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Vitest config**

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    css: false,
  },
});
```

- [ ] **Step 4: Test setup file**

Create `apps/web/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Smoke test**

Create `apps/web/src/test-smoke.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('vitest smoke', () => {
  it('renders text', () => {
    render(<div>hello</div>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the smoke test**

```bash
bun run --filter @folio/web test
```

Expected: 1 pass.

- [ ] **Step 7: Ensure tsc excludes vitest config from build**

`apps/web/tsconfig.json` should already exclude `*.test.ts`. Verify it also excludes `vitest.config.ts`. If not, add it to `exclude`:

```json
"exclude": ["**/*.test.ts", "**/*.test.tsx", "vitest.config.ts"]
```

Then re-run `bun run --filter @folio/web build` to confirm tsc passes. Expected: no type errors.

- [ ] **Step 8: Delete the smoke test, commit**

```bash
rm apps/web/src/test-smoke.test.tsx
git add apps/web/package.json apps/web/tsconfig.json apps/web/vitest.config.ts apps/web/src/test-setup.ts bun.lock
git commit -m "phase-1: vitest + testing-library setup for web"
```

---

## Task 2: API client core — unwrap envelope + typed errors

**Files:**
- Create: `apps/web/src/lib/api/client.ts`
- Create: `apps/web/src/lib/api/errors.ts`
- Create: `apps/web/src/lib/api/errors.test.ts`
- Delete: `apps/web/src/lib/api.ts`
- Modify: every existing import of `lib/api.ts` to point at `lib/api/client.ts`

- [ ] **Step 1: Write failing test for errors helpers**

Create `apps/web/src/lib/api/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ApiError } from './client.ts';
import { formatApiError, apiErrorCode } from './errors.ts';

describe('formatApiError', () => {
  it('uses message from API error envelope', () => {
    const err = new ApiError(409, { error: { code: 'SLUG_TAKEN', message: 'Slug already exists' } });
    expect(formatApiError(err)).toBe('Slug already exists');
  });

  it('falls back to status for ApiError without envelope', () => {
    const err = new ApiError(500, null);
    expect(formatApiError(err)).toBe('Something went wrong');
  });

  it('falls back for non-ApiError', () => {
    expect(formatApiError(new Error('boom'))).toBe('boom');
    expect(formatApiError('boom')).toBe('Something went wrong');
  });
});

describe('apiErrorCode', () => {
  it('extracts code from ApiError envelope', () => {
    const err = new ApiError(409, { error: { code: 'SLUG_TAKEN', message: 'x' } });
    expect(apiErrorCode(err)).toBe('SLUG_TAKEN');
  });

  it('returns null for non-API errors', () => {
    expect(apiErrorCode(new Error('boom'))).toBeNull();
    expect(apiErrorCode('boom')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — confirm it fails on missing modules**

```bash
bun run --filter @folio/web test src/lib/api/errors.test.ts
```

Expected: FAIL (modules don't exist).

- [ ] **Step 3: Write the new client + errors module**

Create `apps/web/src/lib/api/client.ts`:

```ts
/**
 * Folio API client. Cookies handle auth. Successful responses are unwrapped
 * from the `{ data }` envelope. Failures throw ApiError carrying the parsed
 * body so callers can branch on { error: { code, message } }.
 */

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}

type EnvelopeOk<T> = { data: T };

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  contentType: 'application/json' | 'text/markdown' = 'application/json',
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': contentType };
    init.body = contentType === 'application/json' ? JSON.stringify(body) : (body as string);
  }
  const res = await fetch(path, init);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('text/markdown')) {
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, null);
    return text as T;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as EnvelopeOk<T>).data;
  }
  return json as T;
}

export const client = {
  get: <T>(path: string) => request<T>('GET', path),
  getRaw: (path: string) => request<string>('GET', path),  // for .md exports
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postMd: <T>(path: string, md: string) => request<T>('POST', path, md, 'text/markdown'),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  patchMd: <T>(path: string, md: string) => request<T>('PATCH', path, md, 'text/markdown'),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};
```

Create `apps/web/src/lib/api/errors.ts`:

```ts
import { ApiError } from './client.ts';
import type { ErrorCodeType } from '@folio/shared';

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function envelope(body: unknown): ErrorEnvelope | null {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null &&
    'code' in (body as ErrorEnvelope).error &&
    'message' in (body as ErrorEnvelope).error
  ) {
    return body as ErrorEnvelope;
  }
  return null;
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const env = envelope(err.body);
    if (env) return env.error.message;
    return 'Something went wrong';
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export function apiErrorCode(err: unknown): ErrorCodeType | null {
  if (err instanceof ApiError) {
    const env = envelope(err.body);
    if (env) return env.error.code as ErrorCodeType;
  }
  return null;
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
bun run --filter @folio/web test src/lib/api/errors.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Migrate existing callers**

Delete `apps/web/src/lib/api.ts`. Update existing imports:

- `apps/web/src/routes/index.tsx`: change `import { api } from '../lib/api.ts'` → `import { client } from '../lib/api/client.ts'`. Replace `api.get<Me>` with `client.get<{ user: { id: string; email: string; name: string } }>`. The query now resolves to the unwrapped user object — adjust the `Me` interface accordingly: `interface Me { user: { id: string; email: string; name: string }; }` already matches because we unwrap `data`.
- `apps/web/src/routes/login.tsx`: change `import { api } from '../lib/api.ts'` → `import { client } from '../lib/api/client.ts'`. Replace `api.post` calls with `client.post`.

Search for any other references:

```bash
grep -rn "from '.*lib/api'" apps/web/src
grep -rn "from '.*lib/api.ts'" apps/web/src
```

Expected: no remaining hits after the migration.

- [ ] **Step 6: Manual smoke — login still works**

```bash
bun --filter @folio/server dev &  # backend on :3000
bun --filter @folio/web dev        # vite on :5173
```

Open `http://localhost:5173/login`, log in with an existing account (or register via `/login` form). Confirm `/` shows your name correctly (previously it showed `undefined` due to the envelope bug; with this change it shows the real name). Then `Ctrl-C` both processes.

- [ ] **Step 7: Run all web tests**

```bash
bun run --filter @folio/web test
```

Expected: all pass (the `theme.test.ts` and `cn.test.ts` from Phase 0.5 should still pass; the new `errors.test.ts` adds 5).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api/ apps/web/src/routes/index.tsx apps/web/src/routes/login.tsx
git rm apps/web/src/lib/api.ts
git commit -m "phase-1: api client unwraps data envelope; typed error helpers"
```

---

## Task 3: useOptimisticPatch helper

**Files:**
- Create: `apps/web/src/lib/api/optimistic.ts`
- Create: `apps/web/src/lib/api/optimistic.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/lib/api/optimistic.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { ApiError } from './client.ts';
import { useOptimisticPatch } from './optimistic.ts';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

interface Doc { slug: string; title: string; }
type PatchVars = { slug: string; patch: Partial<Doc> };

describe('useOptimisticPatch', () => {
  let qc: QueryClient;
  const detail = (slug: string) => ['doc', slug];
  const list = ['docs'];

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(detail('a'), { slug: 'a', title: 'old' });
    qc.setQueryData(list, [{ slug: 'a', title: 'old' }, { slug: 'b', title: 'b' }]);
  });

  it('applies optimistic patch on mutate; rolls back on error', async () => {
    const { result } = renderHook(
      () =>
        useOptimisticPatch<Doc, PatchVars>({
          detailKey: ({ slug }) => detail(slug),
          listKey: list,
          mutationFn: async () => {
            throw new ApiError(500, null);
          },
          applyToDetail: (prev, { patch }) => ({ ...prev, ...patch }),
          applyToList: (prev, { slug, patch }) =>
            prev.map((d) => (d.slug === slug ? { ...d, ...patch } : d)),
        }),
      { wrapper: wrap(qc) },
    );

    await act(async () => {
      try { await result.current.mutateAsync({ slug: 'a', patch: { title: 'new' } }); } catch {}
    });

    // Cache rolled back to the original
    expect(qc.getQueryData(detail('a'))).toEqual({ slug: 'a', title: 'old' });
    const listVal = qc.getQueryData<Doc[]>(list)!;
    expect(listVal.find((d) => d.slug === 'a')?.title).toBe('old');
  });

  it('keeps optimistic state on success and invalidates', async () => {
    const { result } = renderHook(
      () =>
        useOptimisticPatch<Doc, PatchVars>({
          detailKey: ({ slug }) => detail(slug),
          listKey: list,
          mutationFn: async ({ slug, patch }) => ({ slug, title: patch.title ?? 'old' }),
          applyToDetail: (prev, { patch }) => ({ ...prev, ...patch }),
          applyToList: (prev, { slug, patch }) =>
            prev.map((d) => (d.slug === slug ? { ...d, ...patch } : d)),
        }),
      { wrapper: wrap(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync({ slug: 'a', patch: { title: 'new' } });
    });

    await waitFor(() => {
      expect(qc.getQueryData<Doc>(detail('a'))?.title).toBe('new');
    });
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun run --filter @folio/web test src/lib/api/optimistic.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `apps/web/src/lib/api/optimistic.ts`:

```ts
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

export interface UseOptimisticPatchOptions<TData, TVars> {
  detailKey: (vars: TVars) => QueryKey;
  listKey?: QueryKey;
  mutationFn: (vars: TVars) => Promise<TData>;
  applyToDetail: (prev: TData, vars: TVars) => TData;
  applyToList?: (prev: TData[], vars: TVars) => TData[];
}

export function useOptimisticPatch<TData, TVars>(opts: UseOptimisticPatchOptions<TData, TVars>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const detail = opts.detailKey(vars);
      await qc.cancelQueries({ queryKey: detail });
      if (opts.listKey) await qc.cancelQueries({ queryKey: opts.listKey });
      const prevDetail = qc.getQueryData<TData>(detail);
      const prevList = opts.listKey ? qc.getQueryData<TData[]>(opts.listKey) : undefined;
      if (prevDetail !== undefined) {
        qc.setQueryData(detail, opts.applyToDetail(prevDetail, vars));
      }
      if (opts.listKey && opts.applyToList && prevList !== undefined) {
        qc.setQueryData(opts.listKey, opts.applyToList(prevList, vars));
      }
      return { prevDetail, prevList, detail };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevDetail !== undefined) qc.setQueryData(ctx.detail, ctx.prevDetail);
      if (opts.listKey && ctx.prevList !== undefined) qc.setQueryData(opts.listKey, ctx.prevList);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: opts.detailKey(vars) });
      if (opts.listKey) qc.invalidateQueries({ queryKey: opts.listKey });
    },
  });
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
bun run --filter @folio/web test src/lib/api/optimistic.test.tsx
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/optimistic.ts apps/web/src/lib/api/optimistic.test.tsx
git commit -m "phase-1: useOptimisticPatch — canonical mutation shape"
```

---


---

> **Plan in progress.** Tasks 1-3 are fully written. Tasks 4-30 (per-resource API modules, routing scaffold, onboarding Sheets, list view, inline-edit primitives, slideover, Milkdown body editor, CodeMirror raw editor + round-trip test, slash menu, filter chips, sort, kanban + dnd-kit, wiki tree, copy-as-MD, minimal Cmd-K, manual QA scaffold, Phase 1 completion commit) are still to be written. Resume by reading `docs/superpowers/specs/2026-05-11-phase-1-core-crud-design.md` §8 (Implementation order) — the remaining tasks map 1:1 to steps 5-19 there. Tasks 1-3 already cover the Vitest setup + the foundational API client and `useOptimisticPatch` helper that everything else depends on.
