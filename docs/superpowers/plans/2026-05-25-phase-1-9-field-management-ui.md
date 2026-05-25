# Phase 1.9 — Field Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Test discipline:** Every task is RED → GREEN → REFACTOR. Each task ends with a unit-test gate (Vitest + Bun test). The phase ends with an integration gate (full unit suites green) and an acceptance gate (manual smoke checklist + optional Playwright spec).

**Goal:** Make the spreadsheet table's column model editable from inside the table — users can add a pinned field via `+ Add column`, rename or delete it via a `⋯` menu on each header cell, and promote orphan frontmatter keys via a "Suggested columns" section in the existing column picker. `useFields` is rescoped from project-level to table-level so each table's column set is its own. This must land before Phase 2 (Agents) because agents will write new frontmatter keys and users need a frictionless way to pin them.

**Architecture:**
- Frontend-only feature on top of existing backend (`/api/v1/w/:wslug/p/:pslug/t/:tslug/fields` was shipped in Phase 1.5a).
- Add `tslug` to the `useFields` query key and URL; thread it through `TableView` and its consumers. Default to `"work-items"` when the route doesn't supply one — Phase 6 will introduce explicit `:tslug` in the URL.
- New mutation hooks `useCreateField`, `useUpdateField`, `useDeleteField` next to `useFields`. They mirror `useUpdateView`/`useDeleteView` shape.
- Two new components: `TableAddColumn` (header-trailing inline-popover form) and `ColumnMenu` (hover-revealed `⋯` per non-builtin header cell).
- `ColumnPicker` gains a "Suggested columns" section that scans `documents.frontmatter` for keys not in `fields` and offers `+ Pin` per suggestion.
- **Out of scope for 1.9 (deferred to 1.9.1):** type-change UI, value-remap migration matrix. The `⋯` menu in 1.9 surfaces Rename / Hide / Delete only.

**Tech Stack:** React 18, TanStack Query, TanStack Router, Tailwind, Radix Popover/Dialog, Vitest + Testing Library, Lucide icons, `cmdk` (already in use), Hono server (no backend changes).

**Branch:** `phase-1.9/field-management-ui` cut from `main` at `31af44d`.

---

## File Structure

**New files (web):**
- `apps/web/src/components/table/table-add-column.tsx` — popover form to create a field
- `apps/web/src/components/table/table-add-column.test.tsx`
- `apps/web/src/components/table/column-menu.tsx` — the `⋯` popover (Rename / Hide / Delete) shown on hover
- `apps/web/src/components/table/column-menu.test.tsx`
- `apps/web/src/components/table/column-suggestions.ts` — pure helper that derives the suggestion list from documents
- `apps/web/src/components/table/column-suggestions.test.ts`

**Modified files (web):**
- `apps/web/src/lib/api/fields.ts` — add `tslug` param to `useFields`, add `useCreateField` / `useUpdateField` / `useDeleteField` mutations
- `apps/web/src/components/table/table-view.tsx` — accept `tslug`, pass to `useFields`, wire mutations, mount `TableAddColumn` in header
- `apps/web/src/components/table/table-header.tsx` — render `ColumnMenu` per non-builtin column on hover; render `TableAddColumn` trailing the last header cell
- `apps/web/src/components/table/column-picker.tsx` — render "Suggested columns" section below existing visible/hidden list
- `apps/web/src/components/slideover/document-slideover.tsx` — pass `tslug` (default `"work-items"`) into `useFields`
- `apps/web/src/components/views/list-view.tsx` — same
- `apps/web/src/components/filter/filter-bar.tsx` and `filter-add.tsx` — these only import the `Field` type; no behavior change
- `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` — pass `tslug="work-items"` to `TableView`
- All existing `*.test.tsx` files that mock `/api/v1/.../fields` — update the URL pattern check to also match the table-scoped path

**Modified files (server):** none. The backend already supports `/api/v1/w/:wslug/p/:pslug/t/:tslug/fields`.

---

## Conventions

- **TDD per task.** Write failing test → run → see red → implement minimum → run → green → commit.
- **Unit test runner (web):** `bun run --filter @folio/web test -- <path>` from repo root, OR `cd apps/web && bun run test -- <path>`. Per memory: do NOT use bare `bun test` from repo root for web tests.
- **Unit test runner (server):** `cd apps/server && bun test <path>` — no changes expected in this phase but verify the suite stays green.
- **Type-check:** `cd apps/web && bunx tsc --noEmit`. Pre-existing errors in `apps/server/src/index.ts` and `packages/shared/src/filter-compile.test.ts` are not blockers — do not "fix" them in this phase.
- **Commit cadence:** one commit per task. Atomic. Message format: `phase-1.9: <what>` for feature work; `phase-1.9: test: <what>` for test-only commits if any get split out.
- **CSS:** existing utilities only (`folio-scroll`, `bg-card`, `text-fg-3`, etc.). No new tokens.

---

## Task 1: Add `tslug` parameter to `useFields`

**Files:**
- Modify: `apps/web/src/lib/api/fields.ts` (lines 28-39)
- Test: write the test directly in `apps/web/src/lib/api/fields.test.ts` (new file)

### Step 1: Write the failing test

**Create `apps/web/src/lib/api/fields.test.ts`:**

```ts
import { describe, expect, it } from 'vitest';
import { fieldsKeys } from './fields.ts';

describe('fieldsKeys', () => {
  it('list key includes wslug, pslug and tslug', () => {
    expect(fieldsKeys.list('acme', 'sales', 'work-items')).toEqual([
      'fields',
      'acme',
      'sales',
      'work-items',
    ]);
  });

  it('list key for the same project but different tables produces different keys', () => {
    const a = fieldsKeys.list('acme', 'sales', 'work-items');
    const b = fieldsKeys.list('acme', 'sales', 'bugs');
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test fields.test.ts`
Expected: FAIL — `fieldsKeys.list` is called with three args but currently accepts two.

- [ ] **Step 3: Update `useFields` and `fieldsKeys` signatures**

Replace lines 28-39 of `apps/web/src/lib/api/fields.ts` with:

