# Relation fields + backlinks — design

_Date: 2026-05-31 · Status: design approved, pending spec review_

## Why

A gap analysis against a varied sample of 7 Airtable templates (Sales CRM, Content Calendar, Product Roadmap, Bug Tracker, Event Planning, Applicant Tracker, Inventory) found that **linked records** are the single most universal Airtable primitive — they appeared in all 7 templates and are the backbone of every base. Folio's `document_ref` field looks adjacent but is only a `[[slug]]` text pattern: no typed target, no cardinality, no backlinks, no picker scoping. This design turns linked records into a first-class capability while staying inside the markdown-as-truth wedge.

Scoped to **links + backlinks only**. Lookups, rollups, and formulas are explicitly out (see backlog).

## Scope

**In:**
- A new `relation` field type — a typed, pinned upgrade of `document_ref`.
- Per-field **target** pin: a specific table **or** the wiki (pages).
- Per-field **cardinality** pin: single or multi.
- Bidirectional **backlinks**, computed at read time ("Linked from" panel).
- **Slug immutability** for `work_item` / `page` documents (the linchpin that keeps links durable).
- Scoped link picker, chip rendering in TableView + slideover, unresolved-link rendering.

**Out (explicitly — see "Backlog" at the end):**
- Lookups (pull a field across a link).
- Rollups (aggregate across links: sum/count/avg).
- Formulas / computed columns of any kind.
- New views (Calendar, Timeline, Form, Gallery), attachments, new scalar field types (rating, phone), charts/dashboards. Each is its own future brainstorm.

The raw `[[slug]]` body affordance (Milkdown wiki-link insertion, `wiki-trigger.ts`) is **unchanged**. `relation` is about *typed frontmatter fields*, not body links.

## Data model — frontmatter stays the schema

A relation field is a pinned `fields` row. **No new columns on `documents`. No link table. No stored reverse direction.**

- `fields.type = 'relation'` — a new enum value.
  - Update **both** the Drizzle TS enum **and** the SQL `CHECK` constraint on `fields.type` (precedent: `DECISIONS.md` Phase 2B — the enum is TS-only otherwise and the DB check will reject inserts).
- `fields.options` (existing JSON array, already used by `select` / `currency`) carries the config:
  - `options[0]` = target — `"table:<table_id>"` or `"wiki"` (pages live at `documents.table_id IS NULL`).
  - `options[1]` = cardinality — `"single"` or `"multi"`.
- **Stored frontmatter value** is identical in shape to today's `document_ref`:
  - single → `"[[slug]]"`
  - multi → `["[[slug]]", "[[slug]]"]`

Because the on-disk shape is unchanged, existing `.md` files, bulk export, and the inference path all stay compatible. `relation` is the *pinned, targeted* form of `document_ref`.

### Inference interaction (`packages/shared/src/field-infer.ts`)
- An **unpinned** bare `[[slug]]` (or array of them) still infers as `document_ref` — unchanged. A pin test guards this so we don't regress the existing affordance.
- Pinning a field to `relation` is what unlocks the typed picker + target scoping + backlink participation. `document_ref` remains the "I typed a wiki-link and nobody pinned it" fallback.

## Backlinks — query-time, derived

There is **no stored reverse direction**. "Who links to this doc" is computed on read:

- A new read endpoint resolves backlinks by querying `documents` whose `relation`-typed frontmatter fields contain the target doc's slug, using SQLite `json_each` over the `frontmatter` JSON column. Both the single (`"[[slug]]"`) and multi (`["[[slug]]", ...]`) shapes must match.
- **Scope** of the scan mirrors the forward links: a doc can be linked *from* any table/wiki that has a relation field pointing at it, within the same workspace/project bounds the forward link already respects.
- Start **without** an index — correctness first. Add an expression index on the frontmatter JSON only if profiling shows the reverse scan is hot.
- Why query-time and not a maintained link table: links live **only** in frontmatter (the source of truth). A maintained table is derived state that can drift and needs a reconciler. Query-time can't drift — there's nothing to keep in sync. (Considered and rejected: maintained link table; hybrid index-as-cache.)

### "Linked from" panel
- Renders in the document slideover, grouped by source table.
- Each row is click-through → opens that source doc's slideover.
- **Read-only**: you fix a backlink by editing the source doc's relation field. The reverse direction is never independently editable (it isn't stored).

## Link stability — slugs become immutable

The linchpin. Today there is **no rename cascade** — and worse, `maybeRegenerateSlug` (`services/documents.ts`) *actively changes* a `work_item`/`page` slug when its (auto-derived) title changes, which would silently break every `[[old-slug]]` link. Agents/triggers already opt out of regeneration *specifically* to protect references (see the comment at `documents.ts:875`: "URLs are sticky and frontmatter references would break"). Tables have immutable slugs too (`DECISIONS.md` Phase 2A).

