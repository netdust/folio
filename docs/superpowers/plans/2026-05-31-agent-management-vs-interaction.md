# Agent Management vs. Interaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split agent *management* (create/list/edit) onto a combined "Agents & Triggers" workspace page, leaving the cockpit slidepanel for *interaction* only (give work + watch + results).

**Architecture:** Web-only IA change. A new `/w/:wslug/agents` route renders a two-tab page (Agents | Triggers) reusing the existing `?wdoc=` config slideover for editing. The cockpit panel drops its agents-management screen. No backend changes.

**Tech Stack:** React + TanStack Router, Vitest + RTL. Tests run from `apps/web` via `npx vitest run`. Typecheck: `cd apps/web && bun x tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-05-31-agent-management-vs-interaction-design.md`

---

## File map

- `apps/web/src/components/views/workspace-agents-tab.tsx` — CREATE. The Agents tab body: list agents (title, `provider·model`, `projects` chips) + New-agent create. Adapted from `agent-panel/agent-list.tsx`.
- `apps/web/src/components/views/workspace-automation-page.tsx` — CREATE. Tab wrapper (Agents | Triggers) hosting `WorkspaceAgentsTab` + the existing triggers list body.
- `apps/web/src/components/views/workspace-triggers-page.tsx` — MODIFY. Keep `WorkspaceTriggersPage` as the Triggers tab body (it already is a self-contained list+create); the page wrapper now renders it under a tab.
- `apps/web/src/routes/w.$wslug.agents.tsx` — CREATE. Route → `WorkspaceAutomationPage`, `validateSearch: { wdoc?, tab? }`.
- `apps/web/src/routes/w.$wslug.triggers.tsx` — MODIFY. Redirect to `/w/:wslug/agents?tab=triggers`.
- `apps/web/src/lib/agent-panel-bus.ts` — MODIFY. `AgentPanelScreen` drops `'agents'`.
- `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` — MODIFY. Remove the Agents tab + `AgentList` import.
- `apps/web/src/components/agent-panel/agent-list.tsx` — DELETE (logic moves to `workspace-agents-tab.tsx`).
- `apps/web/src/components/agent-panel/agent-list.test.tsx` — DELETE (replaced by the tab test).
- `apps/web/src/routes/w.$wslug.tsx` — MODIFY. `onOpenAgents` navigates to the page (manage); a separate affordance opens the panel (interaction).
- `memory/DECISIONS.md` — MODIFY. Record the split.

---

## Task 1: Agents tab body (`WorkspaceAgentsTab`)

Move the panel's `AgentList` into the views layer as the Agents tab, adding `provider·model` + `projects` chips (the spec's at-a-glance workspace-scoping cue).

**Files:**
- Create: `apps/web/src/components/views/workspace-agents-tab.tsx`
- Test: `apps/web/src/components/views/workspace-agents-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/views/workspace-agents-tab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi, beforeEach } from 'vitest';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

const agentsData = [
  { id: '1', slug: 'writer', title: 'Writer', frontmatter: { provider: 'anthropic', model: 'claude-haiku-4-5', projects: ['*'] } },
];
vi.mock('../../lib/api/workspace-documents.ts', () => ({
  useWorkspaceAgents: () => ({ data: agentsData, isLoading: false }),
  useCreateWorkspaceDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => navigateMock.mockReset());

test('lists agents with provider·model + projects chips', () => {
  wrap(<WorkspaceAgentsTab wslug="netdust" />);
  expect(screen.getByText('Writer')).toBeInTheDocument();
  expect(screen.getByText(/anthropic·claude-haiku-4-5/)).toBeInTheDocument();
  expect(screen.getByText('All projects')).toBeInTheDocument();
});

test('clicking an agent row opens its config via ?wdoc=', async () => {
  wrap(<WorkspaceAgentsTab wslug="netdust" />);
  await userEvent.click(screen.getByText('Writer'));
  expect(navigateMock).toHaveBeenCalledWith(
    expect.objectContaining({ to: '.', search: expect.any(Function) }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/views/workspace-agents-tab.test.tsx`
Expected: FAIL — module `./workspace-agents-tab.tsx` not found.