```ts
export const fieldsKeys = {
  list: (wslug: string, pslug: string, tslug: string) =>
    ['fields', wslug, pslug, tslug] as const,
};

export function useFields(wslug: string, pslug: string, tslug: string) {
  return useQuery({
    queryKey: fieldsKeys.list(wslug, pslug, tslug),
    queryFn: () =>
      client.get<Field[]>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug && !!tslug,
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun run test fields.test.ts`
Expected: PASS — both cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/fields.ts apps/web/src/lib/api/fields.test.ts
git commit -m "phase-1.9: rescope useFields query key to (wslug, pslug, tslug)"
```

---

## Task 2: Thread `tslug` through `TableView` and its callers

**Files:**
- Modify: `apps/web/src/components/table/table-view.tsx` (Props interface line 34-37; useFields call line 73)
- Modify: `apps/web/src/components/slideover/document-slideover.tsx` (line 279)
- Modify: `apps/web/src/components/views/list-view.tsx`
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` (line 28-30)
- Modify: `apps/web/src/components/table/table-view.test.tsx` (all `/fields` fetch mocks)
- Test: existing `apps/web/src/components/table/table-view.test.tsx` covers this

### Step 1: Write the failing test (extend table-view.test.tsx)

Find the first `it(` block in `apps/web/src/components/table/table-view.test.tsx`. Above it, add a new test:

```ts
it('fetches fields from the table-scoped endpoint when tslug is provided', async () => {
  const fetchCalls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo) => {
    const u = String(input);
    fetchCalls.push(u);
    if (u.includes('/fields') && !u.includes('/t/work-items/')) {
      throw new Error(`useFields hit the wrong URL: ${u}`);
    }
    return jsonResponse(emptyListResponse());
  }) as unknown as typeof fetch;

  renderTableView({ wslug: 'acme', pslug: 'sales', tslug: 'work-items' });

  await waitFor(() => {
    expect(
      fetchCalls.some((u) => u.includes('/p/sales/t/work-items/fields')),
    ).toBe(true);
  });
});
```

> Reuse whatever fetch-mock + render helpers are already in the file. The exact helper names are in the existing tests; copy their setup.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test table-view.test.tsx`
Expected: FAIL — currently `useFields` hits `/p/sales/fields` not `/p/sales/t/work-items/fields`.

- [ ] **Step 3: Update `TableView` props and propagate `tslug`**

Change the `Props` interface in `table-view.tsx` (line 34-37):

```tsx
interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}
```

Update the function signature (line 54):

```tsx
export function TableView({ wslug, pslug, tslug }: Props) {
```

Update the `useFields` call (line 73):

```tsx
const { data: fields } = useFields(wslug, pslug, tslug);
```

- [ ] **Step 4: Update the route to pass `tslug`**

In `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx`, change `WorkItemsRoute`:

```tsx
function WorkItemsRoute() {
  const { wslug, pslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} tslug="work-items" />;
}
```

- [ ] **Step 5: Update `DocumentSlideover` and `ListView`**

In `apps/web/src/components/slideover/document-slideover.tsx` line 279:

```tsx
const { data: fields } = useFields(wslug, pslug, 'work-items');
```

In `apps/web/src/components/views/list-view.tsx`, locate the `useFields(wslug, pslug)` call and change to:

```tsx
const { data: fields } = useFields(wslug, pslug, 'work-items');
```

> **Why a literal `"work-items"` here:** these surfaces don't yet have a `tslug` in scope. Phase 6 (per-view render modes) will introduce explicit table routing; until then, every existing surface targets the default `work-items` table.

- [ ] **Step 6: Update all existing fetch mocks that match `/fields`**

In every `*.test.tsx` file that contains `if (u.includes('/fields')`, the match still works because the new URL also contains `/fields` as a substring. Verify by grepping:

```bash
grep -rn "includes('/fields')" apps/web/src
```

No change needed — substring match accepts both the old `/p/sales/fields` and new `/p/sales/t/work-items/fields`. If any test asserts on the exact URL, update those literals.

- [ ] **Step 7: Run the full web suite to confirm no regressions**

Run: `cd apps/web && bun run test`
Expected: all tests green, including the new one.

- [ ] **Step 8: Type-check**

Run: `cd apps/web && bunx tsc --noEmit 2>&1 | grep -v "node_modules" | head -40`
Expected: no NEW type errors in the touched files (pre-existing server/shared errors are fine).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/table/table-view.tsx \
        apps/web/src/components/table/table-view.test.tsx \
        apps/web/src/components/slideover/document-slideover.tsx \
        apps/web/src/components/views/list-view.tsx \
        apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx
git commit -m "phase-1.9: thread tslug through TableView and its callers"
```

---

## Task 3: Add `useCreateField`, `useUpdateField`, `useDeleteField` mutation hooks

**Files:**
- Modify: `apps/web/src/lib/api/fields.ts`
- Modify: `apps/web/src/lib/api/fields.test.ts`

### Step 1: Write the failing test

Add to `apps/web/src/lib/api/fields.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCreateField, useUpdateField, useDeleteField } from './fields.ts';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useCreateField', () => {
  it('POSTs to the table-scoped fields endpoint and returns the created field', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ data: { field: { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'], required: false, order: 0 } } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCreateField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    const created = await result.current.mutateAsync({ key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'] });

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields');
    expect(calls[0].body).toEqual({ key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'] });
    expect(created.id).toBe('f1');
  });
});

describe('useUpdateField', () => {
  it('PATCHes /fields/:id with the supplied patch', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ data: { id: 'f1', key: 'priority', type: 'select', label: 'Priority renamed', options: ['low', 'high'], required: false, order: 0 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpdateField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ id: 'f1', patch: { label: 'Priority renamed' } });

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields/f1');
    expect(calls[0].method).toBe('PATCH');
  });
});

describe('useDeleteField', () => {
  it('DELETEs /fields/:id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useDeleteField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('f1');

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields/f1');
    expect(calls[0].method).toBe('DELETE');
  });
});
```

Add the import at the top of the file:

```ts
import { vi } from 'vitest';
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/web && bun run test fields.test.ts`
Expected: FAIL — `useCreateField`/`useUpdateField`/`useDeleteField` not exported.

- [ ] **Step 3: Add the mutation hooks**

Append to `apps/web/src/lib/api/fields.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface FieldCreate {
  key: string;
  type: FieldType;
  label?: string;
  options?: string[];
  order?: number;
}

export function useCreateField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server returns `{ data: { field: row } }`; client.post unwraps the outer
    // `data` envelope but not the inner `field` key.
    mutationFn: async (payload: FieldCreate): Promise<Field> => {
      const wrapped = await client.post<{ field: Field }>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields`,
        payload,
      );
      return wrapped.field;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) }),
  });
}

