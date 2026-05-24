# Phase 2B — Spreadsheet Table UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current 3-column work-items list (`title | status | updated`) into a real spreadsheet: shows a column per pinned field, supports currency/date/select/multi-select cell types, has a column-visibility picker and drag-to-reorder, persists per-view column state. Backend lands new `currency` field type + `views.columnOrder`. Frontend rewrites `list-view.tsx` + `list-header.tsx` + `list-row.tsx` as a `TableView` with header / body composition.

**Architecture:** Built columns model = built-in (`title`, `status`, `updated_at`) + per-table `fields` rows (already exists, table-scoped from Phase 2A). View state owns visibility + order via `views.visibleFields` (already exists, string[]) + new `views.columnOrder` (string[]). Width is per-user / localStorage — not in the DB. Reuses existing `FieldRenderer` for cells. Drag-reorder via `@dnd-kit/core` (already a dep). Column picker is a new shadcn-style popover.

**Tech Stack:** Existing — React + TanStack Router + Tailwind + shadcn/ui + dnd-kit + react-query + Vitest + Playwright. New backend bits: a `currency` enum value in the field types whitelist, a `columnOrder` field on the views table, a migration for both. The CLAUDE.md "no `any`, kebab files, no default exports, Biome" rules hold throughout.

---

## File Structure

**Create (frontend):**
- `apps/web/src/components/table/table-view.tsx` — replaces `views/list-view.tsx` for work-items. Composition: header + body + filter bar.
- `apps/web/src/components/table/table-header.tsx` — sticky header row. Per-column header cell with sort + drag handle.
- `apps/web/src/components/table/table-row.tsx` — body row. One `<TableCell>` per visible column.
- `apps/web/src/components/table/table-cell.tsx` — cell wrapper. Dispatches to `FieldRenderer` for frontmatter cells, has built-in renderers for `title` / `status` / `updated_at`.
- `apps/web/src/components/table/column-picker.tsx` — popover for show/hide columns + reorder.
- `apps/web/src/components/table/columns.ts` — pure helpers: `mergeColumns(builtIn, fields, view)`, `applyColumnOrder(cols, order)`, `effectiveVisibleFields(cols, view)`, types.
- `apps/web/src/components/table/columns.test.ts` — Vitest unit tests for those helpers.
- `apps/web/src/components/table/table-view.test.tsx` — RTL render test.
- `apps/web/src/components/table/currency-cell.test.tsx` — unit test for the new currency renderer.

**Modify (frontend):**
- `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` — render `<TableView>` instead of `<ListView>`.
- `apps/web/src/components/slideover/field-renderer.tsx` — add `case 'currency':` branch.
- `apps/web/src/lib/api/fields.ts` — extend the `FieldType` union with `'currency'`.
- `apps/web/src/lib/api/views.ts` — extend the `View` type with `columnOrder: string[] | null`, add `useUpdateView` mutation (column changes save to the view).

**Modify (backend):**
- `apps/server/src/db/schema.ts` — add `currency` to the `fields.type` enum; add `columnOrder` JSON column to `views`.
- `apps/server/src/db/migrations/0004_phase_2b_column_state.sql` — generated migration. Drizzle-kit will rebuild `fields` (enum change) and ALTER `views` (add column).
- `apps/server/src/routes/fields.ts` — add `currency` to the `FIELD_TYPES` const + Zod enum.
- `apps/server/src/routes/views.ts` — extend the Zod schema to accept `columnOrder: string[] | null | undefined`.
- `apps/server/src/routes/views.test.ts` — assert `columnOrder` round-trips.
- `apps/server/src/routes/fields.test.ts` — assert `currency` type accepted.
- `packages/shared/src/index.ts` — if there's a shared `FieldType` schema, mirror the addition.

**Untouched:**
- Kanban view — Phase 2D switches it to a render mode; leave it alone here.
- Rail / sidebar — Phase 2C wires saved-view navigation; the table view in 2B is reached via the existing Work-items tab.
- `documents.ts` route, schema for `documents` — no changes (frontmatter already stores all field values).

---

## Task 1: Backend — add `currency` field type + `views.columnOrder`

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/routes/fields.ts`
- Modify: `apps/server/src/routes/views.ts`
- Generate: `apps/server/src/db/migrations/0004_phase_2b_column_state.sql`

- [ ] **Step 1: Extend the schema**

In `apps/server/src/db/schema.ts`, find the `fields` table definition. Its `type` column currently lists:

```ts
enum: [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
]
```

Add `'currency'`:

```ts
enum: [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  'currency',
]
```

In the same file, find the `views` table. Add a `columnOrder` column:

```ts
columnOrder: text('column_order', { mode: 'json' }).$type<string[] | null>(),
```

Place it right after `visibleFields`. It's nullable — `null` means "fall back to the default order (column-picker resolves it from built-ins + fields)."

- [ ] **Step 2: Generate the migration**

From repo root:

```bash
bun --filter @folio/server db:generate
```

Drizzle will emit `0004_<random>.sql`. Rename to `0004_phase_2b_column_state.sql` and update `meta/_journal.json` to match.

Inspect the generated SQL. Two things should be in it:
- `ALTER TABLE views ADD column_order text` (nullable)
- A table-rebuild of `fields` because the `type` CHECK enum changed: `CREATE TABLE fields_new (... type with new enum ...)` + `INSERT INTO fields_new SELECT FROM fields` + drop + rename.

If Drizzle did NOT rebuild `fields` (it sometimes skips enum changes if it doesn't notice), hand-author the rebuild block following the pattern from `0003_phase_2a_tables.sql`. The `fields` rebuild must preserve every column (id, project_id, table_id, key, type, label, options, order) and the `fields_table_key_idx` unique index.

- [ ] **Step 3: Verify the migration**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
```

Expected: `Migrations complete.` Then sanity-check the schema:

```bash
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
const cols = db.query("PRAGMA table_info(views)").all();
console.log("views.column_order present:", cols.some(c => c.name === "column_order"));
'
```

