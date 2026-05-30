# Agent Cockpit Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the agents *destination page* with a persistent agent **cockpit panel** beside the worktable (pushes the center left), with the agent config opening as a **resizable slideover** anchored over the panel.

**Architecture:** A new `AgentCockpitPanel` mounts in `Shell`'s existing `panel` slot (Shell is flex → a fixed ~360px panel auto-pushes `main` left). Its open state lives at the `w.$wslug` layout (a small module bus, so it's ambient + toggled from the dropdown / rail / Cmd-K). The panel hosts an icon-tab header over three screens — ⚡ Activity (kept `ActivityFeedScreen`), ▶ Run (kept `AgentRunLauncher`), Agents (the list re-homed from the retired page). The agent config document opens via the existing `?doc=` → `WorkspaceDocumentSlideover` (a Radix `Sheet`), now **width-driven by a new `useResizableWidth` hook + a left-edge drag handle**. The `21ef82d` page-consolidation (page tabs + `view` param) is reverted.

**Tech Stack:** React + TanStack Router + react-query + Tailwind + Radix Dialog (`Sheet`). Tests: Vitest.

**Design spec:** `docs/superpowers/specs/2026-05-31-agent-cockpit-panel-design.md`.

---

## Ground-truth reconciliation (verified vs `21ef82d`, 2026-05-31)

