# Phase 3 Sub-phase E — Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent surface — run-history on the agent, live approval state in comments, and a toggleable agent side-panel (Run launcher + Activity feed) — on top of the shipped data/realtime hooks, plus a small server change to link plan comments to runs.

**Architecture:** Three surfaces. (1) Approval lives in comments — `approval-buttons.tsx` reflects live run state via the run linked by `frontmatter.run_id`. (2) Run history is a screen on the agent's slideover, backed by `useRuns({agent})`. (3) A toggleable right-side **agent side-panel** with a NocoDB-style icon-tab header and two screens — **▶ Run** (launcher → `POST /runs`) and **⚡ Activity** (SSE-driven workspace feed). SSE only signals "data changed → invalidate / append"; react-query stays the source of truth.

**Tech Stack:** React + Vite + TanStack Router + @tanstack/react-query + native EventSource. Existing primitives: `Chip`, `Button`, `InlineSelect`, `Sheet`, `TabStrip`, `Icon` (lucide). Tests: Vitest (`cd apps/web && bun run test`), Playwright (F).

**Design spec:** `docs/superpowers/specs/2026-05-30-phase-3-E-agent-surface-design.md`. **Supersedes** E-3..E-9 in `2026-05-30-phase-3-E-web-ui.md` (the dead "runs are a TableView" plan). E-1/E-2/E-2b from that plan **shipped and stand** (the data/realtime layer).

---

## Ground-truth reconciliation (verified vs live source at HEAD `4a1cd31`, 2026-05-30)

| Fact | Verified reality |
|---|---|
| Agent slideover | It IS `apps/web/src/components/slideover/workspace-document-slideover.tsx` (no separate agent-slideover). Props: `{ wslug }`. It already has a **`'runs'` tab** (`WorkspaceDocTabValue = 'fields'\|'activity'\|'runs'`) with a placeholder "No runs yet — Phase 3 wires the runner." **E-4 fills that placeholder.** |
| `doc` in the slideover | `useWorkspaceDocument(wslug, slug)` → `{ id, slug, title, type:'agent'\|'trigger', frontmatter, body }`. The agent's allow-list is `doc.frontmatter.projects` (string[]). |
| `Comment.frontmatter.run_id` | **ALREADY exists** in the web type (`apps/web/src/lib/api/comments.ts` `CommentFrontmatter.run_id?: string`). Server schema allows it (`comment-schema.ts:56` `run_id: z.string().uuid().optional()`). |
| **Plan comments are created by** | **the REST API (`POST .../comments` with `kind:'plan'`), NOT the runner.** (SPEC CORRECTION: the spec said "the runner stamps run_id"; the runner only *consumes* plan comments. E-4b threads `run_id` through `createComment` + the comments POST route so the API caller posting a plan comment can include it.) |
| `createComment` | `CreateCommentInput` (services/comments.ts) does NOT accept `run_id` today; frontmatter is built from `{author,kind,visibility,mentions,target_agent,target_agent_id}`. E-4b adds `run_id` passthrough. |
| `run_id` is a UUID? | The comment schema validates `run_id: z.string().uuid()`. **BUT run document ids are nanoid, not UUID** (this bit C-9 — `resume_of` was `.uuid()`, fixed to `.min(1)`). **E-4b MUST verify** whether the run id stamped is a UUID or nanoid and relax the schema to `.min(1)` if nanoid (grep `createRun` id generation). Bake the verified answer in. |
| Approval buttons | `apps/web/src/components/comments/approval-buttons.tsx`, props `ApprovalButtonsProps { planComment, threadComments, workspaceSlug, projectSlug, parentSlug, workspaceMembers, workspaceAgents }`. Has `workspaceSlug` — E-6 reuses it for `useRun`. Guards on `kind=plan` + agent author; renders resolved (muted) vs unresolved (buttons). |
| `?tab=` routing | **Does NOT exist.** Tab state is local `useState('fields')`, resets per doc. E-5's activity-row → comments-tab deep-link requires adding `tab` to the agents route `validateSearch` + syncing it into the slideover's tab state. |
| Cmd-K secondary UI | The palette (`command-palette.tsx`) has NO mechanism to open a side-panel — only `navigate`/`toggleTheme`/`close`. There's a `command-palette-bus.ts` (open/close only). E-5 adds a small panel-open bus/context. `CommandContext` carries `{ pathname, workspaceSlug, projectSlug, navigate, toggleTheme }`. |
| Primitives | `Chip` (`muted`/`mono`), `Button` (`variant:'primary'\|'secondary'\|'ghost'\|'danger'`, `size:'sm'\|'md'\|'lg'`, `loading`), `InlineSelect` (`value/options/onCommit`), `Sheet`/`SheetContent` (right drawer), `Icon` (lucide wrapper). `Shell` has an UNUSED `panel` slot — the natural mount for `AgentSidePanel`. Tailwind tokens: `text-fg/-2/-3`, `bg-card/primary/warning/success`, `border-border-light`. |
| Tests | Vitest. No shared `renderWithProviders` — tests nest `QueryClientProvider`+`RouterProvider` inline. `vi.stubGlobal('fetch')`. `MockEventSource` pattern established in `event-stream.test.tsx`/`runs.test.tsx`. |
| Shipped data layer | E-1 `useEventStream(wslug, {kinds,...}, onEvent)` + `StreamedEvent`. E-2 `useRuns/useRun/useCreateRun/useCancelRun/useRetryRun/useRunsLiveSync` + `runsKeys` + `AgentRunDoc`. E-2b `useProviderHealth/useReactorHealth`. |

---

## Threat model

E inherits mitigations 1–66. The only server change is **E-4b** (thread `run_id` through `createComment` + the comments POST route). `run_id` is a non-sensitive identifier already visible to anyone who can read the run/comment; stamping it into a comment the same caller can already read adds no exposure. The route adds a Zod-validated optional `run_id` to the POST body (validation symmetry — mitigation class "validation at API boundary"). No new endpoint, no new auth surface. Launcher (E-5) + approval (E-6) POST through D's already-gated `/runs` + comment endpoints (autonomy gate mit 54 fires only for agent-bound bearers; a human/session UI caller is allowed by design). The activity feed consumes the SSE stream whose per-bearer allow-list + visibility filters already gate what it sees. **No threat-model extension required; E-4b is covered by existing comment-write gates + boundary validation.**