Expected: `true`.

- [ ] **Step 4: Update the routes' Zod schemas**

In `apps/server/src/routes/fields.ts`, find the `FIELD_TYPES` const and add `'currency'`:

```ts
const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  'currency',
] as const;
```

Also extend `validateOptions` so `currency` requires an options array containing a single ISO-4217 currency code (e.g. `['EUR']`):

```ts
function validateOptions(type: string, options: string[] | undefined): void {
  if (type === 'select' || type === 'multi_select') {
    if (!options || options.length === 0) {
      throw new HTTPError('INVALID_BODY', `field type "${type}" requires non-empty options`, 422);
    }
    return;
  }
  if (type === 'currency') {
    if (!options || options.length !== 1 || !/^[A-Z]{3}$/.test(options[0] ?? '')) {
      throw new HTTPError('INVALID_BODY', `field type "currency" requires options to be a single ISO-4217 code (e.g. ["EUR"])`, 422);
    }
    return;
  }
  if (options !== undefined) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" does not allow options`, 422);
  }
}
```

In `apps/server/src/routes/views.ts`, find the `baseSchema` Zod definition and add:

```ts
columnOrder: z.array(z.string()).nullable().optional(),
```

And in the POST/PATCH handlers' insert/update payloads, include `columnOrder` (mirror how `visibleFields` is handled).

- [ ] **Step 5: Write tests**

In `apps/server/src/routes/fields.test.ts`, add:

```ts
test('POST /fields accepts type=currency with a single ISO-4217 option', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['EUR'] }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('currency');
  expect(body.data.options).toEqual(['EUR']);
});

test('POST /fields 422 on currency without options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency' }),
  });
  expect(res.status).toBe(422);
});

test('POST /fields 422 on currency with non-ISO code', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['euro'] }),
  });
  expect(res.status).toBe(422);
});
```

Note: existing field-routes use the route file (POST body shape exposed in `data` — confirm by reading `fields.ts:76` which currently returns `{ field: row }` — adjust the assertion accordingly if so).

In `apps/server/src/routes/views.test.ts`, add:

```ts
test('POST /views accepts columnOrder and round-trips it', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/views`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'With order',
      type: 'list',
      visibleFields: ['title', 'status', 'amount'],
      columnOrder: ['title', 'amount', 'status'],
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const id = body.data?.id ?? body.view?.id;
  const get = await app.request(`/api/v1/w/acme/p/web/views`, { headers: { Cookie: seed.sessionCookie } });
  const row = (await get.json()).data.find((v) => v.id === id);
  expect(row.columnOrder).toEqual(['title', 'amount', 'status']);
});

test('PATCH /views/:id accepts columnOrder updates', async () => {
  const { app, seed } = await makeTestApp();
  const created = await (await app.request(`/api/v1/w/acme/p/web/views`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'V', type: 'list' }),
  })).json();
  const id = created.data?.id ?? created.view?.id;
  const res = await app.request(`/api/v1/w/acme/p/web/views/${id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnOrder: ['status', 'title'] }),
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 6: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 112 pass / 0 fail (107 baseline + 5 new).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/ apps/server/src/routes/fields.ts apps/server/src/routes/views.ts apps/server/src/routes/fields.test.ts apps/server/src/routes/views.test.ts
git commit -m "phase-2b: add currency field type + views.columnOrder"
```

---

## Task 2: Frontend — extend `FieldType` + `View` types, add `useUpdateView`

**Files:**
- Modify: `apps/web/src/lib/api/fields.ts`
- Modify: `apps/web/src/lib/api/views.ts`

- [ ] **Step 1: Add `'currency'` to `FieldType` in `fields.ts`**

Find the `FieldType` union and append:

```ts
export type FieldType =
  | 'string' | 'text' | 'number' | 'boolean' | 'date' | 'datetime'
  | 'select' | 'multi_select' | 'user_ref' | 'url' | 'document_ref'
  | 'currency';
```

- [ ] **Step 2: Extend `View` interface in `views.ts`**

Find `interface View` and add `columnOrder`:

```ts
export interface View {
  id: string;
  slug: string;
  name: string;
  type: 'list' | 'kanban';
  filters: unknown;
  sort: unknown;
  groupBy: string | null;
  visibleFields: string[] | null;
  columnOrder: string[] | null;
  isDefault: boolean;
  order: number;
}
```

- [ ] **Step 3: Add `useUpdateView` mutation in `views.ts`**

Append:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface ViewPatch {
  name?: string;
  type?: 'list' | 'kanban';
  filters?: unknown;
  sort?: unknown;
  groupBy?: string | null;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  isDefault?: boolean;
  order?: number;
}

export function useUpdateView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ViewPatch }) => {
      return client.patch<View>(`/api/v1/w/${wslug}/p/${pslug}/views/${id}`, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) }),
  });
}
```

Check that `client.patch` exists in `apps/web/src/lib/api/client.ts`. If only `client.get` / `client.post` exist, look at how `useUpdateDocument` calls it — copy the same pattern.

- [ ] **Step 4: Run the web unit suite — no regression**

```bash
cd apps/web && bun run test
```

Expected: 134 / 134 still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/fields.ts apps/web/src/lib/api/views.ts
git commit -m "phase-2b: frontend types — currency, view.columnOrder, useUpdateView"
```

---

## Task 3: Pure column helpers (`columns.ts` + tests)

**Files:**
- Create: `apps/web/src/components/table/columns.ts`
- Create: `apps/web/src/components/table/columns.test.ts`

The column model: a `Column` is either built-in (`title`, `status`, `updated_at`) or a `field` (one per pinned `Field`). The view can override visibility and order. Pure functions for everything keep the React components dumb.

- [ ] **Step 1: Write the failing tests first**

Create `apps/web/src/components/table/columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';
import { mergeColumns, applyColumnOrder, effectiveVisibleKeys, type Column } from './columns.ts';

