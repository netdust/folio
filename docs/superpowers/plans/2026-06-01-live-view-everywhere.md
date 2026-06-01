# Live View Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing SSE hook into the document-facing surfaces (list/board/table views, comments thread, open slideover) so they update live as agents/other tabs write — closing the agent→human review loop.

**Architecture:** Frontend-only. Each surface mounts the existing `useEventStream(wslug, filters, onEvent)` hook and, on a `document.*` / `comment.*` event, calls `queryClient.invalidateQueries` for that surface's react-query key. The slideover adds a notify-don't-stomp rule (refetch when the draft is clean; show a banner when dirty) via a shared `useLiveDocument` hook used by both slideover components. No server changes.

**Tech Stack:** React + TanStack Query, the existing `event-stream.ts` SSE hook, Vitest (web tests run via `npx vitest run`, NOT bun test).

Spec: `docs/superpowers/specs/2026-06-01-live-view-everywhere-design.md`

---

## Verified facts (from source — used throughout; no assumptions)

- **`useEventStream(wslug, filters, onEvent)`** — `apps/web/src/lib/api/event-stream.ts`. `filters` has
  `{ project?, parent?, run?, agent?, table?, kinds? }`. Server routes frames by `kind`
  (`addEventListener(kind)`), so `kinds` strings MUST match the server's emitted kind exactly. Existing
  template: `activity-feed.ts:38` → `useEventStream(wslug, { kinds: [...RUN_KINDS] }, (e) => {...})`.
- **Document event kinds (server, confirmed):** `document.created`, `document.updated`,
  `document.deleted` (documents.ts:719/1005/1164).
- **Comment event kinds (server, confirmed):** `comment.created` (comments.ts:403), `comment.deleted`
  (comments.ts:641 + documents.ts:1155). NOTE: there is NO `comment.updated` kind, and the stale TODO in
  comments-tab.tsx:26 wrongly says `comment_created` (underscore) — the real names are DOTTED. Subscribe
  to `['comment.created', 'comment.deleted']`. Do NOT subscribe to `comment.mentioned` (a notification,
  not a thread-content change → would cause spurious refetches).
- **`/events` route** (events.ts) honors `?project=` (line 28) and `?parent=` (line 43), and fail-closes
  the project allow-list (line 81). So the views' `project` filter and comments' `parent` filter both
  narrow server-side.
- **documentsKeys** (`apps/web/src/lib/api/documents.ts:68`): `.all = ['documents']`;
  `.list(wslug, pslug, params)`; `.detail(wslug, pslug, slug)`. The list invalidation prefix already used
  by the create mutation (documents.ts:110): `[...documentsKeys.all, wslug, pslug, 'list']`.
- **commentsKeys** (`apps/web/src/lib/api/comments.ts:80`): `.all = ['comments']`;
  list prefix `[...commentsKeys.all, wslug, pslug, parentSlug, 'list']` (comments.ts:128).
- **`useDocumentDraft(doc)`** (`apps/web/src/lib/use-document-draft.ts:60`) returns `{ draft, setBody,
  setFrontmatter, isDirty, reset, diff }`. `isDirty` is the clean/dirty signal.
- **Both slideover components consume useDocumentDraft:** `document-slideover.tsx` and
  `workspace-document-slideover.tsx`. comments-tab.tsx has `workspaceSlug`, `projectSlug`, `parentSlug`
  in scope.

---

## File Structure

- Create: `apps/web/src/lib/api/use-live-documents.ts` — a small hook for the list/board/table views:
  subscribe to document.* + invalidate the documents list key.
- Create: `apps/web/src/lib/use-live-document.ts` — the notify-don't-stomp hook for the slideover
  (returns `{ externalUpdate, dismiss }` so the component renders the banner).
- Modify: the view container that owns the documents list query — mount `useLiveDocuments`.
- Modify: `apps/web/src/components/comments/comments-tab.tsx` — subscribe + invalidate; delete the stale
  TODO.
- Modify: `document-slideover.tsx` + `workspace-document-slideover.tsx` — mount `useLiveDocument`, render
  the banner.
- Tests alongside each.

---

### Task 0: Locate the view container + confirm vitest harness

**Files:** inspect only.

- [ ] **Step 1: Find where the documents list query is consumed (the view container)**

