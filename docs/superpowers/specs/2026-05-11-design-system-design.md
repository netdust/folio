# Folio — Design System Spec

**Date:** 2026-05-11
**Scope:** Visual design language for Folio v1. Tokens, shell, primitives, rules. Does not specify product behavior — that lives in subsequent phase specs.
**Audience:** Anyone building Folio UI. The spec is the source of truth; mockups in `.superpowers/brainstorm/` are reference renderings, not contracts.

---

## 1. Why this spec exists

Folio's v1 covers five phases of feature work. Without a locked design language, every phase risks re-litigating type, color, and layout. This spec defines those once so phase specs only describe behavior.

The design system is also where Folio's posture lives. The choices below — workhorse type, Core-OSS shell, monochrome with semantic accents, Linear density — encode the product's intent: **"do the work."** Folio looks like a tool, not a portfolio piece.

## 2. Design intent (the three commitments this design serves)

From `CLAUDE.md`:

1. **Markdown is the source of truth.** Document bodies are rendered as plain markdown; the UI never invents formatting the export can't preserve.
2. **Agents are first-class users.** The UI is the human surface of the same REST/MCP data layer. Nothing in the UI exists that an agent can't drive.
3. **Keyboard-fast UX.** Cmd-K palette, inline edits, slideovers (not modals), optimistic UI.

The design system supports all three by being calm, scannable, and free of editorial chrome that would slow down repeated daily use.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shell | Core-OSS pattern (rail + main + collapsible right panel) | Reuses a design language Stefan already validated in the Netdust Command Centre. Three-zone shell maps cleanly to Folio's (workspace nav / current view / context). |
| Typography | Geist + Geist Mono only. No serif. | "Do the work" mentality. Earlier `Fraunces` direction made the chrome feel personal; tool chrome should disappear. |
| Palette | Monochrome (black + warm off-whites) with semantic accents only | No chromatic primary color. Brand expresses through type, spacing, and restraint — not hue. Matches Core-OSS. |
| Density | Linear-dense (10px row padding, ~32–36px row height, ~13 rows per 1080p screen) | Pairs with the workhorse palette. Notion-airy was the wrong call after we settled on monochrome — too much breathing room reads as "designed", not "useful". |
| Right panel | Per-view default (list/board closed, doc detail open, settings open, activity open) | Maximizes main work area for scanning views; pre-opens context where it's the point. |
| Dark mode | Ship in v1 alongside light | Cheap to do while tokens are being defined; many self-hosters live in dark. |
| Implementation | Hybrid — own tokens, shadcn for complex a11y primitives only | Token layer and trivial primitives (Pill, Badge, Avatar) are ours. shadcn for `Dialog`/`Sheet`, `Popover`, `Command`, `Toast` where accessibility work is real. |

## 4. Architecture

Three layers, strict dependency direction.

```
tokens.css   ← (CSS custom properties — single source of truth)
   ↑
tailwind.config.ts   ← (maps tokens to semantic utility names)
   ↑
components/ui/   ← (bespoke primitives + shadcn primitives, themed via Tailwind)
   ↑
components/shell/   ← (rail, main frame, right panel — layout only)
   ↑
features/ (Phase 1+)
```

