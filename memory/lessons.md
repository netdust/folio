# Folio — Lessons

Self-improvement log per global CLAUDE.md workflow. After any user correction, append a rule that prevents the same mistake.

## Format

```
## YYYY-MM-DD — <short title>

**Mistake:** what I did wrong.
**Why:** root cause / faulty assumption.
**Rule:** the corrected behavior, written as a directive to future-me.
**Trigger:** when this rule kicks in (file pattern, task type, keywords).
```

## How this is used

- Read this file at session start when working in this project.
- Each entry should be specific enough to act on without re-explanation.
- If two entries conflict, the newer one wins — delete the older.
- Generic lessons that apply across all projects belong in `~/.claude/CLAUDE.md` instead.

---

## Entries

## 2026-05-23 — Hooks come before early returns

**Mistake:** Added a second `useMemo` after the existing `if (isLoading) return ...` early return in `apps/web/src/routes/w.$wslug.tsx`. First render returned early → next render hit the new hook → React threw "Rendered more hooks than during the previous render."
**Why:** Forgot that early returns inside a component freeze the hook count for that render path. Adding any hook below an early-return branch breaks the rules of hooks.
**Rule:** All `useState` / `useMemo` / `useEffect` / custom hooks must appear above any `if (...) return` branches in a component. If a hook depends on data from a query, guard *inside* the hook (return `[]`, `undefined`, etc.), don't gate the hook itself.
**Trigger:** Editing any React component in `apps/web/src/` that has loading/error early returns. Especially when threading new derived data through the render tree.

## 2026-05-23 — `useWorkspaces()` returns memberships, not workspaces

**Mistake:** Wrote `(workspaces ?? []).map((w) => ({ ..., name: w.name, mark: w.name.charAt(0) }))` — runtime crashed on undefined `charAt` because each entry is `{ workspace, role }`, not a flat `Workspace`.
**Why:** Assumed the hook returned the same shape as `useWorkspace(slug)` (singular). The list endpoint actually returns `WorkspaceMembership[]` because workspaces are scoped by membership.
**Rule:** Before destructuring API hook output, open `apps/web/src/lib/api/<resource>.ts` and read the type. The pluralized and singular hooks rarely return the same shape — list usually returns a wrapper with metadata (membership, pagination cursor, role).
**Trigger:** Calling any `use<Resource>s()` hook (plural) for the first time in a new component or route.

## 2026-05-23 — Don't use `bun test` for the web app

**Mistake:** Ran `bun test src/components/...` from `apps/web/`. Bun's runner doesn't know about Vitest globals (`vi.stubGlobal`, `vi.unstubAllGlobals`) and reported 4 failures.
**Why:** The web app's test script is `vitest`, run via `bun run test`. Bun's built-in `bun test` is a different runner that does NOT proxy to vitest, even inside a Vitest project.
**Rule:** For web tests, always use `bun run test` (which invokes `vitest run` per `apps/web/package.json:11`). Never `bun test`. From the repo root use `bun run --filter @folio/web test` or `cd apps/web && bun run test`.
**Trigger:** Running any test under `apps/web/`. Server tests under `apps/server/` use Bun's own runner — `bun test` is correct there.

## 2026-05-23 — Bash cwd carries across calls in a session

**Mistake:** Earlier `cd apps/web/src/components && grep ...` left the shell in that directory. The next `grep -rn ...` from "repo root" silently ran from the components dir, missing matches.
**Why:** The Bash tool persists working directory between calls in the same conversation. There is no per-call reset.
**Rule:** For commands that need a specific cwd, prefix with `cd /home/ntdst/Projects/folio && ...` (absolute path). Don't trust that the shell is where the last command left it. Especially when chaining `grep -rn` searches across the repo.
**Trigger:** Any multi-call Bash flow where one call uses `cd` followed by relative paths in later calls.

## 2026-05-23 — Manual QA mockups assume features that aren't built

**Mistake:** Manual-qa scenarios 1 ("Welcome to Folio + Create workspace button") and scenarios mentioning "log out" / "open account" assumed those UI surfaces existed when the project moved past Phase 0. Stefan immediately found that he literally couldn't sign out or create a second workspace from inside one. The acceptance gate was passing without testing what the user actually needs.
**Why:** Phase 0.5 (design system) and Phase 1 (CRUD) shipped without auditing the manual-qa checklist for completeness against the user journey. The auto-redirect on `/` ("if you have one workspace, navigate to it") silently broke "create a second workspace from inside" because no UI re-exposed that affordance once you were in.
**Rule:** Before declaring a phase "shipped," run the first three or four scenarios from the manual-qa list as a literal user. If a basic affordance (sign out, switch user, create alt-entity) isn't on screen, build it before ticking the phase complete box.
**Trigger:** Any "phase N: complete" claim. Especially Phase 1 / 1.5 / 2 where the rail/shell is the main surface.

## 2026-05-23 — Playwright cold-start is the slow part, not the tests

**Mistake:** First Playwright run took 4.6 minutes for 3 tests passing. Initial reaction was "tests are slow." The actual individual test times were 0.9–3.2 seconds; the rest was Vite + API server cold-starting under Playwright's webServer config.
**Why:** Playwright's `webServer` boots Vite for the first browser request, and Vite's dev-mode TanStack Router plugin + Milkdown + dnd-kit imports take ~3–4 minutes to transform on a cold cache in WSL2.
**Rule:** Don't optimize the tests themselves to make Playwright "fast" — they're already fast. If runs feel slow, look at Vite warmup (consider `vite preview` against a pre-built bundle for CI, or `reuseExistingServer: true` for local re-runs).
**Trigger:** Whenever a Playwright run feels slow. Check per-test durations vs wall-clock before chasing flakes.