Run:
```bash
cd /home/ntdst/Projects/folio && grep -rln "useDocuments\b\|documentsKeys.list\|useDocumentsList" apps/web/src --include=*.tsx | grep -v ".test."
grep -rn "useDocuments(" apps/web/src/routes apps/web/src/components --include=*.tsx | grep -v ".test." | head
```
Record the component/route that mounts the documents list query (where `useLiveDocuments` will be
mounted — one place, not per-row). Also confirm whether board/list/table share one container or each
mount the query separately; if separate, each gets the hook.

- [ ] **Step 2: Confirm the vitest test pattern for hooks**

Run:
```bash
cd /home/ntdst/Projects/folio && grep -rln "renderHook\|QueryClientProvider\|vi.mock" apps/web/src/lib/api/*.test.tsx | head -3
```
Read one existing `*.test.tsx` that tests a react-query hook to learn the harness (how it provides a
QueryClient + mocks the SSE/fetch). Reuse that exact pattern.

---

### Task 1: `useLiveDocuments` hook (views)

**Files:**
- Create: `apps/web/src/lib/api/use-live-documents.ts`
- Test: `apps/web/src/lib/api/use-live-documents.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock the SSE hook so we can capture the onEvent and the filters it was given.
const calls: { filters: unknown; onEvent: (e: unknown) => void }[] = [];
vi.mock('./event-stream.ts', () => ({
  useEventStream: (_wslug: string, filters: unknown, onEvent: (e: unknown) => void) => {
    calls.push({ filters, onEvent });
  },
}));

const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, useQueryClient: () => ({ invalidateQueries: invalidateSpy }) };
});

import { useLiveDocuments } from './use-live-documents.ts';

describe('useLiveDocuments', () => {
  it('subscribes with the project filter + document kinds and invalidates the list key on event', () => {
    calls.length = 0;
    invalidateSpy.mockClear();
    renderHook(() => useLiveDocuments('acme', 'web'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toMatchObject({
      project: 'web',
      kinds: ['document.created', 'document.updated', 'document.deleted'],
    });
    // Fire an event → invalidates the documents list prefix.
    calls[0]!.onEvent({ kind: 'document.updated' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents', 'acme', 'web', 'list'] });
  });
});
```

- [ ] **Step 2: Run red**

Run: `cd apps/web && npx vitest run src/lib/api/use-live-documents.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/api/use-live-documents.ts
import { useQueryClient } from '@tanstack/react-query';
import { documentsKeys } from './documents.ts';
import { useEventStream } from './event-stream.ts';

const DOCUMENT_KINDS = ['document.created', 'document.updated', 'document.deleted'] as const;

/**
 * Live-update the list/board/table views: on any document write in this project,
 * invalidate the documents list query so react-query refetches the active
 * (filtered/sorted/paginated) variant. Mount ONCE at the view container — not
 * per row. SSE teaches react-query WHEN data changed; it owns no state.
 */
export function useLiveDocuments(wslug: string, pslug: string): void {
  const qc = useQueryClient();
  useEventStream(wslug, { project: pslug, kinds: [...DOCUMENT_KINDS] }, () => {
    qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, 'list'] });
  });
}
```

- [ ] **Step 4: Run green**

Run: `cd apps/web && npx vitest run src/lib/api/use-live-documents.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src/lib/api/use-live-documents.ts apps/web/src/lib/api/use-live-documents.test.tsx && git commit -m "feat(web): useLiveDocuments — SSE-driven invalidation for document views"
```

---

### Task 2: Mount `useLiveDocuments` in the view container

**Files:**
- Modify: the view container found in Task 0 (e.g. the documents route/list component)
- Test: that container's existing test file (extend it), or a new one

- [ ] **Step 1: Write the failing test**

Assert that rendering the view container calls `useEventStream` once (mock it as in Task 1). Adapt to the
container's existing test harness from Task 0. Skeleton:
```tsx
// mock event-stream.ts; render the container with required props (wslug, pslug);
// expect the mocked useEventStream to have been called exactly once with project: pslug.
expect(eventStreamCalls).toHaveLength(1);
expect(eventStreamCalls[0].filters).toMatchObject({ project: pslug });
```

- [ ] **Step 2: Run red**

Run: `cd apps/web && npx vitest run <container>.test.tsx`
Expected: FAIL — `useEventStream` not called (hook not yet mounted).

- [ ] **Step 3: Implement**

