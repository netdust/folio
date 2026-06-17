# AssigneePicker in Table + Type-to-Filter Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the existing `AssigneePicker` in the TABLE view's `assignee` column (today it shows as editable plain text), and add a type-to-filter search box to the picker that narrows Members + Agents as you type (benefiting both table and slideover).

**Architecture:** Two additive frontend-only changes in `apps/web`. (1) Add a search `<input>` at the top of `AssigneePicker`'s popover that filters `memberList` + `agentList` by a case-insensitive substring match (member name/email, agent title/slug); the picker's public props and value conventions (`email` / `agent:<slug>` / `''`) stay UNCHANGED, so the slideover keeps working untouched. (2) Wire the picker into the table by special-casing `key === 'assignee'` inside `table-cell.tsx` BEFORE it falls through to `<FieldRenderer>` — mirroring how the slideover special-cases assignee in `frontmatter-form.tsx`, and how `table-cell.tsx` already special-cases the builtins (`title`/`status`/`updated_at`). This requires threading `wslug`/`pslug` from `table-row.tsx` (which already has them) → `table-cell.tsx` (which does not yet).

**Tech Stack:** React 18 + Vite, TanStack Query, Tailwind + shadcn/Radix (`Popover`). Tests: vitest from `apps/web` via `npx vitest run`. Typecheck: `bun x tsc --noEmit` from `apps/web`. Lint: `bun run lint` from repo root.

## Global Constraints

- TypeScript only, `strict: true`. No `any` (use `unknown` + narrow). `noExplicitAny` is `warn` only — does not block the pre-commit hook; only error-severity (e.g. `organizeImports`) blocks. Auto-fix formatter errors with `bunx biome check --write`.
- Files `kebab-case.ts(x)`; components `PascalCase`; functions/vars `camelCase`. Imports via `@/`-style relative `.ts(x)` paths matching the existing files (these components use explicit relative `../...` paths — match them).
- No default exports except routers/route components. `AssigneePicker`, `TableCell` are named exports — keep them named.
- **The AssigneePicker public surface is FROZEN:** `Props = { wslug, pslug, value, onChange }`. The search box is internal state only — do NOT add a prop for it. Value emitted stays `email` (members) / `agent:<slug>` (agents) / `''` (clear). The slideover call site (`frontmatter-form.tsx:225-231`) must not need to change.
- Current web suite: 1100 tests green. Every task records the suite delta.
- Run the web suite from `apps/web` with `npx vitest run` (NOT `bun test`). Run `bun x tsc --noEmit` from `apps/web`.

---

## Ground-truth notes (verified against source 2026-06-17, before this plan shipped)

These premises were READ and CONFIRMED — the plan builds on reality, not memory:

- **Slideover already uses the picker:** `frontmatter-form.tsx` sets `isAssignee = key === 'assignee'` (line 176) and renders `<AssigneePicker wslug={wslug} pslug={pslug} value={...} onChange={...} />` (lines 225-231). Identify-by-`key` is the established pattern — the table will mirror it.
- **Table does NOT use the picker:** `table-cell.tsx` `renderContent()` special-cases builtins `title`/`status`/`updated_at` (lines 61-109), then for non-builtins routes EVERY field through `<FieldRenderer>` (lines 117-127). `field-renderer.tsx` (located at `apps/web/src/components/slideover/field-renderer.tsx`, imported by the table cell) routes `user_ref` → plain `InlineEdit` (lines 42-51). So `assignee` shows as editable text in the table. THIS is the bug.
- **`FieldRenderer` has no `wslug`/`pslug`** (`Props`, field-renderer.tsx:15-27) and is also used in read-only/relation contexts. Keeping workspace context OUT of `FieldRenderer` is correct → the assignee special-case belongs in `table-cell.tsx` (the table-row→cell layer that already owns workspace context), NOT inside `FieldRenderer`. **DECISION: special-case in `table-cell.tsx`.** Justified: it mirrors both (a) `frontmatter-form.tsx`'s own assignee branch sitting OUTSIDE `FieldRenderer`, and (b) `table-cell.tsx`'s existing builtin special-cases. `FieldRenderer` stays workspace-context-free.
- **`table-row.tsx` HAS `wslug`/`pslug`** (Props lines 14-15, destructured 26-27) and renders `<TableCell ...>` (lines 60-73) WITHOUT passing them today. They can be threaded row→cell.
- **Commit path:** `table-row.tsx` defines `onFieldCommit = (slug, key, next) => onUpdate(slug, { frontmatter: { [key]: next } })` (lines 35-36) and passes it to `TableCell`. `table-cell.tsx` calls `onFieldCommit(doc.slug, column.key, next)` (line 123). The assignee branch will call the SAME `onFieldCommit(doc.slug, column.key, next)` so the optimistic write + event path is identical to every other field.
- **Assignee value column key** is `column.key` (the field key); the value lives at `doc.frontmatter?.[column.key]` (table-cell.tsx:112). For the assignee column `column.key === 'assignee'`.
- **`column.source`:** builtins have `column.source === 'builtin'`; `assignee` is a frontmatter field, so it has `column.source !== 'builtin'` and `column.fieldType` set (it's `user_ref` per inference). The special-case must run in the NON-builtin branch (after line 110), gated on `column.key === 'assignee'`, BEFORE the `FieldRenderer` fallthrough.
- **The picker trigger is `h-7 border bg-content`** (assignee-picker.tsx:41) — heavier than the new borderless field-shell look. Per scope, do NOT restyle it. See Deferred follow-up.
- **No HTML rendering of the value:** the label is rendered as `{label}` text inside a `<button>` (assignee-picker.tsx:43); members/agents come from existing authed queries (`useMembers`/`useProjects`/`useWorkspaceAgents`). No `dangerouslySetInnerHTML` anywhere in `apps/web/src`. → no new untrusted-parse / XSS surface.
- **Existing picker tests** (`assignee-picker.test.tsx`, 5 tests) stub fetch for `/members`, `/projects`, `/documents?type=agent`, open via the trigger `name: /unassigned/i`, and assert sections + onChange contracts. These MUST stay green; the search box is additive and must not break the trigger label or the existing button queries.

---

## Gate evaluation (which fired, which did not, with one-line reasons)

- **1a Threat-modeling — DOES NOT FIRE.** Ran the trigger list literally: no user-controlled URLs, no auth/session/token surface, no new untrusted parsing, no BYOK credentials, no tenancy boundary, no server outbound-to-user-URL. The assignee value is user-supplied frontmatter but is rendered as a text label (`{label}`, no HTML — confirmed no `dangerouslySetInnerHTML` in `apps/web/src`) and committed back through the existing `onUpdate` frontmatter path that all fields already use. Members/agents come from existing authed react-query hooks; no new fetch, no new endpoint, no new parse of attacker input. This is a property-checked decision, not a gut call — the literal trigger list is empty for this diff.
- **1b Architecture-invariants — TOUCHED-BUT-RESPECTED (no bypass), no new convergence point.** Relevant: **#6 (web data access: HTTP via the one `client`, react-query keys via `*Keys` factories)** — the picker already consumes `useMembers`/`useProjects`/`useWorkspaceAgents`, which route through the factory hooks; the search filter is pure client-side over already-fetched data (no new fetch), so #6 is respected. **#18 (table/view resolution + renderer)** — the change lives strictly INSIDE a cell rendered downstream of `<ViewRouter>`/`TableView`; it neither adds a renderer nor re-derives the current table, so #18 is untouched. No invariant requires a citation-as-bypass; none is bypassed. No new invariant to author.
- **1c Spec-premise ground-truth — DONE (above).** Core premise "reuse existing AssigneePicker for the table" was verified by reading the picker's public props + the table-cell/field-renderer/table-row chain. Confirmed: the picker accepts exactly the props the table can supply (`wslug`/`pslug`/`value`/`onChange`), and `table-row.tsx` already has `wslug`/`pslug`. Premise holds.
- **1g Feature-acceptance — FIRES.** User-facing interactive flow (a picker + a search box in two surfaces). `## Acceptance flows` matrix embedded below.
- **1f/1h Review sizing + tier — DONE.** 4 tasks, one review cluster (≤4), one `── REVIEW GATE ──`. Tier: **STANDARD** — multi-file UI behavior change, NO 1a trigger surface, no named invariant bypassed, no data layer / migrations. See the gate marker below.

---

## Threat model

**Not applicable — the 1a threat-modeling gate did not fire** (see Gate evaluation above: no trigger-surface touched; value rendered as text, committed through the existing frontmatter path, data from existing authed hooks). No `## Threat model` section is required for this work, and `/security-review` is therefore NOT obligated at the review gate (no plan-time threat model exists). Recorded explicitly so a reviewer sees the gate was evaluated and consciously not fired, not forgotten.

---

## Acceptance flows

Each row = one intended-use flow. **Edges** enumerate the six classes (empty/zero state · denied actor · wrong-order/re-entry · concurrent/double · boundary value · mid-flow failure) — or name why a class is excluded. **Layer** tags how it gets verified at shake-out: BROWSER = the user drives it in their logged-in browser via hot-reload (the executing agent is NOT logged in); UNIT = a vitest assertion stands in for the behavior.

| # | Flow (intended use) | Layer | Edges (6 classes) |
|---|---|---|---|
| 1 | **Assign a MEMBER from the TABLE** — click the `assignee` cell trigger, popover opens, click a member → cell shows the member's resolved NAME (not the raw email), value persists. | BROWSER (user) + UNIT (cell renders picker, calls `onFieldCommit('<slug>','assignee','alice@test')`) | empty: no members → "No members" row (existing picker behavior). denied: read-only viewer — out of scope, table inline-edit already gates writes server-side (no new actor surface). wrong-order/re-entry: reopen the popover after assigning → shows current value's clear action + sections. concurrent/double: double-click the trigger → single popover (Radix handles); rapid pick A then B → last write wins (existing optimistic path). boundary: member whose name === email; member list of 1. mid-flow: commit fails → optimistic rollback + toast (existing `onUpdate` path, unchanged). |
| 2 | **Assign an AGENT from the TABLE** — open the cell picker, click an agent → cell shows the agent TITLE (not `agent:<slug>`), value persists as `agent:<slug>`. | BROWSER (user) + UNIT (clicking an agent calls `onFieldCommit(..., 'agent:triage-bot')`) | empty: project has no allow-listed agents → "No agents yet" row (existing). denied: n/a — same write surface as flow 1. wrong-order: assign agent, reopen → label resolves to title via `agentList`. concurrent/double: switch member→agent rapidly → last write wins. boundary: agent whose title === slug; project with exactly one agent. mid-flow: agents query still loading when popover opens → sections render with empty lists then fill (existing async behavior, must not crash). |
| 3 | **Clear the assignee from the TABLE** — open a cell that has an assignee, click "Clear assignee" → cell shows "Unassigned", value committed as `''`. | BROWSER (user) + UNIT (clear calls `onFieldCommit(..., '')`) | empty: value already `''` → "Clear assignee" action is HIDDEN (existing `value ? ... : null` guard). denied: n/a. wrong-order: clear then immediately reassign in the same open popover → both commits fire in order. concurrent/double: double-click clear → one `''` commit. boundary: clearing the only assigned row. mid-flow: clear commit fails → rollback + toast. |
| 4 | **Type-to-filter narrows the list (TABLE and SLIDEOVER)** — type in the search box at the top of the popover → Members + Agents sections shrink to case-insensitive substring matches on member name/email and agent title/slug. | BROWSER (user, both surfaces) + UNIT (filter logic, the Tier-A test) | empty query: shows ALL members + agents (no filtering). zero-result: query matching nothing → both sections show their empty-state rows ("No members"/"No agents yet") so the user sees "nothing matched", not a blank popover. denied: n/a (client-side filter, no actor). wrong-order/re-entry: close popover mid-type, reopen → search box resets to empty (fresh filter). concurrent/double: fast typing → filter recomputes per keystroke (pure derived state, no race). boundary: 1-char query; query with only-whitespace → treated as match-all (trim); query matching email-domain only (`@test`). mid-flow: members loaded but agents still fetching → filter applies to whatever is loaded; no crash. |
| 5 | **SLIDEOVER picker still works after the search addition** — open a work item slideover, the `assignee` field picker opens, assign/clear/filter all behave; existing slideover assignee behavior is unbroken. | BROWSER (user) + UNIT (existing `assignee-picker.test.tsx` 5 tests stay green) | empty: unassigned item → "Unassigned" trigger label. denied: n/a. wrong-order: covered by the 5 existing tests (open, pick, reopen). concurrent/double: n/a beyond flow 1. boundary: the existing tests cover member-email + agent-slug labels. mid-flow: n/a — additive search box must not change any of the 5 existing assertions; their queries (`name: /unassigned/i`, `name: /Alice alice@test/i`) must still resolve. |

**Verification ownership at shake-out (Stage 3):** Flows 1-5's BROWSER rows are driven by Stefan in his logged-in browser via hot-reload (he confirmed he verifies in-browser; the executing agent is not authenticated and cannot drive the real authed table). The executing agent emits `unverified-no-browser` for the BROWSER portion and `pass`/`fail` for every UNIT portion. The Tier-A filter test (Task 1) is the one UNIT row that fully stands in for flow 4's logic.

---

## Sibling-site audit

`key === 'assignee'` is a cross-cutting identifier (the "this field is the assignee picker" predicate). Enumerate every site that decides "render assignee as a picker":

- `frontmatter-form.tsx:176` — `isAssignee = key === 'assignee'` (slideover). EXISTING. Unchanged by this plan; the search box lives inside the shared `AssigneePicker`, so it inherits the change for free. Verify it still renders (flow 5).
- `table-cell.tsx` (NEW, this plan) — the table's assignee special-case. ADDED in Task 4.
- Any OTHER renderer of frontmatter fields? Grep `<FieldRenderer` and `inferFieldType`/`user_ref` consumers before closing the cluster. Kanban/calendar/timeline/list views render cards, not editable field grids — confirm none of them render an editable `assignee` field that would also want the picker. If one does, it is a sibling site (flag at review; out of THIS plan's scope unless it's a one-line mirror). Record the grep result in the review-gate notes.

---

## File structure

- `apps/web/src/components/assignee/assignee-picker.tsx` — MODIFY. Add internal `query` state + a search `<input>` at the top of the popover; derive `filteredMembers`/`filteredAgents`. Public props unchanged.
- `apps/web/src/lib/assignee-filter.ts` — CREATE. Pure functions `filterMembers(members, query)` + `filterAgents(agents, query)` (or one generic `matchesAssigneeQuery`) — extracted so the filter logic is unit-testable in isolation (Tier A) without mounting the popover. Keeps the component thin.
- `apps/web/src/lib/assignee-filter.test.ts` — CREATE. Tier-A RED-first tests for the filter.
- `apps/web/src/components/table/table-cell.tsx` — MODIFY. Add `wslug`/`pslug` to `Props`; add the `key === 'assignee'` special-case in the non-builtin branch before the `FieldRenderer` fallthrough.
- `apps/web/src/components/table/table-row.tsx` — MODIFY. Pass `wslug={wslug}` `pslug={pslug}` to `<TableCell>`.
- `apps/web/src/components/table/table-cell.test.tsx` (or existing table-cell/table-row test file) — MODIFY/CREATE. Tier-B seam: assert the assignee cell renders the picker trigger (not a plain `InlineEdit`) and that picking commits via `onFieldCommit`.

---

### Task 1: Extract + test the assignee filter logic (Tier A)

**Files:**
- Create: `apps/web/src/lib/assignee-filter.ts`
- Test: `apps/web/src/lib/assignee-filter.test.ts`

**Interfaces:**
- Consumes: the shapes already returned by `useMembers` (member has `{ id, email, name, role }`) and `useWorkspaceAgents` (agent doc has `{ id, slug, title, ... }`). Use minimal structural input types so the helper does not import the full API types if that creates a cycle — accept `{ name: string; email: string }[]` for members and `{ title: string; slug: string }[]` for agents (or `Pick<...>` of the real types).
- Produces: `filterMembers<M extends { name: string; email: string }>(members: M[], query: string): M[]` and `filterAgents<A extends { title: string; slug: string }>(agents: A[], query: string): A[]`. Empty/whitespace-only query returns the input unchanged (match-all). Match is case-insensitive substring.

**Test contract (RED-first):** the filter narrows by name/email (members) and title/slug (agents), is case-insensitive, treats empty/whitespace query as match-all, and returns `[]` on a no-match query.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { filterAgents, filterMembers } from './assignee-filter.ts';

const members = [
  { name: 'Alice', email: 'alice@test' },
  { name: 'Bob', email: 'bob@example.com' },
];
const agents = [
  { title: 'Triage Bot', slug: 'triage-bot' },
  { title: 'Summarizer', slug: 'summarize' },
];

describe('assignee-filter', () => {
  it('empty query returns all members and all agents (match-all)', () => {
    expect(filterMembers(members, '')).toHaveLength(2);
    expect(filterAgents(agents, '')).toHaveLength(2);
  });

  it('whitespace-only query is treated as match-all', () => {
    expect(filterMembers(members, '   ')).toHaveLength(2);
  });

  it('matches member by name, case-insensitive', () => {
    expect(filterMembers(members, 'ali')).toEqual([members[0]]);
    expect(filterMembers(members, 'ALICE')).toEqual([members[0]]);
  });

  it('matches member by email substring (domain)', () => {
    expect(filterMembers(members, '@example')).toEqual([members[1]]);
  });

  it('matches agent by title and by slug, case-insensitive', () => {
    expect(filterAgents(agents, 'triage')).toEqual([agents[0]]);
    expect(filterAgents(agents, 'SUMMAR')).toEqual([agents[1]]);
    expect(filterAgents(agents, 'summarize')).toEqual([agents[1]]); // slug match
  });

  it('no-match query returns empty array', () => {
    expect(filterMembers(members, 'zzz')).toEqual([]);
    expect(filterAgents(agents, 'zzz')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/assignee-filter.test.ts`
Expected: FAIL — `Failed to resolve import "./assignee-filter.ts"` / functions not defined.

- [ ] **Step 3: Write the minimal implementation**

```ts
function normalize(q: string): string {
  return q.trim().toLowerCase();
}

export function filterMembers<M extends { name: string; email: string }>(
  members: M[],
  query: string,
): M[] {
  const q = normalize(query);
  if (!q) return members;
  return members.filter(
    (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
  );
}

export function filterAgents<A extends { title: string; slug: string }>(
  agents: A[],
  query: string,
): A[] {
  const q = normalize(query);
  if (!q) return agents;
  return agents.filter(
    (a) => a.title.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/assignee-filter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio && git add apps/web/src/lib/assignee-filter.ts apps/web/src/lib/assignee-filter.test.ts
git commit -m "phase-6: extract testable assignee filter (name/email/title/slug, case-insensitive)"
```

**Test tier:** A — pure filter logic over user-typed input; one bit worth a real test. RED-first contract above.

---

### Task 2: Add the search box to AssigneePicker (Tier B)

**Files:**
- Modify: `apps/web/src/components/assignee/assignee-picker.tsx`

**Interfaces:**
- Consumes: `filterMembers`, `filterAgents` from `../../lib/assignee-filter.ts` (Task 1).
- Produces: NO public-surface change. Internal: a `query` state + a controlled `<input>` rendered at the TOP of `<PopoverContent>` (above the "Clear assignee" action), `memberList`/`agentList` replaced by `filteredMembers`/`filteredAgents` in the two `.map()` blocks. The empty-state rows ("No members"/"No agents yet") now also show when the FILTERED list is empty (so a no-match query reads as "nothing matched", flow 4 zero-result edge).

**Implementation notes:**
- Add `useState` import: `import { useMemo, useState } from 'react';`.
- `const [query, setQuery] = useState('');` Reset to `''` is handled by Radix unmounting `PopoverContent` on close — but to be safe re-entry-wise (flow 4 wrong-order edge), reset on `onOpenChange` close if `Popover` is made controlled; the SIMPLEST behavior-correct path is to keep `Popover` uncontrolled (as today) since Radix unmounts the content on close, dropping the input's state. Verify in-browser that reopening shows an empty box (flow 4 re-entry edge). If it does NOT reset, make the `Popover` controlled with an `open` state and clear `query` on close (mirror `frontmatter-form.tsx`'s `AddField` pattern, lines 407-416).
- `const filteredMembers = filterMembers(memberList, query);` and `const filteredAgents = filterAgents(agentList, query);` — replace `memberList`/`agentList` in the two render `.map()`s and in the `.length === 0` empty-state checks with the filtered lists.
- The input: borderless-friendly but it lives inside the popover, so use the same input styling as `frontmatter-form.tsx`'s AddField input (line 437) for consistency: `className="mb-1 block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm input-focus"`, `placeholder="Search…"`, `aria-label="Filter assignees"`. Do NOT autofocus via the `autoFocus` attribute (biome a11y warn) — Radix focuses the popover; if Stefan wants auto-focus-on-open as a follow-up, use the ref/effect pattern.
- Keep the "Clear assignee" action, the Members/Agents section headers, and the value conventions EXACTLY as-is.

- [ ] **Step 1: Add the search input + wire the filter**

Edit `assignee-picker.tsx`:
1. Change the React import to include `useState`.
2. Import the filter helpers.
3. Add `const [query, setQuery] = useState('');`.
4. Compute `const filteredMembers = filterMembers(memberList, query);` / `const filteredAgents = filterAgents(agentList, query);`.
5. Render the `<input>` as the FIRST child of `<PopoverContent>` (before the clear action):

```tsx
<input
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  placeholder="Search…"
  aria-label="Filter assignees"
  className="mb-1 block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm input-focus"
/>
```

6. Replace `memberList` → `filteredMembers` and `agentList` → `filteredAgents` in the two section `.map()` blocks AND their `.length === 0 ? (empty-state) : (...)` checks. (Leave the `label` `useMemo` reading the UNFILTERED `memberList`/`agentList` — the trigger label must resolve regardless of the filter.)

- [ ] **Step 2: Run the existing picker tests (must stay green)**

Run: `cd apps/web && npx vitest run src/components/assignee/assignee-picker.test.tsx`
Expected: PASS (the existing 5 tests). The search box is additive; the trigger label query (`/unassigned/i`) and the member/agent button queries (`/Alice alice@test/i`, `/Triage Bot/i`) must still resolve because an empty query shows all.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
cd apps/web && bun x tsc --noEmit
cd /home/ntdst/Projects/folio && bun run lint   # expect exit 0 (warnings ok)
git add apps/web/src/components/assignee/assignee-picker.tsx
git commit -m "phase-6: add type-to-filter search box to AssigneePicker (additive; props unchanged)"
```

**Test tier:** B — `no unit test: Tier B, presentational wiring of the Task-1 filter into the popover; the filter logic is covered by Task 1's Tier-A suite and the existing 5 picker tests are the seam (they prove the additive input did not break open/pick/clear/label).` Optionally ADD one assertion to `assignee-picker.test.tsx` that typing in the search box narrows the visible member buttons (a cheap seam over the real component) — recommended but the existing 5 staying green is the gate.

---

### Task 3: Thread wslug/pslug from table-row into table-cell (Tier B)

**Files:**
- Modify: `apps/web/src/components/table/table-cell.tsx` (add `wslug`/`pslug` to `Props` + destructure)
- Modify: `apps/web/src/components/table/table-row.tsx` (pass them to `<TableCell>`)

**Interfaces:**
- Consumes: `wslug`/`pslug` already on `TableRow` Props (table-row.tsx:14-15, 26-27).
- Produces: `TableCell` Props gains `wslug: string; pslug: string;`. (Make them required — `TableRow` always has them; a required prop catches a missed call site at compile time.)

This task ONLY threads the props; it does not yet use them (Task 4 does). Splitting keeps each task independently typecheck-clean and reviewable.

- [ ] **Step 1: Add props to TableCell**

In `table-cell.tsx` `interface Props`, add after `column`/`doc`:
```ts
  wslug: string;
  pslug: string;
```
Add `wslug,` and `pslug,` to the destructured params in `export function TableCell({ ... })`. Do not use them yet.

- [ ] **Step 2: Pass them from TableRow**

In `table-row.tsx`, in the `<TableCell ... />` call (lines 61-73), add:
```tsx
              wslug={wslug}
              pslug={pslug}
```

- [ ] **Step 3: Typecheck (proves the seam)**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean. (If any OTHER caller of `<TableCell>` exists, the now-required props will surface it as a compile error — grep `<TableCell` to confirm `table-row.tsx` is the only call site; if not, thread there too. This IS the seam check for this task.)

- [ ] **Step 4: Run the table suite (no behavior change expected)**

Run: `cd apps/web && npx vitest run src/components/table`
Expected: PASS, no delta.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio && git add apps/web/src/components/table/table-cell.tsx apps/web/src/components/table/table-row.tsx
git commit -m "phase-6: thread wslug/pslug table-row → table-cell (prep for assignee picker)"
```

**Test tier:** B — `no unit test: Tier B, prop threading; the seam is the tsc pass — a required prop makes a missed call site a compile error, and the grep for <TableCell call sites is the sibling-site check.`

---

### Task 4: Render AssigneePicker in the assignee table cell (Tier B seam)

**Files:**
- Modify: `apps/web/src/components/table/table-cell.tsx`
- Modify/Create test: `apps/web/src/components/table/table-cell.test.tsx`

**Interfaces:**
- Consumes: `AssigneePicker` from `../assignee/assignee-picker.tsx`; `wslug`/`pslug` (Task 3); `onFieldCommit`, `doc`, `column` (existing).
- Produces: in the NON-builtin branch of `renderContent()`, BEFORE the `FieldRenderer` fallthrough, when `column.key === 'assignee'`, render `<AssigneePicker>` instead of `FieldRenderer`.

**Implementation notes:**
- Add `import { AssigneePicker } from '../assignee/assignee-picker.tsx';`.
- Place the special-case AFTER `if (!column.fieldType) return null;` (line 111) and BEFORE the `urgencyClass`/`FieldRenderer` block (line 116+):
```tsx
    if (column.key === 'assignee') {
      const v = doc.frontmatter?.[column.key];
      return (
        <AssigneePicker
          wslug={wslug}
          pslug={pslug}
          value={typeof v === 'string' ? v : ''}
          onChange={(next) => onFieldCommit(doc.slug, column.key, next)}
        />
      );
    }
```
- This mirrors `frontmatter-form.tsx:225-231` exactly (same value-narrowing, same `onChange` shape) and uses the SAME `onFieldCommit(doc.slug, column.key, next)` path the FieldRenderer branch uses — so the optimistic write + event emission are identical to every other field.
- The picker trigger keeps its current `h-7 border bg-content` styling (NOT restyled per scope). See Deferred follow-up.

- [ ] **Step 1: Write the failing seam test**

Create/extend `table-cell.test.tsx`. The cell needs a `QueryClientProvider` (the picker mounts `useMembers`/`useProjects`/`useWorkspaceAgents`) and stubbed fetch (reuse the pattern from `assignee-picker.test.tsx`). Assert (a) the assignee cell renders the picker trigger button (e.g. `name: /unassigned/i`) and NOT a plain text InlineEdit for the assignee value, and (b) picking a member calls the cell's `onFieldCommit` with `(doc.slug, 'assignee', 'alice@test')`.

```tsx
// sketch — fill in the wrap()/stubFetch() helpers from assignee-picker.test.tsx
it('assignee column renders the picker and commits via onFieldCommit', async () => {
  const onFieldCommit = vi.fn();
  const column = { key: 'assignee', source: 'field', fieldType: 'user_ref' /* ...as Column */ };
  const doc = { slug: 'task-1', title: 'T', status: null, frontmatter: { assignee: '' } /* ...as DocumentSummary */ };
  render(
    <TableCell
      column={column}
      doc={doc}
      statuses={[]}
      isPending={false}
      wslug="acme"
      pslug="web"
      onOpen={() => {}}
      onTitleCommit={() => {}}
      onStatusCommit={() => {}}
      onFieldCommit={onFieldCommit}
    />,
    { wrapper: wrap(qc) },
  );
  await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
  await userEvent.click(await screen.findByRole('button', { name: /Alice alice@test/i }));
  expect(onFieldCommit).toHaveBeenCalledWith('task-1', 'assignee', 'alice@test');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/table/table-cell.test.tsx`
Expected: FAIL — no "unassigned" trigger; the assignee value renders through `FieldRenderer` → `InlineEdit` (a textbox), so the button query finds nothing.

- [ ] **Step 3: Add the special-case**

Add the `import` + the `if (column.key === 'assignee') { ... }` block described above.

- [ ] **Step 4: Run to verify it passes + run the full table suite**

Run: `cd apps/web && npx vitest run src/components/table`
Expected: PASS (new test green, no regressions).

- [ ] **Step 5: Full web suite + typecheck + lint + commit**

```bash
cd apps/web && npx vitest run && bun x tsc --noEmit
cd /home/ntdst/Projects/folio && bun run lint   # exit 0 (warnings ok)
git add apps/web/src/components/table/table-cell.tsx apps/web/src/components/table/table-cell.test.tsx
git commit -m "phase-6: render AssigneePicker in the table assignee cell (key==='assignee', mirrors slideover)"
```

**Test tier:** B (seam) — `the un-mocked chain assertion: the assignee cell mounts the real AssigneePicker and a member-pick reaches the cell's onFieldCommit with the email — proving the wiring, not the filter (Task 1) or the picker internals (existing 5 tests). Negative case: the cell no longer renders a plain InlineEdit textbox for assignee.`

---

## ── REVIEW GATE ── (tier: STANDARD — multi-file UI behavior change; NO 1a surface, no named-invariant bypass, no data layer/migrations; invariant #6 touched-but-respected, #18 untouched)

HALT here after Task 4. This is the single review cluster (4 tasks ≤ 4).

**Dispatch (STANDARD tier per 1h):** 2 finder angles (line-by-line + cross-file tracer) + `code-simplicity-reviewer` + the feature-acceptance browser pass. NO `security-sentinel`, NO `performance-oracle` (no 1a surface, no `CODE-MAP.md` hot path). `/code-review --effort=medium`. **No `/security-review`** — no plan-time `## Threat model` exists (1a did not fire).

**One-way escalation (1h):** if ANY finder surfaces a finding on a 1a surface (it should not — but e.g. if the assignee value turns out to be rendered as HTML somewhere, or a new fetch/parse of attacker input slipped in), promote the cluster to FULL and dispatch `security-sentinel` on this same diff before proceeding.

**Cluster-specific review checklist:**
- The AssigneePicker public props + value conventions (`email`/`agent:<slug>`/`''`) are UNCHANGED — diff the `interface Props` and the three `onChange(...)` call sites.
- The 5 existing `assignee-picker.test.tsx` tests pass unchanged (no assertion edits).
- The table assignee branch uses the SAME `onFieldCommit(doc.slug, column.key, next)` as the FieldRenderer path — confirm the optimistic write + event emission are not bypassed (invariant #6 respected: no bare fetch, factory hooks only).
- `FieldRenderer` did NOT gain `wslug`/`pslug` (workspace context stayed in the table-cell layer).
- Sibling-site audit closed: grep confirms `frontmatter-form.tsx` + `table-cell.tsx` are the only "render assignee as picker" sites; no kanban/calendar/timeline/list editable-assignee site was missed (or one was found and flagged).
- Search box reopen behavior verified (flow 4 re-entry edge) — empty box on reopen.

---

## Stage 3 — shake-out (after the gate clears)

1. `/integration` (or web phase-complete) — full web suite green from `apps/web`.
2. **test-effectiveness** over the diff: the dangerous path is the filter (Task 1, covered RED-first) + the cell-wiring seam (Task 4, covered). Confirm no green-but-blind: the seam test asserts the real picker mounts (not a mock), and the negative case (no plain InlineEdit) goes RED if the special-case is removed.
3. **feature-acceptance (Situation B)** — drive the `## Acceptance flows` matrix. UNIT rows verified by the agent; BROWSER rows handed to Stefan (hot-reload, logged in) — emit `unverified-no-browser` for those, with the exact flows he must click (assign member from table → see name; assign agent → see title; clear → Unassigned; type-to-filter narrows both sections + zero-result shows empty-state rows; slideover picker still assigns/clears/filters).
4. `/shakeout` — STANDARD spec-close panel (`reviewer` + `invariant-auditor`).
5. `superpowers:finishing-a-development-branch`.

---

## Deferred follow-ups (out of scope — flagged, not done)

- **Picker trigger visual consistency.** The AssigneePicker trigger is `h-7 border border-border-light bg-content` — heavier than the borderless field-shell look the table's other cells now use. The user asked for FUNCTION (picker in the table + search), not a visual redesign, so the trigger is left as-is. Follow-up: adopt the lighter borderless `EditableShell`-style trigger in the table context (likely a `variant`/`compact` prop on the picker) once the function ships and Stefan eyeballs it.
- **Auto-focus the search input on popover open.** Not done (avoids the `autoFocus` a11y warn). If wanted, use the ref/effect focus pattern (as in `field-renderer.tsx`'s `NumberInput`).
- **Search box keyboard nav** (arrow-down into the filtered list, Enter to pick the first match). Not in scope; current behavior is type-to-filter + click.