---

## File Structure

**New (web):**
- `apps/web/src/components/runs/run-status-chip.tsx` (+ `.test.tsx`) — E-3
- `apps/web/src/components/runs/run-row.tsx` (+ `.test.tsx`) — E-3
- `apps/web/src/components/runs/runs-history-section.tsx` (+ `.test.tsx`) — E-4
- `apps/web/src/lib/api/activity-feed.ts` (+ `.test.tsx`) — `useActivityFeed` — E-5c
- `apps/web/src/components/agent-panel/panel-header.tsx` (+ `.test.tsx`) — shared NocoDB icon-tab header — E-5a
- `apps/web/src/components/agent-panel/agent-side-panel.tsx` (+ `.test.tsx`) — E-5a
- `apps/web/src/components/agent-panel/agent-run-launcher.tsx` (+ `.test.tsx`) — E-5b
- `apps/web/src/components/agent-panel/activity-feed-screen.tsx` (+ `.test.tsx`) — E-5c
- `apps/web/src/lib/agent-panel-bus.ts` (+ `.test.ts`) — open/close + initial-tab bus — E-5a
- `apps/web/src/components/shell/provider-health-banner.tsx` + `reactor-halt-banner.tsx` (+ tests) — E-7

**Modified (web):**
- `apps/web/src/components/slideover/workspace-document-slideover.tsx` — fill `'runs'` tab (E-4); add `?tab=` sync (E-5c deep-link target)
- `apps/web/src/routes/w.$wslug.agents.tsx` — add `tab` to `validateSearch` (E-5c)
- `apps/web/src/components/command-palette.tsx` — "Run agent…" command opens the panel (E-5b)
- `apps/web/src/routes/w.$wslug.tsx` — mount `AgentSidePanel` in the `Shell` `panel` slot + a toggle (E-5a)
- `apps/web/src/routes/__root.tsx` — mount the two banners (E-7)
- `apps/web/src/components/comments/approval-buttons.tsx` — live run state (E-6)
- `apps/web/src/components/slideover/workspace-settings.tsx` — honor `?tab=ai&provider=` (E-7)
- `apps/web/src/components/slideover/body-editor.tsx` — `[[` picker (E-8)

**Modified (server, E-4b):**
- `apps/server/src/services/comments.ts` — `CreateCommentInput.run_id` passthrough
- `apps/server/src/routes/comments.ts` — accept optional `run_id` in POST body
- `apps/server/src/lib/comment-schema.ts` — relax `run_id` to `.min(1)` IF run ids are nanoid (verify)

---

### Task E-3: `RunStatusChip` + `RunRow` shared components

**Files:** Create `apps/web/src/components/runs/run-status-chip.tsx` + `.test.tsx`, `apps/web/src/components/runs/run-row.tsx` + `.test.tsx`.

**Scope:** Two presentational components reused by the history section (E-4) and the activity feed (E-5c). `RunStatusChip` maps a run status to a colored `Chip`. `RunRow` renders one run: status chip + agent + doc + fired-by + relative time, with optional tokens/error. No data fetching — pure props.

- [ ] **Step 1: Write the failing test for RunStatusChip**

```tsx
// apps/web/src/components/runs/run-status-chip.test.tsx
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStatusChip } from './run-status-chip.tsx';

describe('RunStatusChip', () => {
  test('renders the status label for each of the 6 run statuses', () => {
    for (const s of ['planning', 'running', 'awaiting_approval', 'completed', 'failed', 'rejected']) {
      const { unmount } = render(<RunStatusChip status={s} />);
      // labels are humanized (underscores → spaces)
      expect(screen.getByText(s.replace('_', ' '))).toBeInTheDocument();
      unmount();
    }
  });

  test('applies a distinct tone class per status group', () => {
    const { container: running } = render(<RunStatusChip status="running" />);
    const { container: failed } = render(<RunStatusChip status="failed" />);
    expect(running.firstChild).not.toBeNull();
    expect(failed.firstChild).not.toBeNull();
    // running and failed must not share the exact same className string
    expect((running.firstChild as HTMLElement).className)
      .not.toBe((failed.firstChild as HTMLElement).className);
  });

  test('falls back gracefully for an unknown status', () => {
    render(<RunStatusChip status="weird" />);
    expect(screen.getByText('weird')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run RED**

Run: `cd apps/web && bun run test src/components/runs/run-status-chip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement RunStatusChip**

```tsx
// apps/web/src/components/runs/run-status-chip.tsx
import { Chip } from '../ui/chip.tsx';

// Tone per status group, using the codebase's semantic Tailwind tokens.
const TONE: Record<string, string> = {
  planning: 'bg-card text-fg-2',
  running: 'bg-primary/10 text-primary',
  awaiting_approval: 'bg-warning/15 text-warning',
  completed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  rejected: 'bg-danger/15 text-danger',
};

export function RunStatusChip({ status }: { status: string }) {
  const tone = TONE[status] ?? 'bg-card text-fg-3';
  const label = status.replace(/_/g, ' ');
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] ${tone}`}>{label}</span>;
}
```

> **⚠️ E-3 ground-truth note (Step 2.5):** Confirm the exact semantic color tokens exist in the Tailwind config (`bg-warning`, `bg-danger`, `bg-success`, `text-primary`). The recon found `bg-card/primary/warning/success` + `text-fg/-2/-3` in use; verify `danger` vs `error` naming (the Button has a `'danger'` variant, so `danger` should exist). Prefer reusing the existing `Chip` primitive if its variants cover these tones; the inline span above is a fallback if `Chip` only supports `muted`/`mono`.

- [ ] **Step 4: GREEN**

Run: `cd apps/web && bun run test src/components/runs/run-status-chip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for RunRow**

