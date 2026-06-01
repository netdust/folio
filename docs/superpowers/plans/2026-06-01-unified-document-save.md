# Unified Header Save for Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-change auto-save in both document slideovers with one buffered draft-and-save model surfaced by a dirty-gated header disk icon, plus a save/discard/cancel guard on close and Cmd-S/toast/spinner UX.

**Architecture:** A shared `useDocumentDraft` hook holds a `{ body, frontmatter }` buffer, computes `isDirty`, and produces a save diff. The draft lives at the slideover-parent level (where both the header and body render) and is threaded into the body editors as their onChange target. Title and status keep their existing immediate-commit paths. A shared `SaveButton` renders the clean/dirty/saving states in both headers; a shared `useUnsavedGuard` intercepts close/doc-switch while dirty.

**Tech Stack:** React 18, TanStack Router, TanStack Query, Vitest + Testing Library, Tailwind, lucide-react, sonner.

**Reference spec:** `docs/superpowers/specs/2026-06-01-unified-document-save-design.md`

---

## File Structure

- **new** `apps/web/src/lib/use-document-draft.ts` — buffer + isDirty + diff hook
- **new** `apps/web/src/lib/use-document-draft.test.ts`
- **new** `apps/web/src/components/slideover/save-button.tsx` — disk icon, 3 states
- **new** `apps/web/src/lib/use-unsaved-guard.ts` — close/switch intercept + dialog state
- **modify** `apps/web/src/components/slideover/workspace-document-slideover.tsx` — adopt hook, header icon, guard; gut `TriggerFieldsTabPane`
- **modify** `apps/web/src/components/slideover/document-slideover.tsx` — adopt hook, header icon, guard; keep status/title immediate
- **modify** `apps/web/src/components/slideover/workspace-document-slideover.test.tsx`
- **modify** `apps/web/src/components/slideover/document-slideover.test.tsx`
- **modify** `memory/DECISIONS.md` — record auto-save → buffered-save override

**Test runner:** `cd apps/web && npx vitest run <path>` (NOT bun test — per project convention). Typecheck: `cd apps/web && bun x tsc --noEmit`.

---

## Task 1: `useDocumentDraft` hook

**Files:**
- Create: `apps/web/src/lib/use-document-draft.ts`
- Test: `apps/web/src/lib/use-document-draft.test.ts`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentDraft } from './use-document-draft.ts';

const baseDoc = {
  id: 'd1',
  updatedAt: '2026-01-01T00:00:00Z',
  body: '# Hello',
  frontmatter: { priority: 'low' } as Record<string, unknown>,
};