| Fact | Reality |
|---|---|
| `Shell` | `apps/web/src/components/shell/shell.tsx` — flex: `rail` + `<div flex-1 min-w-0>{main}</div>` + optional `panel`. A fixed-width `panel` child auto-pushes `main` left. No layout change needed. |
| `panel` slot | currently UNUSED in `w.$wslug.tsx` (the `<AgentSidePanel>` was removed in `21ef82d`). We re-fill it. |
| `Sheet`/`SheetContent` | `ui/sheet.tsx` — Radix Dialog, `fixed right-0 z-50 h-screen`, **takes a `width?: number` prop** → `style={{ width: min(${width}px, 100vw) }}`. Reusable for a resizable slideover by feeding `width` dynamically. Portal overlays the viewport (spills over center's right edge — option A, worktable stays put behind). |
| `WorkspaceDocumentSlideover({wslug})` | reads `?doc=`/`?tab=` from `useSearch`; mounts `<Sheet><SheetContent width={800}>`. Currently rendered by the agents page. We re-home it + make its width resizable. |
| `AgentRunLauncher({wslug, onLaunched})` | KEEP. Form → `useCreateRun`. |
| `ActivityFeedScreen({wslug})` | KEEP. `useActivityFeed`; rows → `navigate({to:'/w/$wslug/agents', search:{doc, tab:'runs'}})` — **this nav target must change** once the agents route is retired (→ set `?doc=` on the CURRENT route, the panel-anchored slideover). |
| `useActivityFeed(wslug)` | KEEP. `{items: ActivityItem[]}`, SSE live-tail. |
| Agents page | `workspace-agents-page.tsx` (post-`21ef82d`: `PageView` tabs agents/activity/run + the agent LIST + create + `<WorkspaceDocumentSlideover>` mount). The LIST + create move into the panel; the page is RETIRED. |
| Agents route | `w.$wslug.agents.tsx` — `validateSearch {doc, project, tab, view}`. Retired (or thinned). The slideover's `?doc=`/`?tab=` move to being read on whatever route is active (the panel + slideover mount at the `w.$wslug` layout level, so `?doc=` works on any center route). |
| dropdown "Agents" | `workspace-switcher.tsx` `onOpenAgents()` → currently `navigate('/w/$wslug/agents')`. CHANGE → toggle the panel. |
| rail TOOLS | `w.$wslug.tsx` — `[{id:'search',...}]` (Search only post-`21ef82d`). ADD an Agents toggle tool. |
| Cmd-K "Run agent…" | `command-palette.tsx` — navigates `?view=run`. CHANGE → open the panel on ▶ Run. |
| NavItem | `{id,label,lucideIcon?,icon?,kbd?,active?,onClick?,...}` (rail.tsx). |
| resize/width infra | NONE exists. `useResizableWidth` is net-new. |
| deleted in `21ef82d` (rebuild) | `agent-side-panel.tsx`, `panel-header.tsx`, `agent-panel-bus.ts` — we rebuild a minimal panel + header + bus. |

---

## File Structure

**New:**
- `apps/web/src/lib/agent-panel-bus.ts` (+ `.test.ts`) — rebuilt open/close + initial-screen bus (module-level pub/sub, mirrors the old one).
- `apps/web/src/lib/use-resizable-width.ts` (+ `.test.ts`) — `useResizableWidth(key, {default, min, max})` → `{width, onDragStart}`, localStorage-persisted.
- `apps/web/src/components/agent-panel/panel-header.tsx` (+ `.test.tsx`) — rebuilt icon-tab header (title + tab buttons + close).
- `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` (+ `.test.tsx`) — the persistent panel (subscribes to the bus; header + 3 screens; hosts the agent list).
- `apps/web/src/components/agent-panel/agent-list.tsx` (+ `.test.tsx`) — the agent list + "New agent", extracted from the page.
- `apps/web/src/components/ui/resize-handle.tsx` (+ `.test.tsx`) — a thin left-edge drag affordance.

**Modified:**
- `apps/web/src/routes/w.$wslug.tsx` — mount `<AgentCockpitPanel wslug>` in `Shell.panel`; add an Agents rail tool (toggle); change `onOpenAgents` → toggle; mount the slideover at this layout level.
- `apps/web/src/components/shell/workspace-switcher.tsx` — (no change to its API — `onOpenAgents` is just rewired by the caller).
- `apps/web/src/components/slideover/workspace-document-slideover.tsx` — drive `SheetContent` width from `useResizableWidth` + render a `ResizeHandle`.
- `apps/web/src/components/agent-panel/activity-feed-screen.tsx` — change the row nav target (no longer the retired `/agents` route).
- `apps/web/src/components/command-palette.tsx` — "Run agent…" → `agentPanelBus.open('run')` instead of `?view=run`.

**Removed/retired:**
- `apps/web/src/components/views/workspace-agents-page.tsx` (+ test) — list/create move to `agent-list.tsx`; the page is deleted.
- `apps/web/src/routes/w.$wslug.agents.tsx` — retired (the route goes away; the panel is the agent surface). The slideover moves to the layout.

---

## Threat model
No new server surface — pure web layout/interaction reshape over already-gated endpoints (runs/documents/comments). Inherits Phase 3 mitigations 1–66. No extension.

---

### Task 1: `useResizableWidth` hook

**Files:** Create `apps/web/src/lib/use-resizable-width.ts` + `.test.ts`.

**Scope:** A hook that owns a pixel width persisted in localStorage, clamped to [min,max], updated by a pointer-drag. Returns `{ width, onDragStart }`. The drag handle is on the slideover's LEFT edge, so dragging LEFT widens it (width increases as pointer x decreases).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/use-resizable-width.test.ts
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizableWidth } from './use-resizable-width.ts';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useResizableWidth', () => {
  test('returns the default width when nothing is stored', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    expect(result.current.width).toBe(480);
  });

  test('restores a persisted width from localStorage (clamped to min/max)', () => {
    localStorage.setItem('folio:width:k', '5000'); // above max
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    expect(result.current.width).toBe(900);
  });

  test('a left-drag widens the panel and clamps + persists', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    // onDragStart receives a pointerdown at clientX=1000; the handle is on the
    // slideover's LEFT edge, so moving the pointer LEFT (smaller clientX)
    // widens it. Simulate a move to clientX=900 → +100px → 580.
    act(() => {
      result.current.onDragStart({ clientX: 1000, preventDefault() {}, } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 } as MouseEventInit));
      window.dispatchEvent(new MouseEvent('pointerup', {} as MouseEventInit));
    });
    expect(result.current.width).toBe(580);
    expect(localStorage.getItem('folio:width:k')).toBe('580');
  });

  test('clamps to max on a large drag', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    act(() => {
      result.current.onDragStart({ clientX: 1000, preventDefault() {} } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0 } as MouseEventInit)); // +1000 → clamp 900
      window.dispatchEvent(new MouseEvent('pointerup', {} as MouseEventInit));
    });
    expect(result.current.width).toBe(900);
  });
});
```

- [ ] **Step 2: RED** — `cd apps/web && bun run test src/lib/use-resizable-width.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/use-resizable-width.ts
import { useCallback, useRef, useState } from 'react';