```tsx
// apps/web/src/components/runs/run-row.test.tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunRow } from './run-row.tsx';

const run = {
  id: 'r1', slug: 'run-1', type: 'agent_run' as const, title: 'run', status: 'running',
  frontmatter: { agent_slug: 'reply-bot', fired_by: 'assignment', tokens_in: 10, tokens_out: 5 },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), parentId: 'p1', lastTouchedAt: null,
};

describe('RunRow', () => {
  test('renders agent, status, and fired-by', () => {
    render(<RunRow run={run as never} docTitle="Lead #482" />);
    expect(screen.getByText('reply-bot')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText(/assignment/)).toBeInTheDocument();
  });

  test('renders the doc title when provided', () => {
    render(<RunRow run={run as never} docTitle="Lead #482" />);
    expect(screen.getByText(/Lead #482/)).toBeInTheDocument();
  });

  test('calls onClick when the row is clicked', () => {
    const onClick = vi.fn();
    render(<RunRow run={run as never} docTitle="Lead #482" onClick={onClick} />);
    fireEvent.click(screen.getByText('reply-bot').closest('[role="button"]')!);
    expect(onClick).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: RED → implement RunRow → GREEN**

```tsx
// apps/web/src/components/runs/run-row.tsx
import type { AgentRunDoc } from '../../lib/api/runs.ts';
import { RunStatusChip } from './run-status-chip.tsx';

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface RunRowProps {
  run: AgentRunDoc;
  docTitle?: string;
  onClick?: () => void;
}

