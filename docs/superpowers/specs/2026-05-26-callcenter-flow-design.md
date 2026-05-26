# Callcenter Flow — Design

**Status:** Draft, awaiting user review
**Date:** 2026-05-26
**Author:** Stefan + Claude (brainstorming session)
**Phase:** Sits after Phase 3 (Agents) + Phase 3.5 (Script & webhook trigger actions) + Phase 4 (Inbound webhooks). Probably lands as Phase 4.5 or as a "Callcenter pack" Phase 9.
**Related:** `docs/AGENTS.md`, `docs/TRIGGERS.md`, `docs/PHASES.md` Phase 3/3.5/4, `memory/DECISIONS.md` Phase 2.5 (agent scope model).

## Goal

Ship a callcenter / shared-inbox workflow on top of Folio for **one client at a time** (Stefan sells + hosts). The flow:

1. A customer email arrives in the client's Outlook/Exchange shared mailbox.
2. Power Automate POSTs the email to Folio.
3. Folio's `inbox-anonymizer` agent runs synchronously on ingest, strips PII, tags the email, persists an anonymized inbox document.
4. Reviewers triage in a kanban (status flips drive the pipeline).
5. When status flips to `Needs draft`, the `reply-drafter` agent reads past replies + wiki guidelines and creates a linked reply document.
6. Reviewer reviews the draft in a slideover, comments via threads (agents can be `@`-mentioned), approves.
7. Approval fires an outbound webhook back to Power Automate, which calls Microsoft Graph to send the reply from Outlook.
8. Power Automate POSTs the send result back to Folio; the inbox row flips to `Replied`.

Volume target: tens to low-hundreds of emails per day. Quality > throughput.

## Out of scope (v1)

- SLA timers / escalation rules.
- Multi-language beyond Dutch + English heuristic.
- Sentiment / urgency scoring (use tags instead).
- Customer-facing self-service portal.
- Reply attachments (reviewer attaches in Outlook after Folio sends).
- Productization for multiple clients (each install is hand-configured; templates come later).

---

## 1. Data model

Two project tables + a new generic comment document type.

| Table | Doc type | Purpose |
|-------|----------|---------|
| `inbox/` | `work_item` | One row per anonymized incoming email. Source-of-record for the case. |
| `replies/` | `work_item` | One row per draft reply. Linked to an inbox row via `email_ref`. Multiple replies per email allowed (drafts can be superseded). |
| (children of either) | `comment` *(new enum value)* | One row per comment/note. `parent_id` points at the inbox row or reply row. Author can be a user or an agent. |

### New primitives this introduces

1. **`comment` added to `documents.type` enum.** One Drizzle migration. Comments have minimal frontmatter — `parent_id` does the work. Author is `agent:<slug>` or `user:<id>`.
2. **New field type: `relation`.** `fields.type` enum gets a `relation` value. A `relation` field stores a slug + the target `table_id`. UI renders it as a clickable chip; `get_document` MCP tool returns the linked doc inline. This is a **hard prerequisite** for the callcenter — `replies.email_ref` is the first real consumer.
3. **Per-route request-body logging suppression.** A Hono middleware that, when applied to a route, prevents the default request logger from capturing the body. Applied to the ingest webhook to guarantee PII never lands in logs.
4. **Libsodium-encrypted frontmatter fields.** Specific frontmatter keys (configurable per table) get encrypted at write, decrypted only via authenticated reveal endpoints. `inbox.hidden_reply_to` is the first user.

### Inbox row frontmatter (locked schema)

```yaml
status: "New" | "Triaged" | "Needs draft" | "Awaiting review" | "Replied" | "Closed"
tags: [string]                          # set by anonymizer
anonymized_at: ISO timestamp
anonymizer_version: string              # which prompt/model anonymized it
had_attachments: bool
hidden_reply_to: encrypted-string       # libsodium, server-only, revealed via API
message_id: string                      # Outlook's Internet Message-ID header, dedup key + "Open in Outlook" deep link
in_reply_to: string | null              # threading
received_at: ISO timestamp
```

`body` field holds the anonymized email body in markdown.

### Reply row frontmatter

```yaml
status: "Draft" | "Approved" | "Sent" | "Failed"
email_ref: <slug>                       # relation field → inbox/
drafted_by: agent:reply-drafter | user:<id>
accepted_at: ISO timestamp | null       # set when reviewer either accepts as-is or edits before approving
approved_at: ISO timestamp | null
sent_at: ISO timestamp | null
send_error: string | null
```