interface Opts { default: number; min: number; max: number; }

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Pixel width persisted in localStorage, resized by dragging a LEFT-edge handle.
 * The handle sits on the LEFT of a right-anchored panel, so dragging LEFT
 * (smaller clientX) WIDENS it: width += (dragStartX - currentX).
 */
export function useResizableWidth(key: string, opts: Opts): {
  width: number;
  onDragStart: (e: React.PointerEvent) => void;
} {
  const storageKey = `folio:width:${key}`;
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, opts.min, opts.max) : opts.default;
  });
  // Latest width without re-binding move handlers mid-drag.
  const widthRef = useRef(width);
  widthRef.current = width;

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      const onMove = (ev: MouseEvent) => {
        const next = clamp(startWidth + (startX - ev.clientX), opts.min, opts.max);
        setWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        localStorage.setItem(storageKey, String(widthRef.current));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [opts.min, opts.max, storageKey],
  );

  return { width, onDragStart };
}
```

- [ ] **Step 4: GREEN** — `cd apps/web && bun run test src/lib/use-resizable-width.test.ts` (4 pass).

> **⚠️ Task 1 note (Step 2.5):** the test dispatches `pointermove`/`pointerup` as `MouseEvent` (jsdom has no `PointerEvent`). If jsdom rejects `pointermove`, fall back to `mousemove`/`mouseup` listeners in BOTH the hook and the test — keep them consistent. Verify the persist-on-up reads the latest width (via `widthRef`, not the stale closure).

- [ ] **Step 5: Commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/lib/use-resizable-width.ts apps/web/src/lib/use-resizable-width.test.ts
git commit -m "ui: useResizableWidth hook (localStorage-persisted, left-edge drag)"
```

---

### Task 2: `ResizeHandle` affordance

**Files:** Create `apps/web/src/components/ui/resize-handle.tsx` + `.test.tsx`.

**Scope:** A thin (4px) full-height vertical bar with `cursor-col-resize`, absolutely positioned at the left edge of its parent; calls `onDragStart` on pointerdown. Accessible (role=separator, aria-orientation=vertical, aria-label).

- [ ] **Step 1: Failing test**

```tsx
// apps/web/src/components/ui/resize-handle.test.tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from './resize-handle.tsx';

describe('ResizeHandle', () => {
  test('renders a vertical separator and fires onDragStart on pointer down', () => {
    const onDragStart = vi.fn();
    render(<ResizeHandle onDragStart={onDragStart} />);
    const handle = screen.getByRole('separator', { name: /resize/i });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    fireEvent.pointerDown(handle);
    expect(onDragStart).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: RED → implement → GREEN**

```tsx
// apps/web/src/components/ui/resize-handle.tsx
interface Props {
  onDragStart: (e: React.PointerEvent) => void;
}