const fields: Field[] = [
  { id: 'f1', key: 'amount',   type: 'currency',  label: 'Amount',   options: ['EUR'], required: false, order: 0 },
  { id: 'f2', key: 'due_date', type: 'date',      label: 'Due',      options: null,    required: false, order: 10 },
  { id: 'f3', key: 'tags',     type: 'multi_select', label: 'Tags',  options: ['x', 'y'], required: false, order: 20 },
];

describe('mergeColumns', () => {
  it('returns built-in columns even with no fields', () => {
    const cols = mergeColumns([], null);
    expect(cols.map((c) => c.key)).toEqual(['title', 'status', 'updated_at']);
  });

  it('appends one column per field after the built-ins', () => {
    const cols = mergeColumns(fields, null);
    expect(cols.map((c) => c.key)).toEqual(['title', 'status', 'updated_at', 'amount', 'due_date', 'tags']);
  });

  it('marks built-in vs field source correctly', () => {
    const cols = mergeColumns(fields, null);
    expect(cols.find((c) => c.key === 'title')!.source).toBe('builtin');
    expect(cols.find((c) => c.key === 'amount')!.source).toBe('field');
  });

  it('attaches field metadata onto field columns', () => {
    const cols = mergeColumns(fields, null);
    const amount = cols.find((c) => c.key === 'amount')!;
    expect(amount.fieldType).toBe('currency');
    expect(amount.fieldOptions).toEqual(['EUR']);
    expect(amount.label).toBe('Amount');
  });
});

describe('applyColumnOrder', () => {
  it('returns input unchanged when order is null', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, null);
    expect(out).toEqual(cols);
  });

  it('reorders columns to match the order array, appending un-listed', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, ['amount', 'title']);
    expect(out.map((c) => c.key)).toEqual(['amount', 'title', 'status', 'updated_at', 'due_date', 'tags']);
  });

  it('skips keys in the order array that are not in the column list (deleted fields)', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, ['amount', 'GONE', 'title']);
    expect(out.map((c) => c.key)).toEqual(['amount', 'title', 'status', 'updated_at', 'due_date', 'tags']);
  });
});

