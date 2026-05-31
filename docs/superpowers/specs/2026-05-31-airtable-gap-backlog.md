# Airtable template gap backlog

_Date: 2026-05-31 · Status: backlog (not committed work)_

A gap analysis sampled 7 Airtable templates across categories — Sales CRM, Content Calendar, Product Roadmap, Bug Tracker, Event Planning, Applicant Tracker, Inventory — and mapped the feature primitives each relies on against Folio's actual codebase capabilities (not planned, *built*).

**Conclusion:** Folio already covers the per-record half of every template (typed fields, status pipelines, Kanban-by-field, filter/sort/group, saved views). The gaps cluster into three buckets: (1) the relational triad, (2) two missing view types, (3) intake + media. Folio's automation layer (agent runner + event-driven triggers) is *stronger* than the simple "on status change → Slack" rules these templates use — automation is not a gap.

**Being addressed now:** Linked records + backlinks → `2026-05-31-relation-fields-and-backlinks-design.md`.

This doc captures everything else, prioritized, so each gets its own brainstorm → spec → build cycle later.

## Scorecard (at time of analysis, 2026-05-31)

| Primitive | Used by | Folio today | Gap |
|---|---|---|---|
| Single-select status/stage | 7/7 | ✅ `select` + status column | none |
| Kanban grouped by field | 6/7 | ✅ KanbanView, groupBy, manual rank | none |
| Filter / sort / group | 7/7 | ✅ (sort even on custom frontmatter fields) | minor |
| Saved views | 7/7 | ✅ per-table, auto-save | none |
| Multi-select / number / date / currency / url / checkbox / user | 7/7 | ✅ 12 inferred/pinned types | none |
| Status-change automation | 7/7 | ✅✅ agent runner + triggers (stronger) | none |
| **Linked records + backlinks** | **7/7** | ❌ `document_ref` text-pattern only | **being built** |
| **Lookups** | ~5/7 | ❌ | large (cut) |
| **Rollups** (sum/count/avg across links) | Inventory/Event/CRM/ATS | ❌ | large (cut) |
| **Formulas** (computed columns) | Inventory/Roadmap | ❌ none | large (cut) |
| **Calendar view** | Content/Event/ATS | ❌ deferred (Phase 4) | medium |
| **Timeline / Gantt** | Roadmap/Content | ❌ Phase 1.8 spec, unbuilt | medium |
| **Form view / public intake** | ATS/Content | ❌ none | medium |
| **Attachments** | ATS/Bug/Inventory/Event | ❌ none | medium |
| Gallery view | Inventory | ❌ | low |
| `rating` / `phone` field types | ATS/CRM | ❌ | low |
| Charts / dashboards | CRM/Bug/Roadmap | ⚠️ "This Week" buckets planned | low/medium |

## Backlog items (prioritized)

### 1. Lookups + rollups (+ formula scope decision) — LARGE, wedge-touching
The other hard half of Airtable parity. Inventory (`on-hand = rollup(ordered) − rollup(sold)`) and Event budgeting (`actual vs estimated rolled up by category`) are *pure relational math* and are the most uniquely-Airtable templates. Depends on the relation field shipping first (lookups/rollups compute *across* links).

Wedge tension: lookups/rollups can be **read-time, never persisted** (frontmatter stays source of truth). Formulas want a *persisted computed column*, which is the most philosophically awkward vs markdown-as-truth — that's a `DECISIONS.md`-level call, brainstorm separately. **Was explicitly cut from the relation v1.** Revisit as the natural sequel once relations land.

### 2. Calendar view — MEDIUM, additive
Render a table's docs on a calendar by a chosen `date`/`datetime` field. Needed by Content / Event / ATS. Already on the roadmap (Phase 4 / deferred). Doesn't fight the wedge — it's a new render mode over existing data, parallel to TableView/KanbanView. New `views.type = 'calendar'` + a calendar component.

### 3. Form view / public intake — MEDIUM, also feeds the agent story
A form that creates a document from outside the app (public or token-gated). Needed by ATS (job applications) and content-request flows. Strategically valuable beyond template parity: **intake → trigger → agent** is a keystone of the agent thesis (an external submission fires a trigger that an agent reacts to). Touches untrusted input + possibly public endpoints → would trip the threat-modeling trigger; brainstorm with that skill.

### 4. Attachments / files — MEDIUM, needs a storage decision
File uploads (resume, screenshot, product image, contract). Needed by ATS / Bug / Inventory / Event. Biggest deviation from "one MD file = one work item" — requires deciding where bytes live (local disk under the data volume? object storage?) while preserving the single-binary, single-data-volume install promise. A storage-model brainstorm before any UI.

### 5. Gallery view — LOW
Image-led grid (Inventory products). Cheap *after* attachments exist (gallery is mostly "Kanban cards but big image first"). Sequence after #4.

### 6. `rating` + `phone` field types — LOW, small
Two scalar field types: `rating` (candidate scoring, ATS) and `phone` (CRM/ATS contact data). Small additions to the `FIELD_TYPES` enum + `CHECK` constraint + inference + a cell renderer each. Bundle into a single "field-type top-up" ticket.

### 7. Charts / dashboards — LOW/MEDIUM
Summary metrics + charts (pipeline value, open bug counts, candidates per stage). Partially depends on rollups (#1) for the aggregations. The "This Week" activity buckets (Phase 1.7/1.8) are the closest existing thing. Lowest urgency for template parity; highest "looks impressive in a demo" value.

## What is NOT a gap (do not build)
- **Automation** — Folio's agent runner + event triggers already exceed the templates' simple rule automation.
- **Per-record typed fields / status pipelines / Kanban / filter-sort-group / saved views** — all shipped and at parity.
