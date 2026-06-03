# Design — Operator Cockpit Chat

**Date:** 2026-06-03
**Status:** Design approved (brainstorm complete); pending spec review → writing-plans.
**Touches:** the cockpit UI surface, a new conversations/messages data layer, the agent runner (reused — new adapters only), the tool registry (new `ui` tool), the SSE/event stream (reused), `__system` operator content (skill + reference files + `agent.md` + `soul.md`).

---

## ⚠️ Build precondition (read first)

**This is authored now but BUILT AFTER `spec/agent-authority-and-skills` is merged.** Do NOT start implementation until that branch lands. The cockpit chat is the UI layer on top of the operator authority model; it depends on **both** halves of that branch:

- **Piece A — Reach** (instance-reach tokens, `api_tokens.workspace_id` nullable). The chat operator is instance-reach: it creates workspaces and acts across all of them, so its token cannot be pinned to one workspace. As of this writing, only A1–A4 (the reach axis) are committed on the branch; A5+ (admin scopes, the folio_api path→scope map, secret carve-out) and all of Piece B are not yet done.
- **Piece B — Skills** (always-`__system` skill resolution). The operator loads its capability (skill + reference templates) from `__system`. The chat's "set up a project from a reference" and the operator's `agent.md`/`soul.md`/reference-file content all resolve through the `__system` skill-load path that Piece B delivers.

By the time this builds, the substrate (reach + skill reach) is finished. There is no "buildable-now-vs-later" split inside this work — it is gated whole on the authority branch.

---

## Why

Folio is AI-first: the human shouldn't need to know how the app works — the operator does. Today the cockpit is an Activity/Run control panel: pick an agent, pick a parent document, type an input, fire a one-shot run, watch it in a feed. That is a control surface, not a conversation.

The goal is to **replace the cockpit with a chat**. You talk to the operator; it does everything you ask — create a workspace, set up projects from `__system` reference templates, work on tables and work items, build filters and views, generate reports, assign and fire other agents on work items — all through conversation. The cockpit is open by default when the app opens; a human who wants no agents at all just closes it and uses Folio normally (tables, boards, wiki).

