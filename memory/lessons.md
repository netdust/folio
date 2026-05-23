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

## 2026-05-24 — Don't advertise a keyboard shortcut you haven't bound

**Mistake:** The slideover's ModeToggle button rendered "Raw MD ⌥M" as a `<Kbd>` hint, advertising Alt+M as a shortcut — but no `keydown` listener was registered anywhere. Pressing Alt+M did nothing. Users saw the hint, tried it, and assumed the button was broken.
**Why:** A `<Kbd>` next to an action *is* a promise. Adding it as visual polish without the listener is worse than no hint at all — it teaches users the app's shortcuts are unreliable. Also, the glyph was hardcoded Mac (`⌥`) like the earlier `⌘K` problem.
**Rule:** Every `<Kbd>` next to a control must have a corresponding registered listener. When you add the hint, immediately wire the listener (or add `// TODO: wire Alt+M` and pull the Kbd until then). For the glyph, use `altKeyHint()` / `modKeyHint()` from `lib/platform.ts` — never hardcode `⌥` or `⌘`.
**Trigger:** Adding a `<Kbd>` element. Adding a `kbd:` field on a NavItem. Documenting a shortcut in MD/copy.

## 2026-05-24 — Milkdown task items have no built-in checkbox UI — Folio must style + (eventually) wire toggling

**Mistake:** Milkdown's GFM preset parses `- [x]` / `- [ ]` into `<li data-item-type="task" data-checked>` nodes but ships with NO CSS to render a visible checkbox AND no built-in click-to-toggle. The body editor rendered "todo unchecked" and "todo checked" as identical bullet items — visually the user couldn't tell tasks from regular bullets.
**Why:** Headless editor library + assumption that consumers provide the chrome. Easy to miss until you actually look at a doc with task items.
**Rule:** Whenever using a headless editor (Milkdown, ProseMirror, TipTap), grep the rendered DOM for nodes with semantic data attributes (`data-item-type`, `data-checked`, `data-language`) and verify every one has corresponding CSS. For Folio specifically: any new GFM node type added in a future Milkdown version (footnote, callout) needs CSS in `apps/web/src/styles/editor.css`.
**Trigger:** Bumping Milkdown / its presets. Adding new content types to the body editor.

## 2026-05-24 — Children of `<PopoverTrigger asChild>` must be forwardRef components

**Mistake:** `ChipAdd` (and `Chip`) were plain function components. Inside `<PopoverTrigger asChild>`, Radix uses `Slot` to clone the child and attach its own ref/handlers. Without `forwardRef` the ref doesn't reach the DOM node → Floating UI never measures the trigger → the popover content gets rendered into the DOM but stays at the default offscreen position `transform: translate(0, -200%)`. The user clicks the button, `data-state` flips to `"open"`, but they see nothing. Console shows: `Warning: Function components cannot be given refs. ... Check the render method of Primitive.button.SlotClone.`
**Why:** A function component renders fine on its own and tests programmatically (`btn.click()` flips state); the visual breakage only manifests when the popover is actually shown. Easy to miss without a click-through test that asserts the popover *content* is visible, not just that the state changed.
**Rule:** Any reusable button/control that might be passed to a Radix `asChild` slot — `Chip`, `ChipAdd`, `Button`, `IconButton`, `Pill` — MUST be `forwardRef<HTMLButtonElement, Props>`. Inline `<button>` JSX as a direct child works without this because Radix's cloneElement attaches the ref to the native element directly.
**Trigger:** Adding a new reusable button-like primitive in `components/ui/`. Bumping Radix major versions. Any `Warning: Function components cannot be given refs` in the console — never ignore.

## 2026-05-24 — Filter UI shipped without server enforcement

**Mistake:** Phase 1 shipped a +Filter popover that wrote `?status=…&assignee=…&updated_since=…` to the URL, but the server's documents list handler only consumed `?type=`, `?cursor=`, `?limit=`, and the JSON-AST `?filter=`. Other params were silently dropped. The UI had a fully working chip flow that produced no visible effect on the result set — a high-trust-cost bug.
**Why:** Two implementations diverged. The richer `?filter=` AST was built for the agent/MCP path; the toolbar shipped its own flat query shape without anyone validating it round-trips to the server.
**Rule:** When two URL conventions exist for the same intent (flat chips vs structured AST), the server MUST accept both. Add an explicit server-test per flat param at the same time as wiring the UI. Don't assume "the AST handles it" without checking which call sites actually emit the AST.
**Trigger:** Any UI that writes a URL query param and expects the server to filter on it. Cross-check with `grep -n 'c.req.query'` on the matching route.

## 2026-05-24 — Test harness "minimal project" vs "real project" — make it opt-in

**Mistake:** Adding `seedProjectDefaults` to `makeTestApp` to fix new filter tests broke 6 existing tests that asserted the project started with no statuses/views. Tests had silently coupled to the harness's behavior of NOT seeding.
**Why:** Test harnesses fall into two camps — minimal (every fact you assert is something the test set up) and realistic (production-like state). Both are valid, but switching from one to the other affects every test that ever ran on the old contract.
**Rule:** When the harness has a behavior gap from production, expose the gap via an option (`makeTestApp({ seedProjectDefaults: true })`) rather than flipping the default. Document the option in the harness's TSDoc so future test authors know which mode they're in.
**Trigger:** Touching `apps/server/src/test/harness.ts`. Or any test helper named `*makeApp*` / `*makeTestX*`.

## 2026-05-24 — Don't advertise a keyboard shortcut you haven't bound

**Mistake:** `ListRow` rendered a static `aria-label="Open document"` on every row's open icon and a static `aria-label="Document title"` on every inline-edit. With N rows in the list, screen readers heard "Open document, Open document, Open document…" and selector tools (incl. Playwright's strict mode) couldn't disambiguate.
**Why:** Aria-labels are usually written in the abstract ("Open document" describes the button's role), but inside a list of similar items the *role* is the same for every row — what disambiguates them is the data. Generic labels become indistinguishable-from-each-other for the user.
**Rule:** When the same button/control is repeated per row in a list, table, or tree, interpolate at least one row-identifying value into the aria-label (`Open ${title}`, `Edit title: ${title}`). Static labels are fine for singletons; never for repeats.
**Trigger:** Any new `aria-label=` or `ariaLabel=` inside a `.map()` / `for` rendering rows. Cross-check by querying `[...document.querySelectorAll('button[aria-label]')]` in DevTools — count unique aria-label values.

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
