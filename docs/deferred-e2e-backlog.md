# Deferred E2E Backlog

Behaviors that are real, shipped code but cannot be faithfully asserted in jsdom
(they need a real browser: caret geometry, contenteditable selection movement,
cross-element focus, or ProseMirror block-level rendering). Rather than leave
perpetual `it.skip(...)` IOUs in the suite, they are deleted from the unit tests
and tracked here.

Status of every behavior below: **covered by manual QA.** They are low-severity
comment-composer / body-editor UX niceties. Writing serial Playwright specs for
each was scope creep for an M3 polish milestone (the Playwright run here is
serial, ~4.5 min), so the cost/value did not justify it for M3. Revisit if any
behavior regresses in manual QA or graduates to a higher-severity surface.

Source audit: audit finding 3.4 — "skip IOUs never written." Removed in
`phase-m3: delete 8 perpetual Playwright skip-IOUs`.

---

## Comment composer (`apps/web/src/components/comments/comment-composer.tsx`)

The mention/wiki-link trigger logic lives in the editor's `@` / `[[` input
listener (the trigger watcher that opens the picker at the caret); the draft
save is the debounced `markdownUpdated` handler; focus-return is the picker
`onSelect` / `onClose` path that calls `editor.focus()`.

1. **Typing `@` opens MentionPicker at the caret.**
   Why deferred: needs real ProseMirror input events + `range.getBoundingClientRect`
   for caret positioning, which jsdom does not compute.

2. **Typing `[[` opens WikiLinkPicker at the caret.**
   Why deferred: same — real ProseMirror input events + caret geometry.

3. **Selecting an agent replaces `@drafter` with `@drafter ` (trailing space).**
   Why deferred: needs real editor content + cursor positioning to perform the
   in-place range replacement.

4. **Selecting a wiki target replaces `[[task` with `[[task-slug]] `.**
   Why deferred: needs real editor content + range replacement.

5. **Debounced draft save fires 300 ms after an editor change.**
   Why deferred: relies on the real Milkdown `markdownUpdated` event firing on
   input, which jsdom does not emit for ProseMirror.

6. **Focus returns to the editor on picker close (after `onSelect`).**
   Why deferred: jsdom does not propagate focus between elements via
   `setTimeout` / `element.focus()` reliably; needs real browser focus handling.

7. **Focus returns to the editor on picker close (after `onClose` via Escape).**
   Why deferred: same focus-handling limitation.

## Body editor (`apps/web/src/components/slideover/body-editor.tsx`)

8. **Renders the initial markdown (block-split).**
   Behavior lives in the Milkdown initial-render path (the editor is constructed
   with the `value` markdown and ProseMirror parses it into blocks).
   Why deferred: jsdom renders `# Hello\n\nworld` as a single `<h1>` containing
   the full string — block-level parsing requires a layout engine.

## Frontmatter filter — labels array-contains (M3, audit 3.6/M5)

9. **Filtering by `labels` across paginated pages is still client-page-local.**
   M3 wired `priority` (and the existing status/assignee/updated_since) into the
   server `?filter=` param so they filter ALL pages correctly. `labels` could
   NOT be wired server-side: the filter compiler's operator set
   (`$eq $ne $in $nin $gt $gte $lt $lte $exists` — `packages/shared/filter-compile.ts`)
   has no array-contains. `json_extract(frontmatter,'$.labels')` returns the
   labels array as JSON text, so `$in`/`$eq` would compare against the whole
   serialized array — silently WRONG, not just absent. So `labels` stays a
   client-side post-filter (`applyFrontmatterClauses`) and therefore only filters
   the currently-loaded pages — a label match on a not-yet-loaded page is missed.
   Fix needs a compiler array-contains operator backed by a SQLite
   `EXISTS (SELECT 1 FROM json_each(frontmatter,'$.labels') WHERE value = ?)`
   subquery in `filter-to-drizzle.ts`. Priority went server-side; labels deferred.
