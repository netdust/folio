# Design: `claude-code` runner backend (Phase 3.x)

_Status: design approved 2026-05-31. Implementation plan next (writing-plans)._

## Context & motivation

Folio's Phase-3 agent runner executes agents by streaming from a BYOK AI provider
(`anthropic` / `openai` / `openrouter` / `ollama`) through an inner tool-execution
loop that Folio owns. This spec adds a fifth backend, **`claude-code`**, that
executes an agent via the local `claude` CLI instead of an API provider.

The driving use case is making Folio the cockpit for a fleet of WordPress sites
(the netdust-wp-manager integration): a Folio agent runs a maintenance runbook
(health → backup → update → verify → log) by spawning Claude Code, which uses the
host's own SSH config, `wp` CLI, scripts, and skills to do the work — exactly as a
human running `claude` in a terminal does today. But the backend is **general**:
"run a Folio agent as Claude Code instead of via the API" is useful to anyone, on
VPS too, and is the agent engine both the WP-fleet and the (later) callcenter
verticals depend on.

### Why this is a backend, not a plugin

Decided during brainstorming (see the conversation that produced this spec): Folio
should **not** grow a plugin system. Instead it gains a small set of general
*primitives*, and verticals (WP-fleet, callcenter) are **content + config** on top
of them. The `claude-code` backend is one such primitive. The WP-fleet itself is
then pure content — a runbook agent document + frontmatter fields + (later) a
file-sync config — with **zero vertical code**.

### Relationship to the rest of the roadmap

- **Webhooks** (inbound → document) are already **Phase 4**. Not in scope here.
- **Outbound webhook/script trigger actions** are already **Phase 3.5**. Not here.
- **External sync (CMS bridge)** is **Phase 5**, which defines a sync **adapter
  interface**. The WP "keep `site.yml` in sync" need is deferred to a **file-sync
  adapter built on Phase 5's interface, AFTER Phase 5** — so the adapter interface
  is designed once (by Phase 5) and reused, not duplicated. **File-sync is out of
  scope for this spec.**
- **Near-term "keep `site.yml` in sync" is answered by THIS backend, not by a sync
  engine**: until file-sync lands, a `claude-code` run reads `site.yml` and
  `create_document`/`update_document`s the fleet rows over MCP as a runbook step.
  File-sync later upgrades that from agent-triggered to automatic/continuous.

## Goals

1. A `claude-code` provider backend usable by any agent document.
2. CC runs its own agentic loop to completion; Folio captures the result + full
   transcript.
3. CC's writes back into Folio are governed by the **same** scope + project
   allow-list + autonomy model as any other agent — no privilege backdoor.
4. Off by default; explicit opt-in; safe to leave disabled on hosted/VPS installs.

## Non-goals (named deferrals)

- **File-sync / continuous `site.yml` import** — deferred to a post-Phase-5
  adapter on Phase 5's sync interface.
- **Mid-run / model-initiated approval** — CC runs its own loop; Folio cannot pause
  *between* CC's internal steps. v1 ships a **pre-run** gate only. Mid-run approval
  stays the existing Phase-3.x "model-initiated approval" deferred item. The
  "stop and ask mid-task" experience is achievable as a **runbook content pattern**
  (CC posts a `kind=plan` comment and exits; a follow-up run resumes after
  approval) using the approval-comment flow that already exists.
- **Live transcript streaming** — v1 captures the full transcript at completion
  (fidelity C below). Upgrading to live step-by-step streaming (parsing
  `claude --output-format stream-json` into comments as they arrive) is a later
  enhancement with **no data-model change**.
- **Per-agent working directory** — v1 runs CC in Folio's own cwd (see Decisions).
  A per-agent `working_dir` field is a trivial later addition if ambient-context
  loss bites.
- **The WP-fleet content itself** (runbook agent doc, fleet fields, fleet view) —
  separate work; it is *content built on* this backend, not part of it.

## Architecture

### A branch, not an `AIProvider` implementation

The existing `AIProvider.stream()` contract is *messages-in → token/tool-call-events
-out*, because the runner owns the tool loop and feeds Folio's DB tools back between
turns. Claude Code runs its **own** loop — it executes its own tool calls (SSH,
files, MCP) and produces a final result. Forcing CC into `stream()` would marshal
tool calls back and forth pointlessly and fight CC's nature.

Therefore: when a run's `provider === 'claude-code'`, the runner takes a **separate
execution path** (a `claude-code` executor), parallel to the provider-loop path. It
does **not** register in the `AIProvider` REGISTRY.

```
runner.runAgent(run)
  ├─ preflight (allow-list, budget, resume validation) — UNCHANGED
  ├─ key check — now PROVIDER-CONDITIONAL (claude-code skips no_ai_key)
  ├─ pre-run approval gate (requires_approval → awaiting_approval) — reuses Phase 3
  └─ branch on provider:
       ├─ anthropic/openai/openrouter/ollama → runLoop() [EXISTING, unchanged]
       └─ claude-code                        → ccExecute() [NEW]
```

### `ccExecute()` — the new executor

1. **Resolve prompt + context.** The run already snapshots the agent body into
   `frontmatter.system_prompt` at creation. CC's host context comes from the
   **prompt**, not the cwd (since cwd is Folio's own — see Decisions). The runbook
   agent body must therefore be self-describing (tell CC which paths / `site.yml`
   to read).
2. **Wire Folio MCP auth.** Pass the run's **auto-minted API token** (already
   created by the runner, `runner.ts:~273`, scoped to the agent's tools + project
   allow-list) into CC's MCP server config, so CC-over-MCP calls back into Folio
   under the agent's exact envelope. Optional `--model` if the agent pins one.