## 2026-05-23 — Don't pipe `bun run e2e` through `tail`

**Mistake:** `bun run e2e 2>&1 | tail -8` buffered output until the pipeline closed — the output file stayed empty the whole time the run was in progress, making polling for "did it finish yet?" impossible.
**Why:** `tail -N` (without `-f`) waits for EOF before printing the last N lines. With a 5-minute Playwright run in front of it, the file looks dead until the very end.
**Rule:** Capture full output (`bun run e2e 2>&1`), then read the file's tail with `tail -N` *after* it's done. Or pipe through `tee` to keep the file growing live. Never `cmd | tail -N` for a long-running task you want to poll.
**Trigger:** Any long-running background command whose output you plan to poll.

## 2026-05-23 — InlineEdit must treat the initial value as a placeholder, not as a draft, when defaultEditing is true

**Mistake:** When a doc is created from the kanban "+ New work item in X" affordance, it lands with `title='Untitled'`. The slideover opens with `<InlineEdit value="Untitled" defaultEditing />`. The InlineEdit pre-filled `draft = value` (`'Untitled'`) and relied on `input.select()` running in a `useEffect` to highlight the text so typing would replace it. But this is timing-dependent: if any keystroke arrives before the select() effect lands (Chrome MCP `type`, fast users on slow renders, paste from clipboard, programmatic events), the typed text gets *appended* to "Untitled". Persisted DB title became literally `"UntitledFirst task"`.
**Why:** Pre-selecting text via a useEffect to drive replace-behavior is a presentation hack, not a semantic guarantee. Anything that can race the effect breaks it. Worse: it doesn't even show up in unit tests because RTL's `userEvent.type` first clears via select-all internally — masking the bug.
**Rule:** When `defaultEditing` is true on an InlineEdit (or any auto-focusing input), pre-fill the *internal draft* with `''` and render the *original value* as the input's `placeholder` attribute. Typing then accumulates into a fresh draft. On commit, treat empty draft as no-op (revert silently) instead of writing empty over the placeholder.
**Trigger:** Any InlineEdit-style component where the input is auto-focused on mount AND the displayed value is a placeholder the user is meant to overwrite. Don't rely on `input.select()` for replace-semantics.

## 2026-05-24 — react-query list invalidation must be coarse-grained when surfaces use different listParams

**Mistake:** `useUpdateDocument`'s `onSettled` invalidated only `documentsKeys.list(wslug, pslug, listParams)` — a 5-element key including the *specific* params object. When the slideover's title-PATCH used `{ type, sort:'updated_at', dir:'desc' }` but the wiki tree's list query used `{ type, sort:'title', dir:'asc', limit:200 }`, the invalidation didn't reach the wiki tree because React Query's prefix match requires element-by-element equality, and the two params objects are different. Result: edit a page title in the slideover → wiki tree shows the OLD title until reload.
**Why:** Specific-key invalidation looks safe (less network) but breaks the moment two screens of the same data use different list params. The mental model "I'm patching THIS doc, so only refresh queries with the exact same shape" is wrong — the doc lives in multiple lists.
**Rule:** For `useUpdateDocument` (and any mutation that changes a row visible in lists), invalidate the *broad* key `[...documentsKeys.all, wslug, pslug, 'list']` (4 elements, no params). React Query's prefix match then covers every variant. Trade some over-fetching for cross-surface correctness.
**Trigger:** Any react-query mutation onSuccess/onSettled. If invalidation uses a key with params at the tail, check that all consumers of the same resource use compatible params.

## 2026-05-24 — Kbd hint glyphs must be platform-aware

**Mistake:** Rail's Search nav and other Cmd-K hints hardcoded `'⌘K'` as the kbd badge string. Folio's keyboard listener checks `metaKey` on Mac and `ctrlKey` elsewhere (correct), but the *displayed* hint lied to Linux/Windows users — they'd press ⌘K and nothing would happen.
**Why:** Tempting to copy Linear/Notion's ⌘ glyph as a stylistic flourish. It's accurate on Mac and aesthetic everywhere, but factually wrong on non-Mac.
**Rule:** Use a `modKeyGlyph()` / `modKeyHint(suffix)` helper at every kbd display callsite. The helper mirrors the same `navigator.platform.includes('mac')` check the keyboard listener uses, so display and binding stay in lockstep. Static reference pages (`dev/design-system`) can hardcode ⌘ — it's a Mac-style showcase.
**Trigger:** Any new `<Kbd>` or `kbd:` field. Same applies to `⌥` (Alt/Option) and `⇧` (Shift) if those ever diverge.

## 2026-05-23 — Two buttons with the same accessible name in the same view is a UX + selector smell

**Mistake:** The `/` empty state had a "Create workspace" button that opened a sheet, and the sheet's submit button was also named "Create workspace". Same DOM, same accessible name. Selectors had to disambiguate with `.last()` / `.first()` / `[role="dialog"]` scoping. Real users would also be vulnerable: rapid double-click on the empty-state button could in principle hit the submit button mid-transition.
**Why:** Buttons inside containers (sheets, popovers) often duplicate the trigger's label out of mirror-thinking. It's tempting because "tell me what this does" reads naturally — but `New workspace` (sheet title) + `Create` (sheet submit) is just as clear and removes the collision.
**Rule:** Inside a sheet/dialog/popover whose heading already names the entity ("New workspace", "New project"), label the submit button with the verb only (`Create`, `Save`, `Continue`). Don't repeat the entity name. If `getByRole('button', { name: X })` matches more than one element in a single rendered page, rename one.
**Trigger:** Any new sheet/dialog/popover with a submit. Audit existing surfaces when you add a CTA that opens that surface.