- [ ] **Step 3: Implement the tab**

Create `apps/web/src/components/views/workspace-agents-tab.tsx`. Adapt `agent-panel/agent-list.tsx` verbatim, adding the chips. `provider`/`model`/`projects` read off `agent.frontmatter` (typed `Record<string, unknown>`):

```tsx
import { Loader2, Plus } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { formatApiError } from '../../lib/api/index.ts';
import {
  useCreateWorkspaceDocument,
  useWorkspaceAgents,
} from '../../lib/api/workspace-documents.ts';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';

interface Props {
  wslug: string;
}

/**
 * Agents tab of the workspace automation page. Lists workspace agents with
 * provider·model + project-allow-list chips (so workspace-scoping is visible at
 * a glance), plus a "New agent" create. Row click + create both set
 * `?wdoc=<slug>` on the CURRENT route (`to: '.'`) so the layout-mounted config
 * slideover opens. `wdoc` (NOT `doc`) avoids colliding with the project
 * DocumentSlideover's `?doc=`.
 */
export function WorkspaceAgentsTab({ wslug }: Props) {
  const navigate = useNavigate();
  const agentsQ = useWorkspaceAgents(wslug);
  const create = useCreateWorkspaceDocument(wslug);
  const agents = agentsQ.data ?? [];

  const openAgent = (slug: string) =>
    void navigate({
      to: '.',
      search: (prev) => ({ ...(prev as Record<string, unknown>), wdoc: slug }),
    });

  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({
        type: 'agent',
        title: 'Untitled',
        body: '# Prompt\n\nDescribe this agent: its role, and what it should do on every run.',
        frontmatter: { model: 'claude-haiku-4-5', provider: 'anthropic', tools: [] },
      });
      openAgent(created.slug);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const createButton = (
    <Button variant="primary" onClick={onCreate} disabled={create.isPending} className="whitespace-nowrap">
      <Icon icon={create.isPending ? Loader2 : Plus} size={14} className={create.isPending ? 'animate-spin' : ''} />
      New agent
    </Button>
  );

  if (agentsQ.isLoading) {
    return <div className="text-sm text-fg-2">Loading…</div>;
  }
  if (agents.length === 0) {
    return (
      <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
        <p>No agents yet.</p>
        <div className="mt-3 inline-block">{createButton}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">{createButton}</div>
      <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
        {agents.map((agent) => {
          const fm = agent.frontmatter as { provider?: string; model?: string; projects?: string[] };
          const providerModel = [fm.provider, fm.model].filter(Boolean).join('·');
          const projects = Array.isArray(fm.projects) ? fm.projects : ['*'];
          const projectLabel = projects.includes('*') ? 'All projects' : `${projects.length} project${projects.length === 1 ? '' : 's'}`;
          return (
            <li key={agent.id} className="px-3 py-2.5">
              <button type="button" onClick={() => openAgent(agent.slug)} className="w-full min-w-0 text-left">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">{agent.title}</div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {providerModel ? (
                      <span className="rounded-sm bg-card px-1.5 py-0.5 font-mono text-[10px] text-fg-3">{providerModel}</span>
                    ) : null}
                    <span className="rounded-sm bg-card px-1.5 py-0.5 text-[10px] text-fg-3">{projectLabel}</span>
                  </div>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-fg-3">/{agent.slug}</div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/views/workspace-agents-tab.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/components/views/workspace-agents-tab.tsx apps/web/src/components/views/workspace-agents-tab.test.tsx
git commit -m "phase-3.x: WorkspaceAgentsTab — agents list with provider·model + projects chips"
```

---

## Task 2: Combined tabbed page + route + redirect

Wrap Agents + Triggers in a two-tab page, mount it at `/w/:wslug/agents`, and redirect the old `/triggers` route.