describe('useDocumentDraft', () => {
  it('seeds from the doc and is not dirty initially', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    expect(result.current.draft).toEqual({ body: '# Hello', frontmatter: { priority: 'low' } });
    expect(result.current.isDirty).toBe(false);
  });

  it('setBody makes it dirty and diff returns only body', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setBody('# Changed'));
    expect(result.current.isDirty).toBe(true);
    expect(result.current.diff()).toEqual({ patch: { body: '# Changed' }, keys: ['body'] });
  });

  it('setFrontmatter shallow-merges and diff returns only changed keys', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setFrontmatter({ priority: 'high' }));
    expect(result.current.isDirty).toBe(true);
    const d = result.current.diff();
    expect(d.patch).toEqual({ frontmatter: { priority: 'high' } });
    expect(d.keys).toEqual(['priority']);
  });

  it('reset discards edits', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setBody('# Changed'));
    act(() => result.current.reset());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Hello');
  });

  it('re-seeds when doc.id changes (doc switch)', () => {
    const { result, rerender } = renderHook(({ doc }) => useDocumentDraft(doc), {
      initialProps: { doc: baseDoc },
    });
    act(() => result.current.setBody('# Changed'));
    rerender({ doc: { ...baseDoc, id: 'd2', body: '# Other' } });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Other');
  });

  it('re-seeds when doc.updatedAt changes (post-save) and clears dirty', () => {
    const { result, rerender } = renderHook(({ doc }) => useDocumentDraft(doc), {
      initialProps: { doc: baseDoc },
    });
    act(() => result.current.setBody('# Saved body'));
    // Simulate the server returning the saved doc with the new body + updatedAt.
    rerender({ doc: { ...baseDoc, body: '# Saved body', updatedAt: '2026-01-02T00:00:00Z' } });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Saved body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/use-document-draft.test.ts`
Expected: FAIL — `useDocumentDraft` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { useEffect, useMemo, useRef, useState } from 'react';

interface DraftDoc {
  id: string;
  updatedAt: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

interface DraftState {
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface DocumentDraft {
  draft: DraftState;
  setBody: (body: string) => void;
  /** Shallow-merges the patch into draft.frontmatter. */
  setFrontmatter: (patch: Record<string, unknown>) => void;
  isDirty: boolean;
  /** Discard edits and re-seed from the current doc. */
  reset: () => void;
  /** Changed top-level fields; frontmatter keys diffed per-key. */
  diff: () => { patch: Record<string, unknown>; keys: string[] };
}

/**
 * Buffered draft for a document's editable body + frontmatter. Title and status
 * are NOT part of the buffer — they commit immediately at their own call sites.
 *
 * Re-seeds whenever doc.id changes (the user switched documents) OR doc.updatedAt
 * changes (a save returned a fresh version). The slideover is mounted
 * persistently at the layout, so the hook can't rely on remount to re-seed.
 */
export function useDocumentDraft(doc: DraftDoc): DocumentDraft {
  const seed = useMemo<DraftState>(
    () => ({ body: doc.body, frontmatter: doc.frontmatter }),
    [doc.body, doc.frontmatter],
  );
  const [draft, setDraft] = useState<DraftState>(seed);

  // Re-seed on doc.id (switch) or doc.updatedAt (post-save) change.
  const seedKeyRef = useRef<string>(`${doc.id}::${doc.updatedAt}`);
  useEffect(() => {
    const key = `${doc.id}::${doc.updatedAt}`;
    if (seedKeyRef.current !== key) {
      seedKeyRef.current = key;
      setDraft({ body: doc.body, frontmatter: doc.frontmatter });
    }
  }, [doc.id, doc.updatedAt, doc.body, doc.frontmatter]);

  const setBody = (body: string) => setDraft((d) => ({ ...d, body }));
  const setFrontmatter = (patch: Record<string, unknown>) =>
    setDraft((d) => ({ ...d, frontmatter: { ...d.frontmatter, ...patch } }));
  const reset = () => setDraft({ body: doc.body, frontmatter: doc.frontmatter });

  const isDirty =
    draft.body !== doc.body ||
    JSON.stringify(draft.frontmatter) !== JSON.stringify(doc.frontmatter);

  const diff = (): { patch: Record<string, unknown>; keys: string[] } => {
    const patch: Record<string, unknown> = {};
    const keys: string[] = [];
    if (draft.body !== doc.body) {
      patch.body = draft.body;
      keys.push('body');
    }
    if (JSON.stringify(draft.frontmatter) !== JSON.stringify(doc.frontmatter)) {
      patch.frontmatter = draft.frontmatter;
      const oldFm = doc.frontmatter;
      const newFm = draft.frontmatter;
      const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
      for (const k of allKeys) {
        if (JSON.stringify(oldFm[k]) !== JSON.stringify(newFm[k])) keys.push(k);
      }
    }
    return { patch, keys };
  };

  return { draft, setBody, setFrontmatter, isDirty, reset, diff };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/use-document-draft.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio
git add apps/web/src/lib/use-document-draft.ts apps/web/src/lib/use-document-draft.test.ts
git commit -m "feat: useDocumentDraft hook — buffered body+frontmatter draft with diff"
```

---

## Task 2: `SaveButton` component

**Files:**
- Create: `apps/web/src/components/slideover/save-button.tsx`

A presentational icon button with three states. No test of its own (covered by the slideover integration tests in Tasks 4 + 6); it's pure presentation.

- [ ] **Step 1: Write the component**

```tsx
import { Loader2, Save } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';

interface SaveButtonProps {
  /** Buffer differs from the loaded doc. */
  dirty: boolean;
  /** A save PATCH is in flight. */
  saving: boolean;
  onSave: () => void;
}

/**
 * Header save affordance shared by both document slideovers. Clean → disabled +
 * muted; dirty → enabled + accent; saving → spinner. Built on the same token
 * styling as IconButton so it can't regress to the white-on-white pill the old
 * inline trigger Save button had (bg-fg text-bg rendered invisible).
 */
export function SaveButton({ dirty, saving, onSave }: SaveButtonProps) {
  const disabled = !dirty || saving;
  return (
    <button
      type="button"
      aria-label="Save"
      title={dirty ? 'Save changes' : 'No unsaved changes'}
      onClick={onSave}
      disabled={disabled}
      className={
        'grid h-6 w-6 place-items-center rounded transition-colors duration-fast ' +
        (disabled
          ? 'cursor-default text-fg-3'
          : 'text-fg hover:bg-card hover:text-fg')
      }
    >
      <Icon icon={saving ? Loader2 : Save} size={16} className={saving ? 'animate-spin' : ''} />
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: exit 0. (Verified: `text-accent` has zero usages in the codebase, so the component above uses `text-fg` for the dirty/enabled state — a stronger fg than the muted `text-fg-3` clean state. Do NOT use `bg-fg text-bg`; that was the invisible-pill bug.)

- [ ] **Step 3: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/components/slideover/save-button.tsx
git commit -m "feat: SaveButton — shared header save icon (clean/dirty/saving)"
```

---

## Task 3: `useUnsavedGuard` hook

**Files:**
- Create: `apps/web/src/lib/use-unsaved-guard.ts`
- Test: `apps/web/src/lib/use-unsaved-guard.test.ts`

Centralizes the "intercept an action while dirty" logic. It does NOT render the
dialog (the slideover owns that, reusing the existing `Dialog`); it only manages
whether a pending action should be intercepted and the queued action.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUnsavedGuard } from './use-unsaved-guard.ts';

describe('useUnsavedGuard', () => {
  it('runs the action immediately when not dirty', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: false },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it('defers the action and prompts when dirty', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.prompting).toBe(true);
  });

  it('proceed() runs the queued action and stops prompting', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    act(() => result.current.proceed());
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it('cancel() drops the queued action without running it', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    act(() => result.current.cancel());
    expect(action).not.toHaveBeenCalled();
    expect(result.current.prompting).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/use-unsaved-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { useRef, useState } from 'react';

export interface UnsavedGuard {
  /** If dirty, defer `action` and start prompting; otherwise run it now. */
  guard: (action: () => void) => void;
  /** True while the confirm dialog should be shown. */
  prompting: boolean;
  /** Run the queued action (e.g. after Save or Discard) and stop prompting. */
  proceed: () => void;
  /** Drop the queued action and stop prompting. */
  cancel: () => void;
}

/**
 * Intercepts a navigation/close action when there are unsaved edits. The caller
 * renders its own confirm dialog driven by `prompting`, wiring Save/Discard to
 * `proceed` (after persisting/discarding) and Cancel to `cancel`.
 */
export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [prompting, setPrompting] = useState(false);
  const queued = useRef<(() => void) | null>(null);

  const guard = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    queued.current = action;
    setPrompting(true);
  };

  const proceed = () => {
    const action = queued.current;
    queued.current = null;
    setPrompting(false);
    action?.();
  };

  const cancel = () => {
    queued.current = null;
    setPrompting(false);
  };

  return { guard, prompting, proceed, cancel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/use-unsaved-guard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio
git add apps/web/src/lib/use-unsaved-guard.ts apps/web/src/lib/use-unsaved-guard.test.ts
git commit -m "feat: useUnsavedGuard — defer close/switch while a draft is dirty"
```

---

## Task 4: Wire the workspace slideover (agents + triggers)

**Files:**
- Modify: `apps/web/src/components/slideover/workspace-document-slideover.tsx`
- Test: `apps/web/src/components/slideover/workspace-document-slideover.test.tsx`

**Context:** Today `WorkspaceDocumentSlideover` (parent) renders the header; the
editable `doc` + `update` mutation live in the child `SlideoverBody`, and
`TriggerFieldsTabPane` owns a local draft + inline Save. To put the disk icon in
the header AND share one draft, the draft + the `doc`/`update` must live in the
PARENT, and `SlideoverBody` becomes a consumer that receives `draft`/`setBody`/
`setFrontmatter`. The trigger pane's local draft + Save button are removed.

This is the largest task. Sub-steps:

- [ ] **Step 1: Write the failing tests (add to the existing describe block)**

Add these tests after the existing `seeds Fields ...` regression test:

```tsx
  it('shows a disabled Save icon when clean and enables it after an edit (agent)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    // Edit the body via the raw editor (deterministic in jsdom; Milkdown is not).
    // Switch to raw markdown through the More menu.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it('clicking Save PATCHes the diff, toasts, and returns the icon to disabled', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('triage', 'agent', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await userEvent.click(saveBtn);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toMatchObject({ body: expect.stringContaining('edited') });
  });

  it('trigger pane no longer renders its own inline Save button (save is the header icon)', async () => {
    mockWorkspaceDoc('shake-trigger', 'trigger', {
      frontmatter: { schedule: '0 9 * * 1', agent: 'shake-folio-only', enabled: false },
    });
    const { queryClient, router } = setup('?wdoc=shake-trigger');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByLabelText('Enabled');
    // Exactly one element labelled Save — the header icon. The old pane Save
    // button had the literal text "Save" inside the scroll area.
    const saves = screen.getAllByRole('button', { name: 'Save' });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toHaveAttribute('aria-label', 'Save');
  });

  it('closing while dirty opens the unsaved prompt; Discard closes without saving', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('triage', 'agent', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'Close document' }));
    // Prompt appears instead of an immediate close.
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // Closed (title gone) and no PATCH fired.
    await waitFor(() => expect(screen.queryByText('Triage Agent')).not.toBeInTheDocument());
    expect(patches).toHaveLength(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/slideover/workspace-document-slideover.test.tsx`
Expected: the four new tests FAIL (no Save button found / prompt not found); existing tests still pass.

- [ ] **Step 3: Lift `doc` + `update` + draft into the parent and render the header icon**

In `WorkspaceDocumentSlideover` (the parent), the data currently fetched only in
`SlideoverBody` must also be available in the parent. The parent already calls
`useWorkspaceDocument(wslug, slug)` (line ~71). Add the update mutation, the
draft, the guard, and the save handler there:

Add imports at the top:

```tsx
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useUnsavedGuard } from '../../lib/use-unsaved-guard.ts';
import { SaveButton } from './save-button.tsx';
```

Inside `WorkspaceDocumentSlideover`, after the existing `const del = useDeleteWorkspaceDocument(wslug);` line, add:

```tsx
  const update = useUpdateWorkspaceDocument(wslug);
  // Draft is seeded from a stable fallback until the doc loads, then re-seeds on
  // doc.id/updatedAt (handled inside the hook). The fallback keeps hook order
  // stable across the loading→loaded transition.
  const draftDoc = doc ?? { id: '', updatedAt: '', body: '', frontmatter: {} };
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(draftDoc);
  const guard = useUnsavedGuard(isDirty);

  const onSave = async () => {
    if (!doc) return;
    const { patch, keys } = diff();
    if (keys.length === 0) return;
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
      toast.success('Saved');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
```

Replace the existing `close` function so it routes through the guard:

```tsx
  const doClose = () => {
    const { wdoc: _wdoc, ...next } = search;
    void navigate({ to: '.', search: next });
  };
  const close = () => guard.guard(doClose);
```

Add Cmd/Ctrl-S handling next to the existing Alt+M effect (after that effect):

```tsx
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (isDirty && !update.isPending) void onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onSave/isDirty captured fresh each render via the listener closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDirty, update.isPending]);
```

In the header toolbar, render the `SaveButton` immediately BEFORE the `<Popover>` (the `⋯` More menu). Find the `<HeaderTabs ... />` + divider block (around line 161-162) and insert after the divider:

```tsx
                <HeaderTabs value={tab} items={tabItems} onChange={selectTab} />
                <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />
                <SaveButton dirty={isDirty} saving={update.isPending} onSave={() => void onSave()} />
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
```

- [ ] **Step 4: Thread the draft into `SlideoverBody` and remove its local PATCH-on-change**

`SlideoverBody` currently re-fetches the doc and owns `onPatch`. Change its props
to receive the draft handles + the doc from the parent. Update the call site
(line ~234) to pass them:

```tsx
          {slug && doc ? (
            <SlideoverBody
              doc={doc}
              wslug={wslug}
              mode={mode}
              tab={tab}
              draft={draft}
              setBody={setBody}
              setFrontmatter={setFrontmatter}
            />
          ) : null}