Rules:
- No raw hex values appear outside `tokens.css`.
- No layout values appear inside primitives (primitives don't know about the shell).
- shadcn primitives are themed via the same Tailwind tokens — no per-component override files.

### File layout

```
apps/web/src/
├── styles/
│   ├── tokens.css            # CSS variables, light + dark
│   ├── globals.css           # Tailwind layers, base resets, font loading
│   └── fonts.css             # @font-face for Geist + Geist Mono (self-hosted)
├── components/
│   ├── ui/
│   │   ├── button.tsx        # bespoke
│   │   ├── icon-button.tsx   # bespoke
│   │   ├── pill.tsx          # bespoke (status pills)
│   │   ├── badge.tsx         # bespoke (priority, labels)
│   │   ├── chip.tsx          # bespoke (filter chips, "+ Filter")
│   │   ├── avatar.tsx        # bespoke
│   │   ├── kbd.tsx           # bespoke (keyboard hint, used in tooltips/palette)
│   │   ├── dialog.tsx        # shadcn (action dialog primitive)
│   │   ├── sheet.tsx         # shadcn (slideover primitive)
│   │   ├── popover.tsx       # shadcn (workspace switcher, filter editor)
│   │   ├── command.tsx       # shadcn (Cmd-K palette base)
│   │   └── toast.tsx         # shadcn (toaster + Toast primitive)
│   └── shell/
│       ├── shell.tsx         # Three-zone layout container
│       ├── rail.tsx          # Left nav rail (200px default / 64px collapsed)
│       ├── main-frame.tsx    # Header + tabs + toolbar + content slot
│       ├── right-panel.tsx   # 320px collapsible panel + tabs (Context/Events/AI)
│       └── workspace-switcher.tsx
└── lib/
    └── theme.ts              # Theme toggle + persistence
```

## 5. Tokens

All values live in `apps/web/src/styles/tokens.css`. Tailwind references them via CSS-variable utilities. No JavaScript reads these directly.

### 5.1 Color — light theme (`:root`)

```css
/* Surfaces */
--color-shell:        #E3E3E5;  /* page background, visible in gutters */
--color-content:      #FCFCFC;  /* rail / main / panel surface */
--color-brand-2:      #F6F5F3;  /* alt surface — auth, settings panes */
--color-card:         #F4F3F1;  /* selected row, hover, secondary button bg */
--color-border-light: #EAEAEA;  /* section dividers */
--color-border-row:   #F4F3F1;  /* row dividers (blends into card) */

/* Foreground */
--color-fg:           #000000;
--color-fg-2:         #000000a8; /* secondary text */
--color-fg-3:         #00000054; /* tertiary / disabled / captions */
--color-fg-on-primary:#FFFFFF;

/* Primary — no chromatic accent */
--color-primary:      #000000;
--color-primary-fg:   #FFFFFF;
```

### 5.2 Color — dark theme (`.dark`)

```css
--color-shell:        #0a0a0b;
--color-content:      #161618;
--color-brand-2:      #1a1a1d;
--color-card:         #1f1f22;
--color-border-light: #26262a;
--color-border-row:   #1f1f22;

--color-fg:           #f0f0f0;
--color-fg-2:         #f0f0f0a8;
--color-fg-3:         #f0f0f054;
--color-fg-on-primary:#0a0a0b;

--color-primary:      #f0f0f0;
--color-primary-fg:   #0a0a0b;
```

### 5.3 Semantic color (shared hex, theme-shifted backgrounds)

```css
/* Foreground colors — same hex in both themes */
--color-success: #589F72;
--color-danger:  #EA6B6B;
--color-warning: #F0A442;
--color-info:    #6EAFFF;

/* Background washes — light theme */
--color-bg-success: #DEFBE6;
--color-bg-danger:  #FCF1F1;
--color-bg-warning: #FDF4E7;
--color-bg-info:    #F0F7FF;

/* Background washes — dark theme override */
.dark {
  --color-bg-success: #1d2e26;
  --color-bg-danger:  #2e1d1d;
  --color-bg-warning: #2e2519;
  --color-bg-info:    #1a2434;
}
```

### 5.4 Typography

```css
--font-sans: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
```

Type scale (role / size / weight / use):

| Role | Size | Weight | Use |
|---|---|---|---|
| view-title | 15px | 500 | Page-level title (e.g. "Exhibitions") |
| doc-title | 15px | 500 | Document title in the slideover |
| body | 13px | 400 | Default — row titles, paragraphs, inputs |
| caption | 11px | 400 | Sub-meta, helper text |
| label | 10px | 600 | Column headers, section labels. Uppercase, 0.05em tracking |
| badge | 10px | 500 | Pill content |
| mono-11 | 11px | 400 | Geist Mono — slugs, dates, frontmatter keys |
| mono-10 | 10px | 400 | Geist Mono — inline mono in tight UI |

Weights used: 400 (body, caption, badge) and 500 (titles, emphasis) and 600 (uppercase labels). Nothing heavier — heavier weights pull focus into chrome.

### 5.5 Spacing

```css
--space-xs:  4px;
--space-sm:  8px;
--space-md:  16px;
--space-lg:  24px;
--space-xl:  32px;
--space-xxl: 40px;
--space-row: 10px;  /* vertical row padding in dense list */
```

### 5.6 Radius

```css
--radius-sm:   4px;   /* badges, small buttons, hover surfaces */
--radius-md:   6px;   /* icon buttons, sidebar nav items */
--radius-lg:  10px;   /* cards, popovers */
--radius-xl:  16px;   /* shell surfaces */
--radius-pill: 999px; /* buttons, chips, status pills */
```

### 5.7 Depth

Hairlines only. Real shadows are reserved for popovers/dialogs.

```css
/* Light */
--shadow-surface: 0 0 1px rgba(0,0,0,0.25);
--shadow-card:    0 0 1px rgba(0,0,0,0.20);
--shadow-popover: 0 8px 24px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.18);

/* Dark */
.dark {
  --shadow-surface: 0 0 1px rgba(255,255,255,0.10);
  --shadow-card:    0 0 1px rgba(255,255,255,0.08);
  --shadow-popover: 0 8px 24px rgba(0,0,0,0.4), 0 0 1px rgba(255,255,255,0.15);
}
```

### 5.8 Motion

```css
--duration-fast:    120ms;  /* hover state, button color */
--duration-default: 200ms;  /* panel collapse, tab change */
--duration-slow:    280ms;  /* slideover enter/exit */
--ease-default:     cubic-bezier(0.16, 1, 0.3, 1);  /* easeOutExpo */
```

Rules:
- Animate `opacity` and `transform` only. Never animate `width`/`height` of laid-out content.
- Slideover enter: `translateX(8px) → translateX(0)` plus opacity fade.
- Honor `prefers-reduced-motion: reduce` — disable all transitions except opacity ≤ 80ms.

### 5.9 Focus ring

```css
--ring: 0 0 0 2px var(--color-content), 0 0 0 4px var(--color-primary);
```

Two-layer: an inner ring in the surface color, an outer ring in primary. Same recipe light and dark. Applied via `:focus-visible` only.

## 6. Tailwind mapping

`tailwind.config.ts` declares semantic utility names by referencing the CSS variables. Components only consume these — never hex.

```ts
// Pattern (full mapping lives in the config file).
theme.extend.colors = {
  shell:    'var(--color-shell)',
  content:  'var(--color-content)',
  card:     'var(--color-card)',
  'brand-2':'var(--color-brand-2)',
  fg:       'var(--color-fg)',
  'fg-2':   'var(--color-fg-2)',
  'fg-3':   'var(--color-fg-3)',
  primary:  'var(--color-primary)',
  'primary-fg': 'var(--color-primary-fg)',
  success:  'var(--color-success)',
  danger:   'var(--color-danger)',
  warning:  'var(--color-warning)',
  info:     'var(--color-info)',
  'bg-success': 'var(--color-bg-success)',
  'bg-danger':  'var(--color-bg-danger)',
  'bg-warning': 'var(--color-bg-warning)',
  'bg-info':    'var(--color-bg-info)',
}
```

The point: components write `bg-content`, not `bg-[#FCFCFC]`. Theme switching happens by toggling the `.dark` class on `<html>` — token values update; component classes don't.

Tailwind also exposes:
- `font-sans`, `font-mono`
- `rounded-sm | md | lg | xl | pill`
- `shadow-surface | card | popover`
- `text-view-title | doc-title | body | caption | label | badge | mono-11 | mono-10` — via the typography plugin or component classes

## 7. The shell

Three zones inside a `--color-shell` background with 6px padding and 6px gaps.

```
┌─────────────────────────────────────────────────────┐
│  shell-bg (#E3E3E5)                                 │
│  padding 6px                                        │
│  ┌──┐ 6px ┌─────────────────────────┐ 6px ┌──────┐ │
│  │  │     │                         │     │      │ │
│  │R │     │       Main frame        │     │Right │ │
│  │a │     │                         │     │panel │ │
│  │i │     │   header / tabs /       │     │      │ │
│  │l │     │   toolbar / content     │     │320px │ │
│  │  │     │                         │     │      │ │
│  │64│     │                         │     │      │ │
│  └──┘     └─────────────────────────┘     └──────┘ │
└─────────────────────────────────────────────────────┘
```

All three children: `bg-content`, `rounded-xl`, `shadow-surface`. No borders.

### 7.1 Rail

**Default 200px expanded rail (icon + label).** User preference toggles to 64px collapsed (icons only), persisted to localStorage. The expanded default is intentional: labels make the rail self-teaching, and 200px is still narrow enough that the main work area dominates.

Contents top to bottom:
1. **F logo mark** — 30×30, `bg-primary`, `text-primary-fg`, `rounded-md`, weight 600 -0.02em tracking. In expanded mode: "Folio" wordmark sits next to the mark in `text-fg` 13px/500.
2. **Workspace shortcut** — W avatar (24×24, `rounded-md`, `bg-primary`). In expanded mode: workspace name (13px/500) next to the avatar. Click → workspace switcher popover (see §7.4).
3. **Divider** — hairline, full-width in expanded mode (28px centered in collapsed).
4. **Views section** — `[Home, Work items, Board, Wiki, Activity]`. Phase 1 lights up Work items + Board + Wiki. Home + Activity are placeholders until later phases.
5. **Divider**
6. **Tools section** — `[⌘K Search]`. In expanded mode: keyboard hint `⌘K` shows on the right side of the row.
7. **Spacer** — `flex: 1`.
8. **Account section** — `[Settings, User avatar]`.

**Nav item rows** in expanded mode are 36px tall, `rounded-md`, padding `8px 12px`. Structure: `[icon 18×18] [label 13px/500]` (and optionally a keyboard hint on the right for search and similar). Icon size is 18×18 in expanded mode for legibility next to the 13px label.

**Icon button** in collapsed (64px) mode: 40×40 cell with the icon centered. **No background, ever** — not on hover, not on active. The cell is invisible; only the glyph is rendered.

States in collapsed mode:
- Default: icon `color: rgba(0,0,0,0.32)` (light) / `rgba(255,255,255,0.32)` (dark).
- Hover: `color: var(--color-fg-2)`.
- Active: `color: var(--color-fg)` plus a 4×4 dot below the icon (`bottom: 4px`, centered, `bg: var(--color-fg)`, `border-radius: 50%`).

States in expanded mode (nav-item rows):
- Default: `color: var(--color-fg-3)`, transparent bg.
- Hover: `bg: var(--color-card)`, `color: var(--color-fg-2)`.
- Active: `bg: rgba(0,0,0,0.06)` (light) / `rgba(255,255,255,0.08)` (dark), `color: var(--color-fg)`. Background is a subtle wash — never a chunky pill.

**Critical implementation note.** Icon buttons MUST receive a hard `<button>` reset to suppress user-agent and framework styles that can sneak in a 1px square outline. Specifically: `background: none; border: 0; outline: 0; box-shadow: none; appearance: none;` on every native `<button>` element. Focus-visible ring (per §5.9) is the only outline allowed. This applies globally, not just to the rail.

Tooltip on hover only in collapsed mode (`Popover` from shadcn, ~120ms delay), showing the label and any keyboard shortcut. No tooltips in expanded mode — labels are already visible.

Icon set: Lucide SVG, inline. **Stroke 1.5** (slightly lighter than Lucide default 2 — keeps icons feeling minimal alongside thin Geist letterforms), `linecap: round`, `linejoin: round`. Icon size: 18×18 in expanded mode, 18×18 in collapsed.

### 7.2 Main frame

Constant structure across all views; views supply the content slot only.

```
[header]    padding: 16px 22px 0
  [titles]
    view-title  (15px / 500)
    sub-meta    (mono-11 / fg-3) — breadcrumb + counts
  [actions]
    [Export .md]   Button variant="secondary"
    [+ New ...]    Button variant="primary"
    [panel-toggle] IconButton (renders only if the view supports a right panel)

[tabs]      padding: 12px 22px 0
  Horizontal scroll if overflow. Black-pill active state.
  Trailing "+ New view" affordance.

[toolbar]   padding: 10px 22px; border-bottom: 1px solid var(--color-border-light)
  Filter chips → dashed "+ Filter" affordance → spacer → sort label (mono caption)

[content]   flex: 1; overflow: auto; padding: 4px 22px 16px
  Rendered by the active view.
```

The header/tabs/toolbar trio is the constant frame. Every Folio view renders inside it.

### 7.3 Right panel

320px wide, `rounded-xl`, `bg-content`, `shadow-surface`. Collapse animates width and opacity together (`--duration-default`, `--ease-default`). When collapsed, the main frame expands to take the freed space; the shell-grey gutter remains.

Per-view default:

| View | Default | Tab default |
|---|---|---|
| List view | closed | Context |
| Board view | closed | Context |
| Wiki (tree) | closed | Context |
| Document detail | n/a — slideover replaces panel | n/a |
| Workspace settings | open | Context |
| Activity (events feed) | open | Events |

User override: per-session only. Page reload returns to the per-view default. This is intentional — defaults express intent; persistence would create stale state.

Panel structure:

```
[panel-tabs]   padding: 12px 16px 0; gap: 4px; border-bottom: 1px solid var(--color-border-light)
  Underline-active tabs (NOT pill — different from main view tabs).
  [Context | Events | AI*]

[panel-body]   flex: 1; overflow: auto; padding: 14px 16px
  Renders the active tab's content.
```

*AI tab is only mounted when the active workspace has an AI key configured. When no key is set, the tab is absent (not disabled).

#### Context tab

Selection-aware. When something is selected in the current view, renders:
- Selected document's title (15px / 500) + slug (mono-10 / fg-3)
- Frontmatter fields rendered as key-value rows: key in mono-11 / fg-3, value styled per inferred type (date in mono, labels as badges, etc.)
- Action pills row: Open ↗, Copy as MD, slash commands (`/decompose`, `/summarize`)
- Body preview (truncated)
- Recent events (last 3)

Empty state (nothing selected): a one-liner + the active view's keyboard hints.

#### Events tab

Workspace-scoped live event stream (driven by SSE in Phase 2). Each event row:
- Kind in mono-10 / fg-3 (`document.updated`)
- Message in body weight (`status → in_progress`)
- Actor + relative time in mono-10 / fg-3

Empty state: "Events appear here in real time. Connect an agent via the API token to write here."

#### AI tab (conditional)

In-panel surface for AI command results and history. Phase 3 territory.

### 7.4 Workspace switcher

Triggered by clicking the W avatar in the rail. Renders as a `Popover` (shadcn) anchored to the avatar.

Contents:
- Search input (filters by workspace name and slug)
- Workspace list — each row: W avatar + name + slug (mono-10 / fg-3). Active workspace marked with a primary dot.
- When a workspace is selected, the popover expands to show its projects below — a small list, clickable, navigates and closes.
- Footer actions: "Create workspace" (opens action dialog), "Workspace settings" (navigates).

Width: 320px. Max height: 480px with internal scroll. Same `bg-content` + `rounded-lg` + `shadow-popover` treatment as all popovers.

Project navigation does *not* have a persistent sidebar. The active project's breadcrumb appears in the main frame header (`galerie-sint-jan / exhibitions`). Switching projects happens via this popover, via Cmd-K, or by clicking the breadcrumb.

### 7.5 Focused surface rule

At any moment, **exactly one** surface holds the user's primary attention:

| Surface | Width | Blocks input? | Closes via | Use |
|---|---|---|---|---|
| Right panel | 320px | No | Toggle button, `Cmd-\` | Context for selection. Lives inside shell. |
| Document slideover | 600px (mobile: full) | No, but hides right panel | Esc, click-outside, X, `Cmd-\` | The selected document opened for editing. URL-driven. |
| Action dialog | 440px (mobile: ~92vw) | Yes — dims everything behind | Esc, click-outside, X | Create, confirm, AI-output preview. Stacks above slideover if needed. |

Constraints derived from this:
- The right panel and document slideover are **never visible at the same time**. Opening a document hides the panel; closing the document restores the panel to its per-view default.
- Action dialogs **can** appear above a slideover (rare but legal — e.g. confirming deletion of the document you're editing).
- Toasts are not a focused surface — they are passive acknowledgments and never block.

### 7.6 Toasts

Region: fixed, anchored bottom-right.

```
Offset: 16px right, 16px bottom
Stack:  newest top, max 3 visible (older auto-dismiss to make room)
Width:  max 320px
Shape:  bg-content, rounded-lg, shadow-popover, padding 12px
Timing: success/info 3.5s, error sticky until dismissed
Motion: enter slide-up + fade; exit fade
A11y:   aria-live="polite" for success/info, "assertive" for errors
```

Toasts overlay the shell including dialogs. They are for acknowledging actions that already happened ("Saved", "Copied", "Token revoked", "Failed — rolled back"). Not for asking questions (use a dialog), not for status with its own home (use Events tab).

### 7.7 Responsive

| Breakpoint | Behavior |
|---|---|
| ≥1280px | Full shell. Rail expanded (200px) default. Right panel honors per-view default. |
| 1024–1279px | Full shell. Right panel forces closed; toggle still works. |
| 768–1023px | Rail collapses to a top bar (64px). Right panel becomes a slideover-over-content (Sheet from the right). |
| <768px | Single column. Rail → bottom tab bar (5 primary destinations). Right panel → full-screen Sheet. |

Mobile is "passable, not optimized" — v1 ships the desktop and tablet layouts polished; phone works but is not the design target.

### 7.8 Acknowledged constraints (v1.0 trade-offs)

These are intentional v1.0 limits, not bugs:

1. **No drag-to-resize panels.** Rail is 200px (default) or 64px (collapsed); right panel is 320px; main takes the rest. To widen the main area, collapse the rail and/or the right panel. Resize handles are ~150 lines + a settings store + breakpoint edge cases. Revisit in v1.1 if real users ask.
2. **No multi-document tab bar.** Each click on a document replaces whatever was open in the slideover. Cmd-K + browser history (Esc to close, ← to go back) is the navigation pattern. Matches Linear.
3. **Workspace switcher requires learning the W avatar is clickable.** It is not labeled in collapsed-rail mode. Tooltip and Cmd-K reinforce. The expanded 200px rail makes it explicit. Accepted: Linear teaches this in five minutes.

## 8. Primitives (`components/ui/`)

The bespoke set. Each is ~30–60 lines. All accept a `className` prop and merge via `clsx` so feature code can extend without subclassing.

### 8.1 Button

```
Variants: primary | secondary | ghost | danger
Sizes:    sm (24px height) | md (default, 28px) | lg (32px)
Shape:    rounded-pill, padding x: 14px, gap: 6px (for icon + label)
States:   default | hover | active | focus-visible | disabled
Loading:  optional `loading` prop renders a 12px spinner replacing the label
```

- `primary`: `bg-primary text-primary-fg`. Hover: `opacity-90`.
- `secondary`: `bg-card text-fg`. Hover: `brightness-95`.
- `ghost`: transparent, `text-fg-2`. Hover: `bg-card`.
- `danger`: `bg-danger text-fg-on-primary`. Hover: `opacity-90`.

### 8.2 IconButton

26×26 or 32×32 depending on size. `rounded-sm` (small) or `rounded-md` (regular). Same color states as ghost button. Always pair with a `Tooltip` (from `Popover`) for label, except inside obvious contexts.

### 8.3 Pill (status pill)

Used for document statuses. Renders as: `[colored dot] [label]`, inline-flex, font-size 12px.

```
Variants: backlog | todo | in_progress | done
```

Color is driven by the project's `statuses` table (`category` field). Backlog → fg-3, Todo → info, In progress → warning, Done → success. The dot is 7px circle of the same color; the label is the same color.

### 8.4 Badge

Padding 2px 8px, `rounded-sm`, font-size 10px, weight 500.

```
Variants: high | medium | low | label
```

- `high`: `bg-bg-danger text-danger`
- `medium`: `bg-card text-fg-2`
- `low`: `bg-card text-fg-3`
- `label`: configurable — `bg-bg-info text-info` for "curation", `bg-bg-warning text-warning` for "deadline", etc. Label color is driven by a hash of the label string mapped onto the four semantic pairs (success / danger / warning / info) for visual consistency.

### 8.5 Chip (filter chip)

Used for active filters and the dashed "+ Filter" affordance.

Active filter: `bg-card`, `rounded-pill`, padding 3px 10px, font-size 11px. Structure: `[key in fg-3] [value in fg medium]`.
"+ Filter" affordance: same shape, dashed `border-fg-3`, no background.

### 8.6 Avatar

Round, three sizes: 18px (rows), 22px (header), 32px (settings). `bg-primary text-primary-fg` for the default avatar; a deterministic hash maps users to a small set of accent backgrounds (`primary`, `warning`, `success`) to make them distinguishable without a chromatic palette.

Initials are derived from the user's name, two letters max.

### 8.7 Kbd

Inline keyboard hint. `bg-card rounded-sm` padding 1px 5px, font-mono-10, color `fg-2`. Used in tooltips and the palette.

### 8.8 shadcn primitives (themed via Tailwind tokens)

- **Dialog** — action dialog. 440px, centered, dims background. `Cmd+Enter` triggers primary action.
- **Sheet** — slideover. 600px wide. Right side only.
- **Popover** — workspace switcher, filter editor, tooltips.
- **Command** — Cmd-K palette. Themed to match the popover style.
- **Toast** — toaster region + Toast component.

All five inherit the same tokens; no per-component theme files.

## 9. Iconography

- **Library:** Lucide. SVGs inlined; no npm dependency.
- **Stroke:** 1.75
- **Linecap / linejoin:** round
- **Default size:** 16×16 in the rail, 14×14 in icon-buttons, 12×12 in inline contexts
- **Color:** always `currentColor`. Never paint icons directly.
- **Selection:** keep the rail set small (≤ 8 icons). When in doubt, fewer.

## 10. Content style (microcopy)

- Sentence case for everything except: section labels (UPPERCASE), proper nouns, and product names.
- Status names from project config — never invented in chrome.
- Dates always in `YYYY-MM-DD` ISO format, mono-11.
- Empty states are useful, not cute. "No work items yet. Press C to create one." beats "Nothing to see here!"
- Error toasts say what failed *and* what happened to user state: "Failed to update — your change was rolled back."
- Slash commands appear as `/draft`, `/decompose` etc., in mono-11, in any documentation. Never capitalize them.

## 11. Accessibility commitments

- All interactive elements reachable by keyboard. Tab order matches visual order.
- `:focus-visible` style is non-negotiable — the two-layer ring (§5.9).
- Color is never the sole carrier of meaning. Status pills always pair dot + label. Priority badges include the word (High / Medium / Low), not just color.
- Slideovers and dialogs trap focus while open; restore focus to the trigger on close.
- `aria-live` regions for toasts (polite/assertive depending on severity).
- Honor `prefers-reduced-motion`.
- Color contrast verified at WCAG AA for normal text. Tertiary `fg-3` is reserved for non-essential text (captions, metadata) where AA is hard; AAA-critical paths use `fg-2` or `fg`.

## 12. Theming and theme switching

- Theme stored in localStorage as `folio:theme = "light" | "dark" | "system"`.
- System default: matches `prefers-color-scheme`.
- Toggle lives in workspace settings and is accessible via Cmd-K ("Switch theme").
- The `.dark` class is added to `<html>` to flip tokens; no per-component branching.
- First-paint flash avoided by inlining a theme bootstrap snippet in `index.html` that reads localStorage before React mounts.

## 13. Non-goals (explicitly out of scope for v1.0)

- Resizable panels (see §7.8).
- Multiple open documents in tabs (see §7.8).
- Custom theme builder. Users get light + dark; per-customer color customization is a v1.1+ concern.
- Per-project icon/banner imagery. Project surfaces are typographic only.
- Animations beyond the motion tokens defined in §5.8. No spring physics, no scroll-driven effects.
- Right-to-left text support. Defer to when a real customer needs it.

## 14. Acceptance criteria

The design system is complete when:

1. `tokens.css` exists with all values from §5, light and dark.
2. `tailwind.config.ts` maps every token to a semantic utility name; no raw hex in any feature file.
3. All primitives in §8 exist in `components/ui/`, render correctly in light and dark, and have working `:focus-visible` states.
4. The shell components (`shell.tsx`, `rail.tsx`, `main-frame.tsx`, `right-panel.tsx`, `workspace-switcher.tsx`) compose into the layout described in §7.
5. A Storybook-style index page (or equivalent — `/dev/design-system` route, dev-only) renders every primitive and the shell in both themes. This is the visual regression baseline for future phases.
6. The login page and home/workspace-picker (already scaffolded) are re-styled to consume the new tokens — sanity check that nothing in the existing scaffold blocks adoption.
7. Lighthouse accessibility audit on the design-system index page passes ≥ 95.
8. The mockups in `.superpowers/brainstorm/53908-1778511064/content/final-design-language.html` match what the implementation renders in the design-system index.

## 15. Reference renders

The canonical mockups (mid-fidelity, dev companion):

- `.superpowers/brainstorm/53908-1778511064/content/final-design-language.html` — light list with panel + dark list without panel + token catalogue. **Primary reference.**
- `.superpowers/brainstorm/53908-1778511064/content/folio-coreoss-shell.html` — earlier exploration with Fraunces (kept for archival; design moved on from this).
- `.superpowers/brainstorm/53908-1778511064/content/posture-furnished-vs-flat.html` — the posture exploration that locked the shell choice.
- `.superpowers/brainstorm/53908-1778511064/content/type-options.html` — the type exploration that locked Geist-only.

These are documentation, not contracts — the spec above is the contract.

## 16. Open questions intentionally deferred

Surfaced now so they're not surprises later:

1. **Font loading strategy.** Self-host Geist + Geist Mono in `apps/web/public/fonts/` to avoid Google Fonts dependency in a self-hosted product. Confirm in Phase 1 setup.
2. **Brand "F" mark.** Currently a typographic mark in the primary square. A real wordmark/logotype is a v1.1 concern; the typographic mark is sufficient and uses zero design budget.
3. **Status pill colors are bound to status category, not status name.** A project with two "in_progress"-category statuses ("Doing" and "Blocked") will render both in warning amber. That's intended for v1; differentiating same-category statuses is a v1.1 concern.

## 17. What comes after this spec

Once this spec is approved and committed, the next brainstorm session covers **Phase 1 — Core CRUD** (documents API, statuses/fields/views, list + kanban + slideover, Milkdown + CodeMirror raw toggle). That spec consumes this design system; it does not redefine any visual decisions.