**Files:**
- Create: `apps/web/src/components/views/workspace-automation-page.tsx`
- Create: `apps/web/src/routes/w.$wslug.agents.tsx`
- Modify: `apps/web/src/routes/w.$wslug.triggers.tsx`
- Test: `apps/web/src/components/views/workspace-automation-page.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/views/workspace-automation-page.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./workspace-agents-tab.tsx', () => ({ WorkspaceAgentsTab: () => <div>AGENTS TAB</div> }));
vi.mock('./workspace-triggers-page.tsx', () => ({ WorkspaceTriggersPage: () => <div>TRIGGERS TAB</div> }));

import { WorkspaceAutomationPage } from './workspace-automation-page.tsx';

test('defaults to the Agents tab; switching shows Triggers', async () => {
  render(<WorkspaceAutomationPage wslug="netdust" tab="agents" onTabChange={() => {}} />);
  expect(screen.getByText('AGENTS TAB')).toBeInTheDocument();
  expect(screen.queryByText('TRIGGERS TAB')).not.toBeInTheDocument();
});

test('renders the Triggers tab when tab=triggers', () => {
  render(<WorkspaceAutomationPage wslug="netdust" tab="triggers" onTabChange={() => {}} />);
  expect(screen.getByText('TRIGGERS TAB')).toBeInTheDocument();
});

test('clicking a tab calls onTabChange', async () => {
  const onTabChange = vi.fn();
  render(<WorkspaceAutomationPage wslug="netdust" tab="agents" onTabChange={onTabChange} />);
  await userEvent.click(screen.getByRole('tab', { name: /triggers/i }));
  expect(onTabChange).toHaveBeenCalledWith('triggers');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/views/workspace-automation-page.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page wrapper**

Create `apps/web/src/components/views/workspace-automation-page.tsx`. The tab state is controlled by the route (URL `?tab=`), so the component takes `tab` + `onTabChange`:

```tsx
import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';
import { WorkspaceTriggersPage } from './workspace-triggers-page.tsx';
import { cn } from '../ui/cn.ts';

export type AutomationTab = 'agents' | 'triggers';

interface Props {
  wslug: string;
  tab: AutomationTab;
  onTabChange: (tab: AutomationTab) => void;
}

const TABS: { value: AutomationTab; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'triggers', label: 'Triggers' },
];

/**
 * Workspace automation page: Agents + Triggers, both workspace-scoped documents,
 * under one destination with two tabs. Editing either opens the layout-mounted
 * config slideover via ?wdoc=. Management lives here; interaction (giving an
 * agent work) lives in the cockpit panel.
 */