export function RunRow({ run, docTitle, onClick }: RunRowProps) {
  const fm = run.frontmatter;
  const agent = (fm.agent_slug as string | undefined) ?? '—';
  const firedBy = (fm.fired_by as string | undefined) ?? '';
  const status = (run.status as string | null) ?? (fm.status as string | undefined) ?? 'unknown';
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      className={`px-3 py-2.5 border-b border-border-light text-sm ${onClick ? 'cursor-pointer hover:bg-card' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <strong className="text-fg-2">{agent}</strong>
        {docTitle ? <span className="text-fg-3">· {docTitle}</span> : null}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-fg-3">
        <RunStatusChip status={status} />
        {firedBy ? <span>· {firedBy}</span> : null}
        <span>· {relativeTime(run.createdAt)}</span>
        {fm.error_reason ? <span className="text-danger">· {String(fm.error_reason)}</span> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/runs/ && bunx tsc --noEmit
git add apps/web/src/components/runs/run-status-chip.tsx apps/web/src/components/runs/run-status-chip.test.tsx apps/web/src/components/runs/run-row.tsx apps/web/src/components/runs/run-row.test.tsx
git commit -m "phase-3: RunStatusChip + RunRow shared components (E-3)"
```

---

### Task E-4: `RunsHistorySection` in the agent slideover

**Files:** Create `apps/web/src/components/runs/runs-history-section.tsx` + `.test.tsx`. Modify `apps/web/src/components/slideover/workspace-document-slideover.tsx` (fill the `'runs'` tab placeholder).

**Scope:** A read-only list of an agent's runs for its primary project. Uses `useRuns(wslug, primaryProject, {agent: slug})` + `useRunsLiveSync(wslug, {agent: slug})`. Primary project = the first entry of `doc.frontmatter.projects` (the allow-list), skipping `'*'`. Renders `RunRow`s; empty + loading states.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/runs/runs-history-section.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RunsHistorySection } from './runs-history-section.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} } as unknown as typeof EventSource);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ data: [
      { id: 'r1', slug: 'run-1', type: 'agent_run', status: 'completed', frontmatter: { agent_slug: 'bot', fired_by: 'assignment' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

describe('RunsHistorySection', () => {
  test('renders the agent run rows for the primary project', async () => {
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['marketing', 'sales']} />);
    await waitFor(() => expect(screen.getByText('bot')).toBeInTheDocument());
    expect(screen.getByText('completed')).toBeInTheDocument();
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => String(c[0]).includes('/runs'));
    expect(String(call![0])).toContain('/p/marketing/runs');
    expect(String(call![0])).toContain('agent=bot');
  });

  test('shows an empty state when there are no projects (wildcard-only agent)', () => {
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['*']} />);
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED**

Run: `cd apps/web && bun run test src/components/runs/runs-history-section.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/runs/runs-history-section.tsx
import { useRuns, useRunsLiveSync } from '../../lib/api/runs.ts';
import { RunRow } from './run-row.tsx';

interface RunsHistorySectionProps {
  wslug: string;
  agentSlug: string;
  projects: string[]; // doc.frontmatter.projects (allow-list)
}

export function RunsHistorySection({ wslug, agentSlug, projects }: RunsHistorySectionProps) {
  // Primary project: first non-wildcard allow-list entry. v1 shows one project;
  // full cross-project rollup is deferred (E-FOLLOWUP-2).
  const primary = projects.find((p) => p !== '*');

  useRunsLiveSync(wslug, { agent: agentSlug });
  const runsQ = useRuns(wslug, primary ?? '', { agent: agentSlug });

  if (!primary) {
    return <div className="text-fg-3 text-sm py-8 text-center">No project scoped to this agent yet.</div>;
  }
  const runs = runsQ.data ?? [];
  if (runsQ.isLoading) return <div className="text-fg-3 text-sm py-8 text-center">Loading runs…</div>;
  if (runs.length === 0) return <div className="text-fg-3 text-sm py-8 text-center">No runs yet.</div>;

  return (
    <div>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} />
      ))}
    </div>
  );
}
```

> **⚠️ E-4 ground-truth note (Step 2.5):** `useRuns(wslug, '', ...)` is disabled (enabled guard requires pslug), so the wildcard-only branch returns before the hook matters — but confirm `useRuns` tolerates an empty pslug without firing. Verify `doc.frontmatter.projects` is the correct allow-list key on an agent doc (recon said yes). The component takes `projects` as a prop so the slideover passes `doc.frontmatter.projects` — keep the data-fetching decision (which project) here, not in the slideover.

- [ ] **Step 4: GREEN**

Run: `cd apps/web && bun run test src/components/runs/runs-history-section.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into the slideover's `'runs'` tab**

In `workspace-document-slideover.tsx`, replace the `tab === 'runs'` placeholder block:
```tsx
{tab === 'runs' ? (
  <div className="text-fg-3 text-sm py-8 text-center">
    No runs yet — Phase 3 wires the runner.
  </div>
) : null}
```
with:
```tsx
{tab === 'runs' ? (
  doc.type === 'agent' ? (
    <RunsHistorySection
      wslug={wslug}
      agentSlug={doc.slug}
      projects={(doc.frontmatter.projects as string[] | undefined) ?? ['*']}
    />
  ) : (
    <div className="text-fg-3 text-sm py-8 text-center">Runs apply to agents only.</div>
  )
) : null}
```
Add the import. Re-run the slideover's existing tests for no regression.

- [ ] **Step 6: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/runs/ src/components/slideover/workspace-document-slideover.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/runs/runs-history-section.tsx apps/web/src/components/runs/runs-history-section.test.tsx apps/web/src/components/slideover/workspace-document-slideover.tsx
git commit -m "phase-3: agent run-history section in the runs tab (E-4)"
```

---

### Task E-4b: Server — thread `run_id` through plan-comment creation

**Files:** Modify `apps/server/src/services/comments.ts` (`CreateCommentInput` + frontmatter build), `apps/server/src/routes/comments.ts` (POST body), and verify/relax `apps/server/src/lib/comment-schema.ts` `run_id`.

**Scope:** Let an API caller posting a `kind=plan` comment include `run_id` so the approval UI (E-6) can link the comment to its run. SPEC CORRECTION: plan comments come from the REST API, not the runner — so the change is purely the `createComment` service + route passthrough. Tests run from `apps/server` (`cd apps/server && bun test`).

- [ ] **Step 1: Verify run-id format (decides the schema fix)**

Run: `grep -n "createRun\|nanoid\|crypto.randomUUID\|id:" apps/server/src/services/agent-runs.ts | head` and read how a run document's `id` is generated.
- If run ids are **nanoid** (likely — C-9 found `resume_of` had to move off `.uuid()`), change `comment-schema.ts:56` from `run_id: z.string().uuid().optional()` to `run_id: z.string().min(1).optional()` (with a comment: run ids are nanoid, not UUID).
- If genuinely UUID, leave the schema as-is.
Bake the verified answer into the next steps.

- [ ] **Step 2: Write the failing test** (in `apps/server/src/services/comments.test.ts` or the route test)

```ts
test('createComment threads run_id into plan-comment frontmatter', async () => {
  // create workspace/project/parent + an agent, then:
  const c = await createComment({
    workspace, project, parent, authorContext, actor,
    body: 'Here is my plan',
    kind: 'plan',
    run_id: 'run_abc123',          // the new field
  } as never);
  expect((c.frontmatter as Record<string, unknown>).run_id).toBe('run_abc123');
});
```

- [ ] **Step 3: RED**

Run: `cd apps/server && bun test src/services/comments.test.ts`
Expected: FAIL — `run_id` not on `CreateCommentInput` / not in frontmatter.

- [ ] **Step 4: Implement the passthrough**

In `services/comments.ts`:
- Add `run_id?: string;` to `CreateCommentInput`.
- Destructure it and add to `frontmatterRaw` when defined, BEFORE `commentFrontmatterSchema.parse(...)`:
```ts
if (input.run_id !== undefined) frontmatterRaw.run_id = input.run_id;
```
In `routes/comments.ts` POST handler: add `run_id: z.string().min(1).optional()` to the request-body Zod schema and pass it into `createComment({ ..., run_id })`.

- [ ] **Step 5: GREEN + full server suite**

Run: `cd apps/server && bun test src/services/comments.test.ts && bun test`
Expected: target test PASS; full server suite still **960 pass / 1 skip / 0 fail** (+ your new test). Existing comment tests unaffected (run_id is optional).

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/server && bunx tsc --noEmit
git add apps/server/src/services/comments.ts apps/server/src/routes/comments.ts apps/server/src/lib/comment-schema.ts apps/server/src/services/comments.test.ts
git commit -m "phase-3: thread run_id through plan-comment creation (E-4b)"
```

> **⚠️ E-4b note:** This unblocks E-6's direct `useRun(run_id)` linkage. It does NOT auto-stamp run_id on EVERY plan comment — it adds the *capability*. Whoever posts the agent's plan comment (the agent via MCP/REST, carrying its run context) includes `run_id`. If the agent-side plan-posting doesn't yet pass run_id, that's a follow-up (note it); E-6's client gracefully falls back to "no live state" when run_id is absent.

---

### Task E-5a: `PanelHeader` + `AgentSidePanel` shell + toggle + bus

**Files:** Create `apps/web/src/components/agent-panel/panel-header.tsx` + `.test.tsx`, `apps/web/src/components/agent-panel/agent-side-panel.tsx` + `.test.tsx`, `apps/web/src/lib/agent-panel-bus.ts` + `.test.ts`. Modify `apps/web/src/routes/w.$wslug.tsx` (mount in `Shell` `panel` slot + toggle).

**Scope:** The shared NocoDB-style icon-tab header + the panel shell that hosts the two screens + a tiny pub/sub bus so Cmd-K (E-5b) and a toggle button can open the panel on a chosen tab. The panel screens themselves come in E-5b/E-5c — this task ships the shell with placeholder screen slots.

- [ ] **Step 1: Write the failing test for the bus**

```ts
// apps/web/src/lib/agent-panel-bus.test.ts
import { describe, test, expect, vi } from 'vitest';
import { agentPanelBus } from './agent-panel-bus.ts';

describe('agentPanelBus', () => {
  test('open(tab) notifies subscribers with the requested tab', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.open('run');
    expect(fn).toHaveBeenCalledWith({ open: true, tab: 'run' });
    unsub();
  });
  test('close() notifies subscribers', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.close();
    expect(fn).toHaveBeenCalledWith({ open: false, tab: 'run' });
    unsub();
  });
});
```

- [ ] **Step 2: RED → implement the bus → GREEN**

```ts
// apps/web/src/lib/agent-panel-bus.ts
// Tiny pub/sub so Cmd-K + a toggle can open the agent side-panel on a tab.
// Mirrors the existing command-palette-bus pattern (module-level subscribers).
export type AgentPanelTab = 'run' | 'activity';
export interface AgentPanelState { open: boolean; tab: AgentPanelTab; }

type Listener = (s: AgentPanelState) => void;
const listeners = new Set<Listener>();
let state: AgentPanelState = { open: false, tab: 'run' };