`body` field holds the reply markdown. On send, the outbound webhook converts to HTML via Folio's existing markdown pipeline so PA can pick either format.

### Comment row

```yaml
author: agent:<slug> | user:<id>
tags: [string]                          # e.g. ['anonymizer-feedback', 'drafter-feedback', 'approval-drift']
```

Minimal. `parent_id` (top-level column) points to inbox or reply row. Body is the comment markdown.

---

## 2. Event flow & triggers

Five named transitions. Each is one trigger document (or one ingest-handler call). The whole pipeline is a state machine driven by status flips.

### Ingest (Power Automate → Folio)

1. PA POSTs to `/api/v1/webhooks/:secret` (see API section).
2. The webhook handler is special-cased for inbox tables: skips request-body logging, dedups on `message_id`, then runs the **anonymizer agent inline** before persisting.
3. Anonymizer rewrites body, extracts `tags`, returns JSON. Handler encrypts `from_address` → `hidden_reply_to`, persists the inbox row with `status: "Triaged"` (skips `"New"` because anonymization already happened), emits `document.created` + `inbox.ingested`.
4. If anonymizer fails, times out (30s), or returns invalid JSON → handler returns 5xx. PA retries. Nothing is persisted. **Fail-closed.**

### Trigger 1: draft reply

Trigger document config:
```yaml
on_event: document.updated
event_filter:
  table: inbox
  status: "Needs draft"
agent: reply-drafter
```

Reply-drafter agent runs. Reads inbox row + recent replies + wiki guidelines via MCP. Creates a `replies/` row with `email_ref: <inbox-slug>`, `status: "Draft"`. Flips the inbox row to `status: "Awaiting review"`.

### Trigger 2: send approved reply

Trigger document config:
```yaml
on_event: document.updated
event_filter:
  table: replies
  status: "Approved"
action:
  type: webhook
  url: "<project's reply_webhook_url>"
  method: POST
  hmac_secret_ref: replies-outbound-hmac
```

(Uses the Phase 3.5 webhook action type — not an agent.)

Folio POSTs to the configured URL with the decrypted recipient + body. PA validates HMAC, calls Graph send.

### Ack send result (PA → Folio webhook + Trigger 3)

The ack itself is not a trigger — it's the reply-ack webhook handler patching the reply row → `status: "Sent"` or `"Failed"`, setting `sent_at` / `send_error`. This patch emits `document.updated`.

**Trigger 3** then catches that update:
```yaml
on_event: document.updated
event_filter:
  table: replies
  status: "Sent"
action:
  type: builtin
  builtin: flip-linked-inbox-to-replied   # uses the email_ref relation to find the inbox row
```

The flip emits its own `document.updated` on the inbox row, but with `fired_by` chain including Trigger 3 — so re-firing is loop-prevented.

### Trigger 4: @mention

Triggered by a new event kind. Comment-insert path parses `@<slug>` in body. If the slug resolves to an agent in this workspace with this project in its allow-list, emit `comment.mentioned` with payload `{agent_slug, comment_id, parent_id}`.

Trigger config:
```yaml
on_event: comment.mentioned
event_filter:
  agent_slug: thread-helper          # one trigger per mentionable agent
agent: thread-helper
```

The mentioned agent runs with the parent document + full thread + the mention's body as context.

### Loop prevention

Reuses the Phase 3 mechanism. Every agent-originated write carries `fired_by: <trigger-id>`. Triggers refuse to fire on events whose `fired_by` chain contains themselves. Agent A `@`-mentioning agent B who `@`-mentions agent A back → second mention does not fire.

### New event kinds

| Kind | When | Payload |
|------|------|---------|
| `inbox.ingested` | After ingest handler persists an inbox row | `{document_slug, table_id, tags, anonymizer_version}` |
| `comment.created` | When a `type=comment` doc is created (fires alongside generic `document.created`) | `{document_slug, parent_id, author}` |
| `comment.mentioned` | When `comment.created` body parses to a valid agent mention | `{agent_slug, comment_id, parent_id}` |
| `reply.sent` | When a reply's `status` flips to `Sent` via ack-webhook (fires alongside `document.updated`) | `{reply_slug, email_ref_slug, sent_at}` |
| `reply.failed` | Same, for `Failed` | `{reply_slug, email_ref_slug, error}` |
| `audit.recipient_revealed` | When the reveal-recipient endpoint is called | `{document_slug, actor, timestamp}` |
| `reply.recall_requested` | When a reviewer clicks "Recall" within the recall window after Approve | `{reply_slug, requested_by, requested_at}` |

