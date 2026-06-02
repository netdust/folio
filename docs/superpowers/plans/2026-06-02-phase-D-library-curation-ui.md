# Phase D — Library Curation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PREREQUISITE: Phases A + B (+ ideally C) must be built + merged first.** Phase D is the human surface for curating the `__system` library (agents, triggers, skills, reference docs) that A–C made functional. UI-only — NO execution-model change.

**Goal:** Give `__system` members a way to SEE and CURATE the library — exclude `__system` from the ambient workspace switcher (it's not a customer workspace), add a **Settings → System Library** entry visible only to `__system` members that links into `__system`'s existing agents / triggers / Skills+Reference document management UI, and confirm the existing per-workspace management surfaces work unchanged when the workspace IS `__system`.

**Architecture:** `__system` is a NORMAL workspace; its agents, triggers, and skill/reference docs are NORMAL documents. So the curation UI is the EXISTING per-workspace surfaces (`workspace-automation-page` / `workspace-agents-tab` / `workspace-triggers-page` / the document/wiki views) pointed at `__system` — no new management UI is built. Phase D's real work is VISIBILITY: (1) filter `__system` out of `listWorkspaces` (the ambient switcher must not show the system library as a customer workspace), while (2) exposing an `am-I-a-system-member?` signal + a Settings entry that navigates a `__system` member INTO the library's management UI. A non-member sees no Settings entry and no switcher item — `__system` is invisible to them (its membership-gated routes already 403/empty per Phase A M6).

**Tech Stack:** React + Vite + TanStack Router + Tailwind + shadcn/ui (web); Hono + Drizzle (the `listWorkspaces` filter + a small `am-I-a-system-member` read). Reuses Phase A's `SYSTEM_WORKSPACE_SLUG`, the existing settings-tab pattern (`components/settings/*-tab.tsx`), and the existing workspace-automation/agents/triggers pages.

**Spec:** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 2 — visibility; "surfaced via Settings, visible only to `__system` members").

---

## Threat model

> Phase D of the system-library build: the human curation surface + `__system` visibility. Written 2026-06-02. LIGHT threat model — Phase D adds NO new write/auth surface; the risk is purely VISIBILITY (does a non-member see or reach the library?). The auth gates are inherited from Phase A (M6 — `__system` content is membership-gated) + the existing route auth; this section ensures the UI doesn't ACCIDENTALLY widen visibility. Convergence target for `/code-review` on Phase D.

### What we're defending

1. **The library's invisibility to non-members** — a customer (non-`__system`-member) must not see `__system` in any workspace list/switcher, must not see the Settings → System Library entry, and must not reach its agents/triggers/docs.
2. **The membership-gate is the boundary, not the UI** — hiding the Settings entry in the client is convenience; the SERVER must still 403/empty a non-member's request for `__system` content (inherited Phase A M6). The UI hide must not be MISTAKEN for the control.

### Who we're defending against