export const agentPanelBus = {
  open(tab: AgentPanelTab = 'run') { state = { open: true, tab }; listeners.forEach((l) => l(state)); },
  close() { state = { ...state, open: false }; listeners.forEach((l) => l(state)); },
  get() { return state; },
  subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l); },
};
```

- [ ] **Step 3: Write the failing test for PanelHeader**

```tsx
// apps/web/src/components/agent-panel/panel-header.test.tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelHeader } from './panel-header.tsx';

const tabs = [
  { value: 'run', icon: '▶', label: 'Run' },
  { value: 'activity', icon: '⚡', label: 'Activity' },
] as const;

describe('PanelHeader', () => {
  test('renders title + a button per tab + close', () => {
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });
  test('clicking a tab fires onTab with its value', () => {
    const onTab = vi.fn();
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={onTab} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /activity/i }));
    expect(onTab).toHaveBeenCalledWith('activity');
  });
  test('clicking close fires onClose', () => {
    const onClose = vi.fn();
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: RED → implement PanelHeader → GREEN**

```tsx
// apps/web/src/components/agent-panel/panel-header.tsx
import { Icon } from '../ui/icon.tsx';
import { X } from 'lucide-react';

export interface PanelTab<T extends string> { value: T; icon: string; label: string; }

interface PanelHeaderProps<T extends string> {
  title: string;
  tabs: PanelTab<T>[];
  active: T;
  onTab: (t: T) => void;
  onClose: () => void;
}

export function PanelHeader<T extends string>({ title, tabs, active, onTab, onClose }: PanelHeaderProps<T>) {
  return (
    <div className="flex items-center gap-2 border-b border-border-light px-3 py-2.5">
      <strong className="flex-1 truncate text-fg">{title}</strong>
      <div className="flex gap-0.5 rounded-md bg-card p-0.5">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-label={t.label}
            aria-pressed={active === t.value}
            onClick={() => onTab(t.value)}
            className={`rounded px-2 py-1 text-sm ${active === t.value ? 'bg-content shadow-sm text-fg' : 'text-fg-3 hover:text-fg-2'}`}
          >
            {t.icon}
          </button>
        ))}
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg">
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}
```

> **⚠️ E-5a ground-truth note (Step 2.5):** Verify the `Icon` import path + lucide usage (recon: `apps/web/src/components/ui/icon.tsx`, `<Icon icon={X} size={16} />`). Confirm the `Shell` component's `panel` slot prop name + how `main`/`rail`/`panel` lay out (recon said `panel` exists but is unused — read `apps/web/src/components/shell/shell.tsx` for the exact prop + grid). If mounting in `Shell.panel` is awkward, mount `AgentSidePanel` as a fixed right-side overlay in `w.$wslug.tsx` instead (it has `wslug` via `useParams`).

- [ ] **Step 5: Implement AgentSidePanel shell + mount + toggle**

`agent-side-panel.tsx`: subscribes to `agentPanelBus`, holds `{open, tab}` in state, renders nothing when closed; when open renders a fixed right-side panel (`w-[360px]`, `Sheet`-like or a plain fixed div) with `PanelHeader` (tabs Run/Activity) + a tab-switched body with **placeholder** screens (`AgentRunLauncher`/`ActivityFeedScreen` arrive in E-5b/E-5c — use `<div>Run…</div>`/`<div>Activity…</div>` placeholders now, wired in those tasks). Takes `wslug` as a prop. Add a test: bus.open('activity') makes the panel render with Activity active; close hides it. Mount `<AgentSidePanel wslug={wslug} />` in `w.$wslug.tsx` + a toggle button (rail tools or header) calling `agentPanelBus.open('activity')`.

- [ ] **Step 6: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/agent-panel/ src/lib/agent-panel-bus.test.ts && bunx tsc --noEmit
git add apps/web/src/components/agent-panel/ apps/web/src/lib/agent-panel-bus.ts apps/web/src/lib/agent-panel-bus.test.ts apps/web/src/routes/w.\$wslug.tsx
git commit -m "phase-3: agent side-panel shell + NocoDB header + open bus (E-5a)"
```

---

### Task E-5b: `AgentRunLauncher` (▶ Run screen) + Cmd-K command

**Files:** Create `apps/web/src/components/agent-panel/agent-run-launcher.tsx` + `.test.tsx`. Modify `agent-side-panel.tsx` (wire the Run screen) + `apps/web/src/components/command-palette.tsx` (add the command).

**Scope:** The launcher screen: pick agent → target (project, optional parent doc) → optional instruction → `useCreateRun().mutate({agent_slug, parent_slug, input})`. The Cmd-K "Run agent…" command calls `agentPanelBus.open('run')`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/agent-panel/agent-run-launcher.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentRunLauncher } from './agent-run-launcher.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/runs')) {
      return new Response(JSON.stringify({ data: { run_id: 'r9', status: 'planning' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ slug: 'bot', title: 'Reply Bot' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('AgentRunLauncher', () => {
  test('submitting agent + parent fires create run + onLaunched', async () => {
    const onLaunched = vi.fn();
    wrap(<AgentRunLauncher wslug="acme" onLaunched={onLaunched} />);
    fireEvent.change(await screen.findByLabelText(/agent/i), { target: { value: 'bot' } });
    fireEvent.change(screen.getByLabelText(/project/i), { target: { value: 'marketing' } });
    fireEvent.change(screen.getByLabelText(/parent|target doc|document/i), { target: { value: 'task-1' } });
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: RED → implement → GREEN**

Build a controlled form: agent input/select, project input, parent-doc input, optional instruction `<textarea>`, "Run agent →" `Button`. On submit call `useCreateRun(wslug).mutateAsync({ agent_slug, parent_slug, input })`; on success call `onLaunched(result)` (the panel switches to Activity). Surface `ApiError.body.error.code` as an inline message on failure. Use the existing `Button` primitive. The test selectors above are illustrative — match the labels you render (use `<label htmlFor>` + `aria-label` so the test queries work).

> **⚠️ E-5b ground-truth note (Step 2.5):** Read `useWorkspaceAgents` (the agents-list hook MentionPicker uses) for the real agent-list shape, and decide agent/project/parent inputs: simplest v1 is plain text inputs or `InlineSelect`. `useCreateRun` needs `parent_slug` (a doc slug) — confirm the launcher collects a doc slug, not an id. Match `command-palette.tsx`'s `matches()`+`<CommandItem onSelect>` pattern for the command; `onSelect` calls `agentPanelBus.open('run')` then `close()` (the palette's own close).

- [ ] **Step 3: Wire the Run screen into AgentSidePanel + add the Cmd-K command**

Replace the E-5a Run placeholder with `<AgentRunLauncher wslug={wslug} onLaunched={() => setTab('activity')} />`. In `command-palette.tsx`, add (in a sensible group, gated on `ctx.workspaceSlug`):
```tsx
{matches({ label: 'Run agent…' }, query) ? (
  <CommandItem onSelect={() => { agentPanelBus.open('run'); onClose?.(); }}>Run agent…</CommandItem>
) : null}
```

- [ ] **Step 4: Full suite + palette test + typecheck + commit**

```bash
cd apps/web && bun run test src/components/agent-panel/ src/components/command-palette.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/agent-panel/ apps/web/src/components/command-palette.tsx
git commit -m "phase-3: agent run launcher + Cmd-K Run agent (E-5b)"
```

---

### Task E-5c: `useActivityFeed` + Activity screen + `?tab=` deep-link

**Files:** Create `apps/web/src/lib/api/activity-feed.ts` + `.test.tsx`, `apps/web/src/components/agent-panel/activity-feed-screen.tsx` + `.test.tsx`. Modify `agent-side-panel.tsx` (wire Activity screen), `apps/web/src/routes/w.$wslug.agents.tsx` (+ `tab` search param), `workspace-document-slideover.tsx` (sync `?tab=` → tab state).

**Scope:** The feed engine + screen. `useActivityFeed(wslug)`: a bounded live-tail list (cap 50) seeded by SSE events (no backfill endpoint exists; v1 seeds from live events only — empty until activity occurs, which is acceptable for a live feed; a future backfill can merge accessible-project runs). Each `agent.run.*` event upserts a feed item keyed by run id (dedup: started→running→completed collapse to one row showing latest status). The screen renders `RunRow`s; clicking a row navigates to the doc slideover + Activity/comments tab via `?doc=<slug>&tab=activity`.

- [ ] **Step 1: Write the failing test for useActivityFeed**

```tsx
// apps/web/src/lib/api/activity-feed.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { useActivityFeed } from './activity-feed.ts';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string; listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  addEventListener(t: string, fn: (e: MessageEvent) => void) { const a = this.listeners.get(t) ?? []; a.push(fn); this.listeners.set(t, a); }
  removeEventListener() {} close() {}
  emit(t: string, data: string) { for (const fn of this.listeners.get(t) ?? []) fn({ data } as MessageEvent); }
}
function wrapper(qc: QueryClient) { return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>; }

beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource); });
afterEach(() => vi.unstubAllGlobals());

