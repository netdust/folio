# Phase 3 — Manual QA Scenarios (Agent runner + Sub-phase E surfaces)

Walk every scenario before merging `phase-3/agent-runner` to main. Capture screenshots into `apps/web/tests/manual-qa-phase-3-screenshots/` if anomalies appear.

Prereqs:

- `bun dev` running (API + Vite), fresh DB or demo seed loaded (`bun run scripts/seed-demo.ts`), logged in as `stefan@netdust.be`.
- A workspace with at least one project. For the runner scenarios you need a **real Anthropic key** (BYOK) — the runner makes a live outbound call; there is no in-process stub reachable from the running server (see "Provider-down" notes below).
- Suggested agent for the run scenarios: a "reply-drafter" agent with `system_prompt: "Reply in one short sentence in English."`, `provider: anthropic`, `model: claude-haiku-4-5`, `tools: []` (no tools needed for a plain reply), allow-listed for the test project.

The automated companions live in:

- `apps/web/tests/e2e/phase-3-real-anthropic.spec.ts` — end-to-end assign → run → `kind=result` comment, gated on `FOLIO_TEST_ANTHROPIC_KEY`.
- `apps/web/tests/e2e/phase-3-provider-banner.spec.ts` — provider-degraded banner; **skip-gated** because it needs a server-side provider stub hook that does not exist (see surface 6).

---

## Surface 1 — AI settings tab (provider keys + deep-link)

### 1.1 Configure a key for each of the 4 providers

- [ ] Open `/w/<wslug>/settings` → click the **AI** tab (or navigate to `/w/<wslug>/settings?tab=ai`).
- [ ] **Anthropic:** Provider dropdown = `anthropic`, Model defaults to `claude-opus-4-7` (datalist offers opus/sonnet/haiku). Paste a key → **Test** → "✓ Key validated". **Save key** → toast "Saved anthropic key" → row shows "✓ default saved <date>".
- [ ] **OpenAI:** switch Provider to `openai` (key/model/test reset). Model offers `gpt-4o` / `gpt-4o-mini` / `gpt-4-turbo`. Save → row updates.
- [ ] **OpenRouter:** switch Provider to `openrouter`. Model offers `anthropic/claude-haiku-4-5` / `openai/gpt-4o-mini`. Save → row updates.
- [ ] **Ollama:** switch Provider to `ollama`. A **Base URL** field appears (only for ollama). Placeholder is a public example (`https://ollama.example.com`), and the help line states loopback/private addresses are rejected. Save with a reachable URL → row shows the label and, for non-default API-managed rows, the `→ baseUrl`.
- [ ] Switching the Provider dropdown mid-Test or mid-Save surfaces a truthful **info** toast ("Test/Save completed for previous provider (<name>)") — never a lie about which provider was written.
- [ ] **Remove** on a configured default row clears it back to "— not configured".

### 1.2 "Check key" deep-link lands on `?tab=ai`

- [ ] With a provider degraded (see surface 6) the workspace **provider-health banner** shows a "Check key →" button.
- [ ] Click it → URL becomes `/w/<wslug>/settings?tab=ai&provider=<provider>` and the **AI** tab is active on arrival.
- [ ] (v1 contract) the AI tab opens on its own default provider selection — the `provider` search param is read but not yet pre-selected. Document any drift.

---

## Surface 2 — Assign a work_item to an agent → run → `kind=result` comment

### 2.1 Assignment fires a run that posts a result

- [ ] Open a work_item in the test project. In **Fields**, set **Assignee** to the reply-drafter agent (`agent:<slug>` via the assignee picker — agent must be allow-listed for this project).
- [ ] Within a few seconds the **Comments** tab shows agent-authored comments under the parent. A `kind=plan` / `kind=comment` may precede; the terminal one is a **`result`** chip (`<Chip muted>result</Chip>`).
- [ ] The result comment's author is the agent (`agent:<slug>`), and it carries a `run_id` badge (agent-written comments stamp `run_id`).
- [ ] DB: a `type=agent_run` document exists under the parent (`parent_id`), `status=completed`, with `tokens_in`/`tokens_out` populated.
- [ ] No AI key configured for the workspace → run fails with a `kind=error` comment (`no_ai_key`); no `result` comment.

---

## Surface 3 — Agent slideover Runs tab (run history)

### 3.1 Runs tab lists the agent's execution records

- [ ] Open the agent's slideover (from `/w/<wslug>/agents`, open the agent).
- [ ] Switch to the **Runs** tab. The agent's run history renders for its primary project (first allow-listed project / the project context the slideover opened from), with a note that history is primary-project-scoped in v1.
- [ ] Each row shows: a **status chip** (planning / running / awaiting_approval / completed / failed / rejected), **fired-by** (manual / `trigger:<id>` / assignment), **started-at** (relative time), and tokens (in/out) where present; failed rows show the **error reason**.
- [ ] After running scenario 2.1, a new completed run appears here without a manual reload (live via `useRunsLiveSync`).
- [ ] The Runs tab is read-only — no edit/delete affordances on run rows.

---

## Surface 4 — Agent side-panel (Run launcher + Activity feed)

### 4.1 Toggle the panel from the rail "Agents" tool

- [ ] In the rail, click the **Agents** tool (Bot icon; `aria-label="Agents"`).
- [ ] A right-side panel opens on the **⚡ Activity** screen with a NocoDB-style icon-tab header (title "Agents" · `▶` / `⚡` icon tabs · Close).
- [ ] The header tabs switch between **▶ Run** and **⚡ Activity**; the active tab is highlighted (`aria-pressed`).
- [ ] **Close** (X) dismisses the panel.

### 4.2 ▶ Run launcher

