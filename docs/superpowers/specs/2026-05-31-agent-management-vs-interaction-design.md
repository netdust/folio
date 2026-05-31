# Agent management vs. interaction — UX split design

_Date: 2026-05-31 · Status: design approved, pending spec review · Scope: web-only_

## Problem

The agent cockpit panel (`apps/web/src/components/agent-panel/`) currently does two unrelated jobs at once:
1. **Managing** agents — the `agents` screen (list/create/configure).
2. **Interacting** with agents — the `run` + `activity` screens (give work, watch, results).

Conflating them causes two concrete UX failures observed in use:
- **It's not clear agents are workspace-scoped.** Agents have no center-page home (Triggers do, at `/w/:wslug/triggers`), so they feel like a floating panel feature rather than workspace-owned documents.
- **Settings-in-a-panel feels wrong.** Configuring an agent (prompt, provider/model, tools, projects) inside the interaction panel is awkward; configuration wants a normal page + slideover.

This is purely a web information-architecture problem. The backend is correct: agents and triggers are already workspace-scoped documents (`type IN ('agent','trigger')`, `project_id IS NULL`), runs already work end-to-end, and the `?wdoc=` config slideover already exists.

## Solution

Separate the two jobs onto the surfaces that suit them:
- **Management → a center page** (create/list/edit), consistent with the existing Triggers page.
- **Interaction → the slidepanel** (give work, watch it run, read results).

### Section 1 — Combined "Agents & Triggers" workspace page

A workspace destination with **two tabs: Agents | Triggers**.

- **Route:** `/w/:wslug/agents` becomes the canonical page. It carries `validateSearch: { wdoc?: string }` (same as the current triggers route) so the layout-mounted `WorkspaceDocumentSlideover` opens on `?wdoc=`.
- **Agents tab:** lists workspace agents — title, `provider·model`, and `projects` chips (so workspace-scoping + the project allow-list are visible at a glance). `+ New agent` creates an agent and opens its config slideover (`?wdoc=<slug>`). Clicking a row opens the same slideover to edit.
  - New-agent defaults (matching today's `agent-list.tsx` create): `provider: 'anthropic'`, `model: 'claude-haiku-4-5'`, `tools: []`, a `# Prompt` starter body. (A fast default model — Haiku — so a first run is quick + cheap; reflects the speed lesson from this session.)
- **Triggers tab:** the existing trigger list + create flow (`workspace-triggers-page.tsx`), moved under this page's second tab. Behavior unchanged.
- **Back-compat:** the existing `/w/:wslug/triggers` route redirects to `/w/:wslug/agents` with the Triggers tab active (preserves any bookmarked/linked URL). Tab state is reflected in the URL (e.g. `?tab=triggers`) so a direct link lands on the right tab.

**Structure:** mirror `workspace-triggers-page.tsx`. New `WorkspaceAutomationPage` wrapper holds the tab strip + renders `WorkspaceAgentsTab` / the existing triggers list. New file `apps/web/src/components/views/workspace-agents-tab.tsx`; `workspace-triggers-page.tsx`'s body is reused as the triggers tab (extract its list into a `WorkspaceTriggersTab` if the page wrapper currently owns layout chrome — keep the diff minimal).

### Section 2 — Config slideover = settings only

The existing `?wdoc=` `WorkspaceDocumentSlideover` is where an agent is **edited**: prompt body, provider·model (`ProviderModelField`), tools, projects, and the envelope fields (`max_delegation_depth`, `max_tokens_per_run`, `requires_approval`). This is the "normal slidepanel for settings" the user asked for. It already does this — the only change is that agent *management* no longer also lives in the cockpit panel, so this slideover (reached from the page) becomes the single edit surface.

No new editor. No change to `?wdoc=` semantics.

### Section 3 — Cockpit slidepanel = interaction only

The cockpit panel (`agent-panel/`) loses its **agents-management screen** and becomes purely "work with an agent":
- **Give work:** pick an agent → type a task → fire a run (`agent-run-launcher.tsx` / the `run` screen).
- **Watch + results:** status (running → done) + result comments (`activity-feed-screen.tsx` / the `activity` screen).
- **Bus change:** `agentPanelBus`'s `AgentPanelScreen` enum drops `'agents'`, keeps `'run' | 'activity'`. The panel opens to `run` (or `activity`) — never to a manage-agents list.
- `agent-list.tsx` (the panel's management list) is removed from the panel; its create logic moves into the Agents tab (Section 1). If `agent-list.tsx` is reused by the new tab, relocate it under `components/views/` rather than `agent-panel/`.

### Section 4 — Navigation

The workspace switcher (`shell/workspace-switcher.tsx`) currently has `onOpenAgents` (opens the cockpit panel) and `onOpenTriggers` (navigates to the page) — an inconsistency that is itself part of the confusion. After this change:
- **"Agents & Triggers"** (or two entries, "Agents" + "Triggers") → navigates to the `/w/:wslug/agents` page (management). The single "Triggers" entry, if kept, deep-links to the Triggers tab.
- **"Work with an agent"** (or the existing Cmd-K "Run agent…" + a panel toggle) → opens the cockpit panel (interaction).

The exact label wording is an implementation detail; the requirement is that **management and interaction are two visibly distinct destinations**, and the management destination is a page (not a panel).

### Section 5 — Out of scope (explicitly)

- **No backend changes.** Agents/triggers data model, run lifecycle, `?wdoc=` semantics, scopes — all untouched.
- **No new agent capabilities.** This is IA/UX only.
- **The slug-immutability / placeholder-reslug / empty-model / cc-context fixes** from earlier this session stay as-is.
- **The runs-view / result-rendering polish** the user flagged ("not clear what I was looking at") is acknowledged but NOT in this spec — it's a separate follow-up. This spec only relocates *where* management vs. interaction live.
- **claude-code provider** — deprioritized by the user ("leave claude code"); not removed, just not the default. New-agent default is `anthropic` + Haiku.

## Testing

- **Route:** `/w/:wslug/agents` renders the tab strip; default tab = Agents; `?tab=triggers` (or tab click) shows the triggers list.
- **Agents tab:** renders each agent with `provider·model` + `projects` chips; `+ New agent` fires create and navigates to `?wdoc=<slug>`; clicking a row sets `?wdoc=<slug>`.
- **Triggers tab:** existing trigger create + list behavior preserved (port existing `workspace-triggers-page.test.tsx` assertions).
- **Back-compat redirect:** navigating to `/w/:wslug/triggers` lands on `/w/:wslug/agents` with the Triggers tab active.
- **Cockpit panel:** `AgentPanelScreen` no longer includes `'agents'` (type-level + a test that the panel renders run/activity and exposes no manage-agents list); `run` + `activity` still function.
- **Nav:** workspace switcher routes "manage" to the page and "work with an agent" to the panel (distinct destinations).

## DECISIONS.md addendum (to record on approval)

- Agent **management** (create/list/edit) lives on a combined `/w/:wslug/agents` page with **Agents | Triggers** tabs; the `/triggers` route redirects there. Editing uses the existing `?wdoc=` slideover.
- The agent **cockpit panel is interaction-only** (give work + watch + results); `AgentPanelScreen` drops `'agents'`.
- New-agent default provider/model is `anthropic` / `claude-haiku-4-5` (fast + cheap first run). claude-code is opt-in, not default.