export function ResizeHandle({ onDragStart }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={onDragStart}
      className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/30"
    />
  );
}
```

> **⚠️ Task 2 note:** if jsdom lacks `fireEvent.pointerDown`, use `fireEvent.mouseDown` + an `onMouseDown` alias — keep consistent with Task 1's event choice.

- [ ] **Step 3: Commit**

```bash
cd apps/web && bun run test src/components/ui/resize-handle.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/ui/resize-handle.tsx apps/web/src/components/ui/resize-handle.test.tsx
git commit -m "ui: ResizeHandle left-edge drag affordance"
```

---

### Task 3: Make `WorkspaceDocumentSlideover` resizable

**Files:** Modify `apps/web/src/components/slideover/workspace-document-slideover.tsx`.

**Scope:** Drive `SheetContent`'s `width` from `useResizableWidth('agent-config', {default:480, min:360, max: <~70vw px>})` and render a `<ResizeHandle onDragStart={...} />` inside the `SheetContent` (it's `position:fixed`, so the handle's `absolute left-0` sits on the slideover's left edge). Max as a px number (e.g. `Math.round(window.innerWidth * 0.7)` computed once, or a static 1100 — keep simple: static max 1100).

- [ ] **Step 1: Failing test** — render the slideover open (`?doc=<slug>` via a memory router + a stubbed `useWorkspaceDocument`), assert a `separator`/resize handle is present and that dragging changes the SheetContent width. (jsdom can't measure layout, so assert the handle exists + the width style updates after a drag, mirroring Task 1's event simulation.)

```tsx
// addition to workspace-document-slideover.test.tsx
test('config slideover renders a resize handle and widens on drag', async () => {
  // open the slideover (?doc=an-agent), assert getByRole('separator', {name:/resize/i})
  // present; pointerdown + move-left + up → the SheetContent inline width grew.
});
```

- [ ] **Step 2: RED → implement → GREEN** — in the component: `const { width, onDragStart } = useResizableWidth('agent-config', { default: 480, min: 360, max: 1100 });`, pass `width={width}` to `<SheetContent>` (replacing the hard-coded `800`), and render `<ResizeHandle onDragStart={onDragStart} />` as the first child inside `SheetContent`. Re-run the slideover's existing tests for no regression.

> **⚠️ Task 3 note (Step 2.5):** Read the real `SheetContent` usage line (recon: `width={800}`). Confirm `useResizableWidth` is called UNCONDITIONALLY (top of the component, before the `open` early-returns if any — rules of hooks). The handle must be inside `SheetContent` (which is `position:fixed`), so `absolute left-0` anchors to the slideover edge. Verify a `localStorage`-backed hook doesn't break the existing slideover tests (they may need `localStorage.clear()` in setup — jsdom provides localStorage).

- [ ] **Step 3: Commit**

```bash
cd apps/web && bun run test src/components/slideover/workspace-document-slideover.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/slideover/workspace-document-slideover.tsx apps/web/src/components/slideover/workspace-document-slideover.test.tsx
git commit -m "ui: agent config slideover is resizable (useResizableWidth + ResizeHandle)"
```

---

### Task 4: Rebuild the panel bus + header

**Files:** Create `apps/web/src/lib/agent-panel-bus.ts` (+ `.test.ts`), `apps/web/src/components/agent-panel/panel-header.tsx` (+ `.test.tsx`).

**Scope:** Rebuild the open/close-with-screen bus (the `21ef82d`-deleted one) + the icon-tab header. The bus now also carries `open` (the panel is toggleable, persistent) — `toggle()`, `open(screen)`, `close()`, `subscribe`.

- [ ] **Step 1: Bus failing test**

```ts
// apps/web/src/lib/agent-panel-bus.test.ts
import { describe, test, expect, vi } from 'vitest';
import { agentPanelBus } from './agent-panel-bus.ts';

