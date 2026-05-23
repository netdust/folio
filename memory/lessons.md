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
