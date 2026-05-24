# Folio — Memory

Project-local memory. Lives in-repo so it travels with the code, shows up in `git diff`, and is visible to anyone (human or agent) who clones Folio.

## Files

| File | What it is | When it changes |
|------|------------|-----------------|
| `STATE.md` | Living snapshot of where the project actually is — current branch, what's working, what's open. | Session end, if anything below changed. Treat as "what would I need to re-explain tomorrow?" |
| `DECISIONS.md` | Locked architectural + product decisions with reasoning. Re-litigating any requires explicit "I want to revisit X" from Stefan. | Only when a decision is made or reversed. |
| `lessons.md` | Self-improvement log: corrections from Stefan distilled into directives for future-me. | After any user correction. Format is enforced in the file header. |
| `../tasks/todo.md` | Active task list for the current session/branch. Checkboxes you can mark off. | Frequently — during plan, during execution. |

## How this relates to other memory

- **`~/.claude/CLAUDE.md`** — global rules (no `git stash`, plan mode default, etc.). Applies to every project. Read at session start automatically.
- **`~/Sites/netdust-wp-manager/memory/`** — multi-site WordPress fleet memory. Folio is not a WP client site, so it sits outside that tree.
- **`~/.claude/projects/-home-ntdst-Projects-folio/memory/`** — auto-memory: tacit context the agent picks up across sessions (user preferences, scaffold defects, project deltas). Curated by Claude, not by Stefan. Complements but does not replace the in-repo files.

## What goes where

- **Architectural decision, locked** → `DECISIONS.md`.
- **Current state of the world** → `STATE.md`.
- **"Don't do that again"** → `lessons.md`.
- **Tasks for this session** → `../tasks/todo.md`.
- **Phase-level checkboxes** → `../docs/PHASES.md` (already exists, do not duplicate).
- **Spec / PRD-level intent** → `../docs/FOLIO-BRIEFING.md`.
- **Tacit "the agent learned X about Stefan"** → auto-memory at `~/.claude/projects/-home-ntdst-Projects-folio/memory/`.

## Update triggers (per the global "memory discipline" hook)

Update one of the in-repo files when:
- A decision was made that affects future sessions.
- A fragile spot or risk was found.
- A task completed that changes the state of what's shipped vs. pending.
- Context that would need re-explaining next session.

Do NOT update for:
- Routine edits, minor CSS fixes, content updates.
- Anything you'd forget yourself by tomorrow.
- Things already documented in `CLAUDE.md` / `docs/FOLIO-BRIEFING.md` / `docs/PHASES.md`.