describe('useActivityFeed', () => {
  test('appends a feed item on an agent.run event and dedups by run id', () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useActivityFeed('acme'), { wrapper: wrapper(qc) });
    const es = MockEventSource.instances[0]!;
    act(() => es.emit('agent.run.running', JSON.stringify({ id: 'e1', kind: 'agent.run.running', documentId: 'd1', payload: { agent: 'bot', table_id: 't', to: 'running' } })));
    expect(result.current.items).toHaveLength(1);
    // a later event for the same run updates status, does not add a row
    act(() => es.emit('agent.run.completed', JSON.stringify({ id: 'e2', kind: 'agent.run.completed', documentId: 'd1', payload: { agent: 'bot', table_id: 't', to: 'completed' } })));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('completed');
  });
});
```

- [ ] **Step 2: RED → implement useActivityFeed → GREEN**

```ts
// apps/web/src/lib/api/activity-feed.ts
import { useState } from 'react';
import { useEventStream, type StreamedEvent } from './event-stream.ts';

export interface ActivityItem {
  runDocId: string;      // the run document id (event.documentId)
  agent: string;
  status: string;
  firedBy?: string;
  at: number;            // event arrival, for ordering
}

const RUN_KINDS = [
  'agent.run.started', 'agent.run.awaiting_approval', 'agent.run.running',
  'agent.run.completed', 'agent.run.failed', 'agent.run.rejected',
] as const;
const CAP = 50;