describe('effectiveVisibleKeys', () => {
  it('returns built-ins by default when view is null', () => {
    expect(effectiveVisibleKeys(mergeColumns(fields, null), null)).toEqual(
      ['title', 'status', 'updated_at']
    );
  });

  it("returns the view's visibleFields exactly when set", () => {
    const cols = mergeColumns(fields, null);
    const view = { visibleFields: ['title', 'amount'] } as Pick<View, 'visibleFields'>;
    expect(effectiveVisibleKeys(cols, view as View)).toEqual(['title', 'amount']);
  });

  it('drops any visible keys that no longer exist as columns', () => {
    const cols = mergeColumns(fields, null);
    const view = { visibleFields: ['title', 'GONE', 'amount'] } as Pick<View, 'visibleFields'>;
    expect(effectiveVisibleKeys(cols, view as View)).toEqual(['title', 'amount']);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd apps/web && bunx vitest run src/components/table/columns.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement `columns.ts`**

```ts
import type { Field, FieldType } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';

export interface Column {
  key: string;
  label: string;
  source: 'builtin' | 'field';
  fieldType?: FieldType;
  fieldOptions?: string[] | null;
}

const BUILTIN_COLUMNS: Column[] = [
  { key: 'title',      label: 'Title',   source: 'builtin' },
  { key: 'status',     label: 'Status',  source: 'builtin' },
  { key: 'updated_at', label: 'Updated', source: 'builtin' },
];

const DEFAULT_VISIBLE_KEYS = BUILTIN_COLUMNS.map((c) => c.key);

export function mergeColumns(fields: Field[], _view: View | null): Column[] {
  const fieldCols: Column[] = [...fields]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      source: 'field',
      fieldType: f.type,
      fieldOptions: f.options,
    }));
  return [...BUILTIN_COLUMNS, ...fieldCols];
}

export function applyColumnOrder(cols: Column[], order: string[] | null): Column[] {
  if (!order || order.length === 0) return cols;
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const ordered: Column[] = [];
  for (const key of order) {
    const col = byKey.get(key);
    if (col) {
      ordered.push(col);
      byKey.delete(key);
    }
  }
  // Append columns not in the order array (newly-added fields).
  for (const col of cols) {
    if (byKey.has(col.key)) ordered.push(col);
  }
  return ordered;
}

export function effectiveVisibleKeys(cols: Column[], view: View | null): string[] {
  if (!view?.visibleFields || view.visibleFields.length === 0) return DEFAULT_VISIBLE_KEYS;
  const valid = new Set(cols.map((c) => c.key));
  return view.visibleFields.filter((k) => valid.has(k));
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd apps/web && bunx vitest run src/components/table/columns.test.ts
```

Expected: all green.

- [ ] **Step 5: Run the full unit suite**

```bash
cd apps/web && bun run test
```

Expected: 144 / 144 (134 baseline + 10 new).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/table/columns.ts apps/web/src/components/table/columns.test.ts
git commit -m "phase-2b: pure column helpers (merge/order/visible)"
```

---

## Task 4: Add the `currency` cell to `FieldRenderer`

**Files:**
- Modify: `apps/web/src/components/slideover/field-renderer.tsx`
- Create: `apps/web/src/components/table/currency-cell.test.tsx`

The renderer is shared between slideover and table — adding the case here gets it everywhere.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/table/currency-cell.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldRenderer } from '../slideover/field-renderer.tsx';

describe('FieldRenderer currency', () => {
  it('renders the value formatted with the currency symbol', () => {
    render(
      <FieldRenderer
        fieldKey="amount"
        type="currency"
        value={1250}
        options={['EUR']}
        onCommit={() => {}}
      />
    );
    // Locale-dependent — assert the digits and symbol are both present, not a single string.
    const txt = screen.getByText(/1[\.,]250/).textContent ?? '';
    expect(txt).toMatch(/€/);
  });

  it('renders empty when value is null/undefined', () => {
    const { container } = render(
      <FieldRenderer fieldKey="amount" type="currency" value={null} options={['EUR']} onCommit={() => {}} />
    );
    // The display-mode element exists but renders no number.
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('commits a parsed number when the user types and blurs', async () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer fieldKey="amount" type="currency" value={100} options={['EUR']} onCommit={onCommit} />
    );
    fireEvent.click(screen.getByText(/€/));   // enter edit mode
    const input = screen.getByRole('spinbutton', { name: 'amount' });   // <input type=number>
    fireEvent.change(input, { target: { value: '350' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(350);
  });

  it('does not commit on blur when the value is unchanged', () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer fieldKey="amount" type="currency" value={100} options={['EUR']} onCommit={onCommit} />
    );
    fireEvent.click(screen.getByText(/€/));
    const input = screen.getByRole('spinbutton', { name: 'amount' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd apps/web && bunx vitest run src/components/table/currency-cell.test.tsx
```

Expected: fails with unsupported type or no currency renderer.

- [ ] **Step 3: Implement the `currency` branch**

In `apps/web/src/components/slideover/field-renderer.tsx`, find the switch in `FieldRenderer`. Add a `case 'currency':` before the `default`:

```tsx
case 'currency': {
  const code = (options?.[0] ?? 'EUR') as string;
  return (
    <CurrencyInput
      value={typeof value === 'number' ? value : null}
      currency={code}
      onCommit={onCommit as (v: number) => void}
      ariaLabel={fieldKey}
      isPending={isPending}
    />
  );
}
```

Then add the `CurrencyInput` component at the bottom of the file:

```tsx
function CurrencyInput({
  value,
  currency,
  onCommit,
  ariaLabel,
  isPending,
}: {
  value: number | null;
  currency: string;
  onCommit: (v: number) => void;
  ariaLabel: string;
  isPending?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditing(true); }}
        className={cn(
          'inline-block w-full cursor-text rounded-sm px-1 py-0.5 text-right text-sm font-mono hover:bg-card',
          isPending && 'opacity-60',
        )}
      >
        {value == null ? '' : formatter.format(value)}
      </span>
    );
  }
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = Number(draft);
        if (Number.isFinite(n) && n !== value) onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(value == null ? '' : String(value)); setEditing(false); }
      }}
      className={cn(
        'block w-32 rounded-sm border border-border-light bg-shell px-2 py-1 text-right text-sm font-mono text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}
```

`useState` and `cn` are already imported at the top.

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd apps/web && bunx vitest run src/components/table/currency-cell.test.tsx
```

Expected: all 4 pass.

- [ ] **Step 5: Run the full web suite — no regression in slideover tests**

```bash
cd apps/web && bun run test
```

Expected: 148 / 148 (144 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/slideover/field-renderer.tsx apps/web/src/components/table/currency-cell.test.tsx
git commit -m "phase-2b: currency cell renderer (formatted display + edit input)"
```

---

## Task 5: Build `TableCell` — universal cell wrapper

**Files:**
- Create: `apps/web/src/components/table/table-cell.tsx`

Dispatches to the right renderer based on the column. Built-ins (`title`, `status`, `updated_at`) get bespoke render; field columns delegate to `FieldRenderer`.

- [ ] **Step 1: Implement**

```tsx
import { ArrowUpRight } from 'lucide-react';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import { Icon } from '../ui/icon.tsx';
import { Pill } from '../ui/pill.tsx';
import { FieldRenderer } from '../slideover/field-renderer.tsx';
import type { Column } from './columns.ts';
import type { DocumentSummary, DocumentPatch } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  column: Column;
  doc: DocumentSummary;
  statuses: Status[];
  isPending: boolean;
  onOpen: (slug: string) => void;
  onTitleCommit: (slug: string, next: string) => void;
  onStatusCommit: (slug: string, next: string) => void;
  onFieldCommit: (slug: string, key: string, next: unknown) => void;
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.round((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function TableCell({ column, doc, statuses, isPending, onOpen, onTitleCommit, onStatusCommit, onFieldCommit }: Props) {
  if (column.source === 'builtin') {
    if (column.key === 'title') {
      return (
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label={`Open ${doc.title}`}
            onClick={() => onOpen(doc.slug)}
            className="text-fg-3 hover:text-fg"
          >
            <Icon icon={ArrowUpRight} size={14} />
          </button>
          <div className="min-w-0 flex-1">
            <InlineEdit
              value={doc.title}
              onCommit={(v) => onTitleCommit(doc.slug, v)}
              isPending={isPending}
              ariaLabel={`Edit title: ${doc.title}`}
            />
          </div>
        </div>
      );
    }
    if (column.key === 'status') {
      const current = doc.status ? statuses.find((s) => s.key === doc.status) ?? null : null;
      return (
        <InlineSelect
          value={doc.status}
          options={statuses.map((s) => ({ value: s.key, label: s.name, color: s.color }))}
          onCommit={(v) => onStatusCommit(doc.slug, v)}
          isPending={isPending}
          placeholder="no status"
          renderDisplay={(opt) =>
            opt && current ? (
              <Pill category={current.category} label={opt.label} />
            ) : (
              <span className="text-xs text-fg-3">no status</span>
            )
          }
        />
      );
    }
    if (column.key === 'updated_at') {
      return <span className="font-mono text-[11px] text-fg-3">{relativeTime(doc.updatedAt)}</span>;
    }
    return null;
  }

  // Field column — delegate to FieldRenderer
  const value = (doc.frontmatter as Record<string, unknown> | undefined)?.[column.key];
  if (!column.fieldType) return null;
  return (
    <FieldRenderer
      fieldKey={column.key}
      type={column.fieldType}
      value={value}
      options={column.fieldOptions ?? undefined}
      onCommit={(next) => onFieldCommit(doc.slug, column.key, next)}
      isPending={isPending}
    />
  );
}
```

Note: `DocumentSummary` may not currently include `frontmatter` — check `apps/web/src/lib/api/documents.ts`. If it doesn't, you may need to either:
- Add `frontmatter?: Record<string, unknown>` to `DocumentSummary` (server's GET /documents returns it for each row — confirm), OR
- Fetch the full document for field-cell rendering (worse — N+1).

If the field is genuinely not in `DocumentSummary`, do the small type widening and submit it as part of this task.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/table/table-cell.tsx
git commit -m "phase-2b: TableCell dispatches built-ins + delegates to FieldRenderer"
```

(No new tests in this task — the unit tests for the rendering paths are in `columns.test.ts` for the logic and `currency-cell.test.tsx` + `field-renderer`'s implicit usage. A render test for `TableCell` is wired in via the `TableView` integration test in Task 9.)

---

## Task 6: Build `TableHeader` (sort + column-picker + drag-reorder)

**Files:**
- Create: `apps/web/src/components/table/table-header.tsx`
- Create: `apps/web/src/components/table/column-picker.tsx`

- [ ] **Step 1: Implement `column-picker.tsx`**

```tsx
import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import type { Column } from './columns.ts';

interface Props {
  columns: Column[];
  visibleKeys: string[];
  onChange: (nextVisible: string[]) => void;
}

export function ColumnPicker({ columns, visibleKeys, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const isVisible = (k: string) => visibleKeys.includes(k);
  const toggle = (k: string) => {
    if (isVisible(k)) onChange(visibleKeys.filter((x) => x !== k));
    else onChange([...visibleKeys, k]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Columns">
          <Icon icon={Settings2} size={14} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-1">
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
                {c.source === 'builtin' ? (
                  <span className="text-[10px] text-fg-3">built-in</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Implement `table-header.tsx`**

```tsx
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useSortable, SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ColumnPicker } from './column-picker.tsx';
import type { Column } from './columns.ts';

export type SortKey = 'title' | 'status' | 'updated_at';
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir; }

const SORTABLE_BUILTINS: SortKey[] = ['title', 'status', 'updated_at'];

interface Props {
  columns: Column[];           // already ordered + filtered to visible
  allColumns: Column[];        // for the picker (full list)
  visibleKeys: string[];
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  onVisibilityChange: (next: string[]) => void;
  onReorder: (nextOrder: string[]) => void;
}

export function TableHeader({ columns, allColumns, visibleKeys, sort, onSort, onVisibilityChange, onReorder }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const ids = columns.map((c) => c.key);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-light bg-content px-4 py-1.5">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
            {columns.map((c) => (
              <SortableHeaderCell
                key={c.key}
                column={c}
                sort={sort}
                onSort={onSort}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <ColumnPicker columns={allColumns} visibleKeys={visibleKeys} onChange={onVisibilityChange} />
    </div>
  );
}

function SortableHeaderCell({
  column,
  sort,
  onSort,
}: {
  column: Column;
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: column.key });
  const style = { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const sortable = column.source === 'builtin' && SORTABLE_BUILTINS.includes(column.key as SortKey);
  const onClick = sortable
    ? () => {
        const isActive = sort?.key === column.key;
        if (!isActive) onSort({ key: column.key as SortKey, dir: 'asc' });
        else if (sort.dir === 'asc') onSort({ key: column.key as SortKey, dir: 'desc' });
        else onSort(null);
      }
    : undefined;

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onClick}
      className="inline-flex items-center gap-1 text-left text-[11px] uppercase tracking-wide text-fg-3 hover:text-fg-2"
    >
      {column.label}
      {sort?.key === column.key ? (
        <span className="font-mono text-[10px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
      ) : null}
    </button>
  );
}
```

- [ ] **Step 2 (alt): The grid template is auto-fit**

Note: a real spreadsheet uses fixed/auto column widths per column. v1 uses `minmax(140px, 1fr)` for every column — same width everywhere. Width-per-column is **deliberately deferred** to Phase 2C/2D — it's a UI preference that belongs in localStorage and can ship later without a schema or API change.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/table/column-picker.tsx apps/web/src/components/table/table-header.tsx
git commit -m "phase-2b: TableHeader with sort, picker, drag-reorder"
```

---

## Task 7: Build `TableRow`

**Files:**
- Create: `apps/web/src/components/table/table-row.tsx`

A row matches the header's grid layout: same `minmax(140px, 1fr)` columns. Each cell delegates to `TableCell`.

- [ ] **Step 1: Implement**

```tsx
import { TableCell } from './table-cell.tsx';
import { RowContextMenu } from '../views/row-context-menu.tsx';
import { toast } from 'sonner';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { formatApiError } from '../../lib/api/index.ts';
import type { Column } from './columns.ts';
import type { DocumentSummary, DocumentPatch } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  doc: DocumentSummary;
  columns: Column[];
  statuses: Status[];
  wslug: string;
  pslug: string;
  isPending: boolean;
  onOpen: (slug: string) => void;
  onUpdate: (slug: string, patch: Partial<DocumentPatch> & { frontmatter?: Record<string, unknown> }) => void;
}

export function TableRow({ doc, columns, statuses, wslug, pslug, isPending, onOpen, onUpdate }: Props) {
  const onTitleCommit = (slug: string, next: string) => onUpdate(slug, { title: next });
  const onStatusCommit = (slug: string, next: string) => onUpdate(slug, { status: next });
  const onFieldCommit = (slug: string, key: string, next: unknown) =>
    onUpdate(slug, { frontmatter: { ...(doc.frontmatter as Record<string, unknown>), [key]: next } });

  const onCopy = async () => {
    try {
      await copyDocumentAsMarkdown(wslug, pslug, doc.slug);
      toast.success('Copied as Markdown');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <RowContextMenu items={[{ label: 'Copy as Markdown', onSelect: onCopy, hint: '⌘⇧C' }]}>
      <div
        role="listitem"
        className="grid w-full grid-cols-[repeat(auto-fit,minmax(140px,1fr))] items-center gap-3 border-b border-border-light px-4 py-2 hover:bg-card"
      >
        {columns.map((c) => (
          <TableCell
            key={c.key}
            column={c}
            doc={doc}
            statuses={statuses}
            isPending={isPending}
            onOpen={onOpen}
            onTitleCommit={onTitleCommit}
            onStatusCommit={onStatusCommit}
            onFieldCommit={onFieldCommit}
          />
        ))}
      </div>
    </RowContextMenu>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/table/table-row.tsx
git commit -m "phase-2b: TableRow renders one TableCell per column"
```

---

## Task 8: Build `TableView` — replaces `ListView`

**Files:**
- Create: `apps/web/src/components/table/table-view.tsx`

Mostly a port of `apps/web/src/components/views/list-view.tsx` with these differences:
- Uses `useFields` to compute the column model + applies `mergeColumns` + `applyColumnOrder`.
- Reads view from `useViews` (the default view, or one selected via `?view=` — for now just the default; Phase 2C wires the picker).
- Saves visibility + column order to the view via `useUpdateView` (debounced).
- Renders `TableHeader` + `TableRow`s.

- [ ] **Step 1: Implement**

```tsx
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, useCallback } from 'react';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import {
  useDocuments,
  useCreateDocument,
  useUpdateDocument,
  parseFilters,
  clausesToListParams,
  applyFrontmatterClauses,
  type DocumentPatch,
  type FilterClauseUrl,
} from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { useViews, useUpdateView } from '../../lib/api/views.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Icon } from '../ui/icon.tsx';
import { FilterBar } from '../filter/filter-bar.tsx';
import { EmptyState } from '../views/empty-state.tsx';
import { ListSkeleton } from '../views/list-skeleton.tsx';
import { TableHeader, type SortState } from './table-header.tsx';
import { TableRow } from './table-row.tsx';
import { mergeColumns, applyColumnOrder, effectiveVisibleKeys, type Column } from './columns.ts';

interface Props { wslug: string; pslug: string; }

export function TableView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const clauses = useMemo(() => parseFilters(search), [search]);

  const sort: SortState | null = useMemo(() => {
    const k = typeof search.sort === 'string' ? search.sort : null;
    const d = typeof search.dir === 'string' ? search.dir : null;
    if (!k) return null;
    return { key: k as SortState['key'], dir: (d as SortState['dir']) ?? 'asc' };
  }, [search.sort, search.dir]);

  const listParams = useMemo(() => {
    const base = clausesToListParams(clauses);
    return sort ? { ...base, sort: sort.key, dir: sort.dir } : base;
  }, [clauses, sort]);

  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug);
  const { data: viewsData } = useViews(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const updateView = useUpdateView(wslug, pslug);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  // For Phase 2B: use the default view if any, else null. (Phase 2C wires picker.)
  const activeView = useMemo(() => {
    const list = viewsData ?? [];
    return list.find((v) => v.isDefault) ?? list[0] ?? null;
  }, [viewsData]);

  const allColumns: Column[] = useMemo(() => mergeColumns(fields ?? [], activeView), [fields, activeView]);
  const orderedColumns: Column[] = useMemo(
    () => applyColumnOrder(allColumns, activeView?.columnOrder ?? null),
    [allColumns, activeView],
  );
  const visibleKeys = useMemo(() => effectiveVisibleKeys(allColumns, activeView), [allColumns, activeView]);
  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => visibleKeys.includes(c.key)),
    [orderedColumns, visibleKeys],
  );

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onClauseChange = (next: FilterClauseUrl[]) => {
    const nextSearch: Record<string, unknown> = { ...search };
    for (const k of ['status', 'priority', 'labels', 'assignee', 'updated_since']) delete nextSearch[k];
    for (const c of next) {
      if (c.kind === 'status') nextSearch['status'] = c.values;
      if (c.kind === 'priority') nextSearch['priority'] = c.value;
      if (c.kind === 'labels') nextSearch['labels'] = c.values;
      if (c.kind === 'assignee') nextSearch['assignee'] = c.value;
      if (c.kind === 'updated_since') nextSearch['updated_since'] = c.value;
    }
    void navigate({ to: '.', search: nextSearch, replace: false });
  };

  const onSortChange = (next: SortState | null) => {
    const nextSearch: Record<string, unknown> = { ...search };
    if (next) { nextSearch.sort = next.key; nextSearch.dir = next.dir; }
    else { delete nextSearch.sort; delete nextSearch.dir; }
    void navigate({ to: '.', search: nextSearch, replace: false });
  };

  const onUpdate = useCallback(
    async (slug: string, patch: Partial<DocumentPatch> & { frontmatter?: Record<string, unknown> }) => {
      setPendingSlugs((prev) => new Set(prev).add(slug));
      try {
        await update.mutateAsync({ slug, patch });
      } finally {
        setPendingSlugs((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    },
    [update],
  );

  const onVisibilityChange = (next: string[]) => {
    if (!activeView) return;   // no view to save to — Phase 2C will create one on demand
    updateView.mutate({ id: activeView.id, patch: { visibleFields: next } });
  };

  const onReorder = (next: string[]) => {
    if (!activeView) return;
    updateView.mutate({ id: activeView.id, patch: { columnOrder: next } });
  };

  const filteredDocs = useMemo(
    () => applyFrontmatterClauses(page?.data ?? [], clauses),
    [page, clauses],
  );

  return (
    <>
      <div className="px-[22px] py-2">
        <FilterBar
          clauses={clauses}
          statuses={statuses ?? []}
          pinnedFields={fields ?? []}
          onChange={onClauseChange}
        />
      </div>
      <TableHeader
        columns={visibleColumns}
        allColumns={allColumns}
        visibleKeys={visibleKeys}
        sort={sort}
        onSort={onSortChange}
        onVisibilityChange={onVisibilityChange}
        onReorder={onReorder}
      />
      {isLoading ? <ListSkeleton rows={6} /> : null}
      {error ? <div className="p-4 text-danger">Failed to load documents.</div> : null}
      {!isLoading && !error && filteredDocs.length === 0 ? (
        <EmptyState
          icon={clauses.length === 0 ? <Icon icon={Inbox} size={20} /> : undefined}
          title={clauses.length > 0 ? 'No matching documents' : 'No work items yet'}
          description={
            clauses.length > 0
              ? 'Try removing a filter chip above.'
              : 'Create your first work item to get started.'
          }
          action={clauses.length === 0 ? { label: 'Create your first work item', onClick: onCreate } : undefined}
        />
      ) : null}
      <div role="list" className="flex flex-col">
        {filteredDocs.map((doc) => (
          <TableRow
            key={doc.id}
            doc={doc}
            columns={visibleColumns}
            statuses={statuses ?? []}
            wslug={wslug}
            pslug={pslug}
            isPending={pendingSlugs.has(doc.slug)}
            onOpen={openDoc}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/table/table-view.tsx
git commit -m "phase-2b: TableView — spreadsheet replacement for ListView"
```

---

## Task 9: Render test for `TableView`

**Files:**
- Create: `apps/web/src/components/table/table-view.test.tsx`

- [ ] **Step 1: Write a render test that mounts `TableView` with mocked API responses and asserts the column headers + cells render**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { TableView } from './table-view.tsx';

const server = setupServer(
  http.get('/api/v1/w/:ws/p/:p/documents', () =>
    HttpResponse.json({ data: [
      { id: 'd1', slug: 'first', title: 'First task', type: 'work_item', status: 'todo', updatedAt: new Date().toISOString(), frontmatter: { amount: 1250 } },
    ] })
  ),
  http.get('/api/v1/w/:ws/p/:p/statuses', () =>
    HttpResponse.json({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#3b82f6', category: 'unstarted', order: 0 }] })
  ),
  http.get('/api/v1/w/:ws/p/:p/fields', () =>
    HttpResponse.json({ data: [
      { id: 'f1', key: 'amount', type: 'currency', label: 'Amount', options: ['EUR'], required: false, order: 0 },
    ] })
  ),
  http.get('/api/v1/w/:ws/p/:p/views', () =>
    HttpResponse.json({ data: [
      { id: 'v1', slug: 'default', name: 'All', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: ['title', 'status', 'updated_at', 'amount'], columnOrder: null, isDefault: true, order: 0 },
    ] })
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('TableView', () => {
  it('renders columns from the active view and currency cells', async () => {
    const qc = new QueryClient();
    const root = createRootRoute({ component: () => <Outlet /> });
    const route = createRoute({ getParentRoute: () => root, path: '/', component: () => <TableView wslug="acme" pslug="web" /> });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });

    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText(/€/)).toBeInTheDocument();   // currency rendered
  });
});
```

If `msw` isn't already a dev dep, add it: `cd apps/web && bun add -d msw`. (Inspect `package.json` first; if there's a different mock pattern in use — e.g. `vitest`'s built-in fetch interception — use it.)

- [ ] **Step 2: Run the test**

```bash
cd apps/web && bunx vitest run src/components/table/table-view.test.tsx
```

Expected: all assertions green.

- [ ] **Step 3: Run full suite**

```bash
cd apps/web && bun run test
```

Expected: 149 / 149.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/table/table-view.test.tsx apps/web/package.json apps/web/bun.lock
git commit -m "phase-2b: render test for TableView (msw + mocked API)"
```

---

## Task 10: Swap `ListView` → `TableView` in the work-items route

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx`

- [ ] **Step 1: Read the file and find the `ListView` import + render site**

```bash
cat apps/web/src/routes/w.\$wslug.p.\$pslug.work-items.tsx
```

- [ ] **Step 2: Swap the import and the render**

```tsx
// before
import { ListView } from '../components/views/list-view.tsx';
// after
import { TableView } from '../components/table/table-view.tsx';
```

And:

```tsx
// before
<ListView wslug={wslug} pslug={pslug} />
// after
<TableView wslug={wslug} pslug={pslug} />
```

- [ ] **Step 3: Run the dev server and click through**

```bash
cd apps/server && bun --hot src/index.ts &
cd apps/web && bunx vite &
```

Open http://localhost:5173, log in, navigate to a project's Work Items tab. Expected: a real table renders with the three built-in columns (title, status, updated_at) and any fields that exist for the table. The kanban tab and wiki are unaffected.

If the seeded demo has no fields registered, the table will just show built-ins — that's expected. Create a field via `POST /fields` to see it appear as a column (or use the column picker to verify visibility toggles work).

- [ ] **Step 4: Run the manual-qa e2e suite — the existing 13 scenarios must still pass**

```bash
cd apps/web && npx playwright test manual-qa.spec.ts
```

Expected: 13 / 13.

Several scenarios reference the LIST view by visible affordances (`Edit title: ...` aria-label, `Open <title>` button). Those should keep working because:
- `TableCell` reuses `InlineEdit` with the same aria-label format.
- The "Open <title>" button is preserved in the title cell.
- The `<div role="listitem">` wrapper on rows is preserved.

If any scenario fails, investigate — likely a missing `role` attribute or label drift in `TableCell`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/w.\$wslug.p.\$pslug.work-items.tsx
git commit -m "phase-2b: work-items route renders TableView"
```

---

## Task 11: Update the demo seed with fields + a wider view

**Files:**
- Modify: `scripts/seed-demo.ts`

Currently the seed creates documents with rich frontmatter (priority, due_date, labels) but doesn't REGISTER fields. The spreadsheet relies on registered fields to know which columns to show. Add a small loop that POSTs fields after creating each project.

- [ ] **Step 1: After creating each project, register the standard fields**

Find the project-creation loop in `scripts/seed-demo.ts`. After the table-verification log line, add:

```ts
const STANDARD_FIELDS = [
  { key: 'priority',  type: 'select',       label: 'Priority', options: ['low', 'medium', 'high'], order: 10 },
  { key: 'assignee',  type: 'string',       label: 'Assignee', order: 20 },
  { key: 'labels',    type: 'multi_select', label: 'Labels',   options: ['security', 'phase-2', 'phase-1.5', 'phase-1', 'phase-1.1', 'agents', 'ux', 'design', 'bugfix', 'testing', 'docs', 'auth', 'lms', 'crm', 'integration', 'caching', 'billing', 'ops', 'internal-tool', 'security', 'feature', 'kickoff', 'scaffolding', 'blocked', 'frontend', 'content', 'form', 'i18n', 'combell', 'seo', 'launch', 'search'], order: 30 },
  { key: 'due_date',  type: 'date',         label: 'Due',      order: 40 },
];

for (const f of STANDARD_FIELDS) {
  await api('POST', `/api/v1/w/${WSLUG}/p/${p.slug}/fields`, f);
}
console.log(`      • ${STANDARD_FIELDS.length} fields registered`);
```

- [ ] **Step 2: Also patch the default view to show the new columns**

```ts
const v = await api('GET', `/api/v1/w/${WSLUG}/p/${p.slug}/views`);
const defaultView = v.data.find((x) => x.isDefault);
if (defaultView) {
  await api('PATCH', `/api/v1/w/${WSLUG}/p/${p.slug}/views/${defaultView.id}`, {
    visibleFields: ['title', 'status', 'priority', 'assignee', 'due_date', 'labels', 'updated_at'],
  });
}
```

- [ ] **Step 3: Re-seed end-to-end**

```bash
cd /home/ntdst/Projects/folio
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
cd /home/ntdst/Projects/folio
# Make sure the dev server is running (Task 10 started it; or start a fresh one).
bun run scripts/seed-demo.ts
```

Expected: each project logs `4 fields registered`. Reload the browser to see the columns appear.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-demo.ts
git commit -m "phase-2b: seed registers standard fields + opens default view columns"
```

---

## Task 12: Memory + close out

**Files:**
- Modify: `memory/STATE.md`
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Update `memory/STATE.md`**

Mark Phase 2B as shipped:
- Replace `Phase 2B (Spreadsheet table UI): not started.` with `shipped on \`phase-1.5/ux-polish\``.
- Update the "What's working in the UI" section: replace "List view (filters, sort, inline title + status edit)" with "Spreadsheet table view (one column per pinned field, column picker + drag reorder, currency/date/select/multi-select cell types, persisted to the active view)."
- Update test counts: server (~112 with the new fields/views tests); web (~149 with the table tests).
- Add a session-log line for Phase 2B.

- [ ] **Step 2: Update `memory/DECISIONS.md`**

Add a Phase 2B section:

```markdown
## Phase 2B — Spreadsheet table UI (2026-05-24)

- Built-in columns: `title`, `status`, `updated_at`. Field columns appear one per `fields` row, in `fields.order` ascending.
- Visibility + column order live on `views.visibleFields` (string[]) and `views.columnOrder` (string[] | null). Column WIDTH is per-user only — localStorage, not in the DB.
- New `currency` field type: stored as a plain number in frontmatter; `fields.options` carries a single ISO-4217 code (e.g. `["EUR"]`); rendered right-aligned via `Intl.NumberFormat`.
- Drag-reorder columns via `@dnd-kit/sortable` on the header row.
- A view with `visibleFields=[]` falls back to showing built-ins only. A view with `columnOrder=null` uses default order (built-ins, then fields by `fields.order`).
- The new `TableView` lives at `apps/web/src/components/table/*` and replaces `ListView` on the work-items route. `ListView` and its supporting files stay around briefly for diff comparison and will be deleted after Phase 2C lands.
```

- [ ] **Step 3: Commit**

```bash
git add memory/STATE.md memory/DECISIONS.md
git commit -m "memory(folio): close out Phase 2B spreadsheet table UI"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Per-table column visibility picker — Task 6 (`ColumnPicker`).
- ✅ Currency cell type — Tasks 1 (backend) + 4 (frontend renderer).
- ✅ Date cell type — already exists in `FieldRenderer`; surfaced via `TableCell` → `FieldRenderer`.
- ✅ Select / multi-select cell types — already exist; same surfacing.
- ✅ Drag-reorder columns — Task 6 (`SortableContext` + `arrayMove`).
- ✅ Per-view column state — Task 1 (schema) + Task 2 (API client) + Task 8 (TableView reads/writes via useUpdateView).
- ✅ Default view auto-applies — Task 8 (picks `isDefault`).
- ✅ Existing e2e tests still pass — Task 10 verifies.
- ✅ Demo data shows real columns — Task 11.

**Risk areas:**
- `DocumentSummary` might not include `frontmatter` — Task 5 calls this out and accepts a small type widening if needed. Confirm before starting Task 5 whether the server's GET /documents already returns frontmatter on the list rows.
- `client.patch` might not exist — Task 2 says to mirror `useUpdateDocument` if missing.
- `msw` might not be a dep — Task 9 says to install if missing, OR use whatever fetch-mock pattern the repo already uses.
- Grid `repeat(auto-fit, minmax(140px, 1fr))` gives same-width columns; if the table has many fields the row gets crammed. Acceptable for v1; per-column widths land in 2C+.
- The dual-source-of-truth sort (URL params on built-ins, view sort for saved sorts) is not unified in 2B — Phase 2C will harmonize when the view picker lands.

**Out of scope (deferred):**
- View picker UI in rail (Phase 2C).
- Render mode switching per view (Phase 2D — kanban becomes one of many).
- Column widths persisted in DB.
- Locking columns to the left.
- Frozen header row when there are many rows (sticky already, but no scroll container).
- Bulk select + multi-row actions.