These are added to `KNOWN_EVENT_KINDS` in `apps/server/src/lib/trigger-schema.ts`.

---

## 3. Agents

Three agents ship with the callcenter pack as document fixtures. Each is a workspace document — Stefan or the customer admin can edit prompts and tool lists like any other document. Tokens auto-mint per the Phase 2.5 model. All three have `projects: [callcenter-project-slug]` in frontmatter — they only run for the callcenter project.

### Agent 1: `inbox-anonymizer`

- **Trigger:** invoked synchronously from the ingest webhook handler. Not via a trigger document — direct call from the route handler.
- **Tools:** `update_document` only. Operates on the inbound payload before persist; doesn't need read tools.
- **Token scopes:** `documents:write`.
- **Model:** Sonnet (fast + cheap + accurate enough). Anthropic provider.
- **Run config:** `max_tokens_per_run: 4000`, `requires_approval: false`.
- **Behavior:** fail-closed — if it returns invalid JSON or throws, the ingest handler 5xxs and the email is not persisted.
- **System prompt (sketch — refined during shadow week):**
  > "You receive a raw email body in HTML or text. Your job:
  > (1) Strip all personally identifying information — names, email addresses, phone numbers, postal addresses, account numbers, order references containing personal data — replacing each with a neutral placeholder like `[CUSTOMER]`, `[EMAIL]`, `[PHONE]`. Preserve sentence structure, intent, and any non-PII details (product mentions, dates, amounts, complaints).
  > (2) Produce 1-5 tags categorizing the email: one of `{billing, shipping, product-question, complaint, refund, technical, other}` plus optional sub-tags.
  > Return JSON: `{body_md, tags}`. Never invent information."

### Agent 2: `reply-drafter`

- **Trigger:** fires on `document.updated` where `table=inbox & status="Needs draft"`.
- **Tools:** `list_documents`, `get_document`, `get_document_markdown`, `create_document`, `update_document`.
- **Token scopes:** `documents:read`, `documents:write`.
- **Model:** Sonnet by default; project-config can upgrade to Opus per-table.
- **Run config:** `max_tokens_per_run: 20000`, `requires_approval: false`.
- **Behavior:** the human approval gate is the reviewer hitting "Approve" on the reply — not agent-execution approval.
- **System prompt (sketch):**
  > "You're drafting a reply to an anonymized customer email. Process:
  > (1) Read the inbox row's body and tags.
  > (2) `list_documents` with `table=wiki & tags includes 'reply-guidelines'` — read every match in full.
  > (3) `list_documents` with `table=replies & status=Sent` ordered by recency, limit 10 — read each in full as examples of how we reply.
  > (4) Draft a reply in markdown matching the tone of the past replies and the policies in the guidelines. Use Dutch unless the inbox email is clearly in English.
  > (5) `create_document` in the `replies` table with `email_ref: <inbox-slug>`, `status: Draft`, body = your draft.
  > (6) `update_document` to flip the inbox row to `status: Awaiting review`.
  > Never include placeholders like `[CUSTOMER]` in your output — write naturally as if to a real person. Never invent facts not present in the email or the guidelines."

### Agent 3: `thread-helper` (optional)

- **Trigger:** fires on `comment.mentioned` when `agent_slug=thread-helper`.
- **Tools:** same as `reply-drafter`.
- **Run config:** `max_tokens_per_run: 8000`.
- **System prompt (sketch):**
  > "A reviewer has @-mentioned you in a comment thread on either an inbox email or a reply draft. Read the full thread (every comment with the same parent_id, plus the parent doc itself). Answer the reviewer's question or do what they asked. If they want a revised draft, edit the reply's body via `update_document`. If they want context, post a comment via `create_document` with `parent_id=<thread-parent>` and `type=comment`. Be concise — this is a chat, not an essay."

### What's NOT an agent

The send step. No agent calls Microsoft Graph. The outbound webhook fires from a trigger document; the actual mail-send happens in Power Automate. Keeps the "agent did it" audit trail clean — agents draft, humans approve, plumbing sends.

---

## 4. API surface (Power Automate contract)

The integration spec — documented in `docs/API.md` so it's not tribal knowledge.

### Endpoint 1: ingest a new email (PA → Folio)

```
POST /api/v1/webhooks/:secret
Content-Type: application/json
```