- [ ] On the **▶ Run** screen: an **Agent** select (`Select an agent…` + workspace agents), a **Target document** text input (`document slug`), and an optional **Instruction** textarea.
- [ ] "Run agent →" is disabled until both Agent and Target are set.
- [ ] Pick the reply-drafter, type the target work_item's slug, add an instruction, click **Run agent →**.
- [ ] On success the panel switches to **⚡ Activity** and the new run appears in the feed.
- [ ] On error (404 parent/agent, 403 allow-list, 409 already-active) an inline `role="alert"` message shows the server `error.code`.

### 4.3 ⚡ Activity feed

- [ ] The Activity feed lists recent agent runs (bounded backfill of accessible-project runs + live SSE tail). Each row: *agent · ran on `<doc>` · status chip · fired-by · relative time →*.
- [ ] Trigger a run (scenario 2.1 or 4.2) → a new row prepends live without reload; a started→running transition collapses to one row (deduped by run id).
- [ ] Click a feed row → navigates to that document's slideover, **Comments** tab (where interaction lives).

### 4.4 Cmd-K "Run agent…" opens the panel on Run

- [ ] Press Cmd-K → type "Run agent". The **Run agent…** command is listed (workspace context required).
- [ ] Select it → the agent side-panel opens on the **▶ Run** screen.

---

## Surface 5 — Approval buttons on a `kind=plan` comment

### 5.1 Interactive while awaiting_approval

- [ ] Use an agent with `requires_approval: true`. Assign/run it on a work_item.
- [ ] A **`kind=plan`** comment is posted and the linked run sits at **awaiting_approval**.
- [ ] On the plan comment, **Approve** / **Reject** buttons are interactive (the plan comment carries `run_id`; buttons resolve live run state via `useRun`).
- [ ] **Approve** → POSTs a `kind=approval` comment with the resolved `target_agent`; the poller picks up a new resuming run → it completes (a `result` comment lands).
- [ ] **Reject** → opens a reason popover; submit → POSTs `kind=rejection`; the original run transitions to **rejected** and the agent posts a closing `kind=comment`.

### 5.2 Muted once the run moves on

- [ ] After approve/reject (or once the linked run leaves awaiting_approval), the buttons become **muted**, showing "Approved/Rejected by @x · Nm later" — no longer clickable.
- [ ] Approve via keyword: type `@<agent> approved` in the composer → submits as `kind=approval` → same downstream flow.

---

## Surface 6 — Provider-degraded + reactor-halt banners

> **Automated-test note (F-3).** The provider-degraded banner is **not** covered by a runnable Playwright spec. Driving it requires forcing N consecutive provider failures, and the only provider override hook (`provider.__INTERNAL_TEST_ONLY__` in `lib/ai/provider.ts`) is an **in-process, `NODE_ENV=test`-only** registry stub — unreachable from the e2e stack, which runs the server as a separate `bun run --hot` process over HTTP with no test-only health-injection endpoint. `phase-3-provider-banner.spec.ts` is therefore skip-gated with this rationale. To exercise the banner manually, point the workspace's Anthropic key at an unreachable/invalid endpoint (or revoke the key) and let real runs fail.

### 6.1 Provider-degraded banner (warning)

- [ ] Configure a workspace Anthropic key that will fail (revoked/invalid). Fire ≥ `FOLIO_PROVIDER_DEGRADE_THRESHOLD` (default 3) runs that hit Anthropic; each fails.
- [ ] A **warning** banner appears at the top of the workspace shell: "AI provider(s) degraded: **anthropic**. Recent requests to the provider have been failing." with a **Check key →** button (surface 1.2). `role="alert"`, warning styling.
- [ ] Per `(workspace, provider)`: an Anthropic-degraded banner does NOT appear for OpenAI if OpenAI is healthy.
- [ ] Fix the key → one successful run → the banner clears live (SSE `workspace.provider.recovered`). Cancelled runs are excluded from the degrade window.

### 6.2 Reactor-halt banner (danger)

- [ ] When the reaction-plane dispatcher trips its circuit breaker, a **danger** banner appears: "**Automation paused.** The reaction plane halted after a fault (`<errorClass>`). Agent triggers are not running until it recovers." `role="alert"`, danger styling, **no action link**.
- [ ] The banner shows only the error **class**, never a message or tenant data (threat-model mitigation 53).
- [ ] On recovery the banner clears.

---

## Surface 7 — `[[` wiki-link picker in the body editor

### 7.1 Autocomplete + insertion

- [ ] Open any document's body editor (Milkdown).
- [ ] Type `[[` → the **WikiLinkPicker** opens listing current-project docs (same picker as the Phase-2.6 comment composer).
- [ ] Filter by typing → select a doc → the editor inserts `[[slug]]`.
- [ ] Press ESC while the picker is open → the picker closes, the editor stays focused (does not close the slideover).

---

## Surface 8 — Dark-mode parity on the new surfaces

### 8.1 Spot-check contrast in dark mode

- [ ] Toggle dark mode. Spot-check each new surface for correct contrast and no light-mode bleed:
  - [ ] AI settings tab (provider/model/key inputs, configured-keys list, Test/Save buttons, ✓/✗ result row).
  - [ ] Agent side-panel: PanelHeader, ▶ Run launcher fields, ⚡ Activity feed rows + status chips.
  - [ ] Agent slideover Runs tab (status chips, fired-by, error rows).
  - [ ] `kind=result` / `kind=plan` / `kind=error` comment chips + approval buttons (interactive and muted states).
  - [ ] Provider-degraded banner (warning) + reactor-halt banner (danger).
  - [ ] `[[` WikiLinkPicker.

---

## Sign-off

When every checkbox is ticked (or its anomaly is filed as a shake-out bug), the Phase 3 web manual QA gate is passed. Merge with `--no-ff`.