export function WorkspaceAutomationPage({ wslug, tab, onTabChange }: Props) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">Agents &amp; Triggers</h1>
        <p className="mt-0.5 text-xs text-fg-2">
          Workspace-scoped agents and the cron/event triggers that fire them.
        </p>
      </header>

      <div role="tablist" className="mb-5 flex gap-1 border-b border-border-light">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => onTabChange(t.value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm',
              tab === t.value ? 'border-fg-1 text-fg' : 'border-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'agents' ? <WorkspaceAgentsTab wslug={wslug} /> : <WorkspaceTriggersPage wslug={wslug} />}
    </div>
  );
}
```

> Note: `WorkspaceTriggersPage` already renders its own `max-w-3xl px-6 py-8` header + list. Nested inside this wrapper that double-pads. In Step 3b, slim `WorkspaceTriggersPage` so it renders ONLY the list body + its create button (drop its outer `<div className="mx-auto max-w-3xl px-6 py-8">` and `<h1>Triggers</h1>` header, since the wrapper now owns the page chrome + heading).

- [ ] **Step 3b: Slim WorkspaceTriggersPage to a tab body**

In `apps/web/src/components/views/workspace-triggers-page.tsx`, change the outer wrapper + header. Replace the `return (` block's opening:

```tsx
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Triggers</h1>
          <p className="mt-0.5 text-xs text-fg-2">
            Cron- and event-driven triggers that fire workspace agents.
          </p>
        </div>
        {createButton}
      </header>
```

with:

```tsx
  return (
    <div>
      <div className="mb-3 flex justify-end">{createButton}</div>
```

(Keep everything from the `{triggers.length === 0 ? (` conditional onward unchanged, and the closing `</div>`.) The loading branch `return <div className="mx-auto max-w-3xl px-6 py-8" ...>` can stay or be slimmed to `<div className="text-sm text-fg-2">Loading…</div>` — slim it for consistency with the tab context.

- [ ] **Step 4: Implement the route + redirect**

Create `apps/web/src/routes/w.$wslug.agents.tsx`:

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceAutomationPage, type AutomationTab } from '../components/views/workspace-automation-page.tsx';

export const Route = createFileRoute('/w/$wslug/agents')({
  // Agents + triggers open in the layout-mounted WorkspaceDocumentSlideover via
  // ?wdoc= (distinct from the project DocumentSlideover's ?doc=). ?tab= selects
  // the active tab so direct links land correctly.
  validateSearch: z.object({
    wdoc: z.string().optional(),
    tab: z.enum(['agents', 'triggers']).optional(),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const active: AutomationTab = tab ?? 'agents';
  return (
    <WorkspaceAutomationPage
      wslug={wslug}
      tab={active}
      onTabChange={(next) =>
        void navigate({
          to: '/w/$wslug/agents',
          params: { wslug },
          search: (prev) => ({ ...(prev as Record<string, unknown>), tab: next }),
        })
      }
    />
  );
}
```

Modify `apps/web/src/routes/w.$wslug.triggers.tsx` to redirect into the new page's Triggers tab:

```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/triggers')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$wslug/agents',
      params: { wslug: params.wslug },
      search: { tab: 'triggers' },
    });
  },
});
```

- [ ] **Step 5: Run test + typecheck + regenerate the route tree**

The TanStack route tree is generated. After adding/removing a route file, the dev server regenerates `routeTree.gen.ts`; if running tests/build without the dev server, regenerate explicitly:

Run: `cd apps/web && npx vitest run src/components/views/workspace-automation-page.test.tsx`
Expected: PASS.

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean. If it errors on `routeTree.gen.ts` not knowing `/w/$wslug/agents`, run the project's route-gen (start `bun --filter @folio/web dev` briefly, or `npx tsr generate` if configured) and re-check. Confirm `routeTree.gen.ts` now contains `/w/$wslug/agents`.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/components/views/workspace-automation-page.tsx apps/web/src/components/views/workspace-automation-page.test.tsx apps/web/src/routes/w.\$wslug.agents.tsx apps/web/src/routes/w.\$wslug.triggers.tsx apps/web/src/components/views/workspace-triggers-page.tsx apps/web/src/routeTree.gen.ts
git commit -m "phase-3.x: combined Agents & Triggers page (/w/:wslug/agents) + /triggers redirect"
```

---

## Task 3: Cockpit panel = interaction only

Remove the Agents management screen from the panel and the `'agents'` bus screen.

**Files:**
- Modify: `apps/web/src/lib/agent-panel-bus.ts`
- Modify: `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx`
- Delete: `apps/web/src/components/agent-panel/agent-list.tsx`
- Delete: `apps/web/src/components/agent-panel/agent-list.test.tsx`
- Test: `apps/web/src/components/agent-panel/agent-cockpit-panel.test.tsx` (existing — update)

- [ ] **Step 1: Update the panel test to assert NO agents screen**

In `apps/web/src/components/agent-panel/agent-cockpit-panel.test.tsx`, remove/adjust any assertion that the panel renders an "Agents" tab or `AgentList`, and add:

```tsx
test('panel exposes only Activity + Run tabs (no agents-management screen)', () => {
  agentPanelBus.open('activity');
  render(<AgentCockpitPanel wslug="netdust" />);
  expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^agents$/i })).not.toBeInTheDocument();
});
```

> Match the existing test file's render/import style (it already imports `agentPanelBus` + `AgentCockpitPanel`). Remove any existing test that drives `screen === 'agents'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/agent-panel/agent-cockpit-panel.test.tsx`
Expected: FAIL — the Agents tab still renders.

- [ ] **Step 3: Drop `'agents'` from the bus**

In `apps/web/src/lib/agent-panel-bus.ts`, line 1:

```typescript
export type AgentPanelScreen = 'activity' | 'run';
```

- [ ] **Step 4: Remove the Agents tab from the panel**

In `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx`: drop the `AgentList` import (line 7) and the `Bot` icon import (line 2 → keep `Activity, Play`), remove the `{ value: 'agents', ... }` TABS entry (line 12), and remove the `{state.screen === 'agents' ? <AgentList .../> : null}` render line (line 38). Final TABS:

```tsx
import { useSyncExternalStore } from 'react';
import { Activity, Play } from 'lucide-react';
import { agentPanelBus, type AgentPanelScreen, type AgentPanelState } from '../../lib/agent-panel-bus.ts';
import { PanelHeader, type PanelTab } from './panel-header.tsx';
import { ActivityFeedScreen } from './activity-feed-screen.tsx';
import { AgentRunLauncher } from './agent-run-launcher.tsx';

const TABS: PanelTab<AgentPanelScreen>[] = [
  { value: 'activity', icon: Activity, label: 'Activity' },
  { value: 'run', icon: Play, label: 'Run' },
];
```

And the body (drop the agents line):

```tsx
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.screen === 'activity' ? <ActivityFeedScreen wslug={wslug} /> : null}
        {state.screen === 'run' ? (
          <AgentRunLauncher wslug={wslug} onLaunched={() => agentPanelBus.open('activity')} />
        ) : null}
      </div>