// Live-tail feed of agent activity. SSE is the ONLY source (no workspace-wide
// runs-list endpoint exists); items accrue from live events, deduped by run id.
// Justified live-tail state, like useReactorHealth — documented.
export function useActivityFeed(wslug: string) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  useEventStream(wslug, { kinds: [...RUN_KINDS] }, (e: StreamedEvent) => {
    const p = (e.payload ?? {}) as { agent?: string; to?: string; fired_by?: string };
    const runDocId = e.documentId ?? '';
    if (!runDocId) return;
    const status = p.to ?? e.kind.replace('agent.run.', '');
    setItems((prev) => {
      const next = prev.filter((it) => it.runDocId !== runDocId);
      next.unshift({ runDocId, agent: p.agent ?? '—', status, firedBy: p.fired_by, at: Date.now() });
      return next.slice(0, CAP);
    });
  });
  return { items };
}
```

> **⚠️ E-5c ground-truth note (Step 2.5):** Confirm the run-lifecycle event payload keys: started carries `agent`+`table_id`; transitions carry `from`/`to`+`agent`+`table_id` (verified earlier in `services/agent-runs.ts`). `e.documentId` is the run doc id (the row the event targets). For the row → doc-slideover navigation, the feed needs the PARENT doc (the work item), not the run doc — the event payload may not carry the parent slug. Decide: either (a) the row links to the run's parent if the payload carries it, or (b) v1 links to the agent's runs tab. Read the emit payload + pick the reachable target; if parent isn't in the payload, link to the agent slideover Runs tab as the v1 destination and note the limitation.

- [ ] **Step 3: Implement ActivityFeedScreen + `?tab=` deep-link**

Screen renders `useActivityFeed(wslug).items` as rows (reuse `RunRow` where the shape fits, or a small feed-row variant since `ActivityItem` ≠ `AgentRunDoc` — keep `RunRow` for `AgentRunDoc` and make a thin feed row, OR adapt). Empty state "No recent agent activity." Row click → `navigate({ search: { doc: <target>, tab: 'activity' } })`. Add `tab: z.enum(['fields','activity','runs']).optional()` to `w.$wslug.agents.tsx` `validateSearch`; in `workspace-document-slideover.tsx` sync `useEffect(() => setTab(search.tab ?? 'fields'), [search.tab])` and preserve `tab` in the close handler.

> **⚠️ note:** keep `RunRow` for the agent-history (`AgentRunDoc`) and use a SEPARATE small presentational row for the feed if `ActivityItem` doesn't carry enough for `RunRow` — don't force one component to take two shapes (that breaks E-3's clean prop contract). Decide at implementation; DRY where the shapes genuinely match, separate where they don't.

- [ ] **Step 4: Wire Activity screen into AgentSidePanel + full suite + commit**

```bash
cd apps/web && bun run test src/lib/api/activity-feed.test.tsx src/components/agent-panel/ src/components/slideover/workspace-document-slideover.test.tsx && bunx tsc --noEmit
git add apps/web/src/lib/api/activity-feed.ts apps/web/src/lib/api/activity-feed.test.tsx apps/web/src/components/agent-panel/ apps/web/src/routes/w.\$wslug.agents.tsx apps/web/src/components/slideover/workspace-document-slideover.tsx
git commit -m "phase-3: activity feed + screen + ?tab= deep-link (E-5c)"
```

---

### Task E-6: Approval buttons reflect live run state

**Files:** Modify `apps/web/src/components/comments/approval-buttons.tsx` + its test.

**Scope:** When the plan comment carries `frontmatter.run_id`, query the run via `useRun(workspaceSlug, run_id)` and gate the interactive Approve/Reject on `run.status === 'awaiting_approval'`; once the run is running/completed/failed/rejected, fall through to the existing resolved-state rendering (or a muted run-status line). When `run_id` is absent, behave exactly as today (no regression). Reuses the existing `workspaceSlug` prop — no new prop.

- [ ] **Step 1: Write the failing tests** — (a) `run_id` present + run `awaiting_approval` → Approve/Reject buttons render; (b) `run_id` present + run `running` → buttons NOT rendered (muted/resolved instead); (c) no `run_id` → unchanged current behavior. Stub `fetch` for `GET /runs/:id`.

```tsx
// additions to apps/web/src/components/comments/approval-buttons.test.tsx
test('shows interactive buttons when linked run is awaiting_approval', async () => {
  // stub GET /api/v1/w/acme/runs/r1 → { data: { status: 'awaiting_approval', frontmatter:{} } }
  // render ApprovalButtons with planComment.frontmatter = { kind:'plan', author:'agent:bot', run_id:'r1' }
  // assert Approve + Reject present
});
test('hides interactive buttons once linked run is running', async () => {
  // stub GET .../runs/r1 → { data: { status: 'running' } }
  // assert no Approve button
});
test('no run_id → behaves as before (current resolution logic)', async () => {
  // planComment without run_id → existing path unchanged
});
```

- [ ] **Step 2: RED → implement → GREEN**

In `ApprovalButtons`, after the existing guards, read `const runId = planComment.frontmatter.run_id;` and call `const { data: run } = useRun(workspaceSlug, runId);` (the hook is enabled only when `runId` is truthy — already its behavior). Branch: if `runId && run && run.status !== 'awaiting_approval'` → render the muted resolved/status line (reuse existing `findResolution` rendering if a resolution comment exists, else a `RunStatusChip`-style muted line). If `runId && run?.status === 'awaiting_approval'` OR `!runId` (legacy) → existing interactive/resolution logic. Keep all current guards (`kind=plan`, agent author). **Hooks rule:** call `useRun` unconditionally near the top (before the early `return null` guards would skip it) — move the hook above the guards or use the enabled flag; do NOT call a hook after a conditional return.

> **⚠️ E-6 ground-truth note (Step 2.5):** React hooks can't be called after an early `return null`. The current `ApprovalButtons` returns null on the `kind=plan`/agent-author guards BEFORE any hook. Adding `useRun` means restructuring so the hook runs unconditionally (call `useRun(workspaceSlug, planComment.frontmatter.run_id)` at the very top, before the guards). Verify and restructure carefully — this is the one real correctness risk in E-6.

- [ ] **Step 3: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/comments/approval-buttons.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/comments/approval-buttons.tsx apps/web/src/components/comments/approval-buttons.test.tsx
git commit -m "phase-3: approval buttons reflect live run state via run_id (E-6)"
```

---

### Task E-7: Provider-health + reactor-halt banners + AI-tab deep link

**Files:** Create `apps/web/src/components/shell/provider-health-banner.tsx` + `reactor-halt-banner.tsx` (+ tests). Modify `apps/web/src/routes/__root.tsx` (or the `w.$wslug` layout — see note) + `apps/web/src/components/slideover/workspace-settings.tsx`.

**Scope:** `ProviderHealthBanner` reads `useProviderHealth(wslug)`; renders a dismissible banner naming any `degraded` provider with a "Check key →" link to `?tab=ai&provider=<p>`. `ReactorHaltBanner` reads `useReactorHealth(wslug)`; renders a system banner with the error class when `halted`. Mount both where the active workspace is known.

- [ ] **Step 1: Failing tests** — `ProviderHealthBanner`: nothing when all healthy; banner + "Check key" link when one degraded. `ReactorHaltBanner`: nothing when `halted=false`; error-class line when `halted=true`. Stub `useProviderHealth`/`useReactorHealth` (or fetch+EventSource).

- [ ] **Step 2: RED → implement → GREEN** — two small presentational components reading the E-2b hooks. Banner copy + a `Link` to the AI settings tab with `?tab=ai&provider=<p>`. Wire `workspace-settings.tsx` to read `tab`/`provider` search params and preselect the AI tab.

> **⚠️ E-7 ground-truth note (Step 2.5):** `__root.tsx` may not know the active `wslug` (recon: the workspace slug is resolved at the `w.$wslug` layout, not root). If so, mount the banners in `w.$wslug.tsx` (which has `wslug` via `useParams`), NOT `__root.tsx`. Read `workspace-settings.tsx` for the existing tab mechanism + how it reads search params (`useSearch`); confirm the AI tab's existing query-param contract from Phase 2.