1. **A customer member/admin in a normal workspace** (IN scope) — must not discover `__system` exists, see its agents'/skills' content, or reach its management routes by guessing the slug or hitting the endpoint directly.
2. **A `__system` member** (trusted for the library) — the intended curator; sees + edits the library. (Same trust tier as Phase A's instance-owner.)
3. **An unauthenticated user** (IN scope, but covered by existing auth) — no session → no workspace list, no settings.

### Attacks to defend against

1. **D1 — `__system` leaks into the ambient switcher.** `listWorkspaces(userId)` returns every workspace the user is a member of; a `__system` member sees `__system` alongside their customer workspaces in the normal switcher (it's a system workspace, not a customer one — wrong place, and it normalizes the library as "just another workspace"). (Class: ambient-surface leak.)
2. **D2 — The Settings → System Library entry shows for a non-member.** The entry is rendered client-side without an authoritative "is this user a `__system` member?" check, so a non-member sees (and can click into a 403) the entry. (Class: client-only gating.)
3. **D3 — Direct route/endpoint access by a non-member.** A non-member navigates to `/w/__system/agents` (or hits the `__system` documents endpoint) directly. (Class: direct-access bypass of the UI hide.)
4. **D4 — The library's agent/skill CONTENT renders to a non-member via a shared component.** A component that lists agents/docs across workspaces (e.g. the cross-workspace run picker from Phase B Task 7) surfaces `__system` agents to a non-member in a context that reveals their PROMPT or skill body (vs just the invokable name). (Class: content leak via a shared surface.)

### Mitigations required

1. **D1 → `listWorkspaces` EXCLUDES `__system` from the ambient list; a SEPARATE signal exposes membership for Settings.** `listWorkspaces(userId)` filters out the workspace whose slug is `SYSTEM_WORKSPACE_SLUG` (the ambient switcher + workspace picker never show it). A small read — `isSystemMember(userId)` (or an `is_system_member` boolean on the user/session payload) — tells the client whether to show the Settings entry. A test: a `__system` member's `GET /workspaces` does NOT include `__system`; `isSystemMember` is true for them, false for a non-member.
2. **D2 → the Settings → System Library entry renders ONLY when the authoritative membership signal is true.** The entry is gated on the server-provided `isSystemMember` (not a client guess); a non-member's settings page has no such entry. A test: the entry is absent for a non-`__system` member, present for a member.
3. **D3 → direct access is gated SERVER-SIDE (inherited Phase A M6), and Phase D confirms it.** Navigating to `/w/__system/...` as a non-member hits the existing `resolveWorkspace` + membership gate → 403/empty (Phase A M6). Phase D adds NO new route that bypasses this; a test confirms a non-member's request for a `__system` agents/documents endpoint is 403/empty (the UI hide is convenience; the server is the control).
4. **D4 → the cross-workspace agent picker (Phase B Task 7) exposes only the INVOKABLE NAME of a `__system` agent, never its prompt/skill body, to a non-member.** Confirm the union endpoint Phase B added returns only the agent's id/slug/name/`library:true` (the fields needed to INVOKE it), NOT its `body` (prompt) or frontmatter `system_prompt`. A test: the cross-workspace agent list a non-`__system`-member receives contains the library agent's name but NOT its body/prompt. (If Phase B already redacts this, Phase D pins it; if not, Phase D adds the redaction — flag at Task 1 ground-truth.)

### Out of scope (explicit deferrals)

- **A rich library-management UX** (e.g. a dedicated dashboard distinct from the per-workspace agents/triggers pages) — v1 reuses the existing per-workspace surfaces pointed at `__system`; a bespoke library console is a later polish.
- **The `frontmatter.published` library-agent visibility filter** (OP-LIB-1) — still deferred; Phase D surfaces ALL `__system` agents to members for curation (members are trusted), and the cross-workspace INVOKE list is the Phase B/C concern.
- **Multi-tenant instance admin tiers** — instance-admin remains `__system` membership (spec Component 2); no richer model here.

### How to use this section

- **Controller pre-flight:** verify each task carries its named D-mitigation; ground-truth the switcher/settings/`listWorkspaces`/the Phase-B union endpoint live before dispatch.
- **`/code-review` (medium is fine — UI + one server filter, low security surface):** "Verify against the Phase D threat model (D1–D4). Confirm `__system` is excluded from `listWorkspaces` (D1); the Settings entry is gated on a SERVER membership signal not a client guess (D2); a non-member's direct request for `__system` content is server-gated (D3, inherited Phase A M6 — confirm not weakened); the cross-workspace agent list exposes only invokable name, not the prompt/skill body (D4)."
- **`/evaluate` retro:** any missing D-mitigation → plan-correction defect.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/services/workspaces.ts` | `listWorkspaces` excludes `SYSTEM_WORKSPACE_SLUG`; add `isSystemMember(userId)` (or fold an `is_system_member` flag into the session/user payload). | Modify |
| `apps/server/src/routes/workspaces.ts` (or auth/session payload) | Expose `isSystemMember` to the client (a field on `GET /workspaces` response or the session bootstrap). | Modify |
| `apps/web/src/lib/api/workspaces.ts` | `useWorkspaces` no longer receives `__system` (server-filtered); add an `useIsSystemMember()` (or read the flag from the session/me payload). | Modify |
| `apps/web/src/components/settings/...` + `routes/w.$wslug.settings.tsx` | A "System Library" settings entry (gated on `isSystemMember`) that links into `/w/__system/agents` (the existing automation/agents UI). | Modify |
| `apps/web/src/components/shell/workspace-switcher.tsx` + `components/workspace-picker.tsx` | Confirm `__system` is absent (server-filtered) — likely no change beyond a test, OR a defensive client filter. | Modify (likely test-only) |
| Tests per file | TDD | Create |

> **Open ground-truth the implementer MUST resolve in Task 1:** (a) confirm `listWorkspaces` (`services/workspaces.ts:13`) is the SOLE feeder of the switcher + workspace picker (so filtering there covers all ambient surfaces); (b) where to put the `isSystemMember` signal (a field on `GET /workspaces`, the session `me` payload, or a tiny dedicated endpoint — pick the one the client already fetches at boot); (c) confirm the Phase-B cross-workspace agent-union endpoint returns only invokable fields (name/slug/id/library), NOT the agent body/prompt (D4 — redact if not); (d) the settings-tab registration pattern (`components/settings/*-tab.tsx` + the `Tabs` in `w.$wslug.settings.tsx`) — to add the System Library entry; (e) does the System Library entry NAVIGATE to `/w/__system/agents` (the existing page) or EMBED it? Recommended: navigate (reuse the existing route + page wholesale; `__system` is a normal workspace so its `/w/__system/agents` route already works for a member).

---

## Task 1: Ground-truth + exclude `__system` from `listWorkspaces` + the membership signal

**Mitigations: D1.**

**Files:**
- Modify: `apps/server/src/services/workspaces.ts` (filter + `isSystemMember`)
- Test: `apps/server/src/services/workspaces.test.ts` (or `routes/workspaces.test.ts`)

- [ ] **Step 1: Ground-truth** the 5 items in the File-Structure note (the switcher feeder, where the membership signal goes, the Phase-B union endpoint's fields, the settings-tab pattern, navigate-vs-embed). Write findings as a comment.

- [ ] **Step 2: Write the failing test**

```typescript
test('listWorkspaces excludes __system from the ambient list (D1)', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db); // Phase A
  // make the seeded user a __system member (grantOwner) so they'd otherwise see it
  await grantOwner(db, /* the seed user's email */);
  const list = await listWorkspaces(seedUserId);
  expect(list.find((w) => w.workspace.slug === SYSTEM_WORKSPACE_SLUG)).toBeUndefined();
});