```

- [ ] **Step 5: Delete the panel's AgentList + its test**

```bash
cd /home/ntdst/Projects/folio
git rm apps/web/src/components/agent-panel/agent-list.tsx apps/web/src/components/agent-panel/agent-list.test.tsx
```

Then confirm nothing else imports it:

Run: `grep -rn "agent-panel/agent-list" apps/web/src`
Expected: no matches.

- [ ] **Step 6: Run test + typecheck to verify**

Run: `cd apps/web && npx vitest run src/components/agent-panel/agent-cockpit-panel.test.tsx`
Expected: PASS.

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean (a leftover `'agents'` reference anywhere would error here).

- [ ] **Step 7: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/lib/agent-panel-bus.ts apps/web/src/components/agent-panel/agent-cockpit-panel.tsx apps/web/src/components/agent-panel/agent-cockpit-panel.test.tsx
git commit -m "phase-3.x: cockpit panel is interaction-only — drop the agents-management screen"
```

---

## Task 4: Navigation — manage on the page, interact in the panel

Make the workspace switcher route "Agents" (manage) to the page, and keep a distinct affordance for the interaction panel.

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx:337-340`
- Modify: `apps/web/src/components/shell/workspace-switcher.tsx` (label/affordance)
- Test: existing `apps/web/src/routes/w.$wslug.test.tsx` or `workspace-switcher.test.tsx` if present

- [ ] **Step 1: Repoint `onOpenAgents` to the page; add a "Work with an agent" panel affordance**

In `apps/web/src/routes/w.$wslug.tsx`, change the switcher wiring (lines 337-340):

```tsx
                  onOpenAgents={() =>
                    void navigate({ to: '/w/$wslug/agents', params: { wslug } })
                  }
                  onOpenTriggers={() =>
                    void navigate({ to: '/w/$wslug/agents', params: { wslug }, search: { tab: 'triggers' } })
                  }
                  onWorkWithAgent={() => agentPanelBus.toggle()}
```

(The panel toggle moves from `onOpenAgents` to a new `onWorkWithAgent`. `agentPanelBus` is already imported at line 29.)

- [ ] **Step 2: Add the `onWorkWithAgent` entry to the switcher**

In `apps/web/src/components/shell/workspace-switcher.tsx`: add `onWorkWithAgent?: () => void;` to the props interface (after `onOpenTriggers`), destructure it, and render a third button in the agents/triggers section (reuse the `Play` or `Bot` icon):

```tsx
            {onWorkWithAgent ? (
              <button
                type="button"
                onClick={onWorkWithAgent}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
              >
                <Icon icon={Play} size={14} />
                Work with an agent
              </button>
            ) : null}