- [ ] **Step 3: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/shell/ && bunx tsc --noEmit
git add apps/web/src/components/shell/ apps/web/src/routes/ apps/web/src/components/slideover/workspace-settings.tsx
git commit -m "phase-3: provider-health + reactor-halt banners + AI-tab deep link (E-7)"
```

---

### Task E-8: `[[` wiki-link picker in the body editor

**Files:** Modify `apps/web/src/components/slideover/body-editor.tsx` + its test.

**Scope:** The body editor already has slash (`/`) detection + a `SlashMenu`. Add a parallel `[[` trigger that opens the existing `WikiLinkPicker` (Phase 2.6) at the caret; selecting a doc inserts `[[<slug>]]`. Pure web, reuses the picker.

- [ ] **Step 1: Failing test** — typing `[[` opens the picker; selecting inserts `[[<slug>]]`. If jsdom + Milkdown interaction is limited, unit-test the `[[`-detection helper + a Playwright TODO (mirror the Phase 2.6 `[[` deferral).

- [ ] **Step 2: RED → implement → GREEN** — mirror the existing slash-detection state machine for `[[`; render `<WikiLinkPicker workspaceSlug projectSlug query onSelect onClose />`; `onSelect({slug})` inserts `[[${slug}]]` at the caret and closes.

> **⚠️ E-8 ground-truth note (Step 2.5):** Read `body-editor.tsx` slash-detection (lines ~73-179) and mirror its EXACT positioning/query machinery for `[[`. Confirm `WikiLinkPicker`'s `onSelect` shape (`{slug, title}`) + that `workspaceSlug`/`projectSlug` are in editor scope.

- [ ] **Step 3: Full suite + typecheck + commit**

```bash
cd apps/web && bun run test src/components/slideover/body-editor.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/slideover/body-editor.tsx apps/web/src/components/slideover/body-editor.test.tsx
git commit -m "phase-3: [[ wiki-link picker in body editor (E-8)"
```

---

### Task E-9: Sub-phase E integration gate

- [ ] **Step 1:** Full web suite — `cd apps/web && bun run test` (prior 576 + E-3..E-8 additions, 0 fail; rerun `list-view-create.test.tsx` once if it's the only failure per `[[known-test-flakes]]`).
- [ ] **Step 2:** Server + shared unchanged except E-4b's +1: `cd apps/server && bun test` (961 + E-4b's test), `cd packages/shared && bun test` (53).
- [ ] **Step 3:** Typecheck — `cd apps/web && bunx tsc --noEmit` + `cd apps/server && bunx tsc --noEmit` clean for touched files.
- [ ] **Step 4:** `netdust-core:integration` to advance the marker.
- [ ] **Step 5:** `/code-review --base=cf5b2f6 --effort=medium` over the full E diff (E-1..E-8). Verify E inherits mitigations 1–66; confirm E-4b's boundary validation. Sibling-site audit on the touched server files.
- [ ] **Step 6:** Manual smoke (or Playwright F): assign a doc to an agent → run executes → appears in ⚡ Activity AND the agent's 🗐 Runs → approval buttons go live in the comment → click a feed row → lands on the doc + Activity tab.
- [ ] **Step 7:** `netdust-core:evaluate` — Sub-phase E retro.
- [ ] **Step 8:** Mark Sub-phase E complete in `docs/PHASES.md`.

---

## Self-Review

**Spec coverage** (vs `2026-05-30-phase-3-E-agent-surface-design.md`):
- Approval-in-comments → **E-6** ✅ (with the hooks-order correctness note)
- Run-history-on-agent → **E-4** ✅ (primary project; fills the existing `'runs'` tab)
- Side-panel Run screen → **E-5b** ✅ · Activity feed → **E-5c** ✅ · shared NocoDB header + shell → **E-5a** ✅
- Cmd-K "Run agent…" opens panel → **E-5b** ✅
- `run_id` linkage → **E-4b** ✅ (SPEC CORRECTED: API-posted, not runner-stamped)
- Banners + AI deep-link → **E-7** ✅ · `[[` picker → **E-8** ✅ · gate → **E-9** ✅
- Shared `RunRow`/`RunStatusChip` → **E-3** ✅

**Placeholder scan:** The `⚠️ ground-truth note (Step 2.5)` blocks are deliberate reconciliation gates (each names the exact file to read + decision to lock), not TODO placeholders. Real open reconciliations the implementer MUST close, highest-risk first:
1. **E-6 hooks-after-return** — `useRun` must be called before the guard `return null`s. The one real correctness risk.
2. **E-4b run-id format** — nanoid vs UUID decides the `comment-schema.ts` `.uuid()` vs `.min(1)` fix.
3. **E-5c feed-row navigation target** — event payload may lack the parent doc slug; pick a reachable target (parent if present, else agent Runs tab).
4. **E-5a `Shell.panel` slot** — verify the prop/layout, else fixed-overlay mount.
5. **E-7 banner mount** — `__root` likely lacks `wslug`; mount at `w.$wslug` instead.
6. **E-3 color tokens** — `danger` vs `error` token naming.

**Type consistency:** `AgentRunDoc` (E-2) feeds `RunRow`/`RunsHistorySection` (E-3/E-4). `StreamedEvent` (E-1) feeds `useActivityFeed` (E-5c). `AgentPanelTab`/`AgentPanelState` (E-5a bus) used by panel + Cmd-K (E-5b). `useRun`/`useRuns`/`useRunsLiveSync` (E-2) used by E-4/E-6. `ActivityItem` (E-5c) is distinct from `AgentRunDoc` — the plan explicitly keeps `RunRow` for `AgentRunDoc` and allows a separate feed row (no forced one-shape-fits-two).

**Decomposition note:** E-5 split into E-5a (shell+header+bus), E-5b (launcher+Cmd-K), E-5c (feed+deep-link) per the spec's suggestion — each is independently reviewable + commits cleanly.

---

## Execution Handoff

Dispatch via **`netdust-core:ntdst-execute-with-tests`** (upstream = `subagent-driven-development`), Step 2.5 per task (each ⚠️ note is the reconciliation target), two-stage review per task, re-verify test counts (`[[verify-subagent-test-counts]]`). **Order:** E-3 → E-4 → E-4b → E-5a → E-5b → E-5c → E-6 → E-7 → E-8 → E-9. E-3 first (RunRow/chip feed everything); E-4b before E-6 (run_id linkage); E-5a before E-5b/E-5c (panel shell).