The operator stays on-topic (the app and the user's workspaces) and gently nudges off-topic asks back. Beyond text, it can show interactive components — a panel that links to a work item, or a Q&A card with buttons — so the chat is agentic UI, not just prose.

---

## Guiding principle — ONE flow, not parallel flows

**Reuse as much as possible. The chat is a new SEAM on the existing flows, not a second flow that nearly duplicates them.** This is a first-class constraint, not an aside. At plan-review and code-review, any task that looks like it rebuilds something the runner / stream / tool layer already does is a red flag — route through the existing code instead.

Concretely:

- **Run execution** — the chat does NOT get its own runner. It calls the same `runner.ts` core loop (the `MAX_TOOL_ROUNDS = 25` outer tool-use round-loop). New code is two thin **adapters** (thread↔messages), not a second runner. Copying loop logic = stop.
- **Resume** — `handleResumeRun` already re-seeds history and continues a session (built for the approval gate). Cross-turn chat continuation is the same idea. EXTEND that path to accept a message-history source; do not write a separate "chat resume." One resume mechanism, two callers (approval gate, chat turn).
- **Output sink** — the runner posts typed comments (`kind: result|comment|plan|approval|rejection`) via `postAgentComment`. Chat messages are the same typed-output concept aimed at a different sink. GENERALIZE that sink so it can write a `messages` row instead of a document comment. The kinds line up nearly 1:1.
- **Streaming** — reuse `useEventStream` + the existing SSE channel verbatim. No new socket, no new bus. Chat messages flow as events on the channel already live.
- **Components** — the `ui` tool is a tool in the EXISTING registry, validated at the EXISTING tool boundary, executed in the EXISTING tool-use loop. Not a side channel.
- **Web** — message renderers are new presentational components, but they mount inside the EXISTING `AgentCockpitPanel` shell (resize, bus, header); the composer reuses existing form primitives.

**Named convergence points this routes THROUGH (per ARCHITECTURE-INVARIANTS):** runner core loop, the typed-output sink, the SSE/event stream, the tool registry + tool boundary, `handleResumeRun`, the authority/risk floor, BYOK key resolution. Nothing bypasses these.

Net-new surface, deliberately small: **2 tables, 1 tool, 2 thin adapters, a handful of render components, the conversation routes, and authored `__system` content.**

---

## Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Chat model | Multi-turn (operator holds the thread) | "Talk to the operator and it does everything" needs conversation memory. |
| Topic fence | Prompt nudge + tool boundary (advisory) | The tool surface is already the real boundary; a hard classifier would misfire + cost a model call. Advisory is correct for an internal tool (user is the customer, not an adversary). |
| Consequential actions | Act, then report | Matches the agent-is-power-user / human-is-reviewer thesis. Lean on visibility + links, not a confirm gate. |
| Placement | Replaces the cockpit panel; open by default; closeable = human-only mode | Cockpit IS the agent surface; closing it = pure-human Folio. |
| Conversation storage | Dedicated conversations/messages tables, walled off like `agent_run` | Avoids the "every write emits an event" flood + accidental trigger firing (invariant 4). Markdown-as-truth preserved via on-demand export. |
| Markdown export | On-demand only (`GET …/:id.md` serializer) | A projection rendered at request time, never a stored artifact. |
| Runner | API path (BYOK); reuse the 25-round loop; extend resume for cross-turn | claude-code stays hard-disabled (CC-DISABLED-1 authority bypass). |
| Turn visibility | Stream prose + show tool steps | The steps ARE the report in act-then-report. Maximum transparency. |
| v1 thread scope | Single active thread + resume; table modeled for many | Right scope, no rework — multi-thread list is a fast follow-up. |
| Components | Server-defined `ui` tool, closed validated set | Safe (no model-authored markup to the DOM), versionable, styleable. |
| Component types (v1) | `link_panel` (navigates, cockpit stays open) + `choice_card` (button = next turn) | Maps exactly onto "panel that links to something" + "interactive Q&A/buttons". |
| Operator capability | Authored `__system` content: skill + reference files + `agent.md` + `soul.md` | Capability is CONTENT the operator reads, not server code. Tune voice/templates without a rebuild. |

---

## Architecture

### Data model — two tables, walled off from `documents`

Same separation as `agent_run` rows: chat turns never hit the `/documents` endpoint, never emit document events, never fire triggers.

**`conversations`**

| column | type | notes |
|---|---|---|
| `id` | text (uuidv7) | PK |
| `title` | text | derived from the first user message; editable later |
| `created_by` | text | the human (user id) |
| `operator_agent_id` | text | the agent driving (the instance operator) |
| `active_run_id` | text, nullable | the run executing the current turn, if any |
| `created_at` / `updated_at` | text | ISO; `updated_at` drives "recent chat" ordering |

No `workspace_id` — the operator is instance-reach, so a conversation isn't pinned to a workspace. (This is precisely why the work depends on Piece A: a workspace-pinned conversation could not host an operator that creates workspaces.)

**`messages`**

| column | type | notes |
|---|---|---|
| `id` | text (uuidv7) | PK |
| `conversation_id` | text | FK → conversations |
| `seq` | integer | monotonic per conversation; deterministic turn ordering |
| `role` | text | `user` \| `operator` |
| `kind` | text | `text` \| `tool_step` \| `component` |
| `body` | text | prose (markdown) for `text`; empty otherwise |
| `payload` | text (JSON), nullable | structured data for `tool_step` and `component` |
| `run_id` | text, nullable | the run that produced this operator message |
| `created_at` | text | ISO |

**Why `seq`, not timestamp** — a single turn produces many messages (several `tool_step`s + a final `text`) in the same millisecond. `seq` guarantees stable order (same discipline as the keyset-affinity work: ordering must be deterministic).

**Message kinds** (the wire the thread renders by):

- **`text`** — prose. User messages; the operator's streamed reply.
- **`tool_step`** — one tool the operator ran. `payload`: `{ tool, summary, status }`, e.g. `{ tool: 'create_document', summary: 'Created work item "Onboard Acme"', status: 'ok' }`. These are the act-then-report steps.
- **`component`** — a `ui`-tool emission. `payload` is a Zod-validated discriminated union:
  - `{ type: 'link_panel', target: { kind: 'document'|'project'|'view', wslug, ref }, title, subtitle? }`
  - `{ type: 'choice_card', prompt, options: [{ id, label }], chosen?: string }` — `chosen` is set on click; the card then locks.

**Indexes:** `messages (conversation_id, seq)` (thread reads); `conversations (created_by, updated_at)` (recent-chat ordering).

**Markdown export (on demand only):** `GET /conversations/:id.md` renders the thread from the tables at request time — turns as sections, tool steps as a bulleted log, components as readable lines (`[link: Onboard Acme]`, `Q: Which template? → Leads`). Preserves markdown-as-truth; never a stored write.

### Turn lifecycle

A turn is: **user message → operator run (reusing the 25-round loop) → streamed messages back → done.**

1. **Send.** `POST /conversations/:id/messages` with the user's text. Server: inserts a `user`/`text` message (next `seq`); builds the run's message history from the WHOLE prior thread (cross-turn resume); creates a run bound to the operator agent with an instance-reach token; stamps `active_run_id`; starts the runner; returns the run id. UI subscribes to the stream.

2. **Run (core loop reused as-is).** The existing runner drives the provider stream through `MAX_TOOL_ROUNDS = 25`. Two adapters wrap it — the core loop is untouched:
   - **Inbound adapter** — conversation thread → the runner's `messages[]` (user/operator/tool history), REPLACING the current "parent.body + comments" seed. This IS the cross-turn resume: prior turns' text + tool results replayed so the operator has full memory. Delivered by extending `handleResumeRun`'s history source, not a new path.
   - **Outbound adapter** — instead of posting `kind=result` comments on a parent document, each output unit becomes a `messages` row: operator prose → `text`; each real Folio tool run → a `tool_step`; each `ui` tool call → a `component`. Delivered by generalizing the `postAgentComment` sink.

3. **Stream.** Reuse the SSE channel + `useEventStream`. As the runner emits, the server pushes message rows; the thread renders live (prose streams token-by-token; tool steps + components pop in). On completion the runner clears `active_run_id`.

4. **The `ui` tool.** New tool in the operator's toolset, two validated shapes:
   - `show_link_panel({ target, title, subtitle? })` → a `link_panel` component row.
   - `ask_choice({ prompt, options })` → a `choice_card` component row. This PAUSES the turn: the run completes (operator "waiting for your pick"); the card is live.

5. **Interactive continuation.**
   - **`link_panel` click** → frontend navigates the main area to the target; cockpit stays open; NO run. Pure navigation (a smart link).
   - **`choice_card` button click** → `PATCH` the message to set `chosen` (locks the card), then START A NEW TURN with the chosen label as the user message — the SAME code path as typing it. The operator resumes with full context (the resume includes the card + the choice). The action thus goes THROUGH the operator (preserving multi-turn memory), which is correct for an operator meant to drive.

6. **Concurrency.** One active run per conversation. While `active_run_id` is set, the composer shows "operator is working…" and blocks a second send. (Single active thread → simple.)

### Operator content (`__system`) — capability is content, not code

The operator's behavior is authored as `__system` documents it loads via the existing skill-load path (Piece B). NOT hardcoded in the runner.

- **skill** — the existing seeded `folio` skill (the API manual). Unchanged.
- **`agent.md`** — operating instructions / identity: "You are the Folio operator. You help the user run their workspaces…"; the topic-steer ("if asked something outside Folio, briefly + warmly point back to what you can help with here; don't refuse coldly, redirect"); act-then-report ("do the work, then report; prefer acting over asking; when you change something, surface a link via `show_link_panel`; use `ask_choice` only when a real fork needs the user's input"); authority honesty (keep the existing refuse-with-plan when scopes/risk floor won't allow it).
- **`soul.md`** — persona / voice. Separate from `agent.md` so voice tunes independently of instructions.
- **reference files** — the setup-reference docs (the seeded `SETUP_PROJECT_REF_BODY` and siblings). "Set up a CRM-style project" → operator reads the reference → creates project + table + fields + a starter view. No new template system; reuses seeded `__system` reference docs. Adding a template = drop a file in `__system`, no rebuild.

Because identity, persona, and capability are separate files, voice tunes without touching instructions, and templates extend by content. Their actual prose is an AUTHORING task (content), not engineering.

### Topic fence (prompt nudge + tool boundary)

- **Tool boundary (the real fence):** the operator holds ONLY Folio tools (existing operator toolset + the new `ui` tool). No web search, no general compute, no shell. It can chat about anything but can only DO Folio things — off-topic asks have no tool to satisfy, so it has nothing to act on and the prompt steers it back.
- **Prompt nudge:** the `agent.md` topic-steer above. Advisory, not airtight — a user who wants to chit-chat can; the operator just won't be useful at it and redirects. Correct tradeoff for an internal back-office tool.

### UI — inside the existing cockpit shell

Everything mounts inside `AgentCockpitPanel` (resize via `useResizableWidth`, the panel bus, the header). Activity/Run tabs are removed; the body becomes a chat.

- **Header** (reused `PanelHeader`) — conversation title (or "Operator"); actions: **New chat**, **close** (= human-only mode). No tabs.
- **Thread** (scrollable) — messages by `kind`:
  - `text` (user) — plain bubble.
  - `text` (operator) — markdown, streams token-by-token.
  - `tool_step` — compact one-line row (icon + `summary` + status tick); quiet, scannable.
  - `link_panel` — clickable card (title + subtitle + target-type icon); click navigates, cockpit stays open.
  - `choice_card` — prompt + buttons; after a click, locks to the chosen option (others disabled).
- **Empty state** — centered "Good afternoon, <name>." + composer, with a "Recent chat · <title>" pill to resume the single prior thread (v1).
- **Composer** (reused form primitives) — textarea ("Ask anything…"), submit on Enter; while a run is active, "operator is working…" + blocks a second send.

Behavior: thread reads from `messages (conversation_id, seq)` then live-tails the SSE channel (the seed-history-then-tail pattern the Activity feed already uses). `link_panel` navigation uses TanStack Router to push the main area; the panel is layout-level so it persists across navigation. Default-open on app load via the panel bus to the active/most-recent conversation; if the user closed it last session, respect that (persist the open/closed bit, like the resize width).

**Files (new, presentational):** `cockpit-chat.tsx` (replaces the tab body), `message-list.tsx`, `message-text.tsx`, `message-tool-step.tsx`, `message-link-panel.tsx`, `message-choice-card.tsx`, `chat-composer.tsx`.
**Reused:** panel shell, header, bus, `useResizableWidth`, `useEventStream`, form/button/card primitives.
**Deleted:** `activity-feed-screen.tsx`, `agent-run-launcher.tsx` (+ their tab wiring in `agent-cockpit-panel.tsx`).

### Error handling (reuse existing surfaces)

- **Run failure mid-turn** — the runner's terminal failure handling (`MAX_CONSECUTIVE_TOOL_ERRORS`, fatal-tool-error termination) stands. On failure the outbound adapter writes a final `text` message ("I hit an error: …") and clears `active_run_id` so the composer unblocks. No new error path.
- **Authority refusal** — already a graceful refuse-with-plan in the operator's output; renders as a normal `text` message. Not an error.
- **Malformed component** — cannot reach the frontend: the `ui` payload is Zod-validated at the tool boundary; a bad call is a tool error the model sees and retries (existing loop).
- **Provider/BYOK missing** — the existing "AI not configured" graceful-hide (BYOK invariant); the cockpit degrades to closed, same as other AI features.
- **Stream drop / reload** — thread reads from the table (source of truth) on mount then live-tails; a dropped SSE just re-seeds.
- **Stale `active_run_id`** — boot recovery clears a conversation whose run is no longer running (mirrors the runner's existing orphaned-run recovery).

---

## Testing (per testing-workflow gates)

- **Server unit** — conversation/message CRUD + `seq` ordering; the inbound adapter (thread → runner `messages[]`, including a `choice_card` + `chosen` in history); the outbound adapter (tool call → `tool_step`; `ui` call → validated `component`); the markdown serializer; `active_run_id` lifecycle + boot recovery; the `ui` tool's Zod validation (reject malformed).
- **The wiring assertion (the one that matters — per `end-to-end-assertion-at-wiring-task`):** ONE test running a full turn through the REAL runner loop — user message → operator calls a real Folio tool → `tool_step` row → operator calls `ask_choice` → `choice_card` row → simulate a button click → new turn resumes with the choice in history. Seam-only tests miss feature-nullifying integration bugs.
- **Web (vitest, NOT bun test):** message renderers per kind; `link_panel` click navigates + cockpit stays open; `choice_card` click locks + sends a turn; composer blocks while a run is active; default-open-on-load + respect-last-closed.
- **Shake-out (real BYOK key):** a real conversation — "create a workspace and set up a CRM project" → assert the operator acts, `tool_step`s appear, the link panel resolves, a `choice_card` round-trips. The real-key gate (same model as prior phases).
- **No claude-code:** a test asserts the chat operator uses the API path only (claude-code stays hard-disabled).

---

## Out of scope (explicit deferrals)

- **Multi-thread list / thread switcher** — v1 is a single active thread + resume; the table is modeled for many threads (no rework). The list is a fast follow-up.
- **Component types beyond `link_panel` + `choice_card`** — the `ui` tool is a closed set; new types are a small server+web change later (forms, tables-in-chat, charts, etc.).
- **claude-code provider** — stays hard-disabled (CC-DISABLED-1).
- **Confirm-gate flow** — deliberately not built; act-then-report leans on visibility + links + the existing risk floor.
- **`agent.md` / `soul.md` / reference-file PROSE** — authored as content, separate from this engineering plan.

---

## Dependencies

- **HARD precondition:** `spec/agent-authority-and-skills` merged (Piece A reach + Piece B `__system` skill resolution). See the precondition block at the top.
- Reuses: `runner.ts` core loop, `handleResumeRun`, `postAgentComment` sink, the tool registry + boundary, the SSE/event stream + `useEventStream`, the authority/risk floor, BYOK key resolution, the `AgentCockpitPanel` shell + bus + `useResizableWidth`, the seeded `__system` operator skill + reference docs.

---

## Plan-time obligations (per CLAUDE.md §2/§3)

When this goes to writing-plans (after the authority branch merges):

- **threat-modeling** — REQUIRED. This touches: instance-reach token authority in a new surface, untrusted parsing (`ui` tool payloads, `choice_card` button input fed back as a turn), the multi-tenancy boundary (an instance-reach operator acting across workspaces from one conversation), and conversation content the operator reads. Produce the inline `## Threat model` section before task breakdown.
- **architecture-invariants** — REQUIRED. Cite the convergence points this routes through (runner loop, typed-output sink, event stream, tool boundary, authorization/risk floor) and assert no bypass — especially that the chat run path goes THROUGH the authority/risk floor, not around it (the cc fork lesson from Phase C: a "deterministic bound" must name which execution path enforces it).
