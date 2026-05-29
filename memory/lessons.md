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

---

### 2026-05-25 — Don't debug CSS by guessing; open DevTools and measure

**Mistake:** When Stefan reported "row is taller and there's a hover background for titles," I made three wrong fix attempts in a row — each based on reading source code and guessing the cause:
1. `display: contents` on a urgency wrapper (wasn't the cause — was guessing the wrapper was tall).
2. Removed `hover:bg-card` from InlineEdit (wasn't the cause — that hover was content-width, not column-wide).
3. Changed empty `<span aria-hidden/>` to `<div aria-hidden/>` for the 1fr grid spacer (empty inline spans in flexbox are 0px tall — wasn't the cause either).

Each fix shipped, Stefan reloaded, nothing changed. He had to tell me "nothing changed, do you need superpower bug testing?" before I opened Chrome DevTools.

**Why:** The actual root causes, found in 2 minutes once I measured the live DOM:
- Row height: a hidden `<div class="h-8 w-8 shrink-0"/>` spacer inside each row, mirroring the header's 32×32 ColumnPicker IconButton. Adds 32px + py-2 (16px) = ~50px.
- "Hover bg on title": the sticky first-column cell paints `bg-content` (dark, opaque) on top of the row's `bg-card` (lighter, hover state). Title column looked unhovered while the rest of the row hovered. Fixed with `group-hover/row:bg-card` on the sticky cell.

Both were verified by `getComputedStyle()` + `getBoundingClientRect()` reads on the actual rendered DOM via Chrome DevTools MCP.

**Rule:** For ANY visual / CSS / layout bug, do this BEFORE reading source code:
1. Navigate to the affected page in Chrome (use the chrome MCP).
2. Eval `getComputedStyle(el)` and `getBoundingClientRect()` on the offending element.
3. Walk the parent chain checking what owns the unexpected space/color.
4. ONLY THEN open the source to apply the fix.

A 2-minute DevTools read beats 3 commits of guessing.

**Trigger:** Any user report containing "tall / short / wide / narrow / hover / background / floating / scroll / overflow / position / aligned." Visual descriptions = DevTools first.

### 2026-05-25 — Dev DB drift: pulling a new migration doesn't apply it

**Mistake:** Phase 1.7 added migration `0005_phase_1_7_last_touched_at.sql`. Backend tests passed (test harness creates a fresh DB and migrates on every run). But the dev SQLite at `apps/server/folio.db` was created before that migration existed. Stefan clicked "Log activity" and got a 500 because the column didn't exist in his dev DB.

**Why:** Drizzle's migration runner only runs from `bun run db:migrate`. There was no auto-apply at server boot.

**Fix shipped (`4bf5ff4`):** server `index.ts` now calls `migrate(db, ...)` at boot. Cheap when no migrations are pending; drizzle tracks state in `__drizzle_migrations`.

**Rule:** For any project with on-disk SQLite + a long-lived dev DB, run migrations at server bootstrap. Tests don't catch this because they always start from zero.

**Trigger:** Adding a new migration file. Verify the dev server's bootstrap path includes the migrator, not just the migrate script.

## 2026-05-25 — Don't `git stash` to A/B-test pre-existing TS errors

**Mistake:** While verifying whether a `tsc` error in `apps/server` came from my session's edits or was pre-existing on the branch, I ran `git stash && tsc && git stash pop`. The global CLAUDE.md rule 0a explicitly bans `git stash` as a routine session tool — there's a documented history of lost work from that exact pattern.

**Why:** The same outcome is available without stash: `git diff` to identify changed files, then check whether the failing TS error is in a file I touched. Or `git stash push -m "..." -- <specific-paths>` with named, scoped retrieval, which the rule does permit.

**Rule:** No bare `git stash`. To verify whether an error pre-dates the session, list `git status --short`, cross-reference with the file in the error, and reason from there. Stash only with `push -m "<reason>" -- <paths>` and a clear retrieval plan.

**Trigger:** Any thought that begins "let me temporarily set my changes aside to check…". That's the smell — find a non-stash route.

## 2026-05-25 — Invoke superpowers skills at phase start, not after

**Mistake:** On `phase-1.7/crm-polish`, ran `/code-review` + `/security-review` (correct), then implemented all 12 surfaced fixes without invoking `superpowers:test-driven-development` or `superpowers:verification-before-completion`. Wrote production code first, ran the existing suite once at the end, claimed "all tests pass" — handed Stefan a branch he had to manually QA. He named the gap: "yesterday, spec driven development with thorough testing after each spec. now you go at it and i need to run all kinds of tests and reviews manually."

**Why:** Treated the punch list as 12 small edits instead of 12 behavior changes. Each bug fix IS a behavior change → TDD's Iron Law applies ("no production code without a failing test first"). The harness has the skills loaded for exactly this reason. Bypassing them is choosing speed over the discipline the user is paying for.

**Rule:** At the start of any non-trivial Folio phase / change bundle, before writing any code:
1. Check the available-skills list in the system reminder.
2. Invoke every skill that applies, in order: `brainstorming` (if intent is unclear) → `writing-plans` (if multi-task) → `test-driven-development` (per task: red, watch fail, green, refactor) → `verification-before-completion` (before any "done" claim, run the command and quote the output).
3. For bug-fix bundles from `/code-review` or `/security-review`: each finding = one TDD cycle. Write the failing test that demonstrates the bug, watch it fail against current code, write the fix, watch it pass.
4. "I already know how to do this" / "the existing suite will catch it" is the TDD skill's documented red-flag rationalization. Stop and invoke the skill.

**Trigger:** Any prompt that starts a phase ("phase X", "fix these", "implement Y", "do all of these"), or any time a code-review/security-review surfaces a punch list of 2+ findings. The bar to clear: at end of work, the test suite — not Stefan's manual QA — proves the work is done.

## 2026-05-26 — Audit `components/ui/` before claiming a primitive doesn't exist

**Mistake:** Started writing a `<Chip>` primitive for Phase 2.5 BUG-010 after telling the user "no other generic chip exists" — `grep -rln "rounded-pill"` would have shown me `apps/web/src/components/ui/chip.tsx` already existed. Caught it 30 seconds into Phase 1 of systematic-debugging by reading the audit grep output I'd just run. Would have shipped a second `Chip` next to the first if I hadn't caught it; that's exactly the design-system drift the user was complaining about.

**Why:** I framed the "audit" as a grep for chip-like CSS patterns and skimmed the results. The pre-existing `ui/chip.tsx` was in the grep output but I parsed it as "a Tailwind token reference" because I was looking for `rounded-full + bg-primary` shapes, not for an actual `Chip` export. Confirmation bias against the result.

**Rule:** Before writing ANY new primitive in `apps/web/src/components/ui/`, run TWO checks: (1) `ls apps/web/src/components/ui/` to see file names, and (2) `grep "export.*<Name>" apps/web/src/components/ui/*.tsx`. If a file with that name exists OR a matching export exists, READ THE FILE before deciding it doesn't fit — don't assume from the filename or a partial grep. If it doesn't fit cleanly, the right move is usually to rename/refactor the existing one, not to add a sibling with a similar name.

**Trigger:** Any sentence like "no other generic X exists in the codebase" or "I'll add a new primitive for X". Stop, run the two checks, READ the matches in full, then proceed.

## 2026-05-26 — Verify the test scenario, not the test data state

**Mistake:** During Phase 2.5 verification-before-completion, ran a live curl on the BUG-001 fix and saw HTTP 200 instead of the expected 403. Almost claimed "fix regressed." The fix was fine — the agent's `frontmatter.projects` had drifted during the shake-out (an earlier PATCH I'd run added the disallowed project to the allow-list). Iron Law'd correctly enough to investigate first, but only by luck did I check the agent's current state before re-debugging the middleware.

**Why:** Verification uses the CURRENT system state, not the state at the time of the original bug repro. Test data can drift between repros (manual PATCHes during sweep, prior test runs, schema migrations, hot-reload state). I assumed the curl call was running against the "as filed" scenario; it wasn't.

**Rule:** When a live curl re-sweep contradicts an existing test that's green, check the test data state BEFORE re-investigating the code. For Folio specifically: any verification curl that involves an agent's `frontmatter.projects` allow-list must first `GET /api/v1/w/<ws>/documents/<agent-slug>` and confirm the current allow-list matches the scenario the test asserts. If it drifted, either re-PATCH or create a fresh agent — never debug against drifted data.

**Trigger:** Any verification curl that returns the OPPOSITE of what the unit/integration suite asserts. The unit suite controls its own data via the test harness; live curls use whatever is in the dev DB. Drift is the most likely explanation, not a regression.

## 2026-05-26 — Design-system primitives: build when the third copy appears, not after

**Mistake:** Phase 2.5 second-sweep polish added THREE near-duplicate `Chip` definitions (`ProjectChip` in workspace-agents-page, `Chip` in projects-field, `Chip` in tools-field) over three commits across three sessions. Each was a 10-line component, justified locally ("this caller needs a tweak"). The user flagged it on the fourth-sweep manual review: "please make sure that we have a solid set of components that we reuse. no messy design system." Refactoring it out after the fact cost more than building the primitive on the first or second copy would have.

**Why:** Pattern-matching from individual call sites. Each chip felt like a "small local thing" because each call site had a slightly different visual requirement (one neutral, one primary-tinted, one monospaced). The fact that I was repeatedly writing `'rounded-full px-2 py-0.5 text-[11px]' +` should have triggered a "third copy = primitive" reflex.

**Rule:** When writing a component, ask: "have I written this shape (props + JSX) in the last 5 commits in this branch?" If yes → that's the primitive. If no → fine, ship the local version. If unsure → grep the codebase for the at-rest CSS triple I'm about to type (`rounded-`, `px-`, `text-[1`). Three matches with similar surrounding markup = build the primitive NOW, don't defer it. Acceptable to defer ONLY if the third call site is in a planning doc, not in code.

**Trigger:** Any `<span className={`rounded-* px-* …`}>` or `function NamedChip / NamedBadge / NamedTag` written from scratch inside a feature component. Compare against `components/ui/` first. If absent, build the primitive instead of yet another inline.

## 2026-05-26 — Phase shake-out: budget per-bug verification, not just per-suite

**Mistake:** During Phase 2.5 shake-out, the 4-minute Playwright cold-start dominated my verification cadence. I kept marking tasks "RESOLVED — re-sweep pending" and only ran the e2e at the end of multiple polish bundles (BUG-009/010/011/012 shared one e2e run). When BUG-002 itself failed on first re-run despite my fix, I had to wait another 4.5 minutes to verify the second attempt. Compressed by clustering, but inefficient and risky — if a polish bundle had broken the e2e, I'd have to bisect.

**Why:** Treated the e2e as "one regression check at the end" rather than "the test that proves the bug is dead." The shake-out skill's per-bug fix cadence is right: fix → re-sweep that bug → next. I bundled to save time and ended up with a longer feedback loop.

**Rule:** For Folio shake-outs, when a bug's verification needs Playwright (cold-start ~4.5 min), invoke `run_in_background: true` immediately after the fix lands, then continue working on the NEXT bug while the e2e runs. The bg notification fires when it completes; I switch back, check, then move on. Don't batch e2e runs to save cold-start cost — the cost is still paid once per session, batching just delays which bug's signal you get back. Unit tests still run synchronously between fixes (they're fast).

**Trigger:** Any "fix → e2e → next fix" sequence in shake-out. After the first commit, switch to "fix → bg-launch e2e → start next investigation → bg notification → check → next bg-launch."

## 2026-05-27 — Changing a server-side canonical form requires sweeping every UI consumer in the SAME commit

**Mistake:** F11 changed comment `frontmatter.author` from `agent:<slug>` to `agent:<id>` server-side. The fix landed with passing tests because (a) the migration was app-layer only — no UI code touched, (b) test fixtures still used the legacy slug form, so vitest stayed green. Three UI surfaces silently broke: `AuthorDisplay` rendered raw nanoids instead of slugs, `resolveIsAuthor` never matched (lost Edit/Delete affordances), and `ApprovalButtons.findResolution` never resolved approvals (because `target_agent` still stored slug while the plan author now stored id). The second code-review caught all three; the first review missed them because no test in CI exercised the new shape.

**Why:** A canonical-form change is a *protocol* change, not a service-layer change. Every consumer that pattern-matches on the prior shape is broken until updated. "I only edited services/comments.ts" was the trap — F11's blast radius was every file that ever called `author.startsWith('agent:')` or `.slice('agent:'.length)`.

**Rule:** Before changing a server-emitted canonical string (author identity, slug shape, id format), grep the WHOLE repo for the prior form's pattern (`'agent:'`, `startsWith('agent:')`, `slice('agent:'.length)`, etc.). Every match is a consumer that must be updated in the same commit. Update test fixtures to the NEW form so CI exercises the post-change reality. If consumers need extra context (workspace agent list), add a shared helper (`lib/author-ref.ts`) and route every site through it — never let two files independently decode the same string.

**Trigger:** Editing any function that returns a string with a `kind:value` shape (`agent:<id>`, `user:<id>`, `event:<key>`, `cache:<bucket>`), or changing what `value` contains. Bonus trigger: any commit message that mentions "canonical" or "migrate to <new form>." Step zero: `git grep -F "'<prefix>:'"` and budget the audit.

## 2026-05-27 — Zod `.default(...)` fills AFTER your route-layer guard runs

**Mistake:** F2's `assertAgentAllowListWidening` short-circuited when the create payload had no `projects` key — reasoning: "no widening requested." But the agent Zod schema declares `projects: z.array(z.string()).default(['*'])`. The default fires during `agentFrontmatterSchema.safeParse(...)` INSIDE `createDocument`, AFTER the guard ran. A restricted parent agent (`projects: ['projA']`) could mint a child by omitting the field — Zod filled `['*']` and the guard never saw it. G4 fixed it with an `op: 'create' | 'patch'` parameter so create treats missing as widening-to-`'*'`.

**Why:** Schema defaults are a SECOND mutation pass that runs at the service boundary, not at the route. Guards installed at the route level see the user's payload; guards installed at the service level see the post-default payload. A guard placed at the route boundary, gating a write that ALSO defaults fields downstream, is incomplete by construction.

**Rule:** When writing a security guard against a write payload, ask: does the receiver of this payload run any `.default(...)`, `.transform(...)`, or `.refine(...)` that could ADD a field this guard would reject? If yes, either: (a) move the guard to AFTER the schema parse (right altitude — guards in the service layer), or (b) make the guard treat "missing key" as the most permissive value the default could fill. Don't trust the input shape to match what hits the DB.

**Trigger:** Any `assert*` or `require*` guard placed in a route handler that calls a service whose input goes through Zod with `.default(...)`. Especially `frontmatter.projects`, `tools`, `requires_approval`, `max_delegation_depth` — anything where `agentFrontmatterSchema` fills a default.

## 2026-05-27 — Cron field normalization belongs to the SET, not the range endpoints

**Mistake:** F13 fixed dow=7 by normalizing the range endpoints in `parseField`: `if (a === 7) a = 0; if (b === 7) b = 0;`. Looked correct for `* * * * 7` (single value). Broke completely for ranges crossing the rollover: `5-7` became `start=5, end=0` → `start > end` → returned null; `0-7` became `start=0, end=0` → set `{0}` only (dropped Mon-Sat); `1-7` became `start=1, end=0` → null. The original code-review caught dow=7 single-value; the follow-up review caught dow=7 inside ranges.

**Why:** Normalizing at the endpoint level treats `7` as "literally 0" — but in cron `7` means "ALSO 0" inside a range, i.e. set-union semantics. The two cases (single value vs range) have different correct behaviors that can't be expressed with the same operation on the endpoint.

**Rule:** When normalizing input for a parser that uses ranges, apply the normalization to the EXPANDED SET, not to the endpoints. For dow=7: widen the domain to accept 7 during expansion, then post-process the result set to remap 7→0. Same pattern applies to any cron-like field with aliases (`SUN`, `MON`, `JAN`, etc.) — the alias substitution must happen per-value after expansion, not on the range bounds.

**Trigger:** Any field-parser that does `for (let i = start; i <= end; i += step)` AND has a value-aliasing rule (`7 → 0`, `JAN → 1`, etc.). Don't translate `start`/`end` — translate inside the loop.

## 2026-05-27 — bun-sqlite + drizzle doesn't roll back async throws — the SQL row persists

**Mistake:** F6 deferred `eventBus.publish` to post-commit via `txWithEvents` + a per-tx WeakMap queue, on the assumption that throwing inside `db.transaction(async tx => …)` would also roll back any `tx.insert()` calls. It doesn't — bun-sqlite + drizzle has a documented quirk where async throws don't propagate to the rollback. F6 ended up with an inverse phantom: the bus publish was suppressed (correct), but the events row PERSISTED (wrong). Two simultaneously-open clients diverged until reload — the live one missed the event, the reconnecting one got it via Last-Event-Id replay. G10 fixed it by having the catch issue a manual `DELETE FROM events WHERE id IN (...)`.

**Why:** "Transaction rollback handles cleanup" is a foundational mental model from every other SQL stack. With bun-sqlite + drizzle, it's not true for async callbacks. Synchronous throws roll back; awaited throws don't. The driver and ORM both look healthy in isolation — the bug is at their seam.

**Rule:** When using `db.transaction(async tx => …)` on bun-sqlite, never rely on rollback to clean up. If you await inside the callback AND any awaited statement can throw, the prior writes will persist. Either: (a) reify the rollback at the app layer (track inserted ids, delete on catch — what `txWithEvents` does now), or (b) use synchronous `db.transaction(tx => …)` with `tx.run()` for everything you care about rolling back. Document this constraint in any helper that wraps `db.transaction`.

**Trigger:** Any new `db.transaction(async (tx) => ...)` block where the inner code can throw after a row insert. Especially in event-emitting services where the inner write is paired with a side effect that callers depend on being all-or-nothing.

## 2026-05-27 — A canonical-form migration must drop the back-compat path, not preserve it

**Mistake:** F11 introduced a slug back-compat path in `assertAuthor` ("if id check fails, also match by current slug") so pre-F11 comments stayed editable. Looked safe. Was a privilege escalation: hard-delete an agent → slug freed → create new agent with same slug → new agent's token now matches OLD agent's pre-F11 comments via the back-compat branch. The second review caught it as G6. Fix was a migration (0008) that backfills every pre-F11 row to id-canonical AND dropping the back-compat path entirely.

**Why:** Back-compat paths for authorization are different from back-compat paths for data shape. A schema migration that preserves both shapes is fine. A guard that accepts both shapes is a permission bug if either shape can be reused/recycled. Slug back-compat seemed bounded by "agent must currently exist with that slug" — but in a hard-delete world that's a recyclable identifier.

**Rule:** When changing the canonical form of an identifier used in authorization (author, owner, parent, assignee), write the migration FIRST. Backfill every row to the new form. Then drop the back-compat path in the SAME commit. Don't ship a guard that accepts both shapes; rows that can't be backfilled (deleted parent agent, mid-rename) should become uneditable on purpose — that's the security property, not a UX regression to soften.

**Trigger:** Any change to an `assertAuthor` / `assertOwner` / `assertAssignee` style guard. Or any change to the canonical form of a string used in such a guard. Step zero: write the migration. Step one: drop back-compat. Step two: tests must use the new form.

## 2026-05-27 — Code-review caps are an output limit, not a defect limit

**Mistake:** Ran `/code-review` with the xhigh-effort prompt that returns ≤ 15 findings. 16 candidates were verified-confirmed; I cut #16 to stay under the cap and reported "15 findings." The user noticed the cap implicitly: "15 again, is that a limit?" The next review found that I had ALSO introduced new bugs in my fixes (F11's UI consumers — 3 of them — would all have been in #16-#18 if the cap allowed). The cap creates a false sense of "we got them all."

**Why:** The review pipeline is calibrated to a fixed output size for readability. The number of real defects in a code change is not fixed. A clean PR fits well under the cap; a PR that touches a canonical form or moves a guard has more.

**Rule:** When a code-review report says "15 findings," ALWAYS report verified-but-cut findings to the user with the verdict and a one-line summary, even if abbreviated. If the cap forced a cut, name that explicitly. The user should know what was deferred. Better: rank by severity, mention the count of verified findings, then truncate displayed detail — don't truncate the count.

**Trigger:** Running `/code-review` or any reviewer pipeline with a fixed output cap. If the verified-confirmed count exceeds the cap, the closing summary must say so (e.g., "18 verified, top 15 below, remainder: …"). Don't let a presentation limit hide a correctness signal.

## 2026-05-28 — When the plan was written before the convention, re-read it against the live codebase

**Mistake:** Phase 3's plan was authored 2026-05-26. Phase 2.6's reviewer pass (later in the same week) codified two Folio conventions: Zod schema consts use camelCase (every peer schema in `apps/server/src/lib/*-schema.ts` does), and frontmatter schemas always call `.strict()`. The Phase 3 A-4 plan reproduced the older convention verbatim — PascalCase consts, no `.strict()`. The implementer shipped it as written. Stage 2 code-review caught it, but at fix-up cost (commit `bc4b5ee`). Same root cause behind A-4b's installer-heredoc bug: the plan was written before the worktree-portability concern got attention.

**Why:** A plan is a snapshot of conventions at the time it was authored. Between writing and executing, the codebase keeps moving. Patterns codified in reviewer passes (BUG-* fixes, code-review findings) settle into the codebase but DON'T propagate backward into already-written plans. The plan is a stale rubric the moment a new pattern lands.

**Rule:** When the executing-skill cycle (`ntdst-execute-with-tests` → `subagent-driven-development`) opens a plan that's more than a few days old, the controller's pre-flight MUST include: for each new module/class/schema the plan introduces, grep peer files in the target directory (`apps/server/src/lib/*-schema.ts`, `apps/web/src/lib/api/*.ts`, etc) and verify the plan's example matches the live convention. If a peer file uses `.strict()`, the plan's schema must too; if peers are camelCase, the plan's must be too. Caught at pre-flight = zero fix-up cycles; caught at Stage 2 review = one extra commit per drift.

**Trigger:** Any `superpowers:executing-plans` or `superpowers:subagent-driven-development` invocation on a plan file with `mtime > 5 days`. Or any plan task that introduces a NEW file matching a pattern that other peer files in the codebase already follow. Look at the FIRST peer file for each pattern; if it disagrees with the plan, the live code wins.

## 2026-05-28 — When the plan rebuilds an existing table, audit columns against the live schema

**Mistake:** A-2's plan included a SQLite table-rebuild migration for `documents`. The plan's CREATE TABLE block declared `author_id` and `target_agent_id` as real columns — but in the live schema (post-migrations 0007/0008/0011) those names are JSON fields inside `frontmatter`, not real columns. The plan's `INSERT INTO documents_new SELECT * FROM documents;` would have failed at runtime because the column counts didn't match. The controller pre-flight caught it; if it hadn't, the subagent would have shipped a broken migration and the test would have failed cryptically (SQLite error about column count mismatch, not "your plan was wrong"). A-2's subagent ALSO surfaced a third drift mid-execution: the plan referenced `tables.title` when the real column is `tables.name`.

**Why:** SQLite's lack of `ALTER TABLE CHANGE CHECK` forces table-rebuild migrations to re-declare every column of the original table. Any column the plan misses or misnames silently breaks the data copy. The plan author was working from a mental model of the schema that drifted from the actual schema between when the plan was written and when it ran. Drizzle's generated schema files (`schema.ts`) are the source of truth, not the plan's CREATE TABLE.

**Rule:** Whenever a plan introduces a `CREATE TABLE <existing_table>_new (...)` rebuild block, the controller pre-flight MUST do two grep checks BEFORE dispatching:

1. Open `apps/server/src/db/schema.ts` and grep for the target table's column list (e.g. `documents` table). Compare line-by-line against the plan's CREATE TABLE. Any plan-listed column that doesn't appear in `schema.ts` is a phantom column → strike it from the plan SQL.
2. Open the most recent `documents_new`-style migration in `apps/server/src/db/migrations/` (e.g. `0007_phase_2_6_comments.sql`) and copy the column list verbatim. Cross-reference with `schema.ts`. That column list is the canonical one for the next rebuild migration.

Pre-flight catches in ~2 minutes what shipping the broken plan would cost ~20 minutes to debug + 1 corrective commit. ALSO: when the plan references column names from sibling tables (`tables.title` vs `tables.name`), grep `apps/server/src/db/schema.ts` for the actual definition and correct in the dispatch brief.

**Trigger:** Any plan task that contains the text `CREATE TABLE` and includes a column list, OR any plan SQL block that references columns of an existing table by name. Pre-flight is required even if the plan was written yesterday — schema drift can happen across a single sub-phase if a backfill migration ran in between.

## 2026-05-28 — Generated-script heredocs must be single-quoted

**Mistake:** A-4b's plan supplied an `install.sh` containing this block:

```bash
cat > "$HOOK_DST" <<EOF
#!/usr/bin/env bash
"$HOOK_SRC_DIR/pre-commit-migration-journal.sh"
EOF
```

The unquoted `<<EOF` heredoc tells bash to interpolate `$HOOK_SRC_DIR` AT INSTALLATION TIME, baking the installer's machine-absolute path into the generated `.git/hooks/pre-commit`. That makes the hook non-portable: another developer cloning the repo and running `./scripts/hooks/install.sh` would get a hook pointing at the FIRST developer's home directory. Caught by Stage 2 code-review (`13e5954`), fixed with `<<'EOF'` (single-quoted, no interpolation) + a runtime `$(git rev-parse --show-toplevel)` lookup inside the generated script.

**Why:** Bash heredoc quoting has two modes that look almost identical but behave opposite. `<<EOF` interpolates variables (and command substitutions, backticks, etc.) before writing the body to the destination. `<<'EOF'` writes the body literally, deferring all interpolation to whenever the generated script runs. For ANY generated artifact that should be portable across machines, runtimes, or working trees, the literal mode is correct — but the unquoted form is more common in casual examples, so it sneaks into plans.

**Rule:** Any plan that includes a heredoc inside a script-generator (installer, scaffolder, codegen helper) MUST use single-quoted heredocs (`<<'EOF'`) unless there is a specific reason to interpolate at generation time. If interpolation IS needed, the plan must justify why in a comment above the heredoc. The default is to defer. Also: prefer runtime lookups (`$(git rev-parse --show-toplevel)`, `${BASH_SOURCE[0]}`, `$(dirname ...)`) over baked absolute paths.

**Trigger:** Any plan or commit that contains a heredoc inside a shell script that writes to another shell script (hooks, helpers, generated commands, dotfile setup). Grep the plan SQL/bash blocks for `<<EOF` (without quotes) and flag every occurrence. The fix is a 4-character change (`<<'EOF'`) but catching it pre-execution avoids a portability bug that only surfaces when a second developer/machine touches the repo.


## 2026-05-28 — Plans for features touching user-controlled URLs require a Threat model section before task breakdown

**Mistake:** Folio Phase 3 Sub-phase B's plan had functional requirements ("BYOK is libsodium-encrypted") but no threat model. The plan author treated "BYOK + libsodium" as covering security — it didn't. It covered storage-at-rest but not the URL + outbound-request + cross-route consistency surface. Seven tasks of provider + UI code shipped. Two rounds of `/code-review` at `--effort=medium` surfaced ~30 security-class findings across the surface (SSRF + IPv4-mapped IPv6 bypass, credential exfiltration via attacker-controlled baseUrl, persistence-path validation gap, Ollama localhost default, error-message leaks, JSON.parse stream aborts). Critical-class items kept emerging in round 2 that round 1 missed.

**Why:** Without an explicit threat model, every `/code-review` round independently re-discovers the attack surface from scratch. Each round catches a different subset. The cap-of-15 on medium-effort reviews can hide critical findings below the threshold across multiple rounds. Convergence is slow and probabilistic. The "BYOK + encrypted" language is a property statement, not a security spec — the implementer built what the plan asked for, and the plan didn't ask for the right things.

**Rule:** When writing a plan that touches user-controlled URLs (webhooks, BYOK provider URLs, OAuth redirects, embed URLs, CMS bridge endpoints), auth/session/token surfaces (new auth methods, scope additions, multi-tenancy boundaries), untrusted parsing (frontmatter from external sources, AI tool-call args, webhook payloads, file uploads), BYOK credentials, file handling, or any surface where the server makes outbound requests to user-supplied URLs — invoke `netdust-core:threat-modeling` alongside `superpowers:writing-plans`. The threat-modeling skill produces a `## Threat model` section the plan embeds inline, BEFORE task breakdown, with named assets, named attacks, named mitigations, and explicit deferrals. `/code-review` then checks against the named mitigations instead of free-form bug hunting — converges in one round.

**Trigger:** Any plan whose feature description includes the words webhook, URL, baseUrl, redirect, OAuth, upload, parse, untrusted, third-party, BYOK, credential, key, token (in auth context), workspace boundary, cross-workspace, scope-check, or any surface where the server makes outbound HTTP requests to addresses the user supplied. Also: any feature that adds a new public-ish endpoint. Worked example: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` section `## Threat model` — written retrospectively at the cost of 2 rounds of review-fix iteration. Future plans should write it proactively.

## 2026-05-28 — Convergence signal for a threat model: anti-regression scan returns `[]`

**Mistake-prevention pattern, not a mistake.** Sub-phase B went through 7 rounds of `/code-review` (rounds 1-6 medium, round 7 ultra-effort 9-angle local). Findings per round: 15, 15, 9, 9, 11, 7, 15. The threat-model section was iteratively enriched after rounds 2, 4, 5, 6, 7. Round 7's ultra-effort review dispatched an anti-regression angle that walked all ~50 prior findings and confirmed each was still fixed in the current code. That anti-regression scan returned `[]` — zero regressions across 7 rounds of fix-on-fix.

**Why that's the signal:** when a threat model has matured from "checklist" (a list of routes) to "spec" (a rule the codebase enforces), new review rounds find genuinely-new attack classes, not asymmetry leftovers from the previous round's incomplete fixes. Round 7's 15 findings were: 2 new attack classes on adjacent surfaces (HTTP twin of MCP agent-CRUD; PII leak via /members), 1 Sub-phase C data-contract gap (agent_run schema missing slots for refusal/pause_turn), 5 provider long-tail bugs, 4 defense-in-depth gaps, 3 hygiene items. None were "round N missed asymmetric route Y" — that pattern was extinct.

**Rule:** when running `/code-review` in iterative rounds on a security-rich surface, dispatch an anti-regression angle alongside the discovery angles. The anti-regression angle re-verifies every prior finding's fix is still in place. When that angle returns `[]`, you have evidence that the threat model is now a spec, not a checklist. Stop iterating; the remaining findings are new surface, not leftover gaps.

**Trigger:** ≥3 rounds of `/code-review` on the same surface, OR explicit user request for ultra-effort. The anti-regression angle is angle B' in the ultra pattern. Cost: one more subagent dispatch, ~3 minutes wall-clock.

## 2026-05-28 — Implementation:review-cycle time ratio benchmark

**Reference data, not a rule.** Sub-phase B benchmark: 42 min B-1..B-7 implementation, 5h27m review-fix cycles. Ratio 1:7.7. Sub-phase A benchmark: ~50 min total, no review cycles (clean threat-model-free plan). Sub-phase B's high ratio is the cost of NOT writing the threat model at plan-time.

**Hypothesis to test on Sub-phase C:** with the threat model carried forward from B + the new pre-dispatch security check (per Sub-phase B retro recommendation §1), the ratio should drop closer to 1:2 or 1:3. If Sub-phase C also runs 1:7+, the discipline isn't holding. Re-measure at Sub-phase C close.

## 2026-05-28 — Sub-phase C.1 implementation:review ratio (hypothesis test result)

**Result of the hypothesis test from the Sub-phase B entry above.** Sub-phase C.1 ratio: ~2h primary implementation : ~3h review work (counting bundles 1-8 across freeform review + review-of-review). Ratio ~1:1.5. The hypothesis ("dropping closer to 1:2 or 1:3 with the threat model carried forward") was wrong direction but right magnitude — review-fix work was LESS than 1:7, but a second review layer (review-of-review) added unanticipated time.

**New benchmark**: phase-3 sub-phases with services-layer cross-cutting concerns are running ~1:1.5 to 1:2. The 1:7 of Sub-phase B was a threat-model-write-time tax, not a permanent regime. Future sub-phases should plan for 1:2 review time as baseline.

## 2026-05-28 — `tx.all<T>` with RETURNING * is a runtime type lie

**Mistake found in C-3, fixed in F12 (bundle 1).** When Drizzle's bun-sqlite query helper is called via raw SQL with `tx.all<Document>(sql\`UPDATE ... RETURNING *\`)`, the generic type `T` does NOT match the runtime shape. `RETURNING *` yields raw SQLite columns in snake_case (`workspace_id`, `parent_id`, `frontmatter`), but `Document = typeof documents.$inferSelect` is camelCase (`workspaceId`, `parentId`). Only `.id` reads happen to work (no case difference).

**Why it slips past tsc:** the cast is a generic argument, not a runtime check. TypeScript trusts the annotation; the raw row at runtime has snake_case keys; any `.workspaceId` access reads `undefined`.

**Rule:**
- If you read more than `.id` off a `tx.all<T>(sql\`...RETURNING *\`)` row, either (a) restrict `T` to a snake_case shape literal matching what `RETURNING *` produces, or (b) convert RETURNING to a narrow column list with camelCase aliases (`RETURNING id, workspace_id AS workspaceId, ...`).
- The pattern `tx.all<{ id: string }>(sql\`UPDATE ... RETURNING id\`)` is safe — only reads `.id`, only returns `id`.
- If the function is supposed to return a typed `Document`, follow the RETURNING with a typed `tx.query.documents.findFirst(...)` re-read. That's the canonical shape (used by `claimNextPlanningRun`).

**Trigger:** any new `tx.all<>(sql\`...\`)` call with `RETURNING *` OR with a `T` that's a Drizzle `$inferSelect` type. Audit at write time AND at every code review.

## 2026-05-28 — Cross-cutting changes need a sibling-site audit at plan-write time

**Meta-pattern from Sub-phase C.1 reviews.** Across two layers of code-review (freeform 9-angle, then review-of-review 5-angle), every primary fix that touched a CROSS-CUTTING concern had 1-2 SIBLING SITES that needed the SAME change but were missed by the primary fix:

- C-1 widened `DocumentType` to include `'agent_run'` on the server. Bundle 4 hardened agent_run writes (5 route guards). Bundle 6 hardened agent_run reads (4 more route guards) AND FE+shared union widening (2 more files). Same root change rippled to 11+ sites.
- F6 in bundle 1 changed `json_extract(...status)` → `status` column predicate in 2 places (claim + recovery). Bundle 6 found `countPendingPlanning` was the 3rd site, also needed the change.
- F4 in bundle 3 fixed `workspace.provider.*` event scope to `projectId: null`. Audit of similar workspace-wide events (`runs_table.lazy_seeded`, etc.) not done — open question.
- F5 in bundle 3 tightened SQL filter. Bundle 6 (R4) added the recency-floor that should have shipped together.

**Rule:** when a plan task touches any of these cross-cutting concerns, the task body includes a `## Sibling-site audit` block enumerating the surface to check:

- TypeScript union / enum / discriminator: audit FE union + shared union/enum + every consumer's switch/narrow.
- SQL predicate on a JSON-extract → column change: audit ALL read sites of the same field (count, filter, sort).
- Event scope (projectId, workspaceId, documentId): audit every emitter of similar-class events.
- Cross-route guard (writes hardened → audit reads; reads hardened → audit writes).
- Closed-enum literal: audit every site that writes/compares the literal.

The audit lives in the plan, gets verified by the implementer, reviewed at code-review time. Per-task cost: 5-10 minutes at plan-write; net savings ~1-2 review-fix bundles per sub-phase.

## 2026-05-29 — ground-truth the dependency surface before expanding a runner/integration plan (Sub-phase C.2)

A plan expanded as an outline before its dependency surface was read will drift. C.2's plan assumed a Vercel-AI-SDK-shaped provider — `continueWithToolResult(streamHandle, ...)` continuation + an injectable `AbortController` — that the actual Sub-phase B layer (`lib/ai/provider.ts`) does NOT have: `stream(opts)` is one-shot, no continuation, no abort param; the tool round-trip is via message history (re-call `stream()` with appended `{role:'assistant', tool_calls}` + `{role:'tool', tool_use_id, content}`). It also named `error_reason` enum members that don't exist, an `actor:'system:runner'` that violates the `documents.updated_by`→`users.id` FK, and a `kind=cancel` comment kind that doesn't exist.

All three C.2 tasks shipped DIVERGED_DEFECT — but every drift was caught at controller PRE-FLIGHT (reading `provider.ts`/`agent-runs.ts`/`comments.ts`/`agent-run-schema.ts` against the plan) and corrected in the plan BEFORE/at dispatch (3 inline plan-corrections). Rule: when expanding/executing a plan that integrates against another sub-phase's code, READ that code's actual exported signatures + types + enums first — the plan's prose is a hypothesis, the source is truth. Reinforces [[plan-server-source-audit]]. Third sub-phase (A, C.1, C.2) to surface plan-freshness drift → promoted to a HUMAN_DECISION follow-up (plan-freshness check as a writing-plans skill rule).