3. **Spawn.** `claude -p "<prompt>"` (+ `--model`, + MCP config) as a subprocess in
   **Folio's own cwd**. Capture stdout/stderr.
4. **Capture (fidelity C).** On completion:
   - Post CC's **final result** as the run's `kind=result` comment on the parent
     work_item/page (same path as `postResultAndComplete` today).
   - Write CC's **full session transcript** to the **run document's `body`**
     (currently unused for runs — **no schema change**).
5. **Map exit → run state machine.**
   - clean exit → `completed`
   - non-zero / spawn error / timeout → `failed` with `error_reason` + `error_detail`
   - cancel → existing cancel path; terminate the subprocess.

### Permission model (unchanged from Phase 3)

- **Folio-side:** CC's writes back into Folio are gated by the per-run minted token —
  identical tools/scopes/project allow-list as an API-loop agent. CC is a different
  *engine* behind the same envelope, **not** a backdoor around allow-lists.
- **Host-side:** CC's local powers (SSH to sites, reading `site.yml`, running `wp`,
  scripts) are governed by the **machine + CC's own permissions** — outside Folio's
  envelope, by design. This is the same trust model as running `claude` in a
  terminal. Folio's token does not (and cannot) gate host-side actions.

### Pre-run approval gate (the risk tier)

`requires_approval: true` → run enters `awaiting_approval` **before** CC is spawned.
The approver sees the task + target + which runbook will run, then approves/rejects
via the existing `kind=approval` / `kind=rejection` comment flow. On approve → CC
spawns and runs autonomously to completion. `requires_approval: false` → spawns
immediately. This maps directly onto the WP risk tiers: `risk: high` sites
(vad-vormingen) use `requires_approval: true`; `risk: low` sites run unattended.

## Data model changes

- **No migration.** Provider enum widening + optional `model` are Zod-schema-only;
  the transcript reuses the existing run `body` column.
- `agent-run-schema.ts` / `agent-schema.ts`: add `claude-code` to `providerSchema`.
- `model` becomes **optional** when `provider === 'claude-code'` (passed as
  `--model` if present; otherwise CC's own default).
- Run `body`: documented as the transcript store for `claude-code` runs.

## Core changes (small)

| File | Change |
|------|--------|
| `lib/cc-executor.ts` (new) | spawn / capture / state-map logic (the meaty part) |
| `lib/runner.ts` | branch on `provider === 'claude-code'`; make the key-check provider-conditional |
| `lib/agent-run-schema.ts`, `lib/agent-schema.ts` | add `claude-code` to provider enum; `model` optional for it |
| provider registry | **unchanged** — `claude-code` is NOT an `AIProvider` |
| agent form UI (`ProviderModelField`) | show `claude-code` option only when the flag is on; hide gracefully when off (mirrors how BYOK features hide without a key) |

## Enablement & safety

- **`FOLIO_CLAUDE_CODE_ENABLED` env flag, default `false`.** Spawning a local
  `claude` process with host SSH access is powerful; a hosted/multi-user/VPS Folio
  must not have it on unless deliberately enabled. Local/personal installs flip it
  on.
- When off: `claude-code` is not a selectable provider in the agent form, and a run
  that somehow names it fails preflight with a clear reason.
- Subprocess lifecycle: bounded by the run's existing cancel path; a configurable
  timeout maps to `failed`.

## Decisions (locked in this spec)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Output fidelity | **C** — final result as `kind=result` comment + full transcript in run `body` |
| 2 | CC → Folio auth/scope | **A** — reuse the per-run minted token; identical envelope to an API agent |
| 3 | Autonomy gate | **A** — pre-run approval only; mid-run approval deferred (runbook pattern covers "ask mid-task") |
| 4 | Working directory | Folio's own cwd; host context comes from the prompt (per-agent `working_dir` deferred) |
| 5 | Enablement | `FOLIO_CLAUDE_CODE_ENABLED=false` by default; graceful UI hide when off |
| 6 | Integration shape | A branch in the runner, NOT an `AIProvider` impl |

## Testing strategy

- **Unit:** `ccExecute()` with a mocked subprocess — assert: clean exit →
  `completed` + result comment posted + transcript written to body; non-zero →
  `failed` with `error_reason`/`error_detail`; cancel terminates the process; the
  minted token is wired into the MCP config (scopes unchanged).
- **Schema:** provider enum accepts `claude-code`; `model` optional only for it;
  rejects `claude-code` runs when the flag is off (preflight).
- **Permission:** a `claude-code` run's minted token carries exactly the agent's
  scopes + allow-list (no widening vs. an API agent).
- **Gate:** `requires_approval: true` → `awaiting_approval` before any spawn;
  approve → spawn; reject → `rejected` with no spawn.
- **Integration (manual, local-only):** a real `claude -p` run that calls back into
  Folio over MCP (`update_document`) and completes — proving the loop end-to-end on
  a read-only task before any maintenance runbook touches a site.

## Out-of-scope follow-ups (roadmap)

1. **WP-fleet content** — runbook agent doc + fleet fields + fleet view (built on
   this backend; near-term import via a `claude-code` run reading `site.yml`).
2. **Phase 5 (CMS bridge)** — ships the sync adapter interface.
3. **Post-Phase-5 file-sync** — a file adapter on Phase 5's interface; upgrades
   `site.yml` import from agent-triggered to automatic.
4. **Live transcript streaming** (C→B) — no data-model change.
5. **Mid-run / model-initiated approval** — existing Phase-3.x item.
6. **Per-agent `working_dir`** — if ambient-context loss bites.
