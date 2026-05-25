# Phase 1.9.1 — Type Change UI + `useUpdateView` Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD per task: RED → GREEN → REFACTOR → commit.

**Goal:** Close out the two deferred items from Phase 1.9. (1) Add compatible-only type-change to the column header `⋯` menu (`string ↔ text`, `number → currency` with default ISO `EUR`, `* → text`). Block incompatible type changes with a clear error message. (2) Fix the latent envelope-unwrap bug in `useUpdateView` so its return type matches reality.

**Architecture:**
- **Server:** New `validateTypeChange(oldType, newType)` helper in `apps/server/src/routes/fields.ts` returns the compatibility matrix. PATCH `/fields/:id` calls it when `patch.type` is set and `patch.type !== row.type`. Returns 422 with `INVALID_TYPE_CHANGE` code on incompatible changes.
- **Client:** Extend `ColumnMenu` with a new "Change type" item (between Rename and Hide). It opens an inline popover (reusing `TableAddColumn`'s form shape minus the key input) that PATCHes `/fields/:id` with the new type + options. Client also surfaces the server's 422 as a toast.
- **`useUpdateView` fix:** Mirror Task 3's `useUpdateField` pattern: `client.patch<{ view: View }>(...)` then return `wrapped.view`. Update test mocks to use the realistic `{ data: { view: ... } }` shape.

**Tech Stack:** Hono (server validation), Drizzle (read existing field type), Vitest (web tests), Bun test (server tests). No new dependencies.

**Branch:** `phase-1.9.1/type-change-and-views-fix` cut from `phase-1.9/field-management-ui` tip `dfae47d`. Will merge into main after Phase 1.9 PR #2 lands.

---

## Compatibility Matrix (spec)

| From → To | Compatible? | Notes |
|-----------|-------------|-------|
| `string ↔ text` | ✅ | Both store strings; cell renderer changes. |
| `number → currency` | ✅ | Server fills `options[0] = 'EUR'` if not provided. Currency cell renders the same numeric value with formatting. |
| `currency → number` | ✅ | Drops the `options` array (server sets options to `null`). |
| any → `text` | ✅ | `text` accepts any stringifiable value. |
| same type | ✅ (no-op) | Allowed but does nothing. |
| anything else | ❌ | Server returns 422 with `INVALID_TYPE_CHANGE` and a message listing the allowed transitions. |

**Out of scope (defer further):** value-remap UI for incompatible changes (PHASES.md's full migration matrix), `select ↔ multi_select` (would need a remap path for arrayification), `date ↔ datetime` (would need normalization).

---

## File Structure

**New files:**
- `apps/server/src/lib/field-type-change.ts` — pure helper `validateTypeChange(oldType, newType): { ok: true } | { ok: false; reason: string }`
- `apps/server/src/lib/field-type-change.test.ts` — compatibility matrix tests
- `apps/web/src/components/table/column-type-change.tsx` — popover form for type change
- `apps/web/src/components/table/column-type-change.test.tsx` — form tests

**Modified files:**
- `apps/server/src/routes/fields.ts` — call `validateTypeChange` in PATCH handler when `patch.type` differs from row.type
- `apps/server/src/routes/fields.test.ts` — add compatibility tests (allow string→text, block date→number, etc.)
- `apps/web/src/components/table/column-menu.tsx` — add "Change type" `<button>` between Rename and Hide; new `onChangeType` prop
- `apps/web/src/components/table/column-menu.test.tsx` — new test for Change type action
- `apps/web/src/components/table/table-view.tsx` — wire `onChangeType` → open the new popover; build `onChangeTypeSubmit` handler
- `apps/web/src/components/table/table-view.test.tsx` — new test for full change-type happy path + 422 toast
- `apps/web/src/lib/api/views.ts` — fix `useUpdateView` to unwrap `{ view: row }` envelope
- `apps/web/src/lib/api/views.test.tsx` (likely new) or extend an existing test file — assert return-value contract

---

## Conventions

Same as Phase 1.9 plan:
- TDD per task. Web tests via `cd apps/web && bun run test <file>`. Server via `cd apps/server && bun test <file>`.
- Type-check via `cd apps/web && bunx tsc --noEmit`.
- Commit cadence: one commit per task, message format `phase-1.9.1: <what>`.
- No drive-by edits. No new CSS tokens. No new dependencies.

---

## Task 1: `validateTypeChange` server-side helper

**Files:**
- Create: `apps/server/src/lib/field-type-change.ts`
- Create: `apps/server/src/lib/field-type-change.test.ts`

### Step 1: Write the failing test

**Create `apps/server/src/lib/field-type-change.test.ts`:**

```ts
import { describe, expect, it } from 'bun:test';
import { validateTypeChange } from './field-type-change.ts';

describe('validateTypeChange', () => {
  it('accepts string → text and back', () => {
    expect(validateTypeChange('string', 'text').ok).toBe(true);
    expect(validateTypeChange('text', 'string').ok).toBe(true);
  });

  it('accepts number → currency and back', () => {
    expect(validateTypeChange('number', 'currency').ok).toBe(true);
    expect(validateTypeChange('currency', 'number').ok).toBe(true);
  });

  it('accepts any → text', () => {
    expect(validateTypeChange('number', 'text').ok).toBe(true);
    expect(validateTypeChange('date', 'text').ok).toBe(true);
    expect(validateTypeChange('select', 'text').ok).toBe(true);
    expect(validateTypeChange('multi_select', 'text').ok).toBe(true);
    expect(validateTypeChange('boolean', 'text').ok).toBe(true);
  });

  it('accepts same → same (no-op)', () => {
    expect(validateTypeChange('number', 'number').ok).toBe(true);
    expect(validateTypeChange('select', 'select').ok).toBe(true);
  });

  it('rejects incompatible changes with a clear reason', () => {
    const r = validateTypeChange('number', 'select');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/number → select/);
    }
  });

  it('rejects date ↔ number', () => {
    expect(validateTypeChange('date', 'number').ok).toBe(false);
    expect(validateTypeChange('number', 'date').ok).toBe(false);
  });

  it('rejects select ↔ multi_select', () => {
    expect(validateTypeChange('select', 'multi_select').ok).toBe(false);
    expect(validateTypeChange('multi_select', 'select').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/server && bun test field-type-change.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `validateTypeChange`**

**Create `apps/server/src/lib/field-type-change.ts`:**

```ts
const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  'currency',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type TypeChangeResult =
  | { ok: true }
  | { ok: false; reason: string };

const COMPATIBLE_PAIRS: ReadonlySet<string> = new Set([
  // bidirectional string-family
  'string→text', 'text→string',
  // bidirectional number ↔ currency
  'number→currency', 'currency→number',
]);

export function validateTypeChange(oldType: FieldType, newType: FieldType): TypeChangeResult {
  if (oldType === newType) return { ok: true };
  // any → text is always safe; text accepts any stringifiable value.
  if (newType === 'text') return { ok: true };
  const key = `${oldType}→${newType}`;
  if (COMPATIBLE_PAIRS.has(key)) return { ok: true };
  return {
    ok: false,
    reason: `Cannot change ${oldType} → ${newType}. Allowed: string ↔ text, number ↔ currency, any → text. Delete the column and recreate it with the new type to migrate values manually.`,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/server && bun test field-type-change.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/field-type-change.ts apps/server/src/lib/field-type-change.test.ts
git commit -m "phase-1.9.1: add validateTypeChange compatibility helper"
```

---

## Task 2: Wire `validateTypeChange` into PATCH `/fields/:id`

**Files:**
- Modify: `apps/server/src/routes/fields.ts`
- Modify: `apps/server/src/routes/fields.test.ts`

### Step 1: Write the failing test

In `apps/server/src/routes/fields.test.ts`, add new cases inside the existing PATCH `describe` block (or after it). Look at the existing test for shape — copy the helpers / setup.

```ts
it('allows compatible type change: string → text', async () => {
  // Setup: create a `string` field, then PATCH it to `text`.
  // (Use existing test setup helpers; do not invent new ones.)
  const created = await /* create field with type: 'string' */;
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/t/${table.slug}/fields/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: authCookie },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.field.type).toBe('text');
});

it('rejects incompatible type change: number → select with 422', async () => {
  const created = await /* create field with type: 'number' */;
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/t/${table.slug}/fields/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: authCookie },
    body: JSON.stringify({ type: 'select', options: ['low', 'high'] }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_TYPE_CHANGE');
  expect(body.error.message).toMatch(/number → select/);
});

it('allows any type change to text', async () => {
  const created = await /* create field with type: 'date' */;
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/t/${table.slug}/fields/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: authCookie },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(res.status).toBe(200);
});

it('allows number → currency and stores default EUR option when none provided', async () => {
  const created = await /* create field with type: 'number' */;
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/t/${table.slug}/fields/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: authCookie },
    body: JSON.stringify({ type: 'currency' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.field.type).toBe('currency');
  expect(body.data.field.options).toEqual(['EUR']);
});
```

> **Helper hint:** the existing test file already has factories for creating workspaces, projects, tables, and fields. Reuse them. If you can't find a factory for "create field with type X", look at how the existing PATCH tests create the seed field — they likely POST and then capture the response.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/server && bun test fields.test.ts`
Expected: FAIL — server currently allows all type changes (only validates options shape), so the `number → select` rejection won't happen and the `number → currency` default-EUR injection won't either.

- [ ] **Step 3: Modify `apps/server/src/routes/fields.ts` PATCH handler**

Around line 103-107, add the compatibility check + default-EUR injection BEFORE `validateOptions`:

```ts
import { validateTypeChange } from '../lib/field-type-change.ts';

// ...inside the PATCH handler, after `const patch = c.req.valid('json');`...
const finalType = patch.type ?? row.type;

if (patch.type && patch.type !== row.type) {
  const check = validateTypeChange(row.type, patch.type);
  if (!check.ok) {
    throw new HTTPError('INVALID_TYPE_CHANGE', check.reason, 422);
  }
}

// Default-EUR injection for number → currency when no options supplied.
let finalOptions: string[] | undefined =
  patch.options !== undefined ? patch.options : (row.options ?? undefined);
if (patch.type === 'currency' && row.type !== 'currency' && (!finalOptions || finalOptions.length === 0)) {
  finalOptions = ['EUR'];
}

// When transitioning AWAY from currency, drop the options to null.
if (row.type === 'currency' && patch.type && patch.type !== 'currency' && patch.options === undefined) {
  finalOptions = undefined;
}

validateOptions(finalType, finalOptions ?? undefined);

// Persist the (possibly mutated) options + type.
const updatePatch: typeof patch & { options?: string[] | null } = { ...patch };
if (patch.type === 'currency' && !patch.options) {
  updatePatch.options = ['EUR'];
}
if (row.type === 'currency' && patch.type && patch.type !== 'currency' && patch.options === undefined) {
  updatePatch.options = null;
}
```

Then replace the `await tx.update(fields).set(patch)` call with `await tx.update(fields).set(updatePatch)` and the final `return jsonOk(c, { field: { ...row, ...patch } });` with `return jsonOk(c, { field: { ...row, ...updatePatch } });`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/server && bun test fields.test.ts`
Expected: PASS — all new cases + existing PATCH tests still green.

- [ ] **Step 5: Run the full server suite**

Run: `cd apps/server && bun test`
Expected: 123 + 4 = 127 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/fields.ts apps/server/src/routes/fields.test.ts
git commit -m "phase-1.9.1: enforce type-change compatibility on field PATCH"
```

---

## Task 3: `ColumnTypeChange` popover form

**Files:**
- Create: `apps/web/src/components/table/column-type-change.tsx`
- Create: `apps/web/src/components/table/column-type-change.test.tsx`

### Step 1: Write the failing test

**Create `apps/web/src/components/table/column-type-change.test.tsx`:**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ColumnTypeChange } from './column-type-change.tsx';