describe('agentPanelBus', () => {
  test('open(screen) notifies open:true + the screen', () => {
    const fn = vi.fn(); const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.open('run');
    expect(fn).toHaveBeenCalledWith({ open: true, screen: 'run' });
    unsub();
  });
  test('toggle flips open', () => {
    const fn = vi.fn(); const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.close(); agentPanelBus.toggle();
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
    agentPanelBus.toggle();
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    unsub();
  });
  test('unsubscribe stops notifications', () => {
    const fn = vi.fn(); const unsub = agentPanelBus.subscribe(fn); unsub();
    agentPanelBus.open('activity'); expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: RED → implement bus → GREEN**

```ts
// apps/web/src/lib/agent-panel-bus.ts
export type AgentPanelScreen = 'activity' | 'run' | 'agents';
export interface AgentPanelState { open: boolean; screen: AgentPanelScreen; }
type Listener = (s: AgentPanelState) => void;
const listeners = new Set<Listener>();
let state: AgentPanelState = { open: false, screen: 'activity' };
function emit() { for (const l of listeners) l(state); }
export const agentPanelBus = {
  open(screen: AgentPanelScreen = 'activity') { state = { open: true, screen }; emit(); },
  close() { state = { ...state, open: false }; emit(); },
  toggle() { state = { ...state, open: !state.open }; emit(); },
  get() { return state; },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
};
```

- [ ] **Step 3: Header failing test + impl** — `PanelHeader({title, tabs, active, onTab, onClose})`: title + a button per tab (icon, aria-label) + a close button; `onTab(value)`/`onClose()` fire. (Mirror the deleted one — recoverable from git `git show 177bc69:apps/web/src/components/agent-panel/panel-header.tsx` for the exact prior shape; rebuild it.)

```tsx
// apps/web/src/components/agent-panel/panel-header.tsx
import { Icon } from '../ui/icon.tsx';
import { X } from 'lucide-react';
export interface PanelTab<T extends string> { value: T; icon: string; label: string; }
interface PanelHeaderProps<T extends string> {
  title: string; tabs: PanelTab<T>[]; active: T; onTab: (t: T) => void; onClose: () => void;
}
export function PanelHeader<T extends string>({ title, tabs, active, onTab, onClose }: PanelHeaderProps<T>) {
  return (
    <div className="flex items-center gap-2 border-b border-border-light px-3 py-2.5">
      <strong className="flex-1 truncate text-fg">{title}</strong>
      <div className="flex gap-0.5 rounded-md bg-card p-0.5">
        {tabs.map((t) => (
          <button key={t.value} type="button" aria-label={t.label} aria-pressed={active === t.value}
            onClick={() => onTab(t.value)}
            className={`rounded px-2 py-1 text-sm ${active === t.value ? 'bg-content text-fg shadow-sm' : 'text-fg-3 hover:text-fg-2'}`}>
            {t.icon}
          </button>
        ))}
      </div>
      <button type="button" aria-label="Close" onClick={onClose}
        className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg">
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: GREEN + commit**

```bash
cd apps/web && bun run test src/lib/agent-panel-bus.test.ts src/components/agent-panel/panel-header.test.tsx && bunx tsc --noEmit
git add apps/web/src/lib/agent-panel-bus.ts apps/web/src/lib/agent-panel-bus.test.ts apps/web/src/components/agent-panel/panel-header.tsx apps/web/src/components/agent-panel/panel-header.test.tsx
git commit -m "ui: rebuild agent-panel bus (toggle/open/close) + icon-tab PanelHeader"
```

---

### Task 5: `AgentList` (extracted from the retiring page)

**Files:** Create `apps/web/src/components/agent-panel/agent-list.tsx` + `.test.tsx`.

**Scope:** The agent list + "New agent" button, extracted from `workspace-agents-page.tsx` (lines ~55-170 of recon). Each agent row click sets `?doc=<slug>` on the CURRENT route (opens the config slideover); "New agent" creates an agent (`useCreateDocument`) then sets `?doc=<created.slug>`. Takes `{wslug}`.

- [ ] **Step 1: Failing test** — render in a QueryClientProvider + memory router, stub `useWorkspaceAgents` to return 2 agents; assert both titles render + a "New agent" button; clicking an agent navigates with `?doc=<slug>`.

- [ ] **Step 2: RED → implement → GREEN** — copy the list/create logic from `workspace-agents-page.tsx` (the `<ul>` map + `onCreate` + the project-filter chip is OPTIONAL — drop it for the panel, or keep a compact version; lean: drop the filter chip in the narrow panel). IMPORTANT: the row + create navigation must NOT hard-code `to: '/w/$wslug/agents'` (that route is retired in Task 7) — use `navigate({ to: '.', search: (prev) => ({ ...prev, doc: slug }) })` to set `?doc=` on whatever the current route is (the slideover mounts at the layout level, Task 6).

> **⚠️ Task 5 note (Step 2.5):** Read the page's exact `onCreate` (the create-agent frontmatter defaults) + `useCreateDocument` signature + the row markup to copy faithfully. Confirm `navigate({to:'.', ...})` is valid in this codebase's TanStack version for "stay on current route, change search" (the slideover close handler uses `navigate({to:'.', search})` per earlier E work — mirror it).

- [ ] **Step 3: Commit**

```bash
cd apps/web && bun run test src/components/agent-panel/agent-list.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/agent-panel/agent-list.tsx apps/web/src/components/agent-panel/agent-list.test.tsx
git commit -m "ui: AgentList (list + New agent), extracted for the cockpit panel"
```

---

### Task 6: `AgentCockpitPanel` + mount + slideover at the layout

**Files:** Create `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` (+ `.test.tsx`). Modify `apps/web/src/routes/w.$wslug.tsx`.

**Scope:** The persistent panel: subscribes to `agentPanelBus`, renders `null` when closed; when open renders a fixed-width (`w-[360px] shrink-0`) column with `PanelHeader` (tabs: ⚡ Activity / ▶ Run / 🤖 Agents) + the active screen (`ActivityFeedScreen` / `AgentRunLauncher onLaunched={→activity}` / `AgentList`). Mounted in `Shell.panel`. ALSO move `<WorkspaceDocumentSlideover wslug={wslug} />` to the layout (so `?doc=` opens the config slideover over the panel from anywhere). Add an Agents rail tool (`agentPanelBus.toggle()`); rewire `onOpenAgents` → `agentPanelBus.toggle()`.

- [ ] **Step 1: Failing test** (panel) — bus closed → renders null; `bus.open('run')` → renders with Run active; `bus.open('activity')` → Activity; close button → hidden. Stub fetch + EventSource.

- [ ] **Step 2: RED → implement `AgentCockpitPanel` → GREEN.** Tabs array `[{value:'activity',icon:'⚡',label:'Activity'},{value:'run',icon:'▶',label:'Run'},{value:'agents',icon:'🤖',label:'Agents'}]`. Local `screen` state seeded from `agentPanelBus.get()`, updated by the bus + by header `onTab`. `w-[360px] shrink-0 bg-content rounded-md border border-border-light flex flex-col` (match the shell card aesthetic).

- [ ] **Step 3: Wire into `w.$wslug.tsx`** — `panel={<AgentCockpitPanel wslug={wslug} />}` on `<Shell>`; add to `TOOLS`: `{id:'agents', label:'Agents', lucideIcon: Bot, onClick: () => agentPanelBus.toggle()}` (re-import `Bot`); change `onOpenAgents={() => agentPanelBus.toggle()}` (remove the `navigate('/agents')`); mount `<WorkspaceDocumentSlideover wslug={wslug} />` inside the layout (e.g. alongside the existing create dialogs/sheets, so it's present on every center route). Re-run `w.$wslug.test.tsx`.

> **⚠️ Task 6 note (Step 2.5):** The slideover currently mounts on the agents PAGE. Moving it to the layout means it's always mounted (reads `?doc=` from any route). Confirm that doesn't double-mount if the page also still mounts it (Task 7 retires the page, so it won't — but order matters: do Task 6 + 7 together or ensure no double-mount). Also: the activity-feed-screen's row nav (`to:'/w/$wslug/agents'`) is retired in Task 7 — Task 6's panel works regardless, but flag the cross-dependency.

- [ ] **Step 4: Commit**

```bash
cd apps/web && bun run test src/components/agent-panel/agent-cockpit-panel.test.tsx src/routes/w.\$wslug.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/agent-panel/agent-cockpit-panel.tsx apps/web/src/components/agent-panel/agent-cockpit-panel.test.tsx apps/web/src/routes/w.\$wslug.tsx
git commit -m "ui: AgentCockpitPanel mounted in Shell.panel; dropdown + rail toggle it; slideover at layout"
```

---

### Task 7: Retire the agents page + route; rewire Cmd-K + feed nav

**Files:** Delete `apps/web/src/components/views/workspace-agents-page.tsx` (+ test) + `apps/web/src/routes/w.$wslug.agents.tsx`. Modify `apps/web/src/components/command-palette.tsx`, `apps/web/src/components/agent-panel/activity-feed-screen.tsx`.

**Scope:** Remove the page + route now that the panel is the agent surface. Repoint the two navigations that targeted `/w/$wslug/agents`.

- [ ] **Step 1:** Cmd-K "Run agent…" — change `onSelect` from `navigate('/agents?view=run')` to `agentPanelBus.open('run')` + `close()`. (Import `agentPanelBus`.)
- [ ] **Step 2:** `activity-feed-screen.tsx` — the row `openAgentRuns` navigates to `/w/$wslug/agents?doc=&tab=runs`. Change to `navigate({ to: '.', search: (prev) => ({ ...prev, doc: item.agent, tab: 'runs' }) })` (set `?doc=` on the current route — the layout slideover opens). Verify `tab:'runs'` still selects the slideover's Runs tab.
- [ ] **Step 3:** Delete `workspace-agents-page.tsx` (+ test) and `w.$wslug.agents.tsx`. Grep `workspace-agents-page|w.\$wslug.agents|/w/\$wslug/agents|/agents'|view=run|PageView` across `apps/web/src` → repoint/remove every dangling ref (the route tree may auto-generate from the file — confirm removing the route file is clean; TanStack file-based routing drops it).
- [ ] **Step 4:** Full web suite + tsc; grep clean.

> **⚠️ Task 7 note (Step 2.5):** TanStack Router is file-based — deleting `w.$wslug.agents.tsx` removes the route. Confirm no other code `navigate({to:'/w/$wslug/agents'})` (grep) and that the generated route tree (`routeTree.gen.ts` if present) regenerates / doesn't break the build. If the dropdown or anything else still links to the dead route, repoint to the panel toggle.

- [ ] **Step 5: Commit**

```bash
cd apps/web && bun run test && bunx tsc --noEmit
git add -A apps/web
git commit -m "ui: retire the agents page + route — the cockpit panel is the agent surface; rewire Cmd-K + feed nav"
```

---

### Task 8: Integration gate

- [ ] Full web suite green (`cd apps/web && bun run test` — judge by fail-count, the Milkdown jsdom artifact + `list-view-create` flake aside). Server + shared untouched (`cd apps/server && bun test`, `cd packages/shared && bun test` — unchanged).
- [ ] tsc clean (web).
- [ ] Manual smoke (or note for shake-out): dropdown "Agents" toggles the panel beside the table; the worktable narrows (not covered); ⚡/▶/🤖 tabs work; clicking an agent opens the config slideover over the panel; the slideover's left edge drags to resize + the width persists across reopen; Cmd-K "Run agent…" opens the panel on Run; an activity-feed row opens the run's agent in the slideover. No dead `/agents` route.
- [ ] `/code-review --base=<this-task-cluster-base> --effort=medium`.

---

## Self-Review

**Spec coverage:** persistent push-center panel (T6 + Shell.panel) ✅ · ⚡Activity/▶Run/🤖Agents in panel (T6) ✅ · agent list re-homed (T5) ✅ · config = resizable slideover anchored over panel, option A (T3 + T1/T2) ✅ · dropdown toggles panel (T6) ✅ · rail tool + Cmd-K open panel (T6/T7) ✅ · page+route retired (T7) ✅ · width persists (T1) ✅ · keep ActivityFeed/RunLauncher/useActivityFeed (T6 reuses) ✅.

**Placeholder scan:** the ⚠️ Step-2.5 notes are deliberate reconciliation gates (each names the file + decision), not TODOs. Real open reconciliations: (1) jsdom pointer-vs-mouse event naming (T1/T2 — pick one, keep consistent), (2) `navigate({to:'.'})` validity in this TanStack version (T5/T6/T7), (3) slideover double-mount during the T6→T7 window (do them as a pair), (4) file-based-route removal cleanliness (T7).

**Type consistency:** `AgentPanelScreen` ('activity'|'run'|'agents') used by the bus (T4) + panel (T6) + Cmd-K (T7). `useResizableWidth(key, {default,min,max}) → {width, onDragStart}` used by T2/T3. `PanelTab<T>`/`PanelHeader` (T4) used by T6. `ActivityItem`/`useActivityFeed` (kept) used by T6's Activity screen.

**Decomposition note:** T6 + T7 are coupled (the slideover move + the route retire) — execute them back-to-back; the integration gate (T8) catches any double-mount/dead-route gap.

---

## Execution Handoff

Dispatch via **`netdust-core:ntdst-execute-with-tests`** (upstream = `subagent-driven-development`), Step 2.5 per task (each ⚠️ note is the reconciliation target), two-stage review per task, re-verify counts (`[[verify-subagent-test-counts]]`). **Order:** T1 → T2 → T3 (resizable slideover, independent) · T4 → T5 → T6 → T7 (panel + retire, sequential; T6+T7 as a pair) · T8 gate.