In the view container, add the hook call near the existing `useDocuments(...)` call:
```tsx
import { useLiveDocuments } from '@/lib/api/use-live-documents';
// ...inside the component, with wslug + pslug already in scope:
useLiveDocuments(wslug, pslug);
```
(Use the exact prop/variable names the container already uses for workspace + project slug — confirm in
Task 0.)

- [ ] **Step 4: Run green**

Run: `cd apps/web && npx vitest run <container>.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src && git commit -m "feat(web): document views subscribe to live updates"
```

---

### Task 3: Comments thread live updates

**Files:**
- Modify: `apps/web/src/components/comments/comments-tab.tsx` (subscribe + delete stale TODO at line ~25-26)
- Test: `apps/web/src/components/comments/comments-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// Mock event-stream.ts to capture filters + onEvent (as in Task 1).
// Mock useQueryClient to capture invalidateQueries.
// Render CommentsTab with workspaceSlug='acme', projectSlug='web', parentSlug='wi-1', parentId='pid-1'.
it('subscribes to comment events for the parent and invalidates the comments list on event', () => {
  // ...render...
  expect(calls).toHaveLength(1);
  expect(calls[0].filters).toMatchObject({
    parent: 'pid-1',     // SSE ?parent= matches the parent DOC ID, not the slug
    kinds: ['comment.created', 'comment.deleted'],
  });
  calls[0].onEvent({ kind: 'comment.created' });
  expect(invalidateSpy).toHaveBeenCalledWith({
    queryKey: ['comments', 'acme', 'web', 'wi-1', 'list'],   // query key is slug-based
  });
});
```
VERIFIED from source: `/events?parent=` matches the parent **document id** (events.ts:44/157 compares the
event's parent id), NOT the slug. So the SSE filter MUST pass `parent: parentId`. The query-key
invalidation keeps using `parentSlug` because `commentsKeys.list` is keyed on the slug. Two different
identifiers for two different purposes — do not conflate. Both `parentId` and `parentSlug` are already
props on CommentsTab (lines 40-41). Adapt rendering to the file's existing test harness.

- [ ] **Step 2: Run red**

Run: `cd apps/web && npx vitest run src/components/comments/comments-tab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In comments-tab.tsx, replace the stale TODO comment (lines ~25-26) and add, inside the component (with
`workspaceSlug`, `projectSlug`, `parentSlug`, AND `parentId` all in scope as props):
```tsx
import { useQueryClient } from '@tanstack/react-query';
import { commentsKeys } from '@/lib/api/comments';
import { useEventStream } from '@/lib/api/event-stream';
// ...
const qc = useQueryClient();
useEventStream(
  workspaceSlug,
  // parent: parentId — the events route matches ?parent= by DOC ID (events.ts:157), NOT slug.
  { parent: parentId, kinds: ['comment.created', 'comment.deleted'] },
  () => {
    qc.invalidateQueries({
      // query key is slug-based (commentsKeys.list keys on parentSlug).
      queryKey: [...commentsKeys.all, workspaceSlug, projectSlug, parentSlug, 'list'],
    });
  },
);
```
Delete the stale `// When SSE ships...` TODO (it has the wrong underscore kind names).

- [ ] **Step 4: Run green**

Run: `cd apps/web && npx vitest run src/components/comments/comments-tab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src/components/comments && git commit -m "feat(web): comments thread updates live via SSE"
```

---

### Task 4: `useLiveDocument` hook — notify-don't-stomp (slideover core)

**Files:**
- Create: `apps/web/src/lib/use-live-document.ts`
- Test: `apps/web/src/lib/use-live-document.test.tsx`

- [ ] **Step 1: Write the failing tests (the regression-critical cases)**

```tsx
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const calls: { filters: unknown; onEvent: (e: unknown) => void }[] = [];
vi.mock('./api/event-stream.ts', () => ({
  useEventStream: (_w: string, filters: unknown, onEvent: (e: unknown) => void) => {
    calls.push({ filters, onEvent });
  },
}));

import { useLiveDocument } from './use-live-document.ts';

describe('useLiveDocument', () => {
  it('clean draft + document.updated → reports a refetch-eligible external update (not a banner)', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1' }));
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(result.current.externalUpdate).toBeNull(); // no banner when clean
  });

  it('dirty draft + document.updated → banner, NO refetch (no stomp)', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: true, onRefetch }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1', actor: 'agent:helper' }));
    expect(onRefetch).not.toHaveBeenCalled();          // never stomp a dirty draft
    expect(result.current.externalUpdate).toMatchObject({ kind: 'updated', actor: 'agent:helper' });
  });

  it('document.deleted → deleted banner regardless of dirty', () => {
    calls.length = 0;
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch: vi.fn() }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.deleted', documentId: 'd1' }));
    expect(result.current.externalUpdate).toMatchObject({ kind: 'deleted' });
  });

  it('ignores events for a different document id', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'OTHER' }));
    expect(onRefetch).not.toHaveBeenCalled();
    expect(result.current.externalUpdate).toBeNull();
  });

  it('dismiss clears the banner', () => {
    calls.length = 0;
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: true, onRefetch: vi.fn() }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1' }));
    expect(result.current.externalUpdate).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.externalUpdate).toBeNull();
  });
});
```

- [ ] **Step 2: Run red**

Run: `cd apps/web && npx vitest run src/lib/use-live-document.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/use-live-document.ts
import { useState } from 'react';
import { useEventStream, type StreamedEvent } from './api/event-stream.ts';

export interface ExternalUpdate {
  kind: 'updated' | 'deleted';
  actor: string | null;
}

export interface UseLiveDocumentArgs {
  wslug: string;
  docId: string;
  /** Current draft dirty state (from useDocumentDraft). */
  isDirty: boolean;
  /** Called to pull server truth when it is safe (clean draft, updated event). */
  onRefetch: () => void;
}

/**
 * Notify-don't-stomp live updates for the open slideover document.
 * - document.updated + CLEAN draft → onRefetch() (pull server truth, no banner).
 * - document.updated + DIRTY draft → set externalUpdate banner, NEVER refetch
 *   (would overwrite unsaved typing — the refetch-stomp the buffered-save work fixed).
 * - document.deleted → banner regardless of dirty.
 * Events for other document ids are ignored.
 * NOTE (v1, last-write-wins): the banner makes the race visible; it does not
 * prevent a subsequent Save from overwriting the external edit. No server guard.
 */
export function useLiveDocument({ wslug, docId, isDirty, onRefetch }: UseLiveDocumentArgs): {
  externalUpdate: ExternalUpdate | null;
  dismiss: () => void;
} {
  const [externalUpdate, setExternalUpdate] = useState<ExternalUpdate | null>(null);

  useEventStream(
    wslug,
    { kinds: ['document.updated', 'document.deleted'] },
    (e: StreamedEvent) => {
      if (e.documentId !== docId) return;
      if (e.kind === 'document.deleted') {
        setExternalUpdate({ kind: 'deleted', actor: e.actor ?? null });
        return;
      }
      // document.updated
      if (isDirty) {
        setExternalUpdate({ kind: 'updated', actor: e.actor ?? null });
      } else {
        onRefetch();
      }
    },
  );

  return { externalUpdate, dismiss: () => setExternalUpdate(null) };
}
```

- [ ] **Step 4: Run green**

Run: `cd apps/web && npx vitest run src/lib/use-live-document.test.tsx`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src/lib/use-live-document.ts apps/web/src/lib/use-live-document.test.tsx && git commit -m "feat(web): useLiveDocument — notify-don't-stomp live updates for the open document"
```

---

### Task 5: Wire `useLiveDocument` into both slideovers + render the banner

**Files:**
- Modify: `apps/web/src/components/slideover/document-slideover.tsx`
- Modify: `apps/web/src/components/slideover/workspace-document-slideover.tsx`
- Test: their existing `.test.tsx` files (extend)

- [ ] **Step 1: Write the failing test (one per slideover)**

For each slideover test file, with event-stream mocked (capture onEvent) and a doc rendered with a CLEAN
draft, assert that firing `document.updated` for the open doc triggers a refetch (e.g. the documents
detail query is invalidated / refetch callback fires), and with a DIRTY draft asserts a banner element
appears (e.g. `getByText(/updated by/i)`) and the draft input value is unchanged. Adapt to each file's
existing harness.

- [ ] **Step 2: Run red**

Run: `cd apps/web && npx vitest run src/components/slideover/document-slideover.test.tsx src/components/slideover/workspace-document-slideover.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement (identical shape in both files)**

In each slideover, where `useDocumentDraft` and the doc + wslug are in scope:
```tsx
import { useLiveDocument } from '@/lib/use-live-document';
// draft = useDocumentDraft(doc); qc + detail-query refetch already available
const { externalUpdate, dismiss } = useLiveDocument({
  wslug,
  docId: doc.id,
  isDirty: draft.isDirty,
  onRefetch: () => {
    // clean-draft path: pull server truth. Reuse the existing detail-query
    // invalidation so the doc re-seeds via useDocumentDraft's updatedAt remount.
    qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, doc.slug) });
  },
});
```
Render the banner near the header when `externalUpdate` is set:
```tsx
{externalUpdate && (
  <div role="status" className="...banner styles...">
    {externalUpdate.kind === 'deleted'
      ? 'This document was deleted.'
      : `Updated by ${externalUpdate.actor ?? 'someone'}.`}
    {externalUpdate.kind === 'updated' && (
      <button onClick={() => { dismiss(); /* reload: discard draft + refetch */ draft.reset(); qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, doc.slug) }); }}>
        Reload
      </button>
    )}
    <button onClick={dismiss}>Dismiss</button>
  </div>
)}
```
Use each file's actual `qc`, `pslug`, `doc` variable names — confirm them when editing. The "Reload"
action discards the local draft (`draft.reset()`) then invalidates the detail query so the fresh server
doc seeds.

- [ ] **Step 4: Run green**

Run: `cd apps/web && npx vitest run src/components/slideover/document-slideover.test.tsx src/components/slideover/workspace-document-slideover.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src/components/slideover && git commit -m "feat(web): slideovers show live external-update banner (notify-don't-stomp)"
```

---

### Task 6: Full verification + live re-test

**Files:** inspect only.

- [ ] **Step 1: Web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS, prior baseline + new tests. (If `list-view-create.test.tsx` flakes, rerun once —
[[project_known-test-flakes]].)

- [ ] **Step 2: Typecheck web**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Confirm server/shared unaffected (no server changes were made)**

Run: `cd apps/server && bun test 2>&1 | tail -3` and `cd packages/shared && bun test 2>&1 | tail -3`
Expected: unchanged pass counts.

- [ ] **Step 4: Live re-test (requires dev server on this branch)**

With `bun dev` running:
- Open a board/list view + a document slideover.
- Trigger an edit on a visible document from a SECOND browser tab (or an agent run).
- Expect: the row/card updates in the first tab WITHOUT refresh; an open CLEAN slideover updates; an open
  DIRTY slideover shows the "Updated by …" banner WITHOUT losing typing; a posted comment appears live.

Record:
```
views live:           ____
comments live:        ____
slideover clean:      ____
slideover dirty banner: ____
```

---

## Self-Review

**Spec coverage:**
- Shared mechanism (invalidate-refetch via useEventStream) → Tasks 1, 3, 4. ✓
- Views surface → Tasks 1 + 2. ✓
- Comments surface → Task 3 (with the corrected dotted kind names). ✓
- Slideover notify-don't-stomp → Tasks 4 (hook + the no-stomp regression test) + 5 (both components + banner). ✓
- Shared useLiveDocument hook across both slideovers → Task 4 (hook) used by both in Task 5. ✓
- Pre-work verification (kinds, project/parent filter, query keys, dirty signal) → resolved in the
  "Verified facts" section from source; Task 0 confirms the view container + parent id-vs-slug detail. ✓
- Accepted last-write-wins limitation → documented in the useLiveDocument doc comment (Task 4). ✓
- Out-of-scope (server guard, rail, cache-patching) → no task touches them. ✓
- Verification (web suite + tsc + server/shared spot-check + live re-test) → Task 6. ✓

**Placeholder scan:** No TBD/TODO. The only blanks are the live-re-test record lines (filled by the
executor) and the Task 0 lookups (view container path, parent id-vs-slug), which are explicitly
investigation steps that gate the dependent tasks — acceptable because they resolve before use.

**Type consistency:** `useLiveDocument({ wslug, docId, isDirty, onRefetch })` defined in Task 4 and
called with the same shape in Task 5. `externalUpdate: { kind: 'updated'|'deleted', actor }` consistent
between hook return (Task 4) and banner render (Task 5). `useLiveDocuments(wslug, pslug)` signature
consistent Task 1 ↔ Task 2. Kind strings (`document.*`, `comment.created`/`comment.deleted`) consistent
with the verified server kinds throughout.