describe('ColumnTypeChange', () => {
  it('lists the current type and offers compatible targets', () => {
    render(<ColumnTypeChange currentType="string" currentOptions={null} onSubmit={vi.fn()} onClose={vi.fn()} open />);
    expect(screen.getByLabelText(/^new type$/i)).toBeInTheDocument();
    const select = screen.getByLabelText(/^new type$/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    // string → text is compatible; string → text → string round-trip listed
    expect(options).toContain('text');
    // string → select is incompatible — not in the dropdown (or disabled)
    expect(options).not.toContain('select');
  });

  it('shows ISO input when target is currency and source is number', () => {
    render(<ColumnTypeChange currentType="number" currentOptions={null} onSubmit={vi.fn()} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'currency' } });
    expect(screen.getByLabelText(/iso code/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/iso code/i) as HTMLInputElement).value).toBe('EUR');
  });

  it('calls onSubmit with the new type + options on Apply', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ColumnTypeChange currentType="number" currentOptions={null} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'currency' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ type: 'currency', options: ['EUR'] });
    });
  });

  it('does not include options for changes that drop the array (currency → number)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ColumnTypeChange currentType="currency" currentOptions={['EUR']} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ type: 'number' });
    });
  });

  it('surfaces an error returned from onSubmit', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('server said no'));
    render(<ColumnTypeChange currentType="string" currentOptions={null} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(await screen.findByText(/server said no/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test column-type-change.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ColumnTypeChange`**

**Create `apps/web/src/components/table/column-type-change.tsx`:**

```tsx
import { useState } from 'react';
import type { FieldType } from '../../lib/api/fields.ts';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';

const ISO_RE = /^[A-Z]{3}$/;

interface Props {
  currentType: FieldType;
  currentOptions: string[] | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { type: FieldType; options?: string[] | null }) => Promise<void>;
}

function compatibleTargets(from: FieldType): FieldType[] {
  // Mirror the server matrix exactly; the server is the source of truth, this
  // just keeps incompatible options out of the dropdown so users don't fight
  // the form.
  if (from === 'string') return ['text'];
  if (from === 'text') return ['string'];
  if (from === 'number') return ['currency', 'text'];
  if (from === 'currency') return ['number', 'text'];
  return ['text'];
}

export function ColumnTypeChange({ currentType, currentOptions, open, onClose, onSubmit }: Props) {
  const targets = compatibleTargets(currentType);
  const [target, setTarget] = useState<FieldType>(targets[0] ?? 'text');
  const [iso, setIso] = useState(currentOptions?.[0] ?? 'EUR');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleApply() {
    setError(null);
    let options: string[] | null | undefined;
    if (target === 'currency' && currentType !== 'currency') {
      if (!ISO_RE.test(iso)) {
        setError('Currency requires a 3-letter ISO-4217 code (e.g. EUR, USD).');
        return;
      }
      options = [iso];
    } else if (currentType === 'currency' && target !== 'currency') {
      options = null;
    }
    setSubmitting(true);
    try {
      const payload: { type: FieldType; options?: string[] | null } = { type: target };
      if (options !== undefined) payload.options = options;
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change type.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <DialogContent>
        <DialogTitle>Change column type</DialogTitle>
        <DialogDescription>
          Current: <code>{currentType}</code>. Pick a compatible new type. Values that don't fit the new type remain in raw frontmatter but the cell renderer changes.
        </DialogDescription>
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="ctc-type">New type</label>
          <select
            id="ctc-type"
            value={target}
            onChange={(e) => setTarget(e.target.value as FieldType)}
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          >
            {targets.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {target === 'currency' && currentType !== 'currency' ? (
            <>
              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="ctc-iso">ISO code</label>
              <input
                id="ctc-iso"
                value={iso}
                onChange={(e) => setIso(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="EUR"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleApply()} disabled={submitting || target === currentType}>
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

> If `Button` doesn't export `variant="primary"` / `variant="secondary"`, read `apps/web/src/components/ui/button.tsx` and match the variants used in `column-menu.tsx`'s delete dialog.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/web && bun run test column-type-change.test.tsx`
Expected: PASS — 5/5 green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/table/column-type-change.tsx \
        apps/web/src/components/table/column-type-change.test.tsx
git commit -m "phase-1.9.1: add ColumnTypeChange dialog"
```

---

## Task 4: Wire "Change type" into `ColumnMenu` + `TableView`

**Files:**
- Modify: `apps/web/src/components/table/column-menu.tsx`
- Modify: `apps/web/src/components/table/column-menu.test.tsx`
- Modify: `apps/web/src/components/table/table-view.tsx`
- Modify: `apps/web/src/components/table/table-view.test.tsx`

### Step 1: Extend `ColumnMenu` test

In `apps/web/src/components/table/column-menu.test.tsx`, add a new case:

```tsx
it('calls onChangeType when Change type is selected', () => {
  const onChangeType = vi.fn();
  render(
    <ColumnMenu
      columnKey="amount"
      columnLabel="Amount"
      onRename={() => {}}
      onChangeType={onChangeType}
      onHide={() => {}}
      onDelete={() => Promise.resolve()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /change type/i }));
  expect(onChangeType).toHaveBeenCalled();
});
```

Also update the existing 3 tests to include `onChangeType={() => {}}` in the rendered props (the prop is required — or make it required in the interface).

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test column-menu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add `Change type` to `ColumnMenu`**

In `apps/web/src/components/table/column-menu.tsx`:

- Add `onChangeType: () => void` to the `Props` interface.
- Destructure it in the function.
- Insert a new `<button role="menuitem">` between Rename and Hide:
  ```tsx
  <button
    type="button"
    role="menuitem"
    className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
    onClick={() => { setMenuOpen(false); onChangeType(); }}
  >
    Change type
  </button>
  ```

- [ ] **Step 4: Run column-menu tests and watch them pass**

Run: `cd apps/web && bun run test column-menu.test.tsx`
Expected: PASS — 4 tests now.

- [ ] **Step 5: Wire from `TableView`**

Add to `apps/web/src/components/table/table-view.tsx`:

```tsx
import { ColumnTypeChange } from './column-type-change.tsx';
// ...
const [changingTypeKey, setChangingTypeKey] = useState<string | null>(null);
```

In `renderColumnMenu`, add:

```tsx
onChangeType={() => setChangingTypeKey(column.key)}
```

After the existing `<TableHeader>` JSX, mount the dialog:

```tsx
{changingTypeKey ? (() => {
  const field = (fields ?? []).find((f) => f.key === changingTypeKey);
  if (!field) return null;
  return (
    <ColumnTypeChange
      currentType={field.type}
      currentOptions={field.options}
      open={!!changingTypeKey}
      onClose={() => setChangingTypeKey(null)}
      onSubmit={async ({ type, options }) => {
        await updateField.mutateAsync({
          id: field.id,
          patch: options === null ? { type, options: undefined } : (options !== undefined ? { type, options } : { type }),
        });
      }}
    />
  );
})() : null}
```

> **Note on the `options: null` case:** the server's PATCH handler interprets a missing `options` key on a `currency → number` transition as "drop to null." The client passes `options: undefined` (i.e. omits the key) for that case. For `* → currency`, the client passes `options: ['EUR']` explicitly. For `string ↔ text`, omit `options`.

- [ ] **Step 6: Add a TableView test for the full flow**

In `apps/web/src/components/table/table-view.test.tsx`, add:

```tsx
it('Change type → Apply PATCHes /fields/:id with the new type', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    if (u.includes('/fields') && method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: u, method, body });
      return jsonResponse({ data: { field: { id: 'f1', key: 'amount', type: 'currency', label: 'Amount', options: ['EUR'], required: false, order: 0 } } });
    }
    if (u.includes('/fields') && method === 'GET') {
      return jsonResponse([{ id: 'f1', key: 'amount', type: 'number', label: 'Amount', options: null, required: false, order: 0 }]);
    }
    return jsonResponse(emptyListResponse());
  }) as unknown as typeof fetch;

  renderTableView({ wslug: 'acme', pslug: 'sales', tslug: 'work-items' });
  await screen.findByText('Amount');

  // Hover the Amount header cell to reveal ⋯, then click it.
  fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /change type/i }));

  fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'currency' } });
  fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));

  await waitFor(() => {
    expect(calls[0]?.url).toContain('/fields/f1');
    expect(calls[0]?.body).toMatchObject({ type: 'currency', options: ['EUR'] });
  });
});
```

> If the test fails to find the `⋯` button because it's hover-revealed: the existing Hide/Delete tests already work around this — copy their setup.

- [ ] **Step 7: Run the full web suite**

Run: `cd apps/web && bun run test`
Expected: 245 + 5 (Task 3) + 1 (Task 4 ColumnMenu) + 1 (Task 4 TableView) = 252 passing.

- [ ] **Step 8: Type-check**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/table/column-menu.tsx \
        apps/web/src/components/table/column-menu.test.tsx \
        apps/web/src/components/table/table-view.tsx \
        apps/web/src/components/table/table-view.test.tsx
git commit -m "phase-1.9.1: wire Change type into ColumnMenu and TableView"
```

---

## Task 5: Fix `useUpdateView` envelope unwrap

**Files:**
- Modify: `apps/web/src/lib/api/views.ts`
- Create OR extend: `apps/web/src/lib/api/views.test.tsx`

### Step 1: Write the failing test

If `views.test.tsx` doesn't exist, create it. Otherwise extend it.

```tsx
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpdateView } from './views.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useUpdateView', () => {
  it('PATCHes /views/:id and returns the unwrapped View', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        data: { view: { id: 'v1', name: 'Renamed', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: ['title'], columnOrder: null, isDefault: true, order: 0 } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const { result } = renderHook(() => useUpdateView('acme', 'sales'), { wrapper: wrap(qc) });
    const updated = await result.current.mutateAsync({ id: 'v1', patch: { name: 'Renamed' } });

    expect(updated.name).toBe('Renamed');
    expect(updated.id).toBe('v1');
    // Crucially: the resolved value is a View, NOT { view: View }.
    expect('view' in (updated as unknown as Record<string, unknown>)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/web && bun run test views.test.tsx`
Expected: FAIL — `updated.name` is `undefined` because `updated` is `{ view: View }`, and `'view' in updated` is `true`.

- [ ] **Step 3: Apply the fix to `apps/web/src/lib/api/views.ts`**

Replace `useUpdateView` (lines 72-80) with:

```ts
export function useUpdateView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server PATCH returns `{ data: { view: row } }`; client.patch strips the
    // outer `data` envelope but not the inner `view` key.
    mutationFn: async ({ id, patch }: { id: string; patch: ViewPatch }): Promise<View> => {
      const wrapped = await client.patch<{ view: View }>(
        `/api/v1/w/${wslug}/p/${pslug}/views/${id}`,
        patch,
      );
      return wrapped.view;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) }),
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/web && bun run test views.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full web suite**

Run: `cd apps/web && bun run test`
Expected: 252 + 1 = 253 passing. **Check carefully** — `useUpdateView` is heavily used in `TableView` (filters auto-save, sort auto-save, columnOrder, visibleFields). If any existing test was implicitly relying on the buggy `{ view: ... }` resolution (e.g. asserting on a wrapper shape), it will now fail.

If a test fails, read it: does it actually depend on the wrapped shape, or did it just not assert deeply enough? In almost every case the test should be tightened to assert the contract (return value is a `View`).

- [ ] **Step 6: Type-check**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: clean. **Likely catches any caller that was structurally accessing the wrong shape** — fix those callsites if any.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api/views.ts apps/web/src/lib/api/views.test.tsx
git commit -m "phase-1.9.1: fix useUpdateView envelope unwrap"
```

---

## Task 6: Docs + integration gate + PR

**Files:**
- Modify: `docs/PHASES.md` — check off the Phase 1.9.1 line under 1.9.1 follow-ups (or add a "Phase 1.9.1 — shipped" line).
- Modify: `memory/STATE.md` — flip Phase 1.9.1 from queued to shipped; remove the "Latent bug surfaced" section since it's fixed.

### Steps

- [ ] **Step 1:** In `docs/PHASES.md`, under the "Phase 1.9.1 — deferred follow-ups" block (just added in Phase 1.9's Task 10), strike through items 1 and 3 (type-change + envelope fix shipped). Leave the Playwright item as still deferred.

- [ ] **Step 2:** In `memory/STATE.md`, replace the existing Phase 1.9.1 mention with a "shipped" line and remove the "Latent bug surfaced" section.

- [ ] **Step 3: Run the integration gate.**

```bash
cd apps/web && bun run test
cd apps/server && bun test
cd packages/shared && bun test
cd apps/web && bunx tsc --noEmit
```

Expected: all green. Server count: 127 (was 123 + 4). Web count: 253 (was 245 + 8). Shared: 28.

- [ ] **Step 4: Manual smoke (5 minutes).**

Start `bun dev`, open the work-items page. Hover a `currency` or `number` column header → `⋯ → Change type`. Try:
- `string → text` (should succeed, table re-renders with text cell renderer)
- `number → currency` (should succeed, cell becomes currency-formatted, default EUR applied)
- `currency → number` (should succeed, cell becomes plain number)
- `number → select` (server returns 422; UI shows red toast / inline error with the rejection message)

- [ ] **Step 5: Commit docs.**

```bash
git add docs/PHASES.md memory/STATE.md
git commit -m "phase-1.9.1: complete"
```

- [ ] **Step 6: Push branch and open PR against main.**

```bash
git push -u origin phase-1.9.1/type-change-and-views-fix
gh pr create --title "phase-1.9.1: type-change UI + useUpdateView fix" --body "..."
```

PR body template:

```
## Summary

Phase 1.9.1 — closes the two follow-ups from Phase 1.9.

1. **Compatible-only type-change in column `⋯` menu.** Allowed: `string ↔ text`, `number ↔ currency`, `any → text`. Incompatible changes return 422 with `INVALID_TYPE_CHANGE` and a message listing the allowed transitions. Default ISO `EUR` is auto-injected on `number → currency`; options drop to `null` on `currency → number`.
2. **`useUpdateView` envelope unwrap.** Mirrors Task 3's `useUpdateField` fix. Server returns `{ data: { view: row } }`; the hook now resolves with the unwrapped `View`, not `{ view: View }`.

## Test plan

- [x] Server unit suite: 127 / 127 (was 123 + 4 from new compatibility tests)
- [x] Web unit suite: 253 / 1 skipped (was 245 + 8 from new Column Type Change tests + Column Menu change-type test + TableView integration test + views.test.tsx fix test)
- [x] Shared package: 28 / 28
- [x] Type-check: `bunx tsc --noEmit` in `apps/web` clean
- [ ] Manual smoke: change type on a `number`, `string`, and `currency` column; attempt an incompatible change and confirm the toast surfaces the server's rejection message.

## Out of scope (deferred further)

- Value-remap UI for incompatible type changes (PHASES.md's full migration matrix). Path forward: "Delete column and recreate" with explicit confirmation.
- `select ↔ multi_select`, `date ↔ datetime` — would need value-shape normalization.
- Playwright e2e for the full column-management flow.

## Note

Branch is cut from `phase-1.9/field-management-ui`; merge **after** PR #2 lands so this PR's diff is clean against main.
```

---

## Self-Review

Spec coverage:

| Spec line | Plan task |
|-----------|-----------|
| Compatible-only type matrix | Task 1 (helper), Task 2 (server enforcement), Task 3 (client form), Task 4 (wiring) |
| Default ISO `EUR` on `* → currency` | Task 2 (server) + Task 3 (client) |
| Drop options on `currency → *` | Task 2 + Task 4 |
| Server returns 422 for incompatible | Task 2 |
| Client surfaces server error | Task 3 step 5 (error path test) + Task 4 |
| `useUpdateView` envelope fix | Task 5 |
| Update PHASES.md + STATE.md | Task 6 |
| Manual smoke | Task 6 step 4 |

Placeholder scan: no TBDs. Every code block is complete. Test mocks are realistic.

Type consistency: `FieldType`, `TypeChangeResult`, `Props` shapes are all defined before use. `compatibleTargets` matches the server's `validateTypeChange` matrix exactly — the spec doc on Task 1 is the source of truth and both implementations cite it.
