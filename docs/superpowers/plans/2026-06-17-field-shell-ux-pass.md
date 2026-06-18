# Field Shell UX-Quality Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After EACH task the user eyeballs the change via hot-reload (user is logged in; the executing agent is NOT — see Acceptance flows for which flows are browser-verify vs unit-coverable).

**Goal:** Extract one shared "editable cell shell" that every inline field sub-component consumes, so all fields look and behave identically, with zero layout shift between display and edit state and refined Linear/Raycast-grade motion — fixing the four reported inconsistency bugs at the root, not one-by-one.

**Architecture:** A new `EditableShell` primitive (`apps/web/src/components/inline/editable-shell.tsx`) becomes the single styling convergence point for inline field appearance: it owns the font-size token, padding, radius, hover background, focus ring, and the display↔edit box-equivalence guarantee. Each existing field sub-component (`InlineEdit`, `InlineSelect`, `DateInput`, `NumberInput`, `CurrencyInput`, `UrlField`, plus the chip surfaces) is migrated to render its display affordance and its edit control through the shell, replacing its hand-rolled independent classes. No backend, no API, no schema — pure `apps/web`. Behavior (commit/escape/blur/optimistic semantics) is preserved verbatim; only the presentational wrapper changes.

**Tech Stack:** React 18, TypeScript (strict), Tailwind + `tailwindcss-animate`, Radix Popover, Vitest (run from `apps/web` via `npx vitest run`), `bun x tsc --noEmit`, Biome (`bun run lint` from repo root).

## Global Constraints

- **No backend / API / schema / migration changes.** Every change is under `apps/web/src/`. (Verbatim from task brief.)
- **ZERO layout shift between display and edit state.** Display box and edit box MUST occupy identical width/height and identical font metrics (size + line-height). This is the core acceptance criterion; the "font gets bigger when editing" complaint IS this bug. (Verbatim from task brief.)
- **Behavior-preserving.** Every existing commit / Escape / blur / Enter / optimistic-`isPending` semantic stays. The full vitest suite (currently 1096 green) MUST stay green; existing `inline-edit.test.tsx` / `inline-select.test.tsx` / `field-renderer.test.tsx` tests MUST NOT be gutted — they assert behavior contracts and remain the regression net.
- **Keep the existing dark aesthetic.** Fix in place. Do NOT invent a new look. Tokens already exist in `apps/web/src/styles/tokens.css` (`--color-card`, `--color-shell`, `--radius-sm`, `--ring`) and `globals.css` (`.input-focus`, `*:focus-visible { box-shadow: var(--ring) }`). Reuse them.
- **Motion: refined & subtle (locked).** 120–180ms ease-out; dropdowns scale+fade from origin; animated focus rings; smooth hover-bg transitions; ZERO layout shift entering edit. CSS / `tailwindcss-animate` / Radix `data-state` only — NO heavyweight motion library. Respect the existing `prefers-reduced-motion` block in `tokens.css` (lines 96–104) — it already strips animations to opacity-only; new motion must not fight it.
- **Consistency: extract shared field primitives (locked).** ONE shell consumed by all field types. Fix the class of bug at the root.
- **Naming/conventions (from CLAUDE.md):** files `kebab-case.ts(x)`; components `PascalCase`; no default exports except routers/route components; absolute `@/` imports inside the app; no `any` (use `unknown` + narrow); `strict: true`.

---

## Scope & Deferrals

**In scope (this plan):** the 4 reported bugs + the shared-shell extraction + refined motion, across `InlineEdit`, `InlineSelect`, and the `field-renderer.tsx` sub-components (`DateInput`, `NumberInput`, `CurrencyInput`, `UrlField`, `TextArea`, the chip surfaces `MultiSelect`/`RelationField`), plus `popover.tsx` (scale-from-origin motion) and `columns.ts` (date width).

**Explicitly DEFERRED — out of scope for THIS plan (do NOT touch):**
- Assignee-as-select (rendering `user_ref` as a picker instead of plain text). Separate later task.
- Table full-width / grid-template-columns redesign (the trailing `1fr` / fixed-px-width model in `columns.ts` beyond the single date-width fix). Separate later task.
- Calendar view, kanban drag-and-drop. Separate later tasks.
- The "can't edit any field" blocking bug — ALREADY FIXED and committed (`b1069bbf`). Do not re-address.

---

## Gate decisions (recorded by the planner)