```

Rewrite the `SlideoverBody` signature + internals. It no longer fetches or
mutates — the parent owns that. Its `onPatch` is replaced by buffer writes:

```tsx
function SlideoverBody({
  doc,
  wslug,
  mode,
  tab,
  draft,
  setBody,
  setFrontmatter,
}: {
  doc: Document;
  wslug: string;
  mode: EditorMode;
  tab: WorkspaceDocTabValue;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
}) {
```

- Delete the `useWorkspaceDocument` / `useUpdateWorkspaceDocument` / `pendingKeys`
  / `onPatch` block at the top of `SlideoverBody` and the loading/error guards
  (the parent already shows the skeleton/error in the header; the body only
  renders when `doc` is present).
- In the FIELDS-tab agent branch, change `FrontmatterForm` to read from the draft
  and write to the buffer:

```tsx
              frontmatter={draft.frontmatter}
              pinnedFields={[]}
              onStatusCommit={() => {}}
              onFrontmatterCommit={(p) => setFrontmatter(p)}
              pendingKeys={new Set()}
```

- Change both body editors to render the draft body and buffer changes:

```tsx
              <BodyEditor
                key={`rich-${doc.slug}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
                documents={[]}
                aiConfigured={false}
                showToolbar={false}
              />
```

```tsx
              <RawMdEditor
                key={`raw-${doc.slug}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
              />
```

- [ ] **Step 5: Gut `TriggerFieldsTabPane` — remove its local draft + inline Save**

Replace the whole `TriggerFieldsTabPane` component with a thin wrapper that
drives the shared buffer (the local draft/diff/Save button are deleted):

```tsx
function TriggerFieldsTabPane({
  doc,
  wslug,
  draft,
  setBody,
  setFrontmatter,
}: {
  doc: Document;
  wslug: string;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
}) {
  return (
    <TriggerForm
      value={{ title: doc.title, body: draft.body, frontmatter: draft.frontmatter }}
      onChange={(next) => {
        // Title auto-commits via InlineEdit — ignore next.title here.
        if (next.body !== draft.body) setBody(next.body);
        // Replace frontmatter wholesale: TriggerForm emits the full object.
        setFrontmatter(next.frontmatter);
      }}
      workspaceSlug={wslug}
    />
  );
}
```

Update its call site in `SlideoverBody` (the trigger FIELDS branch) to pass the
draft handles:

```tsx
          <TriggerFieldsTabPane doc={doc} wslug={wslug} draft={draft} setBody={setBody} setFrontmatter={setFrontmatter} />
```

> Note: `setFrontmatter` shallow-merges, and `TriggerForm` emits the full
> frontmatter object each change, so passing the whole object is correct — any
> keys it drops (e.g. switching schedule→event nulls `schedule`) arrive as
> `{ schedule: null, ... }` from `TriggerForm`'s own emit logic, so the merge
> still reflects them.

- [ ] **Step 6: Render the unsaved-changes dialog**

Add a second `Dialog` (next to the existing delete-confirm `Dialog`, before
`</Sheet>` close) driven by `guard.prompting`:

```tsx
      <Dialog open={guard.prompting} onOpenChange={(o) => { if (!o) guard.cancel(); }}>
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {doc ? <>You have unsaved edits to &ldquo;{doc.title}&rdquo;.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => { reset(); guard.proceed(); }}
            >
              Discard
            </Button>
            <Button variant="secondary" onClick={() => guard.cancel()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={update.isPending}
              onClick={async () => { await onSave(); guard.proceed(); }}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```

> Verified: `Button` accepts `variant="primary"` (it's the default). The delete
> dialog uses `variant="danger"`; here Save is the primary action.

- [ ] **Step 7: Run the file's tests**

Run: `cd apps/web && npx vitest run src/components/slideover/workspace-document-slideover.test.tsx`
Expected: PASS (all, including the 4 new tests). Fix any existing test that
asserted the old auto-save behavior (e.g. a test expecting a PATCH on body
change must now expect a buffer + explicit save — update it to click Save first,
and note the change in the test's comment).

- [ ] **Step 8: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio
git add apps/web/src/components/slideover/workspace-document-slideover.tsx apps/web/src/components/slideover/workspace-document-slideover.test.tsx
git commit -m "feat: workspace slideover uses buffered save (header disk icon + close guard)"
```

---

## Task 5: Doc-switch guard for the workspace slideover

**Files:**
- Modify: `apps/web/src/components/slideover/workspace-document-slideover.tsx`
- Test: `apps/web/src/components/slideover/workspace-document-slideover.test.tsx`

The close path is guarded (Task 4). Switching to a DIFFERENT `?wdoc=` while dirty
must also prompt. Today a doc switch just changes `search.wdoc`. We intercept it.

- [ ] **Step 1: Write the failing test**

```tsx
  it('switching to a different wdoc while dirty opens the unsaved prompt', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    // Programmatic switch to a different doc (simulates clicking another row).
    await router.navigate({ to: '.', search: { wdoc: 'other-agent' } });

    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/slideover/workspace-document-slideover.test.tsx -t "switching to a different wdoc"`
Expected: FAIL — no prompt; the slideover just swaps docs.

- [ ] **Step 3: Intercept the wdoc change**

Add an effect in `WorkspaceDocumentSlideover` that detects an incoming `?wdoc=`
different from the currently-loaded doc while dirty, reverts the URL, and routes
the intended switch through the guard:

```tsx
  // Guard doc-SWITCH (not just close): if the URL wdoc changes to a different
  // slug while the buffer is dirty, intercept — revert the URL to the current
  // doc and prompt. proceed() re-applies the intended switch.
  const lastLoadedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (doc?.slug) lastLoadedSlugRef.current = doc.slug;
  }, [doc?.slug]);
  useEffect(() => {
    const incoming = search.wdoc;
    const current = lastLoadedSlugRef.current;
    if (!incoming || !current || incoming === current) return;
    if (!isDirty) return;
    // Revert URL to the loaded doc and queue the intended switch behind the guard.
    void navigate({ to: '.', search: { ...search, wdoc: current } });
    guard.guard(() => navigate({ to: '.', search: { ...search, wdoc: incoming } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.wdoc]);
```

> Edge: after `proceed()` re-navigates to `incoming`, `isDirty` is false (the
> buffer was reset on Discard, or saved + re-seeded on Save), so the effect
> re-runs, sees `isDirty === false`, and lets the switch through. Verify this in
> the test by also asserting Discard → lands on the new doc.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/slideover/workspace-document-slideover.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio
git add apps/web/src/components/slideover/workspace-document-slideover.tsx apps/web/src/components/slideover/workspace-document-slideover.test.tsx
git commit -m "feat: workspace slideover guards doc-switch while dirty"
```

---

## Task 6: Wire the project slideover (work items + pages)

**Files:**
- Modify: `apps/web/src/components/slideover/document-slideover.tsx`
- Test: `apps/web/src/components/slideover/document-slideover.test.tsx`

Same shape as Task 4 + 5, with two differences: (a) **status stays
immediate-commit** (`onStatusCommit` keeps calling an immediate PATCH, NOT the
buffer); (b) the save icon only matters on the `fields` tab (comments/activity
aren't buffered). Pages have no FrontmatterForm but DO have a body buffer.

- [ ] **Step 1: Write the failing tests**

Open `document-slideover.test.tsx`, find the existing `setup` helper + a doc
mock, and add (adapt the mock-fetch helper names to whatever the file already
uses — match its existing pattern):

```tsx
  it('shows a disabled Save icon when clean, enables after a body edit, and PATCHes on save', async () => {
    // ...use the file's existing doc-mock helper for a work_item 'lead-1'...
    // render with ?doc=lead-1, switch to Raw markdown via ModeToggle, type into
    // the textarea, assert the 'Save' button enables, click it, assert a PATCH
    // with { body: ...} fired exactly once.
  });

  it('status commit still PATCHes immediately and does NOT make the buffer dirty', async () => {
    // render a work_item, change status via the FrontmatterForm status control,
    // assert a status PATCH fired AND the Save button is still disabled.
  });

  it('closing while dirty prompts; Save persists then closes', async () => {
    // edit body (raw), click Close, assert 'Unsaved changes' dialog, click Save,
    // assert body PATCH fired and the slideover closed.
  });
```

> Fill these in concretely using the file's existing mock harness (read the top
> of `document-slideover.test.tsx` first — it has its own `setup()` and fetch
> stub; mirror the `workspace-document-slideover.test.tsx` patterns from Task 4
> for the Raw-markdown switch + textarea typing + `getByRole('button', { name:
> 'Save' })`). The ModeToggle here lives in the header (`tab === 'fields' ?
> <ModeToggle .../>` around line 168), not in a More menu — click it directly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/slideover/document-slideover.test.tsx`
Expected: new tests FAIL.

- [ ] **Step 3: Lift draft + update into the parent (`DocumentSlideover`)**

Mirror Task 4 Step 3 in `DocumentSlideover` (the parent that renders the header).
The parent must fetch the doc + own `useUpdateDocument`. Note this slideover
needs `listParams` for the mutation cache key — read how `SlideoverBody`
constructs it (lines 319-320: `useUrlDerivedListParams(doc?.type ?? 'work_item')`
+ `useUpdateDocument(wslug, pslug, listParams)`) and lift that to the parent too.

Add imports:

```tsx
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useUnsavedGuard } from '../../lib/use-unsaved-guard.ts';
import { SaveButton } from './save-button.tsx';
```

In the parent, after the doc fetch:

```tsx
  const listParams = useUrlDerivedListParams(doc?.type ?? 'work_item');
  const update = useUpdateDocument(wslug, pslug, listParams);
  const draftDoc = doc ?? { id: '', updatedAt: '', body: '', frontmatter: {} };
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(draftDoc);
  const guard = useUnsavedGuard(isDirty);

  const onSave = async () => {
    if (!doc) return;
    const { patch, keys } = diff();
    if (keys.length === 0) return;
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
      toast.success('Saved');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
```

Wrap `close` in the guard (mirror Task 4 Step 3), add the Cmd-S effect (mirror
Task 4 Step 3 verbatim), and render `<SaveButton dirty={isDirty}
saving={update.isPending} onSave={() => void onSave()} />` in the header toolbar
left of the `⋯` More menu / next to the tabs (mirror Task 4 Step 3 placement).

- [ ] **Step 4: Thread draft into `SlideoverBody`; keep status immediate**

In `SlideoverBody`:
- Remove its own `useUpdateDocument` + `onPatch` + `pendingKeys` (the parent owns
  saving now). Keep the OTHER hooks it needs for rendering (`useStatuses`,
  `useFields`, `useDocuments`, `useWorkspaceAiKeys`, comments hooks).
- Receive `draft`, `setBody`, `setFrontmatter`, and an `onStatusCommit` from the
  parent. **Status keeps an immediate PATCH** — add a parent handler:

In the parent:

```tsx
  const onStatusCommit = async (next: string) => {
    if (!doc) return;
    try {
      await update.mutateAsync({ slug: doc.slug, patch: { status: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
```

Pass `onStatusCommit` to `SlideoverBody`, then in the `FrontmatterForm`:

```tsx
                status={doc.status}
                statuses={statuses ?? []}
                frontmatter={draft.frontmatter}
                pinnedFields={fields ?? []}
                onStatusCommit={(next) => void onStatusCommit(next)}
                onFrontmatterCommit={(p) => setFrontmatter(p)}
                pendingKeys={new Set()}
```

> `status` reads from `doc.status` (the server truth) — NOT the buffer — because
> status commits immediately and isn't part of the draft.

Change both body editors to `value={draft.body}` + `onChange={(body) => setBody(body)}`
(mirror Task 4 Step 4). The `documents`/`aiConfigured`/`showToolbar` props stay
as they are today.

- [ ] **Step 5: Add the unsaved dialog + doc-switch guard**

Add the same `Dialog` driven by `guard.prompting` (mirror Task 4 Step 6).

**PLAN CORRECTION (from Task 5):** the original `lastLoadedSlugRef` +
`[search.doc]`-effect-reading-`isDirty` approach DOES NOT WORK — switching the
doc unloads the old one and `useDocumentDraft` re-seeds on the new load, so
`isDirty` is already `false` by the time any effect fires. Use the **dirty-slug
latch** pattern Task 5 landed for the workspace slideover (see
`workspace-document-slideover.tsx`, the `dirtySlugRef` / `prevWdocRef` /
`pendingSwitchRef` block). Adapt it for `?doc=` instead of `?wdoc=`:

```tsx
  // Latch the slug whose buffer is dirty (survives the switch's re-seed).
  const dirtySlugRef = useRef<string | null>(null);
  if (doc?.slug && isDirty) dirtySlugRef.current = doc.slug;
  else if (doc?.slug && doc.slug === dirtySlugRef.current && !isDirty) dirtySlugRef.current = null;
```

Then build the guard on the latched signal — `const guard =
useUnsavedGuard(isDirty || dirtySlugRef.current !== null);` (replacing the plain
`useUnsavedGuard(isDirty)` added in Step 3) — and detect the `?doc=` flip during
render into a `pendingSwitchRef`, consumed by a `[search.doc]` effect that
reverts to `dirtySlugRef.current` and queues the intended switch behind the
guard:

```tsx
  const prevDocRef = useRef<string | undefined>(search.doc as string | undefined);
  const pendingSwitchRef = useRef<string | null>(null);
  if (prevDocRef.current !== (search.doc as string | undefined)) {
    const incoming = search.doc as string | undefined;
    const dirtySlug = dirtySlugRef.current;
    if (incoming && dirtySlug && incoming !== dirtySlug) pendingSwitchRef.current = incoming;
    prevDocRef.current = incoming;
  }
  useEffect(() => {
    const incoming = pendingSwitchRef.current;
    const dirtySlug = dirtySlugRef.current;
    pendingSwitchRef.current = null;
    if (!incoming || !dirtySlug || incoming === dirtySlug) return;
    void navigate({ to: '.', search: { ...search, doc: dirtySlug } });
    guard.guard(() => navigate({ to: '.', search: { ...search, doc: incoming } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(search as Record<string, unknown>).doc]);
```

> The dialog handlers (`reset(); guard.proceed()` for Discard; `await onSave();
> guard.proceed()` for Save; `guard.cancel()` for Cancel) need no latch-specific
> code — the render-time `else if` releases the latch once the reverted doc's
> buffer goes clean. See the working workspace implementation for the exact
> shape.

- [ ] **Step 6: Run the file's tests**

Run: `cd apps/web && npx vitest run src/components/slideover/document-slideover.test.tsx`
Expected: PASS (all, including the 3 new tests). Update any existing test that
asserted auto-save-on-body-change to click Save first (mirror Task 4 Step 7).

- [ ] **Step 7: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio
git add apps/web/src/components/slideover/document-slideover.tsx apps/web/src/components/slideover/document-slideover.test.tsx
git commit -m "feat: project slideover uses buffered save (status/title stay immediate)"
```

---

## Task 7: Record the decision + full verification

**Files:**
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Append the decision**

Add to `memory/DECISIONS.md` under the most recent dated section (read the file
first to match its heading format):

```markdown
## 2026-06-01 — Document editing uses buffered save, not optimistic auto-save

In-slideover editing of agents, triggers, work items, and pages buffers
body+frontmatter edits behind a header disk icon (dirty-gated) instead of
PATCHing per change. This **intentionally overrides** the "Optimistic writes"
UX commitment in CLAUDE.md *for document editing* — that commitment still holds
for inline-edit on list rows and other mutations. Title and status stay
immediate-commit. Close/doc-switch while dirty prompts Save/Discard/Cancel.
Rationale: a long-form agent prompt or work item is a deliberate, reviewable
edit; a visible dirty/save state beats silent optimism for file-like documents.
Spec: docs/superpowers/specs/2026-06-01-unified-document-save-design.md.
```

- [ ] **Step 2: Run the FULL web suite**

Run: `cd apps/web && npx vitest run`
Expected: all files pass (no regressions). The total should be ≥ the prior 706
passing tests plus the new ones (≈ +20). Investigate any failure before
proceeding — a slideover test asserting old auto-save behavior is the likely
culprit; fix it to the buffered model.

- [ ] **Step 3: Typecheck the whole web app**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /home/ntdst/Projects/folio
git add memory/DECISIONS.md
git commit -m "docs: record buffered-save override of optimistic-writes commitment"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** hook (T1), save icon + contrast fix (T2), close guard (T3+T4+T6), editor rewiring (T4+T6), trigger pane gutting (T4), status/title immediate (T6), Cmd-S/toast/spinner (T4+T6), doc-switch guard (T5+T6), decision record (T7). All spec sections mapped.
- **Type consistency:** `useDocumentDraft` returns `{ draft, setBody, setFrontmatter, isDirty, reset, diff }` — used identically in T4/T6. `useUnsavedGuard` returns `{ guard, prompting, proceed, cancel }` — used identically. `SaveButton` props `{ dirty, saving, onSave }` — consistent.
- **Known divergence to verify at execution:** Task 4 lifts `doc`+`update` from `SlideoverBody` to the parent in the WORKSPACE slideover; Task 6 does the same for the PROJECT slideover including `listParams`. The executing agent must confirm no other consumer of `SlideoverBody` relies on its internal fetch (grep usages first).
- **Token guards (resolved):** `text-accent` has zero usages → SaveButton uses `text-fg`. `Button variant="primary"` confirmed valid. ModeToggle in the project slideover lives in the header (`tab === 'fields' ? <ModeToggle .../>`, line 168) — click it directly in T6 tests, no More-menu.
```