test('isSystemMember is true for a __system member, false otherwise (D1)', async () => {
  // a __system member → true; a user with no __system membership → false
});
```

- [ ] **Step 3: Run to verify fail** — FAIL.

- [ ] **Step 4: Implement** — in `listWorkspaces`, add a `where` clause excluding `workspaces.slug = SYSTEM_WORKSPACE_SLUG` (the ambient list never includes it). Add `isSystemMember(userId): Promise<boolean>` — a findFirst on `(memberships.userId = userId AND the workspace is __system)`. (Import `SYSTEM_WORKSPACE_SLUG` from Phase A's `lib/system-workspace.ts`.)

- [ ] **Step 5: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/workspaces.ts apps/server/src/services/workspaces.test.ts
git commit -m "phase-D: exclude __system from listWorkspaces + isSystemMember signal (D1)"
```

---

## Task 2: Expose `isSystemMember` to the client

**Mitigations: D2 (the signal the entry gates on).**

**Files:**
- Modify: `apps/server/src/routes/workspaces.ts` (or the session/me payload — wherever the client reads boot state) + `apps/web/src/lib/api/workspaces.ts`
- Test: server route test + web hook test

- [ ] **Step 1: Write the failing test** — the client can read an authoritative `isSystemMember` from the server (the same fetch it already does at boot — `GET /workspaces` response envelope or the `me`/session payload).