Body:
```json
{
  "message_id": "<AAMkAGI2...@outlook.com>",
  "in_reply_to": "<previous-message-id>" | null,
  "received_at": "2026-05-26T14:23:11Z",
  "from_address": "jan@example.com",
  "from_name": "Jan Janssens",
  "to_addresses": ["support@klant.be"],
  "subject": "Probleem met mijn bestelling",
  "body_html": "<p>...</p>",
  "body_text": "...",
  "has_attachments": false
}
```

Behavior:
- Webhook config maps payload → `inbox` table. A "callcenter-inbox-ingest" preset ships out of the box.
- Handler dedups on `message_id` (if exists → `200 {deduplicated: true}`), calls the anonymizer agent on `body_text` (fallback to stripped `body_html`), encrypts `from_address` → `hidden_reply_to`, persists with status `Triaged`, emits `document.created` + `inbox.ingested`.
- **No request-body logging.** Route-scoped middleware suppresses the default Hono request logger.
- Response: `200 {document_slug, deduplicated: false}` on success. `5xx` on anonymizer failure (PA retries; email not stored).
- Auth: URL's `:secret` segment. Optional `hmac_secret` per webhook config — if set, `X-Folio-Signature: sha256=<hmac(body)>` required.

### Endpoint 2: ack a sent reply (PA → Folio)

```
POST /api/v1/webhooks/:secret
```

Same endpoint, different webhook config ("callcenter-reply-ack"). Body:
```json
{
  "reply_slug": "draft-2026-05-26-abc123",
  "status": "sent" | "failed",
  "error": "string" | null,
  "sent_at": "2026-05-26T14:25:00Z",
  "outlook_message_id": "<AAMkAGI2...>" | null
}
```

Handler patches the reply row's `status`, `sent_at`, `send_error`. The patch emits `document.updated`, which the inbox-flip trigger catches.

### Endpoint 3: deliver an approved reply (Folio → PA)

Outbound webhook configured per-project at `/settings/integrations`:
- `name: "Send reply via Power Automate"`
- `url: <PA HTTP-trigger URL>`
- `event_filter: { table: "replies", status_to: "Approved" }`
- `hmac_secret: <generated>`

Payload:
```json
{
  "event": "reply.approved",
  "reply_slug": "draft-2026-05-26-abc123",
  "email_ref_slug": "ticket-2026-05-26-xyz789",
  "recipient": "jan@example.com",
  "recipient_name": "Jan Janssens",
  "subject": "Re: Probleem met mijn bestelling",
  "body_md": "Beste Jan,\n\n...",
  "body_html": "<p>Beste Jan,</p>...",
  "in_reply_to_message_id": "<AAMkAGI2...>",
  "thread_message_id": "<AAMkAGI2...>"
}
```

Headers: `X-Folio-Event: reply.approved`, `X-Folio-Signature: sha256=<hmac(body)>`, `X-Folio-Delivery-Id: <uuid>`.

Notes:
- `recipient` + `recipient_name` are the decrypted hidden_reply_to values. **This is the only outbound moment Folio surfaces PII** — and only to PA, which already has Outlook access.
- `body_md` is source-of-truth; `body_html` rendered server-side so PA picks whichever.
- Retry policy: standard Folio outbound-webhook retry (exponential backoff, 5 attempts, then `webhook.failed`).

### Endpoint 4: reveal recipient on demand (UI → Folio)

```
GET /api/v1/documents/:slug/reveal-recipient
Auth: session (must have role in workspace)
```

Returns `{recipient_email, recipient_name}`. Used by the reply slideover ("Show recipient" link) and by the bulk export when the exporter has the new `documents:export-pii` scope. Every call emits `audit.recipient_revealed`.

---

## 5. UI surfaces

Everything lives inside Folio's existing primitives — slideovers, spreadsheet, kanban, command palette — with three small additions.

### The inbox kanban

- New "Inbox" view shipped as the default landing view for the callcenter project. Six columns matching the status field.
- "New" column normally empty (anonymizer runs synchronously). Kept as a column anyway in case anonymization is later moved async.
- Card shows: subject, tags as chips, `received_at` relative time, first ~80 chars of body as preview, attachment icon if `had_attachments: true`.
- Drag-to-move flips status. Dragging to "Needs draft" fires the reply-drafter trigger; card animates into "Awaiting review" within seconds.

### The inbox slideover (right side, ~600px)