**Decision:** extend that precedent — make `work_item` / `page` slugs immutable as well.
- Remove `maybeRegenerateSlug` from the work_item/page update path (and the call site at `documents.ts:875`).
- A slug is fixed at creation. Retitling changes `title` only; the slug never moves.
- Result: `[[slug]]` links stay valid forever, frontmatter stays human-readable (`[[fix-login-bug]]`, not `[[01HX...]]`), and there is **no cascade machinery**.
- Cost: slug can drift from title over time — already accepted for agents/triggers/tables, so this is consistency, not a new tradeoff.
- (Considered and rejected: a rename cascade rewriting `[[old]]→[[new]]` across linking docs — net-new fan-out writes + last-write-wins races to preserve a behavior the codebase is already retreating from. Also rejected: storing `[[uuid]]` and rendering the title — bulletproof but guts the markdown-as-truth wedge for anyone reading the raw file.)

### Dangling links (target deleted)
- Render the raw `[[slug]]` as **unresolved** (greyed / struck-through) in cells, chips, and the picker.
- **Frontmatter keeps the string untouched** — it's the source of truth; we do not mutate other docs' data on a delete. Self-heals if the slug ever returns; the user can clear it manually.
- → **No delete-cascade.** (Considered and rejected: auto-stripping dead refs on delete — reintroduces the write-cascade we deliberately avoided, and mutates source-of-truth on an unrelated doc's delete. Also rejected: hiding unresolved links silently — hides data loss, worst for trust.)

## UI surfaces

- **Field config** — reuse the existing fields-table column-type flow. Choosing `relation` reveals two inline selects: **target** (the project's table list + a "Wiki / Pages" option) and **cardinality** (single / multi). No new config panel. Both write into `fields.options`.
- **Cell rendering (TableView)** — linked doc title(s) render as chips; clicking a chip opens that doc's slideover. An empty cell opens the typed picker. Unresolved slugs render struck-through.
- **Picker** — a scoped variant of the existing `WikiLinkPicker`, filtered to the pinned target (a specific table's docs, or pages). Keyboard-fast; matches the existing `[[` ergonomics. Single replaces the value; multi appends to the array with removable chips.
- **Slideover (`FieldRenderer`)** — edit link(s) via the same picker. Single = one chip; multi = removable chip list. Plus the read-only "Linked from" backlink panel.
- **Cmd-K / copy-as-MD** — unchanged. Links are plain frontmatter, so copy-as-MD already emits them correctly.

## Migration & testing

**Migration:** the only schema change is widening the `fields.type` `CHECK` constraint for the new `relation` enum value. **No data migration** — the on-disk frontmatter shape is unchanged and `relation` is opt-in per field. Removing `maybeRegenerateSlug` is code-only (no migration).

**Tests:**
- Field config round-trip — target + cardinality persist in `fields.options` and reload.
- Storage shape — single stores `"[[slug]]"`, multi stores `["[[slug]]", ...]`.
- Picker scoping — a field pinned to `table:X` lists only table X's docs; `wiki` lists only pages.
- Backlink query correctness — single-link match, multi-link array match, cross-table sources, empty result; the `json_each` predicate matches both shapes.
- Unresolved-link rendering — a `[[slug]]` with no live target renders struck-through and the frontmatter value is **not** mutated.
- **Pin test (slug immutability):** retitling a `work_item`/`page` does NOT change its slug and does NOT break an inbound link. This pins the deliberate removal of `maybeRegenerateSlug` — if a future change reintroduces regeneration, this test fails loudly.
- **Pin test (inference unchanged):** an unpinned bare `[[slug]]` still infers as `document_ref`.

## Threat model note

This feature does not add a new untrusted-input surface beyond what already exists: relation values are frontmatter strings, already parsed and validated through the existing document write path; the backlink query is a parameterized read over the user's own workspace data. No outbound requests, no new auth surface, no external URLs. The CLAUDE.md threat-modeling trigger (user-controlled URLs / auth / untrusted parsing / BYOK / multi-tenancy / outbound requests) is not tripped, so no standalone `## Threat model` section is required. The one durable invariant worth stating: **a relation never widens read scope** — a backlink query returns only docs the requester could already read; rendering a backlink must not leak a doc the user lacks access to.

## DECISIONS.md addendum (to record on approval)

- `relation` is the pinned/targeted upgrade of `document_ref`; both store the same `[[slug]]` / `["[[slug]]"]` frontmatter shape. Backlinks are query-time only, never stored.
- **`work_item` / `page` slugs are immutable** (extends the table/agent/trigger precedent). `maybeRegenerateSlug` is removed. Retitle changes title only.
- Dangling relations render unresolved and are never auto-stripped; frontmatter is source of truth.

---

## Backlog — gaps from the Airtable analysis NOT addressed here

Captured so nothing is lost. Each is its own future brainstorm → spec → build cycle. Full backlog lives in `docs/superpowers/specs/2026-05-31-airtable-gap-backlog.md`.

- **Lookups / rollups / formulas** — the other hard half of Airtable parity (Inventory + Event budgeting are pure rollup math). Deliberately cut from v1 of relations.
- **Calendar view** — Content / Event / ATS. Additive view; on roadmap (Phase 4).
- **Timeline / Gantt** — Roadmap / Content. Phase 1.8 spec exists, not built.
- **Form view / public intake** — ATS / content-request; also feeds the agent story (intake → trigger → agent).
- **Attachments / files** — ATS / Bug / Inventory / Event; biggest deviation from "one MD file", needs a storage decision.
- **Gallery view** — Inventory; low urgency.
- **`rating` / `phone` field types** — ATS / CRM; small.
- **Charts / dashboards** — "This Week" buckets planned; no charting.