export interface FieldPatch {
  key?: string;
  type?: FieldType;
  label?: string;
  options?: string[];
  order?: number;
}

export function useUpdateField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FieldPatch }) =>
      client.patch<Field>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields/${id}`,
        patch,
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) }),
  });
}

export function useDeleteField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) }),
  });
}
```

Update the existing top-of-file import line:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
```

(Remove the duplicate import you appended in the block above — fold them into the existing line.)

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/web && bun run test fields.test.ts`
Expected: PASS — all four `describe` blocks green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/fields.ts apps/web/src/lib/api/fields.test.ts
git commit -m "phase-1.9: add useCreateField/useUpdateField/useDeleteField"
```

---

## Task 4: Build `TableAddColumn` popover form

**Files:**
- Create: `apps/web/src/components/table/table-add-column.tsx`
- Test: `apps/web/src/components/table/table-add-column.test.tsx`

This is a controlled popover. Trigger = a small `+` IconButton sized to match header height. Content = a form with `key`, `label`, `type` (and conditional `options`). Submit calls the supplied `onSubmit` and closes on success.

### Step 1: Write the failing test

**Create `apps/web/src/components/table/table-add-column.test.tsx`:**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TableAddColumn } from './table-add-column.tsx';

describe('TableAddColumn', () => {
  it('opens a popover and submits a valid string field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TableAddColumn onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'string' } });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ key: 'owner', label: 'Owner', type: 'string' });
    });
  });

  it('rejects invalid keys (uppercase, leading number, special chars)', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'Owner Name' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/lowercase letters, numbers, underscore/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires options for select and multi_select types', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'priority' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'select' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/at least one option/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires a 3-letter ISO code for currency', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'price' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'currency' } });
    // currency input defaults to EUR; clear it and submit empty
    fireEvent.change(screen.getByLabelText(/iso code/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/3-letter iso-4217/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-derives the label from the key when label is left blank', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'next_action' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'next_action', label: 'Next Action', type: 'string' }),
      );
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test table-add-column.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TableAddColumn`**

**Create `apps/web/src/components/table/table-add-column.tsx`:**

```tsx
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import type { FieldType } from '../../lib/api/fields.ts';

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'string', label: 'Text (single line)' },
  { value: 'text', label: 'Text (multi-line)' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'select', label: 'Select (one of)' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'user_ref', label: 'User' },
  { value: 'url', label: 'URL' },
  { value: 'document_ref', label: 'Document link' },
];

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ISO_RE = /^[A-Z]{3}$/;

function titleize(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface AddColumnPayload {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

interface Props {
  onSubmit: (payload: AddColumnPayload) => Promise<void> | void;
}

export function TableAddColumn({ onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('string');
  const [optionsText, setOptionsText] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setKey('');
    setLabel('');
    setType('string');
    setOptionsText('');
    setCurrencyCode('EUR');
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!KEY_RE.test(key)) {
      setError('Key must start with a lowercase letter and contain only lowercase letters, numbers, underscore.');
      return;
    }
    let options: string[] | undefined;
    if (type === 'select' || type === 'multi_select') {
      const parsed = optionsText.split(',').map((s) => s.trim()).filter(Boolean);
      if (parsed.length === 0) {
        setError(`${type} requires at least one option.`);
        return;
      }
      options = parsed;
    } else if (type === 'currency') {
      if (!ISO_RE.test(currencyCode)) {
        setError('Currency requires a 3-letter ISO-4217 code (e.g. EUR, USD).');
        return;
      }
      options = [currencyCode];
    }
    const finalLabel = label.trim() || titleize(key);

    setSubmitting(true);
    try {
      const payload: AddColumnPayload = { key, label: finalLabel, type };
      if (options) payload.options = options;
      await onSubmit(payload);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create column.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setError(null); }}>
      <PopoverTrigger asChild>
        <IconButton label="Add column" size="sm">
          <Icon icon={Plus} size={14} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-3">
        <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
          <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-key">Key</label>
          <input
            id="add-col-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. next_action"
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
            autoFocus
          />

          <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-label">Label</label>
          <input
            id="add-col-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="auto-derived from key"
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          />

          <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-type">Type</label>
          <select
            id="add-col-type"
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>

          {(type === 'select' || type === 'multi_select') ? (
            <>
              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-options">Options (comma-separated)</label>
              <input
                id="add-col-options"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder="low, medium, high"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {type === 'currency' ? (
            <>
              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-iso">ISO code</label>
              <input
                id="add-col-iso"
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="EUR"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {error ? <p className="text-xs text-danger">{error}</p> : null}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { reset(); setOpen(false); }}
              className="rounded-sm px-2 py-1 text-sm text-fg-2 hover:text-fg-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-sm bg-fg-1 px-2 py-1 text-sm text-content disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
```

> If the existing button styles in the file use different utility classes than `bg-fg-1 text-content`, copy whatever pattern `TableAddRow` (in the same folder) uses to stay visually consistent.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/web && bun run test table-add-column.test.tsx`
Expected: PASS — all five test cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/table/table-add-column.tsx \
        apps/web/src/components/table/table-add-column.test.tsx
git commit -m "phase-1.9: add TableAddColumn popover form"
```

---

## Task 5: Mount `TableAddColumn` at the right end of the header row

**Files:**
- Modify: `apps/web/src/components/table/table-header.tsx`
- Modify: `apps/web/src/components/table/table-view.tsx`
- Modify: `apps/web/src/components/table/table-view.test.tsx`

### Step 1: Write the failing test (extend table-view.test.tsx)

Add a new `it` block:

```tsx
it('clicking + Add column posts to /fields and re-fetches', async () => {
  const created: { url: string; body: unknown }[] = [];
  let createPosted = false;
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    if (u.includes('/fields') && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      created.push({ url: u, body });
      createPosted = true;
      return jsonResponse({
        data: { field: { id: 'fnew', key: 'owner', type: 'string', label: 'Owner', options: null, required: false, order: 0 } },
      }, 201);
    }
    if (u.includes('/fields') && method === 'GET') {
      return jsonResponse(createPosted
        ? [{ id: 'fnew', key: 'owner', type: 'string', label: 'Owner', options: null, required: false, order: 0 }]
        : []);
    }
    return jsonResponse(emptyListResponse());
  }) as unknown as typeof fetch;

  renderTableView({ wslug: 'acme', pslug: 'sales', tslug: 'work-items' });

  await screen.findByRole('button', { name: /add column/i });
  fireEvent.click(screen.getByRole('button', { name: /add column/i }));
  fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'owner' } });
  fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

  await waitFor(() => {
    expect(created[0]?.url).toContain('/p/sales/t/work-items/fields');
    expect(created[0]?.body).toMatchObject({ key: 'owner', type: 'string' });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test table-view.test.tsx`
Expected: FAIL — no `Add column` button rendered.

- [ ] **Step 3: Render `TableAddColumn` in the header**

In `apps/web/src/components/table/table-header.tsx`, add a `trailing` prop and render after the grid:

```tsx
interface Props {
  columns: Column[];
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  onReorder: (nextOrder: string[]) => void;
  trailing?: React.ReactNode;
}
```

Update the function signature and JSX root to render `trailing` after the `<DndContext>`:

```tsx
export function TableHeader({ columns, sort, onSort, onReorder, trailing }: Props) {
  // ... existing sensors / ids / onDragEnd ...

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-light bg-content py-1.5">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/* existing SortableContext + grid */}
      </DndContext>
      {trailing ? <div className="flex-shrink-0">{trailing}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire `TableAddColumn` from `TableView`**

In `apps/web/src/components/table/table-view.tsx`, add the import:

```tsx
import { TableAddColumn } from './table-add-column.tsx';
import { useFields, useCreateField } from '../../lib/api/fields.ts';
```

Add the mutation hook near the other hooks (around line 75):

```tsx
const createField = useCreateField(wslug, pslug, tslug);
```

Add a handler:

```tsx
const onAddColumn = useCallback(
  async (payload: { key: string; label: string; type: FieldType; options?: string[] }) => {
    const created = await createField.mutateAsync(payload);
    if (activeView) {
      const nextVisible = [...(activeView.visibleFields ?? effectiveVisibleKeys(allColumns, activeView)), created.key];
      try {
        await updateView.mutateAsync({ id: activeView.id, patch: { visibleFields: nextVisible } });
      } catch (err) {
        toast.error(formatApiError(err));
      }
    }
  },
  [createField, activeView, allColumns, updateView],
);
```

Add the `FieldType` import:

```tsx
import type { FieldType } from '../../lib/api/fields.ts';
```

Pass `trailing` to `TableHeader`:

```tsx
<TableHeader
  columns={visibleColumns}
  sort={sort}
  onSort={onSortChange}
  onReorder={onReorder}
  trailing={<TableAddColumn onSubmit={onAddColumn} />}
/>
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd apps/web && bun run test table-view.test.tsx`
Expected: PASS — including the new test.

- [ ] **Step 6: Confirm visibility autosave**

The handler above adds the new field's key to `visibleFields` so the column appears immediately. If the existing `effectiveVisibleKeys` returns the built-in defaults when `visibleFields` is null, the spread above produces an explicit array — that's deliberate, so the new field doesn't get filtered out.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/table/table-header.tsx \
        apps/web/src/components/table/table-view.tsx \
        apps/web/src/components/table/table-view.test.tsx
git commit -m "phase-1.9: mount TableAddColumn at the right end of the header"
```

---

## Task 6: Build `ColumnMenu` (rename / hide / delete) and wire to header cells

**Files:**
- Create: `apps/web/src/components/table/column-menu.tsx`
- Test: `apps/web/src/components/table/column-menu.test.tsx`
- Modify: `apps/web/src/components/table/table-header.tsx`
- Modify: `apps/web/src/components/table/table-view.tsx`

### Step 1: Write the failing test for `ColumnMenu`

**Create `apps/web/src/components/table/column-menu.test.tsx`:**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ColumnMenu } from './column-menu.tsx';

describe('ColumnMenu', () => {
  it('renders Rename, Hide, Delete actions', () => {
    render(
      <ColumnMenu
        columnKey="priority"
        columnLabel="Priority"
        onRename={() => {}}
        onHide={() => {}}
        onDelete={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /hide column/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete column/i })).toBeInTheDocument();
  });

  it('calls onRename when Rename is selected', () => {
    const onRename = vi.fn();
    render(
      <ColumnMenu columnKey="priority" columnLabel="Priority" onRename={onRename} onHide={() => {}} onDelete={() => Promise.resolve()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }));
    expect(onRename).toHaveBeenCalled();
  });

  it('shows confirm dialog before deleting and calls onDelete only after confirm', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <ColumnMenu columnKey="priority" columnLabel="Priority" onRename={() => {}} onHide={() => {}} onDelete={onDelete} affectedDocCount={3} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete column/i }));

    expect(await screen.findByText(/delete column .priority./i)).toBeInTheDocument();
    expect(screen.getByText(/3 document/i)).toBeInTheDocument();

    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test column-menu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ColumnMenu`**

**Create `apps/web/src/components/table/column-menu.tsx`:**

```tsx
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.tsx';

interface Props {
  columnKey: string;
  columnLabel: string;
  onRename: () => void;
  onHide: () => void;
  onDelete: () => Promise<void>;
  affectedDocCount?: number;
}