```typescript
// server: GET /workspaces response (or /me) carries is_system_member
test('GET /workspaces exposes is_system_member for the caller (D2)', async () => {
  // a __system member → is_system_member: true; a non-member → false
});
// web: useIsSystemMember() reads it
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — add `is_system_member` to whichever boot payload the client already fetches (per Task 1b — prefer NOT a new endpoint; fold it into `GET /workspaces` envelope `{ data: [...], is_system_member }` or the session `me`). Web: `useIsSystemMember()` (or read the flag from the existing hook). Keep it server-authoritative (computed from membership, never client-derived).

- [ ] **Step 4: Run to verify pass + tsc (server + web)** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/workspaces.ts apps/web/src/lib/api/workspaces.ts <test files>
git commit -m "phase-D: expose server-authoritative is_system_member to the client (D2)"
```

---

## Task 3: The Settings → System Library entry (member-gated, links into the library)

**Mitigations: D2.**

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.settings.tsx` + a small `components/settings/system-library-tab.tsx` (or a link entry)
- Test: `apps/web/src/routes/w.$wslug.settings.test.tsx`

- [ ] **Step 1: Write the failing test** — the System Library entry is PRESENT in settings for a `__system` member, ABSENT for a non-member; clicking it navigates to `/w/__system/agents`.

```typescript
test('Settings shows a System Library entry only to a __system member (D2)', () => {
  // render Settings with isSystemMember=true → the entry exists; with false → it does not
});
test('the System Library entry links to the __system agents/automation page', () => {
  // the entry navigates to /w/__system/agents (the existing automation/agents UI)
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — add a "System Library" entry to the settings surface (a tab or a link section), rendered ONLY when `useIsSystemMember()` is true. It NAVIGATES to `/w/__system/agents` (the existing `workspace-automation-page` — agents | triggers tabs — which already works for `__system` as a normal workspace; the Skills/Reference docs are reachable via that workspace's wiki/document views). Do NOT build a new management UI — reuse the existing per-workspace surfaces pointed at `__system`. A short intro line ("Curate the agents, triggers, and skills available across all workspaces") + the link.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/w.$wslug.settings.tsx apps/web/src/components/settings/system-library-tab.tsx apps/web/src/routes/w.$wslug.settings.test.tsx
git commit -m "phase-D: Settings → System Library entry, member-gated, links into the library UI (D2)"
```

---

## Task 4: Confirm the switcher excludes `__system` + the existing UIs work for `__system`

**Mitigations: D1 (switcher), D3 (direct access stays gated), supports the reuse.**

**Files:**
- Test-mostly: `apps/web/src/components/shell/workspace-switcher.test.tsx`, `apps/web/src/components/workspace-picker.tsx` (+ a defensive client filter only if needed)
- Test: server `routes/documents.test.ts` / `workspaces.test.ts` for the non-member 403

- [ ] **Step 1: Write the tests**

```typescript
// web: the switcher + workspace picker never list __system (server already filtered; pin it)
test('the workspace switcher does not show __system (D1)', () => {
  // useWorkspaces returns no __system (server-filtered); the switcher renders none
});
// server: a non-member's direct access to __system content is gated (D3, inherited Phase A M6)
test('a non-__system-member gets 403/empty for __system agents/documents (D3)', async () => {
  // GET /w/__system/p/.../documents (or agents) as a non-member → 403/empty (membership gate)
});
```

- [ ] **Step 2: Run to verify** — the switcher test should PASS (Task 1 server-filtered `__system`); the D3 test should PASS (Phase A M6 already gates it). If the switcher still shows `__system` (e.g. a cached/alternate feeder), add a defensive client filter excluding `SYSTEM_WORKSPACE_SLUG` + a comment. These are guard/regression pins confirming the boundary.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/... apps/server/src/... <test files>
git commit -m "phase-D: pin __system excluded from switcher + non-member 403 on __system content (D1/D3)"
```

---

## Task 5: Confirm D4 (cross-workspace agent list exposes name only, not prompt/skill body)

**Mitigations: D4.**

**Files:**
- Modify: the Phase-B cross-workspace agent-union endpoint (`apps/server/src/...`) only IF it leaks the body — else test-only.
- Test: server test on the union endpoint.

- [ ] **Step 1: Write the test** — the cross-workspace agent list a NON-`__system`-member receives contains the library agent's invokable fields (name/slug/id/`library:true`) but NOT its `body` (prompt) or `system_prompt`.

```typescript
test('the cross-workspace agent list exposes only invokable fields of a __system agent, not its prompt (D4)', async () => {
  // a non-__system-member in workspace B fetches the run/assign agent list (Phase B Task 7 endpoint);
  // the library agent entry has name/slug/library:true but NO body / system_prompt
});
```

- [ ] **Step 2: Run to verify** — if Phase B's union endpoint already projects only the invokable fields, this PASSES (a pin). If it returns the full document (incl. `body`), it FAILS → redact in Step 3.

- [ ] **Step 3: Implement (only if the test failed)** — narrow the cross-workspace agent-union projection to the invokable fields (id, slug, name/title, `library:true`), dropping `body`/`frontmatter.system_prompt`. (Mirror the existing run-redaction pattern — `redactRunForApi` is the precedent for "strip the prompt from a cross-tenant surface".)

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/... <test files>
git commit -m "phase-D: cross-workspace agent list exposes invokable fields only, not the prompt (D4)"
```

---

## Task 6: Integration gate

**Files:** verification only.

- [ ] **Step 1: Full suites** — server (`cd apps/server && bun test`, 0 fail), shared, web (`npx vitest run`). tsc per app.
- [ ] **Step 2: A manual/headless walk-through** — as a `__system` member: Settings shows System Library → click → land on `/w/__system/agents` → see/edit the operator agent, the skills, the reference docs. As a non-member: no System Library entry, `__system` absent from the switcher, direct `/w/__system/...` is 403/empty.
- [ ] **Step 3: `/integration`** then `/code-review` (medium — UI + one server filter; D1–D4 as input), then merge. **This completes the cross-workspace operator (A→D); merge the full arc to main if not already.**
- [ ] **Step 4: Commit** any gate-fix; `/evaluate` the A→D arc (the operator build's close-out retro).

---

## Self-Review (run before dispatch)

**Spec coverage (Component 2 — visibility):** `__system` excluded from the ambient switcher (Task 1/4 — D1), the server-authoritative membership signal (Task 2 — D2), the Settings → System Library entry gated on it linking into the existing library UI (Task 3 — D2), direct-access stays server-gated (Task 4 — D3), the cross-workspace agent list exposes name-not-prompt (Task 5 — D4), the integration walk-through (Task 6). No new management UI is built — the existing per-workspace agents/triggers/document surfaces are reused pointed at `__system`. ✅

**Placeholder scan:** test bodies have `// ...` fixture markers (deliberate pointers). The navigate-vs-embed + where-the-signal-lives decisions are ground-truthed in Task 1, not guessed. Task 5 is conditionally-implementing (test-only if Phase B already redacts) — flagged.

**Type consistency:** `SYSTEM_WORKSPACE_SLUG` (Phase A), `isSystemMember(userId)` / `is_system_member` / `useIsSystemMember()`, the existing `/w/:wslug/agents` route reused for `__system` — consistent. No new agent/run/auth types.

**Biggest risk flagged:** D4 (the cross-workspace agent list leaking the prompt/skill body to a non-member) is the only real CONTENT-leak risk — verify the Phase-B union endpoint projects invokable fields only (redact if not). Everything else is visibility-hiding (D1/D2) over a server boundary that already holds (D3, Phase A M6) — the UI hide must never be mistaken for the control.

---

## Execution Handoff

Plan complete. **Phases A + B (+ C) must merge first.** Recommended: subagent-driven per task with two-stage review; controller verifies the named D-mitigation + ground-truths the switcher feeder / the membership-signal location / the Phase-B union endpoint / the settings-tab pattern live (Step 2.5 gate). After Task 6: `/code-review` (medium — D1–D4), `/integration`, merge — **this completes the cross-workspace operator (A→D)**; run the `/evaluate` close-out retro on the whole arc.