1. **Header:** subject, editable tag chips, `received_at`, status dropdown, action buttons (`Mark closed`, `Open original in Outlook` deep link via `message_id`).
2. **Body section:** anonymized markdown. Read-only by default; reviewer can click "Edit anonymized version" to fix anonymizer mistakes. Edits emit `document.updated` with `actor=user:<id>`.
3. **"Show recipient" link:** click reveals decrypted `from_address` + `from_name` for ~30 seconds, then re-hides. Emits `audit.recipient_revealed`.
4. **Linked replies section:** lists `replies/` rows where `email_ref == this slug`. Clicking opens a stacked slideover (second slides over the first; esc closes the top one).
5. **Thread:** child `comment` documents, sorted by `created_at`. Each shows author chip (`@stefan` or `🤖 thread-helper`), timestamp, body.
6. **Composer:** small markdown textarea with `Cmd+Enter` to post. Typing `@` triggers a mention picker dropdown listing workspace agents (filtered by project allow-list) + workspace users. On send, server parses, fires `comment.mentioned` if a valid agent is mentioned.

### The reply slideover

Same layout, with:

- **Body is editable inline** (it's a draft).
- **Two prominent buttons:**
  - `Approve & send` — flips status to `Approved`, fires Trigger 2. Disabled until reviewer has accepted as-is or made an edit (`accepted_at` recorded either way).
  - `Ask @thread-helper to revise` — pre-fills a comment with `@thread-helper please revise — ` and focuses the cursor.
- **Read-only preview of the linked inbox email** at the top (collapsible — open by default first time, remembers preference). So reviewers don't bounce between slideovers.

### Anonymizer feedback affordance

Tiny `↑ improve / ↓ wrong` button pair on the inbox body section. Click ↓ → one-field form ("What did the anonymizer miss or get wrong?") → creates a `comment` with `tags=['anonymizer-feedback']` on the inbox doc. We don't auto-train anything in v1, but this gives a queryable log of bad outputs for prompt tuning.

### Settings UI

`/settings/integrations` gets a new section "Inbound email (via Power Automate)":
- Webhook URL + secret for ingest (copy-to-clipboard).
- Webhook URL + secret for reply-ack.
- Outbound URL config (where Folio POSTs approved replies).
- "Test" button that sends a synthetic email through the full pipeline so the operator can verify wiring without waiting for real customer email.

### What's NOT changing

- No new top-level navigation. Callcenter is a project inside an existing workspace with two tables.
- No new theme, typography, or component primitives. Reuses Phase 1–1.7.

---

## 6. Testing & rollout

### Unit tests (Bun test, server-side)

- **Anonymizer prompt:** fixture suite of 20+ synthetic-but-realistic emails (Dutch + English, names, emails, phone numbers, addresses, order refs). Assert every fixture's PII patterns are absent from agent output, expected tags produced, JSON parses. Re-run on every prompt edit. **Highest-risk regression guard.**
- Ingest webhook handler: dedup on `message_id`, anonymizer-fail → 5xx + no persist, `hidden_reply_to` encryption round-trip, log-suppression middleware works.
- Reply-drafter retrieval: with seeded past replies + wiki pages, assert the agent's `list_documents` calls match expected filters.
- HMAC signing/verification on inbound + outbound webhooks.
- New event kinds emit with correct payload shape.
- Loop prevention: A→B→A mention chain — second mention does not fire trigger.

### Integration tests (Bun test, in-memory SQLite)

End-to-end through the API, no UI:

1. POST a fake email → inbox row with `status=Triaged`, no PII in body, `hidden_reply_to` decrypts to original.
2. Flip inbox to `Needs draft` via API → reply row appears within 5s (mocked agent), inbox flips to `Awaiting review`.
3. Flip reply to `Approved` → outbound webhook fires (caught by test HTTP server), payload includes decrypted recipient, HMAC validates.
4. POST a reply-ack with `status: sent` → reply flips to `Sent`, inbox flips to `Replied`.
5. POST a comment with `@thread-helper` → `comment.mentioned` fires; mocked agent posts a child comment.
6. Dedup: POST same email twice → second returns `{deduplicated: true}`, no second row.

### E2E tests (Playwright)

Three flows only (these are slow):

1. Drag inbox card from `Triaged` to `Needs draft` → reply appears in `Awaiting review` → open slideover → `Approve & send` → outbound webhook fires (caught by Playwright fixture HTTP server).
2. Open inbox slideover, post comment with `@thread-helper please summarize` → child comment from helper appears within ~10s.
3. Click "Show recipient" → decrypted email shows for 30s then re-hides → audit log shows one `audit.recipient_revealed` event.

### Manual QA

12-scenario manual pass in `apps/web/tests/manual-qa-callcenter.md` (same pattern as `manual-qa-phase-1.md`). Covers PII edge cases unit tests miss, reviewer ergonomics, audit log readability after a real flow.

### Rollout to the actual client (three weeks)

**Week 1 — Shadow mode.** Ingest live; PA POSTs every real email. Replies drafted by agent. **No outbound webhook configured.** Reviewers (Stefan + client support lead) read each draft, compare to what they'd write. Feedback goes into `anonymizer-feedback` and `drafter-feedback` comment tags. Stefan tunes prompts.

**Week 2 — Approval mode, manual send.** Outbound webhook off. Reviewers approve drafts in Folio (records `approved_at`), then manually paste-and-send from Outlook. Catches "Folio thinks it's approved but human is still rewriting" cases. Drift recorded as `approval-drift` comment.

**Week 3 — Full auto-send.** Outbound webhook on. Approved replies fire through PA → Graph send. Reviewers can hit "Recall" within 60s of approval — fires `reply.recall_requested` event that PA's outbound flow listens for and aborts send if not yet dispatched.

### Telemetry from day one

- Anonymizer: run count, failure count, average latency, `↓ wrong` feedback count.
- Drafter: draft count, average time-to-first-edit by reviewer (trust proxy), `accepted_as_is` vs `edited_before_approve` ratio.
- End-to-end: median time from `inbox.ingested` to `reply.sent`, broken down by tag.

A Folio `wiki` page at `callcenter/telemetry.md` with hand-written SQL snippets is enough for v1. No Grafana, no dashboard. The numbers are the agreement-evidence with the client.

---

## 7. Dependencies on other phases

This design assumes the following ship first (in order):

| Phase | Why this design needs it |
|-------|--------------------------|
| Phase 2 (Agents) — shipped | Agent documents, MCP tools, `agent.task.assigned` event. |
| Phase 2.5 (Workspace agents) — shipped | Workspace-level agent scope with `projects:` allow-list. |
| Phase 3 (AI in UI + Agent runner) | Trigger scheduler/matcher. Anonymizer fail-closed pattern. Loop prevention via `fired_by`. |
| Phase 3.5 (Script & webhook trigger actions) | `action.type=webhook` for Trigger 2 (outbound send). |
| Phase 4 (Inbound webhooks) | `POST /api/v1/webhooks/:secret`, HMAC verify, mapping config, outbound webhook retry. |

Plus this design introduces three new primitives that should land **before** the callcenter pack itself:

1. **`comment` document type** — one Drizzle migration, MCP-tool aware.
2. **`relation` field type** — pin field type to "relation to another table" with slug-resolution in `get_document`.
3. **Encrypted frontmatter fields + reveal-with-audit endpoint** — libsodium round-trip plus `audit.recipient_revealed` event kind.

These three could ship as a small "Phase 4.1 — Primitives for relational + private fields" before the callcenter pack lands.

## 8. Open questions (for the implementation plan)

- Exact Drizzle migration order — comment type and relation field type are independent of each other; either can land first. Encrypted field metadata likely needs a `fields.encrypted: boolean` column.
- Mention parser placement — at insert time on the API route, or as a post-write hook on `document.created` for `type=comment`? Insert-time is simpler; hook-based is more uniform with other parsing.
- Webhook config preset format — do we ship presets as seed data, or as a `/scripts/seed-callcenter.ts` you run once per install?
- Recall window: 60s is a guess. Validate during Week 3.
- Reply-drafter retrieval cap — `limit 10` past replies is a guess. May need tuning based on context window cost.
- `hidden_reply_to` rotation — if the master key rotates, every encrypted field needs re-encryption. Out of scope here; handled by Phase 6/7 ops work.

---

## 9. Acceptance

A working callcenter pack is one where:

1. PA can POST a real Outlook email; Folio anonymizes and stores it within 30s.
2. A reviewer can drag the card to "Needs draft" and get a usable draft within 30s.
3. A reviewer can `@`-mention `thread-helper`, ask for a revision, and see the draft update within 30s.
4. A reviewer can click "Approve & send"; the reply goes out via PA → Graph; the inbox row reaches `Replied` within 30s.
5. PII never lands in server logs (verified by manual log review during shadow week).
6. The anonymizer fixture suite passes at ≥95% PII-removal rate before going to shadow week.
7. After the three-week rollout, the median end-to-end time (`inbox.ingested` → `reply.sent`) is under 20 minutes for tagged categories the agent handles well.