export function ColumnMenu({ columnKey, columnLabel, onRename, onHide, onDelete, affectedDocCount }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete() {
    setDeleting(true);
    try {
      await onDelete();
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <IconButton label="Column actions" size="sm">
            <Icon icon={MoreHorizontal} size={14} />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[180px] p-1" role="menu">
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
            onClick={() => { setMenuOpen(false); onRename(); }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
            onClick={() => { setMenuOpen(false); onHide(); }}
          >
            Hide column
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm text-danger hover:bg-card"
            onClick={() => { setMenuOpen(false); setConfirmOpen(true); }}
          >
            Delete column
          </button>
        </PopoverContent>
      </Popover>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete column "{columnLabel}"?</DialogTitle>
            <DialogDescription>
              The pinned field <code>{columnKey}</code> will be removed from this table.
              {typeof affectedDocCount === 'number' && affectedDocCount > 0
                ? ` ${affectedDocCount} document${affectedDocCount === 1 ? '' : 's'} ${affectedDocCount === 1 ? 'has' : 'have'} a value for this key — the values remain in raw frontmatter but lose their column.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-sm text-fg-2 hover:text-fg-1"
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              className="rounded-sm bg-danger px-2 py-1 text-sm text-content disabled:opacity-50"
              onClick={handleConfirmDelete}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

> **If `Dialog` doesn't export `DialogHeader` / `DialogDescription` / `DialogFooter` / `DialogTitle`:** read `apps/web/src/components/ui/dialog.tsx` and use whatever primitive shape it actually exports. Reuse what `DocumentSlideover`'s delete dialog already uses (per STATE.md line 41).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/web && bun run test column-menu.test.tsx`
Expected: PASS — all three test cases green.

- [ ] **Step 5: Wire `ColumnMenu` into header cells**

In `apps/web/src/components/table/table-header.tsx`, extend `Props` and `SortableHeaderCell`:

Add to `Props`:

```tsx
interface Props {
  columns: Column[];
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  onReorder: (nextOrder: string[]) => void;
  trailing?: React.ReactNode;
  renderColumnMenu?: (column: Column) => React.ReactNode;
}
```

Pass `renderColumnMenu` through to `SortableHeaderCell` and render it for non-builtin columns inside the header button's container. Restructure the rendered cell so the menu sits next to the label:

```tsx
return (
  <div
    ref={setNodeRef}
    style={style}
    className={`group/header relative inline-flex items-center gap-1${isSticky ? ' sticky left-0 z-[1] border-r border-border-light bg-content pl-[22px] pr-3' : ''}`}
  >
    <button
      type="button"
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={sortable ? `Sort by ${column.label} (drag to reorder)` : `Drag to reorder ${column.label}`}
      className="flex flex-1 cursor-grab items-center gap-1 text-left text-[11px] uppercase tracking-wide text-fg-3 hover:text-fg-2 active:cursor-grabbing"
    >
      {column.label}
      {sort?.key === column.key ? (
        <span className="font-mono text-[10px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
      ) : null}
    </button>
    {column.source === 'field' && renderColumnMenu ? (
      <span className="opacity-0 transition-opacity group-hover/header:opacity-100">
        {renderColumnMenu(column)}
      </span>
    ) : null}
  </div>
);
```

> The `group/header` Tailwind named-group ensures the menu trigger reveals on header-cell hover, not row hover.

- [ ] **Step 6: Wire from `TableView`**

In `table-view.tsx`, add imports:

```tsx
import { ColumnMenu } from './column-menu.tsx';
import { useUpdateField, useDeleteField } from '../../lib/api/fields.ts';
```

Add hooks and handlers:

```tsx
const updateField = useUpdateField(wslug, pslug, tslug);
const deleteField = useDeleteField(wslug, pslug, tslug);

const docs = page?.data ?? [];

const renderColumnMenu = useCallback(
  (column: Column) => {
    if (column.source !== 'field') return null;
    const field = (fields ?? []).find((f) => f.key === column.key);
    if (!field) return null;
    const affected = docs.filter(
      (d) => d.frontmatter && d.frontmatter[column.key] != null,
    ).length;
    return (
      <ColumnMenu
        columnKey={column.key}
        columnLabel={column.label}
        affectedDocCount={affected}
        onRename={() => {
          const next = window.prompt(`Rename "${column.label}" to:`, column.label);
          if (next && next.trim() && next.trim() !== column.label) {
            updateField.mutate(
              { id: field.id, patch: { label: next.trim() } },
              { onError: (err) => toast.error(formatApiError(err)) },
            );
          }
        }}
        onHide={() => {
          if (!activeView) return;
          const nextVisible = visibleKeys.filter((k) => k !== column.key);
          updateView.mutate(
            { id: activeView.id, patch: { visibleFields: nextVisible } },
            { onError: (err) => toast.error(formatApiError(err)) },
          );
        }}
        onDelete={async () => {
          try {
            await deleteField.mutateAsync(field.id);
          } catch (err) {
            toast.error(formatApiError(err));
            throw err;
          }
        }}
      />
    );
  },
  [fields, docs, updateField, deleteField, activeView, visibleKeys, updateView],
);
```

> **Why `window.prompt` for rename:** keeps the code small and ships the feature in one task. If we want a nicer inline edit later, it can be folded into 1.9.1 alongside type-change. The user explicitly authorized this as v1 scope (Rename / Hide / Delete only). `window.prompt` is supported in jsdom for tests; the existing test suite uses it elsewhere if needed (verify before committing — if not, swap for a tiny inline-edit popover; see Task 6b below).

Pass to `TableHeader`:

```tsx
<TableHeader
  columns={visibleColumns}
  sort={sort}
  onSort={onSortChange}
  onReorder={onReorder}
  trailing={<TableAddColumn onSubmit={onAddColumn} />}
  renderColumnMenu={renderColumnMenu}
/>
```

- [ ] **Step 7: Run the full table-view test suite**

Run: `cd apps/web && bun run test table-view.test.tsx column-menu.test.tsx`
Expected: PASS — all existing + new tests green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/table/column-menu.tsx \
        apps/web/src/components/table/column-menu.test.tsx \
        apps/web/src/components/table/table-header.tsx \
        apps/web/src/components/table/table-view.tsx
git commit -m "phase-1.9: column header ⋯ menu (rename / hide / delete)"
```

---

## Task 6b: Replace `window.prompt` rename with inline edit (only if Task 6 used prompt)

**Skip this task if Task 6 already shipped an inline rename.** Otherwise this swaps `window.prompt` for the existing `InlineEdit` primitive so the rename matches the rail's UX (per memory `[[rail-ux-pattern]]`).

**Files:**
- Modify: `apps/web/src/components/table/table-header.tsx`
- Modify: `apps/web/src/components/table/table-view.tsx`

### Steps

- [ ] **Step 1: Pass `isRenaming` + `onRenameCommit` props through `SortableHeaderCell`.** When `isRenaming === true`, render `<InlineEdit value={column.label} onCommit={onRenameCommit} onCancel={...} />` instead of the static label.
- [ ] **Step 2: Lift `renamingKey: string | null` state into `TableView`.** `ColumnMenu`'s `onRename` sets it; `onRenameCommit` PATCHes and clears it.
- [ ] **Step 3: Test:** extend `table-view.test.tsx` with a case that clicks `⋯ → Rename`, types a new label, presses Enter, and asserts a PATCH to `/fields/:id`.
- [ ] **Step 4: Commit:** `phase-1.9: inline-edit rename for column header`.

---

## Task 7: Build `columnSuggestions` helper

**Files:**
- Create: `apps/web/src/components/table/column-suggestions.ts`
- Test: `apps/web/src/components/table/column-suggestions.test.ts`

### Step 1: Write the failing test

**Create `apps/web/src/components/table/column-suggestions.test.ts`:**

```ts
import { describe, expect, it } from 'vitest';
import { columnSuggestions, type ColumnSuggestion } from './column-suggestions.ts';
import type { Field } from '../../lib/api/fields.ts';

const f = (key: string, type: Field['type'] = 'string'): Field => ({
  id: key, key, type, label: null, options: null, required: false, order: 0,
});

const doc = (frontmatter: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  slug: 's',
  title: 't',
  type: 'work_item' as const,
  status: 'todo',
  body: '',
  frontmatter,
  parentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('columnSuggestions', () => {
  it('returns frontmatter keys that are not pinned fields', () => {
    const docs = [doc({ owner: 'Alice', priority: 'high' }), doc({ owner: 'Bob' })];
    const fields = [f('priority')];
    const out = columnSuggestions(docs, fields);
    expect(out.map((s) => s.key)).toEqual(['owner']);
  });

  it('includes a sample value (first non-null occurrence)', () => {
    const docs = [doc({ owner: null }), doc({ owner: 'Alice' })];
    const out = columnSuggestions(docs, []);
    expect(out[0].sample).toBe('Alice');
  });

  it('infers type from sample value', () => {
    const docs = [
      doc({ price: 42 }),
      doc({ shipped: true }),
      doc({ due: '2026-06-01' }),
      doc({ note: 'hello' }),
      doc({ tags: ['a', 'b'] }),
    ];
    const out = columnSuggestions(docs, []);
    const byKey = (k: string) => out.find((s) => s.key === k) as ColumnSuggestion;
    expect(byKey('price').inferredType).toBe('number');
    expect(byKey('shipped').inferredType).toBe('boolean');
    expect(byKey('due').inferredType).toBe('date');
    expect(byKey('note').inferredType).toBe('string');
    expect(byKey('tags').inferredType).toBe('multi_select');
  });

  it('dedupes and sorts alphabetically', () => {
    const docs = [doc({ z: 1, a: 1 }), doc({ m: 1, a: 1 })];
    const out = columnSuggestions(docs, []);
    expect(out.map((s) => s.key)).toEqual(['a', 'm', 'z']);
  });

  it('returns an empty list when every key is already pinned', () => {
    const docs = [doc({ a: 1, b: 2 })];
    expect(columnSuggestions(docs, [f('a'), f('b')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test column-suggestions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `columnSuggestions`**

**Create `apps/web/src/components/table/column-suggestions.ts`:**

```ts
import type { Field, FieldType } from '../../lib/api/fields.ts';

export interface ColumnSuggestion {
  key: string;
  sample: unknown;
  inferredType: FieldType;
}

interface DocLike {
  frontmatter: unknown;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function inferType(value: unknown): FieldType {
  if (Array.isArray(value)) return 'multi_select';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return 'date';
  return 'string';
}

export function columnSuggestions(docs: DocLike[], fields: Field[]): ColumnSuggestion[] {
  const pinned = new Set(fields.map((f) => f.key));
  const seen = new Map<string, unknown>();

  for (const d of docs) {
    const fm = (d.frontmatter ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fm)) {
      if (pinned.has(k)) continue;
      const existing = seen.get(k);
      if (existing == null && v != null) seen.set(k, v);
      else if (!seen.has(k)) seen.set(k, v);
    }
  }

  const out: ColumnSuggestion[] = [];
  for (const [key, sample] of seen) {
    out.push({ key, sample, inferredType: inferType(sample) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/web && bun run test column-suggestions.test.ts`
Expected: PASS — all five cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/table/column-suggestions.ts \
        apps/web/src/components/table/column-suggestions.test.ts
git commit -m "phase-1.9: columnSuggestions helper"
```

---

## Task 8: Render Suggested columns inside the `ColumnPicker`

**Files:**
- Modify: `apps/web/src/components/table/column-picker.tsx`
- Modify: `apps/web/src/components/table/table-view.tsx`
- Modify: `apps/web/src/components/table/table-view.test.tsx`

### Step 1: Write the failing test

Add to `apps/web/src/components/table/table-view.test.tsx`:

```tsx
it('column picker lists orphan frontmatter keys under Suggested', async () => {
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    if (u.includes('/documents') && method === 'GET') {
      return jsonResponse({
        data: [{
          id: '1', slug: 'doc-1', title: 'Doc 1', type: 'work_item', status: 'todo',
          body: '', frontmatter: { owner: 'Alice', extra_note: 'x' },
          parentId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        }],
        page: { total: 1 },
      });
    }
    if (u.includes('/fields') && method === 'GET') return jsonResponse([]);
    return jsonResponse(emptyListResponse());
  }) as unknown as typeof fetch;

  renderTableView({ wslug: 'acme', pslug: 'sales', tslug: 'work-items' });

  await screen.findByRole('button', { name: /columns/i });
  fireEvent.click(screen.getByRole('button', { name: /columns/i }));

  expect(await screen.findByText(/suggested from your data/i)).toBeInTheDocument();
  expect(screen.getByText('owner')).toBeInTheDocument();
  expect(screen.getByText('extra_note')).toBeInTheDocument();
});

it('clicking + Pin on a suggestion posts a field with the inferred type', async () => {
  let pinned = false;
  const calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    if (u.includes('/fields') && method === 'POST') {
      pinned = true;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: u, body });
      return jsonResponse({ data: { field: { id: 'fnew', key: body.key, type: body.type, label: body.label, options: null, required: false, order: 0 } } }, 201);
    }
    if (u.includes('/documents') && method === 'GET') {
      return jsonResponse({ data: [{ id: '1', slug: 'doc-1', title: 'Doc 1', type: 'work_item', status: 'todo', body: '', frontmatter: { owner: 'Alice' }, parentId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' }], page: { total: 1 } });
    }
    if (u.includes('/fields') && method === 'GET') {
      return jsonResponse(pinned
        ? [{ id: 'fnew', key: 'owner', type: 'string', label: 'Owner', options: null, required: false, order: 0 }]
        : []);
    }
    return jsonResponse(emptyListResponse());
  }) as unknown as typeof fetch;

  renderTableView({ wslug: 'acme', pslug: 'sales', tslug: 'work-items' });
  await screen.findByRole('button', { name: /columns/i });
  fireEvent.click(screen.getByRole('button', { name: /columns/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pin owner/i }));

  await waitFor(() => {
    expect(calls[0]?.body).toMatchObject({ key: 'owner', type: 'string' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/web && bun run test table-view.test.tsx`
Expected: FAIL — neither the heading nor the keys are rendered.

- [ ] **Step 3: Extend `ColumnPicker` to render suggestions**

Replace `apps/web/src/components/table/column-picker.tsx` with:

```tsx
import { useState } from 'react';
import { Settings2, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import type { Column } from './columns.ts';
import type { ColumnSuggestion } from './column-suggestions.ts';
import type { FieldType } from '../../lib/api/fields.ts';

interface Props {
  columns: Column[];
  visibleKeys: string[];
  onChange: (nextVisible: string[]) => void;
  suggestions?: ColumnSuggestion[];
  onPinSuggestion?: (payload: { key: string; type: FieldType; label: string }) => Promise<void> | void;
}

function titleize(key: string): string {
  return key.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function ColumnPicker({ columns, visibleKeys, onChange, suggestions, onPinSuggestion }: Props) {
  const [open, setOpen] = useState(false);
  const isVisible = (k: string) => visibleKeys.includes(k);
  const toggle = (k: string) => {
    if (isVisible(k)) onChange(visibleKeys.filter((x) => x !== k));
    else onChange([...visibleKeys, k]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Columns" size="sm">
          <Icon icon={Settings2} size={14} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-fg-3">Columns</div>
        <ul className="flex flex-col">
          {columns.map((c) => (
            <li key={c.key}>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-card">
                <input
                  type="checkbox"
                  checked={isVisible(c.key)}
                  onChange={() => toggle(c.key)}
                  aria-label={`Toggle ${c.label}`}
                />
                <span className="flex-1">{c.label}</span>
                {c.source === 'builtin' ? <span className="text-[10px] text-fg-3">built-in</span> : null}
              </label>
            </li>
          ))}
        </ul>

        {suggestions && suggestions.length > 0 ? (
          <>
            <div className="mt-2 border-t border-border-light px-2 pt-2 text-[11px] uppercase tracking-wide text-fg-3">
              Suggested from your data
            </div>
            <ul className="flex flex-col">
              {suggestions.map((s) => (
                <li key={s.key} className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-card">
                  <span className="flex-1 font-mono text-xs">{s.key}</span>
                  <span className="text-[10px] text-fg-3">{s.inferredType}</span>
                  <button
                    type="button"
                    aria-label={`Pin ${s.key}`}
                    onClick={() => onPinSuggestion?.({ key: s.key, type: s.inferredType, label: titleize(s.key) })}
                    className="rounded-sm p-0.5 text-fg-3 hover:bg-content hover:text-fg-1"
                  >
                    <Icon icon={Plus} size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Wire suggestions from `TableView`**

In `table-view.tsx`, add imports:

```tsx
import { columnSuggestions } from './column-suggestions.ts';
```

Add memo:

```tsx
const suggestions = useMemo(
  () => columnSuggestions(docs, fields ?? []),
  [docs, fields],
);
```

Add the pin handler:

```tsx
const onPinSuggestion = useCallback(
  async (payload: { key: string; type: FieldType; label: string }) => {
    // Pinning a string-typed inferred key requires no options; select/currency
    // can't be inferred from a single sample so we never produce those here.
    await onAddColumn(payload);
  },
  [onAddColumn],
);
```

Pass to `ColumnPicker`:

```tsx
<ColumnPicker
  columns={allColumns}
  visibleKeys={visibleKeys}
  onChange={onVisibilityChange}
  suggestions={suggestions}
  onPinSuggestion={onPinSuggestion}
/>
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/web && bun run test table-view.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/table/column-picker.tsx \
        apps/web/src/components/table/table-view.tsx \
        apps/web/src/components/table/table-view.test.tsx
git commit -m "phase-1.9: Suggested columns section in ColumnPicker"
```

---

## Task 9: Polish — disabled-states + keyboard

**Files:**
- Modify: `apps/web/src/components/table/table-add-column.tsx`
- Modify: `apps/web/src/components/table/column-menu.tsx`

Small UX fixes that don't need a dedicated test file but improve feel:

- [ ] **Step 1: Disable `Create` while the field key is empty.** Add `disabled={!key || submitting}` to the Create button.
- [ ] **Step 2: Close the popover on Escape.** Radix `Popover` handles this by default — verify by manual smoke. If not, add `onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}` on the form.
- [ ] **Step 3: When the popover closes, reset its internal state** (already wired in Task 4 via the `onOpenChange` handler).
- [ ] **Step 4: Visual sanity check.** Run `cd apps/web && bun run dev`, open `/dev/design-system` if it has table primitives, and the work-items page. Confirm: `+` button matches header height, `⋯` reveals on hover, picker layout doesn't overflow at 260px.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/table/table-add-column.tsx \
        apps/web/src/components/table/column-menu.tsx
git commit -m "phase-1.9: polish add-column / column-menu interactions"
```

---

## Task 10: Update PHASES.md and STATE.md

**Files:**
- Modify: `docs/PHASES.md`
- Modify: `memory/STATE.md`

- [ ] **Step 1: Check off Phase 1.9 acceptance criteria** in `docs/PHASES.md` lines 436-444. Cross off:
  - `+ Add column` at end of header row works
  - `⋯` menu rename/hide/delete works (note: rename + delete + hide only; type-change deferred to 1.9.1)
  - "Suggested columns" picker works
  - `useFields` is table-scoped
  - Web unit suite covers the three new components + `column-suggestions` + `fields` mutations
  - Add a "Phase 1.9.1 (deferred)" line for the type-migration work
  - `Commit: phase-1.9: complete`

- [ ] **Step 2: Update `memory/STATE.md`:**
  - Move Phase 1.9 from "queued" to "shipped" with the branch + commit tip
  - Update the `What's working in the UI` section: add "Inline `+ Add column` in the spreadsheet header, `⋯` menu on column headers (Rename / Hide / Delete), Suggested columns in the picker"
  - Add a line to `Open Threads`: "Phase 1.9.1 — type-change UI for column header `⋯` menu + value-remap migration matrix"
  - Replace the stale `Current branch` line with `main` (or `phase-1.9/field-management-ui` if not yet merged)

- [ ] **Step 3: Commit**

```bash
git add docs/PHASES.md memory/STATE.md
git commit -m "phase-1.9: complete"
```

---

## Integration Gate (phase-complete)

After Task 10, BEFORE opening the PR, the controller (not a subagent) runs:

- [ ] **Web unit suite:**
  ```bash
  cd apps/web && bun run test
  ```
  Expected: ALL green. Compare count to baseline — `123 server + 215 web + 28 shared` per STATE.md. Phase 1.9 should add roughly 15-20 web tests (`fields.test.ts` ×4, `table-add-column.test.tsx` ×5, `column-menu.test.tsx` ×3, `column-suggestions.test.ts` ×5, `table-view.test.tsx` ×3 new cases).

- [ ] **Server unit suite (no expected changes, regression-only):**
  ```bash
  cd apps/server && bun test
  ```
  Expected: 123 / 123 green.

- [ ] **Shared package tests:**
  ```bash
  cd packages/shared && bun test
  ```
  Expected: 28 / 28 green.

- [ ] **Type-check the web app:**
  ```bash
  cd apps/web && bunx tsc --noEmit
  ```
  Expected: no new type errors in `apps/web/src/components/table/**` or `apps/web/src/lib/api/fields.ts`.

- [ ] **Smoke checklist (manual, takes ~5 min):**
  Start `bun dev` from repo root, open `http://localhost:5173/`, log in as `stefan@netdust.be`, open a project.
  - [ ] Click the `+` at the right end of the header row → popover opens.
  - [ ] Type `key = owner`, leave label empty, type = string, click Create. Column "Owner" appears at the end of the row. Reload page — still there.
  - [ ] Hover over the "Owner" column header → `⋯` button reveals. Click it → Rename / Hide column / Delete column.
  - [ ] Rename → enter a new label → header label updates.
  - [ ] Hide column → column disappears from the table but stays available in the column picker.
  - [ ] Add a frontmatter key directly via the slideover's raw-MD editor (e.g. `extra_note: hello`) on an existing doc. Save. Open the column picker → `extra_note` appears under "Suggested from your data".
  - [ ] Click `+` next to `extra_note` → it becomes a column.
  - [ ] Click `⋯ → Delete column` on a column → confirm dialog shows correct affected-doc count → Delete → column gone, refresh — still gone.
  - [ ] Switch to a different project → its column set is independent of the first project's.

- [ ] **Optional Playwright spec (skip if time-boxed):** add a click-through journey to `apps/web/tests/e2e/click-through.spec.ts` covering the full add-column → use-column → rename → delete flow. If skipped, document in the PR description that manual smoke is the only acceptance gate.

---

## PR

- [ ] **Open PR against `main`** with title `phase-1.9: field management UI` and body:

  ```
  ## Summary
  - Inline `+ Add column` in the spreadsheet header
  - Column header `⋯` menu: Rename / Hide / Delete (type-change deferred to 1.9.1)
  - "Suggested columns" section in the ColumnPicker for orphan frontmatter keys
  - `useFields` rescoped to the active table (`/p/:pslug/t/:tslug/fields`)

  ## Why now
  Phase 2 (Agents) is the next phase and agents will create frontmatter keys.
  Without this surface, users have to edit raw JSON or call the API to pin them.

  ## Test plan
  - [x] Unit suites green: 123 server / 230+ web / 28 shared
  - [x] Type-check clean on touched files
  - [x] Manual smoke checklist (see plan doc, Integration Gate)

  ## Deferred to 1.9.1
  - Type-change in `⋯` menu (compatible matrix + value-remap UI for incompatible)
  ```

---

## Self-Review (already done before saving)

Spec coverage check against `docs/PHASES.md` Phase 1.9:

| Spec line | Plan task |
|-----------|-----------|
| Rescope `useFields` to active table | Task 1, 2 |
| `+ Add column` at end of header row | Task 4, 5 |
| Column header `⋯` menu | Task 6 (and optional 6b) |
| Rename action | Task 6 |
| Change-type action | **Deferred to 1.9.1 per user decision** |
| Hide column action | Task 6 |
| Delete column action with affected count | Task 6 |
| "Suggested columns" in ColumnPicker | Task 7, 8 |
| Web unit coverage | Tasks 1, 3, 4, 6, 7, 8 |
| Playwright coverage | Optional (Integration Gate) |
| Type migration matrix | **Deferred to 1.9.1** |

Placeholder scan: no TBDs in steps. Every code block is complete. Every command has expected output.

Type consistency: `FieldType`, `Field`, `FieldCreate`, `FieldPatch`, `ColumnSuggestion`, `AddColumnPayload` — all defined where they're first used and used consistently across tasks.