| Gate | Fires? | One-line reason |
|------|--------|-----------------|
| **1a Threat-modeling** | **NO** | Ran the trigger list literally: no user-controlled URLs (the existing `isSafeImageUrl` scheme guard is preserved VERBATIM, not a new/modified surface), no auth/session/token, no untrusted parsing (the shell renders already-fetched, already-trusted frontmatter values — it parses no new external input), no BYOK, no tenancy, no outbound requests. Pure presentational refactor. |
| **1b Architecture-invariants** | **NO** | Touches no convergence point in `ARCHITECTURE-INVARIANTS.md`: not authorization (`lib/access.ts`), not data access, not live updates/SSE, not error handling (`HTTPError`/serializer), not entity modeling. The shell is a leaf presentational component BELOW the `onCommit` callbacks, which are untouched. `ARCHITECTURE-INVARIANTS.md` already exists; no edit needed. |
| **designing-apis** | **YES (light)** | The shell is a new exported module surface / type contract consumed by 8+ sub-components → contract-first: the shell's props are Task 1, before any migration. The shell is the single **UI styling convergence point** for field appearance (a presentational convergence, NOT an architecture invariant). |
| **1g Feature-acceptance** | **YES** | Changes user-facing inline-edit behavior across every field type → `## Acceptance flows` matrix below, with browser-verify vs unit-coverable tagged per the hot-reload workflow. |
| **Stage 0 brainstorm** | **SKIPPED** | Design concretely specified (two locked decisions, four enumerated bugs, fix-in-place). No open design questions. |

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `apps/web/src/components/inline/editable-shell.tsx` | **NEW.** The single styling convergence point. Owns font token, padding, radius, hover-bg transition, focus ring, and the display↔edit box-equivalence guarantee. Exposes a small typed contract (see Task 1). | Create |
| `apps/web/src/components/inline/editable-shell.test.tsx` | **NEW.** Tier-A test of the one thing the shell carries logic for: display and edit modes resolve to the SAME box/font class set (box-equivalence), and the size token maps to identical classes across both modes. | Create |
| `apps/web/src/components/inline/inline-edit.tsx` | Click-to-edit text. Migrate display `<span>` + edit `<input>` to render through the shell. Preserve all commit/escape/blur/defaultEditing logic verbatim. | Modify |
| `apps/web/src/components/inline/inline-select.tsx` | Dropdown. Migrate trigger to the shell; unify trigger font (`text-xs`) and option-row font so they MATCH (Bug 3). | Modify |
| `apps/web/src/components/slideover/field-renderer.tsx` | Migrate `DateInput`, `NumberInput`, `CurrencyInput`, `UrlField`, `TextArea`, and the chip surfaces to the shell. Fix `DateInput` edit width (Bug 4). | Modify |
| `apps/web/src/components/ui/popover.tsx` | Add scale-from-origin + fade motion via `tailwindcss-animate` `data-state` utilities (currently fade-only). | Modify |
| `apps/web/src/components/table/columns.ts` | Widen the `date` column so the date edit input fits without clipping (Bug 4, the column-side half). | Modify |
| `apps/web/src/styles/globals.css` *(optional, only if a token can't be expressed in Tailwind)* | Add a `.field-shell` motion/transition helper IF the hover-bg + focus-ring transition can't be done with Tailwind `transition-*` utilities alone. Prefer Tailwind utilities; touch CSS only if forced. | Modify (conditional) |

---

## The shared-shell contract (designing-apis — contract-first, Task 1 designs this)

The shell is the consumer-facing surface 8+ sub-components depend on. Per Hyrum's Law, expose the **minimum**; anything it renders becomes a de-facto contract. Design intent (the implementer locks the exact prop names in Task 1, but this is the shape):

- **Two modes, expressed as a discriminated prop, not a bag of booleans.** A field is EITHER displaying OR editing. Model it as `mode: 'display' | 'edit'` (the consumer already owns its own `editing` state; the shell just reflects it). The shell renders `children` (the consumer's display affordance OR its edit control) inside a box whose classes are IDENTICAL across both modes except for the focus-ring/active treatment.
- **A single `size` token** (e.g. `size?: 'sm'` for now; default `'sm'`) → maps to ONE Tailwind class set for font-size + line-height + padding, applied identically in both modes. This is what kills "font gets bigger when editing": display and edit read the SAME token. The title cell that currently inherits a larger cell font must pass the same token so display == edit.
- **`isPending?: boolean`** → the existing `opacity-60` treatment, centralized.
- **`className?: string`** passthrough for per-call layout (e.g. the title cell's `w-full truncate`), merged via `cn`. The shell owns appearance; the caller owns layout placement only.
- **`align?: 'left' | 'right'`** so currency (right-aligned, mono) keeps its alignment without re-styling the box.
- **Box-equivalence guarantee (the load-bearing invariant):** the wrapper element's width/height/padding/font are determined ENTIRELY by `size` + `align` + `className`, NEVER by `mode`. `mode` may only toggle the focus ring / hover affordance / `data-state` for motion. This is what Task 1's test asserts and every migration must honour.

**Convergence-point note (UI):** after this plan, ANY future field appearance change is made in `editable-shell.tsx` only. A new field sub-component that hand-rolls its own padding/font instead of consuming the shell is the bypass to flag in review — the UI sibling of an architecture-invariant bypass.

---

## Acceptance flows (feature-acceptance gate 1g)

One row per intended-use flow. Edge column is mandatory (six classes: empty/zero, denied actor, wrong-order/re-entry, concurrent/double, boundary value, mid-flow failure — or why excluded). **Verify column** tags how each flow is proven given the hot-reload workflow (user logged in, agent not): `BROWSER` = user eyeballs via hot-reload (the agent cannot drive the authed app); `UNIT` = covered by vitest in jsdom; `BOTH` = unit asserts behavior + user eyeballs the visual.

| # | Flow | Edges (six classes) | Verify |
|---|------|---------------------|--------|
| F1 | **Enter→exit edit on a text field (title) with no layout shift** | empty: empty title shows placeholder, same box. denied: n/a (no per-field authz — UI leaf). re-entry: click→edit→Escape→click again works. concurrent: blur while another row pending — `isPending` opacity, no box change. boundary: very long title truncates in display AND edit, box width unchanged. mid-flow failure: commit rejected upstream → optimistic rollback (existing behavior, unchanged). | BOTH (UNIT: commit/escape/box-class equivalence; BROWSER: the actual no-pixel-shift on real fonts) |
| F2 | **Enter→exit edit on each non-text field type (number, currency, date, url)** | empty: null/empty renders placeholder in same box. denied: n/a. re-entry: edit→Escape→edit again. concurrent: `isPending` overlap. boundary: number=0, currency=0, url very long (truncate), date min/max. mid-flow failure: invalid number/url draft → revert (existing). | BOTH (UNIT: type-specific commit value contracts already in `field-renderer.test.tsx`; BROWSER: visual box-equivalence per type) |
| F3 | **Dropdown open/close + select a value (status/select/multi_select)** | empty: no value → placeholder trigger; no options → (multi_select) the `+` hidden when none remain. denied: n/a. re-entry: open→close (Escape/outside-click)→open again. concurrent: open dropdown while a commit pending. boundary: single option; many options (scroll). mid-flow failure: selecting current value is a no-op (existing test). | BOTH (UNIT: option-fires-onCommit, current-value-no-op already tested; BROWSER: trigger font == option font (Bug 3) + scale-from-origin motion) |
| F4 | **Pick a date within the column width** | empty: empty date shows placeholder, no clip. denied: n/a. re-entry: open native picker, Escape, reopen. concurrent: n/a. boundary: the edit input must fit inside the (widened) date column — the bug is the 176px input in a 140px column. mid-flow failure: blur with unchanged/empty draft → no commit (existing). | BROWSER (the clip/overflow is a live-DOM layout bug invisible to jsdom — MUST be eyeballed; the width *logic* is UNIT-covered in Task 7) |
| F5 | **Keyboard: Enter commits, Escape reverts (every editable field)** | empty: Enter on empty draft over non-empty value reverts (existing InlineEdit guard). denied: n/a. re-entry: Escape then re-edit. concurrent: n/a. boundary: Enter with unchanged value → no onCommit (existing). mid-flow failure: n/a. | UNIT (keyboard semantics are jsdom-coverable and already partly tested; keep those tests green) |
| F6 | **Empty / zero state across the layer** | the dedicated empty-state row: placeholder text in display, empty box same size as filled box, no collapse to zero-height (a known field-layer failure mode). | BOTH (UNIT: empty value still renders the shell box; BROWSER: empty box height == filled box height) |

**Driving note (shake-out, situation B):** F4 and the visual half of F1/F2/F3/F6 are `unverified-no-browser` from the agent's side — they MUST be handed to the user's hot-reload eyeball pass after each task, and recorded `pass` only once the user confirms. The behavior halves (commit values, keyboard, no-op) are UNIT and the agent verifies them. No UI flow is marked `pass` by the agent on jsdom alone — the "font gets bigger" and "input clips the column" bugs are precisely the live-DOM class jsdom masks.

---

## Sibling-site audit (cross-cutting)

After the shell exists and the first two consumers are migrated, sweep EVERY inline editable surface for the same independent-styling smell, so none is left hand-rolled:
- `apps/web/src/components/inline/inline-edit.tsx`
- `apps/web/src/components/inline/inline-select.tsx`
- `field-renderer.tsx`: `DateInput`, `NumberInput`, `CurrencyInput`, `UrlField`, `TextArea`, `MultiSelect` chips, `RelationField` chips + its search input
- any other caller of `InlineEdit`/`InlineSelect` (grep `from '../inline/` and `from '@/components/inline/`)

A field rendered through a path that does NOT consume the shell is a missed sibling — list it in the Task 8 audit and either migrate it or record why it's intentionally excluded.

---

## REVIEW GATE structure

Three clusters, each ≤4 tasks, each independently shippable (user eyeballs via hot-reload after each task).

- Cluster 1 — Tasks 1–2 (the shell + its first consumer)
- Cluster 2 — Tasks 3–5 (migrate select + the field-renderer sub-components + the chip surfaces)
- Cluster 3 — Tasks 6–8 (motion + date-width + sibling audit)

---

### Task 1: Create the `EditableShell` primitive (the convergence point)

**Files:**
- Create: `apps/web/src/components/inline/editable-shell.tsx`
- Test: `apps/web/src/components/inline/editable-shell.test.tsx`

**Interfaces:**
- Produces: an exported `EditableShell` component and an exported `FieldSize` type. Indicative contract (lock exact names here):
  - `EditableShell({ mode, size, align, isPending, className, children })`
  - `mode: 'display' | 'edit'`
  - `size?: FieldSize` (`FieldSize = 'sm'`; default `'sm'`)
  - `align?: 'left' | 'right'` (default `'left'`)
  - `isPending?: boolean`
  - `className?: string`
  - `children: ReactNode`
- The shell resolves `size` → one Tailwind class set for font-size + line-height + padding (start from the existing `text-sm px-1 py-0.5` baseline so current text fields don't visually move). `mode` toggles ONLY the focus/hover/`data-state` treatment, NEVER the box metrics.
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write the failing test (box-equivalence + size→class mapping)**

```tsx
// editable-shell.test.tsx — the ONE thing the shell carries logic for.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditableShell } from './editable-shell.tsx';

// Helper: the box-metric classes (font/padding/size) that MUST be identical
// across modes. Adjust the regex to the exact tokens the shell emits.
const BOX_METRIC_RE = /(text-sm|px-1|py-0\.5)/g;
function boxMetrics(el: HTMLElement): string[] {
  return (el.className.match(BOX_METRIC_RE) ?? []).sort();
}

describe('EditableShell box-equivalence', () => {
  it('display and edit modes carry IDENTICAL box-metric classes (no layout shift)', () => {
    const { container: disp } = render(
      <EditableShell mode="display">x</EditableShell>,
    );
    const { container: edit } = render(
      <EditableShell mode="edit">x</EditableShell>,
    );
    const dispBox = disp.firstElementChild as HTMLElement;
    const editBox = edit.firstElementChild as HTMLElement;
    expect(boxMetrics(dispBox)).toEqual(boxMetrics(editBox));
    expect(boxMetrics(dispBox).length).toBeGreaterThan(0);
  });

  it('applies the pending opacity treatment in both modes', () => {
    const { container } = render(
      <EditableShell mode="display" isPending>x</EditableShell>,
    );
    expect((container.firstElementChild as HTMLElement).className).toMatch(/opacity-60/);
  });

  it('right align does not change box-metric classes', () => {
    const { container: l } = render(<EditableShell mode="display" align="left">x</EditableShell>);
    const { container: r } = render(<EditableShell mode="display" align="right">x</EditableShell>);
    expect(boxMetrics(l.firstElementChild as HTMLElement)).toEqual(
      boxMetrics(r.firstElementChild as HTMLElement),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/inline/editable-shell.test.tsx`
Expected: FAIL — cannot resolve `./editable-shell.tsx`.

- [ ] **Step 3: Implement the shell**

Implement `EditableShell` so the box-metric classes (font-size, line-height, padding, radius) are emitted from the `size` token and applied identically regardless of `mode`; `mode === 'edit'` adds only the focus-ring/`input-focus`-style treatment and (later) a `data-state` hook; `align === 'right'` adds `text-right` (which is NOT a box-metric class). Merge `className` last via `cn`. Reuse existing tokens (`rounded-sm`, `text-sm`, `px-1`, `py-0.5`, `hover:bg-card`, `input-focus`). Add a `transition-colors duration-150 ease-out` for the hover-bg smoothness (motion locked-decision; does not change box metrics). NO default export.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/inline/editable-shell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint + full suite**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then `cd .. && cd .. && bun run lint`
Expected: tsc clean; full suite green (1096 + 3); lint exit 0 (warnings OK).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/inline/editable-shell.tsx apps/web/src/components/inline/editable-shell.test.tsx
git commit -m "phase-6: add EditableShell — single styling convergence point for inline fields"
```

**Tier:** A — the shell carries one real piece of logic (size/mode→class resolution with a box-equivalence INVARIANT). RED-first test asserts display==edit box metrics; this is the contract the whole plan rests on, and a regression here silently reintroduces the layout-shift bug.
**Test count:** record `<before> -> <after>` in the commit body.
**Risk this test does NOT cover:** real-DOM pixel metrics on actual fonts (jsdom has no layout) — deferred to /shakeout BROWSER pass (F1/F6).

---

### Task 2: Migrate `InlineEdit` to the shell

**Files:**
- Modify: `apps/web/src/components/inline/inline-edit.tsx`
- Test: existing `apps/web/src/components/inline/inline-edit.test.tsx` (must stay green; do NOT gut)

**Interfaces:**
- Consumes: `EditableShell`, `FieldSize` from Task 1.
- Produces: unchanged public `Props` of `InlineEdit` (callers in `table-cell.tsx`, slideover, list views must not break). `inputClassName`/`className` passthroughs preserved.

- [ ] **Step 1: Confirm existing tests are the contract, run them GREEN first**

Run: `cd apps/web && npx vitest run src/components/inline/inline-edit.test.tsx`
Expected: PASS (current behavior baseline — 10 tests). These ARE the behavior contract; they must still pass after migration.

- [ ] **Step 2: Migrate display + edit to render through the shell**

Replace the hand-rolled display `<span>` classes (`'inline-block cursor-text rounded-sm px-1 py-0.5 hover:bg-card ...'`) and the edit `<input>` classes (`'block w-full rounded-sm border border-transparent bg-card px-1 py-0.5 text-sm text-fg input-focus'`) so BOTH render inside `EditableShell` with the same `size`. The display `<span>` becomes the shell's `children` in `mode="display"`; the `<input>` becomes the shell's `children` in `mode="edit"` (the input itself drops its own box-padding/font classes — the shell owns them — keeping only `w-full bg-transparent outline-none` so it fills the shell box). Preserve verbatim: `defaultEditing`, the empty-draft revert guard (lines 43–53), `inputRef.focus()/select()`, Enter/Escape/blur handlers, `isPending`, `ariaLabel`, `placeholder`. Keep the `inputClassName`/`className` passthroughs flowing to the shell's `className`.

- [ ] **Step 3: Run the existing tests — still green**

Run: `cd apps/web && npx vitest run src/components/inline/inline-edit.test.tsx`
Expected: PASS (all 10). If `hover:bg-card` assertion (test at line 70–77) breaks, the shell must surface that class in display mode — fix the shell, not the test.

- [ ] **Step 4: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: all green; lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inline/inline-edit.tsx
git commit -m "phase-6: render InlineEdit through EditableShell (kills title font-grows-on-edit, Bug 2)"
```

**Tier:** B — `no unit test: Tier B, presentational migration; the behavior contract is already covered by the un-gutted existing `inline-edit.test.tsx` (commit/escape/blur/defaultEditing) which is run GREEN before and after. The box-equivalence logic lives in Task 1's Tier-A test.`
**Seam note:** this WIRES the shell into its first real consumer → the existing test file IS the live-chain assertion (real InlineEdit through the real shell, no mock), and the empty-draft-revert test is the negative case. Satisfies the seam obligation without a new bespoke test.
**Risk this test does NOT cover:** the actual no-pixel-shift on real fonts (F1) — deferred to /shakeout BROWSER pass.

**── REVIEW GATE ── (tier: STANDARD — new presentational primitive + first consumer migration; no 1a surface, no named invariant, no data layer. 2 finders + simplicity + the feature-acceptance F1/F6 browser eyeball.)**

---

### Task 3: Migrate `InlineSelect` + unify trigger/option font (Bug 3)

**Files:**
- Modify: `apps/web/src/components/inline/inline-select.tsx`
- Test: existing `apps/web/src/components/inline/inline-select.test.tsx` (stay green)

**Interfaces:**
- Consumes: `EditableShell` (for the trigger). The trigger renders in `mode="display"` (it is the closed/display affordance).
- Produces: unchanged `InlineSelect` `Props` + `SelectOption`. `renderDisplay` passthrough preserved (the status Pill path in `table-cell.tsx` depends on it).

- [ ] **Step 1: Run existing tests GREEN first**

Run: `cd apps/web && npx vitest run src/components/inline/inline-select.test.tsx`
Expected: PASS (4 tests) — behavior baseline.

- [ ] **Step 2: Migrate the trigger through the shell and unify the font**

Render the `PopoverTrigger`'s `<button>` content through `EditableShell mode="display"` so its font/padding match every other field's display state. **Fix Bug 3:** the trigger is currently `text-xs` (line 40) while option rows are `text-sm` (line 69). Pick ONE size and apply it to BOTH the trigger (via the shell's `size`) and the option `<button>` rows so they match. (The shell's default `size='sm'` = `text-sm`; bring the option rows in line with the shell, OR set both to the trigger's intended size — match them either way; the locked rule is they must be EQUAL.) Preserve `renderDisplay`, `isPending`, `placeholder`, the color dot, the `aria-selected`/`role="option"` semantics, and the current-value `bg-card` highlight.

- [ ] **Step 3: Existing tests still green**

Run: `cd apps/web && npx vitest run src/components/inline/inline-select.test.tsx`
Expected: PASS (all 4).

- [ ] **Step 4: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green; lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inline/inline-select.tsx
git commit -m "phase-6: render InlineSelect trigger through EditableShell + match trigger/option font (Bug 3)"
```

**Tier:** B — `no unit test: Tier B, presentational migration + font-token unification; behavior covered by the un-gutted existing inline-select.test.tsx (open→select→commit, current-value-no-op). No branching logic added.`
**Risk this test does NOT cover:** the visual trigger-font == option-font equality (F3) — deferred to /shakeout BROWSER pass.

---

### Task 4: Migrate the field-renderer text/number/currency/url sub-components

**Files:**
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (`DateInput` display half, `NumberInput`, `CurrencyInput`, `UrlField`, `TextArea`)
- Test: existing `apps/web/src/components/slideover/field-renderer.test.tsx` (stay green)

**Interfaces:**
- Consumes: `EditableShell`. `NumberInput`/`CurrencyInput` edit inputs render in `mode="edit"`; their display spans in `mode="display"`. `CurrencyInput` uses `align="right"` to preserve its right-aligned mono treatment. `UrlField`'s display `<a>` stays a link but its box renders through the shell; its edit `<input>` through the shell `mode="edit"`.
- Produces: unchanged commit value contracts (number→number, currency→number, url→string). `isSafeImageUrl` and the entire `ImageField` are UNTOUCHED (security guard preserved verbatim — do NOT refactor it into the shell; the image case is a thumbnail, not a text box).

- [ ] **Step 1: Run existing field-renderer tests GREEN first**

Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: PASS — behavior baseline (string/number/date/select/etc. commit contracts).

- [ ] **Step 2: Migrate each sub-component's box to the shell**

For `NumberInput`, `CurrencyInput`, `UrlField`, `TextArea`, and `DateInput`'s DISPLAY span: replace each hand-rolled class string (the varying `border border-border-light bg-shell px-2 py-1 text-sm`, `bg-card px-1 py-0.5`, `w-32`, `text-right font-mono`, etc.) with `EditableShell` wrapping the control. The inner `<input>`/`<textarea>`/`<a>`/`<span>` keeps only its functional classes (`bg-transparent outline-none w-full`, plus `font-mono`/`text-right` for currency via `align="right"`), the shell owns box metrics. Preserve EVERY existing handler: `onBlur` commit, Enter→blur, Escape→revert, `Number.isFinite` guard, the currency formatter, `isPending`. **`TextArea` is multi-line** — pass `size` but allow its own `rows`/height; box-equivalence applies to font/padding, not the multi-line height (note this explicitly so the reviewer doesn't flag it). Leave `DateInput`'s EDIT input for Task 7 (width fix lives there) — Task 4 only migrates its display span.

- [ ] **Step 3: Existing tests still green**

Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: PASS (all). Commit value contracts unchanged.

- [ ] **Step 4: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green; lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/slideover/field-renderer.tsx
git commit -m "phase-6: render number/currency/url/text/date-display fields through EditableShell (Bug 1 consistency)"
```

**Tier:** B — `no unit test: Tier B, presentational migration; commit value contracts (number→number, currency→number, url→string) covered by the un-gutted field-renderer.test.tsx. isSafeImageUrl/ImageField untouched.`
**Risk this test does NOT cover:** per-type visual box-equivalence (F2) — deferred to /shakeout BROWSER pass.

---

### Task 5: Migrate the chip surfaces (MultiSelect / RelationField) to shell-consistent tokens

**Files:**
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (`MultiSelect` chips + add-button, `RelationField` chips + add-button + the search `<input>`, `MultiSelectAdd` option rows)
- Test: existing `field-renderer.test.tsx` multi_select/relation cases (stay green)

**Interfaces:**
- Consumes: the shell's size token for consistency, but chips are pills not edit boxes — they adopt the shell's FONT token only (so chip text matches field text), not the full editable box. The RelationField search `<input>` (line 263–268) and the `MultiSelectAdd`/`RelationPicker` option rows adopt the SAME font as `InlineSelect`'s option rows (Task 3) so all dropdowns read identically.
- Produces: unchanged onCommit array/token contracts.

- [ ] **Step 1: Run existing tests GREEN first**

Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: PASS — baseline.

- [ ] **Step 2: Unify chip + dropdown-option fonts**

Bring the chip text (`text-xs` on lines 226, 422), the add-button, the RelationField search input, and all dropdown option rows onto the SAME font token used by Task 3's option rows, so the whole field layer reads at one size. Preserve every handler (`addLink`/`removeLink`, `onCommit(filter)`, the broken-link `line-through` styling, `excludeSlugs`). Do NOT change the pill SHAPE (rounded-sm bg-card) — only the font token for consistency.

- [ ] **Step 3: Existing tests still green**

Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: PASS (all).

- [ ] **Step 4: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green; lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/slideover/field-renderer.tsx
git commit -m "phase-6: unify chip + dropdown-option fonts with field shell token (Bug 1/3)"
```

**Tier:** B — `no unit test: Tier B, font-token unification on presentational chips; onCommit array/token contracts covered by existing multi_select/relation tests.`
**Integration gate (Cluster 2):** run `cd apps/web && npx vitest run` (full suite) — confirm 1096+3 green; then the user does a hot-reload eyeball pass on F2 + F3 (every field type and every dropdown reads at one font, one box) before Cluster 3 opens.

**── REVIEW GATE ── (tier: STANDARD — multi-file presentational migration across field-renderer sub-components; no 1a surface, no named invariant, no data layer. 2 finders + simplicity + feature-acceptance F2/F3 browser pass. NOTE: if review finds ImageField or isSafeImageUrl was touched, escalate to FULL — that is the one 1a-adjacent surface in this file.)**

---

### Task 6: Refined dropdown motion — scale + fade from origin (Popover)

**Files:**
- Modify: `apps/web/src/components/ui/popover.tsx`

**Interfaces:**
- Consumes: `tailwindcss-animate` (already configured in `tailwind.config.ts`) `data-[state]` utilities and Radix's `--radix-popover-content-transform-origin`.
- Produces: unchanged `PopoverContent` API (`align`/`side`/`sideOffset`/`className`).

- [ ] **Step 1: Add scale-from-origin + fade motion**

Augment the existing `data-[state=open]:animate-in data-[state=closed]:animate-out` + fade classes (lines 32–34) with `tailwindcss-animate` zoom utilities: `data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95` plus a 120–150ms duration (`duration-150`) and `ease-out`, and set `transform-origin` to Radix's content origin so the scale grows from the trigger. Keep it subtle (95%→100%, not a bounce). The existing `prefers-reduced-motion` block in `tokens.css` already neutralizes this to opacity-only — do NOT add a competing media query; verify the existing one wins.

- [ ] **Step 2: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green (motion is class-only; no test should break). lint exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/popover.tsx
git commit -m "phase-6: dropdowns scale+fade from origin (refined motion, locked decision)"
```

**Tier:** B — `no unit test: Tier B, classname/style-only presentational change; motion is invisible to jsdom and a /bg or /zoom classname assertion proves nothing the user cares about (the real proof is the live animation).`
**Risk this test does NOT cover:** the actual animation feel + reduced-motion neutralization — deferred to /shakeout BROWSER pass (F3) and a manual reduced-motion toggle check.

---

### Task 7: Fix the date edit-input width vs column width (Bug 4)

**Files:**
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (`DateInput` edit input, line ~391 `w-44`)
- Modify: `apps/web/src/components/table/columns.ts` (`FIELD_WIDTHS.date` and `BUILTIN_WIDTHS` if a builtin date exists — currently only the `date` field type at 140px)
- Test: `apps/web/src/components/table/columns.test.ts` (CREATE or extend if it exists) — Tier A on the width relationship

**Interfaces:**
- Consumes: `columnWidth(col)` from `columns.ts`.
- Produces: a `date`-type column whose width is ≥ the date edit input's rendered width, so the native date picker fits without clipping. The fix has two coordinated halves: (a) the edit input no longer hard-codes `w-44` (176px) but fills its container via the shell (`w-full`), and (b) the date column is widened so `w-full` is wide enough for the native picker control.

- [ ] **Step 1: Write the failing test (the width INVARIANT)**

```ts
// columns.test.ts — Tier A: the date column must be wide enough for the date
// edit control. This is the falsifiable contract behind Bug 4.
import { describe, expect, it } from 'vitest';
import { columnWidth, type Column } from './columns.ts';

// Native date inputs need ~150px+ for the dd/mm/yyyy + spinner/calendar glyph.
const MIN_DATE_EDIT_WIDTH = 150;

describe('date column width fits the date edit control', () => {
  it('a date field column is at least the date edit control min-width', () => {
    const col: Column = { key: 'due', label: 'Due', source: 'field', fieldType: 'date' };
    expect(columnWidth(col)).toBeGreaterThanOrEqual(MIN_DATE_EDIT_WIDTH);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/table/columns.test.ts`
Expected: FAIL — `date` is currently 140 (< 150).

- [ ] **Step 3: Fix both halves**

(a) In `field-renderer.tsx` `DateInput` edit branch: drop `w-44` (the hard 176px that overflowed a 140px column) and render the input through `EditableShell mode="edit"` filling its container (`w-full`). (b) In `columns.ts`: raise `FIELD_WIDTHS.date` to a value ≥ `MIN_DATE_EDIT_WIDTH` that comfortably fits the native picker (e.g. 160). Keep `datetime` consistent if it shares the date control.

- [ ] **Step 4: Run test + existing field-renderer date test**

Run: `cd apps/web && npx vitest run src/components/table/columns.test.ts src/components/slideover/field-renderer.test.tsx`
Expected: PASS (width invariant green; date commit contract still green).

- [ ] **Step 5: Typecheck + full suite + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green; lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/slideover/field-renderer.tsx apps/web/src/components/table/columns.ts apps/web/src/components/table/columns.test.ts
git commit -m "phase-6: date edit input fills column instead of overflowing 140px (Bug 4)"
```

**Tier:** A — the date-width-vs-column relationship is real branching logic with a falsifiable contract (the bug is a numeric mismatch: 176px input in a 140px column). RED-first test asserts the column width ≥ the edit-control min-width. This is one of the two parts the brief explicitly called out as worth a real test.
**Test count:** record before→after.
**Risk this test does NOT cover:** that the native picker GLYPH actually renders unclipped at the chosen width (live-DOM) — deferred to /shakeout BROWSER pass (F4, which is browser-only).

---

### Task 8: Sibling-site audit + final consistency sweep

**Files:**
- Read-only sweep across: all callers of `InlineEdit`/`InlineSelect`, all field sub-components, list-view rows, slideover frontmatter form.
- Modify: any straggler still hand-rolling field box styling (migrate to the shell or record an intentional exclusion).

**Interfaces:**
- Consumes: `EditableShell` (for any straggler migration).
- Produces: a one-paragraph audit note (in the commit body) listing every inline-editable surface and its status (migrated / intentionally-excluded-because-X).

- [ ] **Step 1: Grep every inline-editable surface**

Run: `cd apps/web && grep -rn "from '.*inline/inline-edit'\|from '.*inline/inline-select'\|input-focus\|border-border-light bg-shell" src/`
Expected: a list. For each hit NOT already going through the shell, decide migrate vs exclude.

- [ ] **Step 2: Migrate stragglers or document exclusions**

Migrate any remaining hand-rolled field box to the shell. Legit exclusions (document them): `ImageField` (thumbnail, not a text box — and carries the security guard), `TextArea` multi-line height, the boolean checkbox (line 69–78 of field-renderer — a checkbox is not a text box). Preserve all behavior.

- [ ] **Step 3: Full suite + typecheck + lint**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run` then repo-root `bun run lint`
Expected: green; lint exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/src
git commit -m "phase-6: sibling-site audit — every inline field converges on EditableShell (Bug 1 closed)"
```

**Tier:** B — `no unit test: Tier B, audit + presentational straggler migration; all behavior contracts covered by the existing suite run green before and after.`
**Integration gate (Cluster 3 / phase-complete):** `cd apps/web && npx vitest run` full suite green (1096 + new Task 1 & Task 7 tests). Then the user runs the full F1–F6 hot-reload eyeball pass (it is the BROWSER half of the acceptance manifest the agent cannot drive). Sign off only when the user confirms: no font-grow on edit (Bug 2), one font across triggers/options (Bug 3), date picker fits its column (Bug 4), every field reads at one box/size (Bug 1), dropdowns scale-fade from origin, and zero pixel shift entering edit on every type.

**── REVIEW GATE ── (tier: STANDARD — motion + width fix + audit sweep; the only Tier-A logic (date width) has its RED test, no 1a surface, no invariant, no data layer. 2 finders + simplicity + feature-acceptance F4 browser pass for the date-clip. Reminder: F4 is browser-ONLY — do not mark it pass on jsdom.)**

---

## Self-Review (planner ran this against the brief)

1. **Bug coverage:** Bug 1 (inconsistent font/border) → Tasks 1–5 + 8 (shell convergence). Bug 2 (font grows on title edit) → Task 1 (box-equivalence) + Task 2 (InlineEdit migration). Bug 3 (trigger vs option font) → Tasks 3 + 5. Bug 4 (date input overflows column) → Task 7. All four mapped. ✓
2. **Locked decisions:** Motion → Task 6 (popover scale-fade) + shell `transition-colors` (Task 1); reduced-motion respected. Shared primitive → Task 1, consumed by all. ✓
3. **Hard constraints:** zero-layout-shift → Task 1 Tier-A test + every BROWSER acceptance row; behavior-preserving → every migration task runs the existing test file GREEN before and after and is forbidden from gutting it; shell = single convergence point → stated in the contract + Task 8 audit; no backend → every file under `apps/web/src`. ✓
4. **Tier discipline:** two Tier-A tasks (Task 1 box-equivalence, Task 7 date width) — exactly the two parts the brief flagged as worth a real test; the rest Tier B with a recorded reason and the existing suite as the net. ✓
5. **Browser vs unit:** F4 + the visual halves of F1/F2/F3/F6 tagged BROWSER (agent cannot drive the authed app) → handed to the user's hot-reload pass; behavior halves UNIT. ✓
6. **Placeholders:** none — every code step shows the test or names the exact classes/lines to change. ✓

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review at each `── REVIEW GATE ──`, user eyeballs hot-reload between tasks. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — batch with checkpoints at the review gates. REQUIRED SUB-SKILL: `superpowers:executing-plans`.