```

(Import `Play` from `lucide-react` alongside the existing `Bot`, `Zap`. Update the section's render guard to include `onWorkWithAgent`: `{(onOpenAgents || onOpenTriggers || onWorkWithAgent) && (`.) Relabel the existing `onOpenAgents` button from "Agents" to "Agents & Triggers" (it now opens the combined page); the `onOpenTriggers` entry may be dropped (the page has the Triggers tab) OR kept as a deep-link — keep it, labelled "Triggers", deep-linking to the tab.

- [ ] **Step 3: Test the nav routing**

Add to the existing route/switcher test (mirror its setup; if `workspace-switcher.test.tsx` exists use it, else add to `w.$wslug.test.tsx`):

```tsx
test('"Agents & Triggers" navigates to the agents page; "Work with an agent" toggles the panel', async () => {
  // render the switcher with spies for onOpenAgents + onWorkWithAgent,
  // click each, assert the right handler fired.
});
```

> Fill the test body using the existing test file's render harness for `WorkspaceSwitcher` (props are plain callbacks — assert the spies fire on click of the labelled buttons). If no switcher test harness exists, assert at the `w.$wslug` level that clicking "Agents & Triggers" calls `navigate` toward `/w/$wslug/agents`.

- [ ] **Step 4: Run test + typecheck**

Run: `cd apps/web && npx vitest run src/components/shell/workspace-switcher.test.tsx src/routes/w.\$wslug.test.tsx`
Expected: PASS (or the subset that exists).

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/routes/w.\$wslug.tsx apps/web/src/components/shell/workspace-switcher.tsx apps/web/src/components/shell/workspace-switcher.test.tsx
git commit -m "phase-3.x: nav — Agents&Triggers opens the page; Work-with-an-agent opens the panel"
```

---

## Task 5: Record decisions + full gates

**Files:**
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Append the decision record**

Add a `## Phase 3.x — Agent management vs. interaction (2026-05-31)` section to `memory/DECISIONS.md`:
- Agent **management** (create/list/edit) lives on `/w/:wslug/agents`, a combined page with **Agents | Triggers** tabs (`?tab=`); `/w/:wslug/triggers` redirects there. Editing uses the existing `?wdoc=` slideover.
- The cockpit panel is **interaction-only** (give work + watch + results); `AgentPanelScreen` dropped `'agents'`; `agent-panel/agent-list.tsx` deleted (its logic now lives in `views/workspace-agents-tab.tsx` with provider·model + projects chips).
- Workspace switcher: "Agents & Triggers" → page (manage); "Work with an agent" → panel (interact) — two distinct destinations.
- New-agent default stays `anthropic` / `claude-haiku-4-5`.

- [ ] **Step 2: Run the full web gates**

Run, from `apps/web`:
- `cd apps/web && npx vitest run` — expect 0 fail (note the known intermittent `list-view-create.test.tsx` flake; rerun once if it alone fails).
- `cd apps/web && bun x tsc --noEmit` — clean.

Server + shared are untouched, but sanity-check nothing imports the deleted file from outside web: `grep -rn "agent-panel/agent-list" apps` → no matches.

- [ ] **Step 3: Commit**

```bash
cd /home/ntdst/Projects/folio
git add memory/DECISIONS.md
git commit -m "docs: record agent management-vs-interaction split"
```

---

## Self-review notes

- **Spec coverage:** combined tabbed page (T2) ✓; Agents tab with provider·model+projects chips (T1) ✓; config slideover unchanged/reused (T1/T2 via `?wdoc=`) ✓; panel interaction-only + bus drop `'agents'` (T3) ✓; distinct nav destinations (T4) ✓; `/triggers` redirect (T2) ✓; DECISIONS (T5) ✓. Out-of-scope items (backend, runs-view polish, claude-code removal) correctly absent.
- **Type consistency:** `AutomationTab = 'agents'|'triggers'` used in T2 page + T2 route + T4 nav search. `AgentPanelScreen = 'activity'|'run'` consistent across T3 bus + panel. `onWorkWithAgent` introduced in T4 step 1 (route) and defined in T4 step 2 (switcher props) — matches.
- **Known divergence to verify at execution:** the TanStack `routeTree.gen.ts` is generated — T2 step 5 calls this out; the implementer must ensure it regenerates and is committed. The triggers-page test does not exist today (no false "port" claim — T2 writes fresh tests).
- **Branch:** `main` is the current branch (the feature branch was merged). This is a fresh slice — consider a dedicated branch (e.g. `phase-3.x/agents-page`) before executing rather than committing straight to `main`.
