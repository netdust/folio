# Phase 2.6 — Manual QA Scenarios

Walk every scenario before merging `phase-2.6/comments-and-slideover` to main. Capture screenshots into `apps/web/tests/manual-qa-phase-2.6-screenshots/` if anomalies appear.

Prereqs: `bun dev` running, fresh DB or demo seed loaded (`bun run scripts/seed-demo.ts`), logged in as `stefan@netdust.be`.

---

## Sub-phase A + B — Comments core + MCP tools

### 1. Plain comment on a work item

- [ ] Open any work item slideover → Comments tab.
- [ ] Composer is visible; placeholder text reads naturally.
- [ ] Type "this is a test", Cmd+Enter.
- [ ] Comment appears in the list with my avatar, name, timestamp.
- [ ] Reload — comment persists. DB has a `type=comment` document linked to the parent.

### 2. @mention of a workspace agent

- [ ] In a work item where at least one workspace agent has the current project in its allow-list:
- [ ] Type "hey @" → MentionPicker opens with the agent in it.
- [ ] Select → composer shows `@<agent-slug>` chip.
- [ ] Submit → comment list shows resolved mention.
- [ ] An `comment.mentioned` event row exists in the events table.

### 3. @mention of a member

- [ ] Type "@" → MentionPicker shows workspace members too.
- [ ] Select another member → submit. No `comment.mentioned` event (members aren't agents).

### 4. Wiki-link `[[`

- [ ] Type "[[" → WikiLinkPicker opens with current-project docs.
- [ ] Select → composer shows `[[doc-slug]]`.
- [ ] Submit → rendered comment shows the linked title (or slug if untitled). Click → navigates to that doc.

### 5. Approval keyword auto-conversion

- [ ] On a work item, type "@drafter approved — looks good" → submit.
- [ ] Comment row renders with an "Approval" badge AND a `target_agent: drafter` chip.
- [ ] DB: `kind=approval`, `target_agent='drafter'` in frontmatter.

### 6. Approval/Reject buttons

- [ ] Hover the approval comment → ✓ Approve / ✗ Reject buttons visible.
- [ ] Click Reject → creates a new comment with `kind=rejection`. The approval becomes resolved.

### 7. Edit own comment

- [ ] On my own comment, hover → Edit affordance visible.
- [ ] Click → composer pre-fills with body.
- [ ] Save → comment body updates. `edited_at` shown next to timestamp.

### 8. Delete own comment (soft)

- [ ] Hover own comment → Delete. Confirm dialog → confirm.
- [ ] Row becomes "Deleted by …" placeholder.
- [ ] No row removal — just soft-delete. Refresh confirms persistence.

### 9. Non-author cannot edit/delete

- [ ] Log in as a different user (or use a different bearer token).
- [ ] Try to edit / delete a comment authored by someone else → 403 with `COMMENT_AUTHOR_ONLY`.

### 10. Localstorage draft persistence

- [ ] Open a slideover, type a partial comment in the composer.
- [ ] Close slideover → reopen → draft is restored.
- [ ] Submit → draft cleared.

### 11. Visibility toggle (public / internal)

- [ ] Composer has a visibility toggle.
- [ ] Send an "internal" comment → renders with a small "internal" pill.
- [ ] Logged-in non-member (if testable) does not see internal comments.

### 12. MCP create_comment (via curl)

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer <pat>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_comment","arguments":{"workspace_slug":"acme","project_slug":"web","parent_slug":"WI-1","body":"comment from MCP"}}}'
```

- [ ] Returns the created comment. UI shows it on next refresh / SSE event.

---

## Sub-phase C — Tabbed slideover

### 13. Work item slideover tabs

- [ ] Work item slideover renders 3 tabs: Fields, Comments, Activity.
- [ ] All three switch correctly. Body editor stays mounted under the tab area.

### 14. Page slideover tabs

- [ ] Page slideover renders 3 tabs. "Fields" tab shows the empty-state note "No fields for pages." (intentional in v1.)

### 15. Agent slideover tabs

- [ ] Agent slideover renders 3 tabs: Fields, Activity, Runs.
- [ ] Runs tab shows "No runs yet — Phase 3 wires the runner."

### 16. Trigger slideover tabs

- [ ] Trigger slideover renders 3 tabs: Fields, Activity, Runs.
- [ ] Fields tab renders the structured **TriggerForm** (NOT the generic FrontmatterForm).

### 17. Workspace agent Activity tab

- [ ] On a workspace agent's Activity tab, the LogActivity button is visible.
- [ ] Clicking → opens the activity composer → save logs an `activity.logged` event.

### 18. Tab keyboard nav

- [ ] Focus the TabStrip → Left/Right arrows cycle tabs. Enter / Space activates.
- [ ] Tab focus ring visible.

---

## Sub-phase D — Trigger form + builtins + MCP agent-lifecycle

### 19. New workspace auto-seeds 4 builtin triggers

- [ ] Create a new workspace via UI → open Triggers settings.
- [ ] See exactly: `builtin-on-assignment`, `builtin-on-mention`, `builtin-on-approval`, `builtin-on-rejection`.
- [ ] Approval + Rejection are `enabled=true`; Assignment + Mention are `enabled=false`.

### 20. Builtin trigger read-only banner

- [ ] Open `builtin-on-approval` slideover → Fields tab.
- [ ] Banner: "Builtin trigger — only the Enabled toggle is mutable."
- [ ] Schedule/Event mode radios disabled; event-kind dropdown disabled; agent select disabled; payload textarea disabled.
- [ ] Only the Enabled toggle is interactive.

### 21. Builtin enabled toggle works

- [ ] Toggle Enabled off → Save → reload → still off.
- [ ] DB: `frontmatter.enabled === false`.

### 22. Builtin delete blocked

- [ ] Try to DELETE a builtin trigger via API:
```bash
curl -X DELETE http://localhost:3001/api/v1/w/acme/documents/builtin-on-approval \
  -H "Cookie: <session>"
```
- [ ] Returns 422 with `BUILTIN_TRIGGER_LOCKED`.

### 23. Custom trigger — schedule mode

- [ ] Create a custom trigger via the workspace popover.
- [ ] Open it → Fields tab → mode is "Schedule" by default (cron field visible).
- [ ] Type `0 9 * * *` → green ✓ appears, "Next: ..." preview shows 3 ISO timestamps.
- [ ] Type `not a cron` → red ✗ appears, preview hidden.

### 24. Custom trigger — event mode

- [ ] Switch to Event mode → cron input hides, event-kind dropdown appears.
- [ ] Dropdown lists all `KNOWN_EVENT_KINDS` (comment.created, agent.task.assigned, etc.).
- [ ] Add a key/value filter row → reflected in `frontmatter.event_filter`.

### 25. Custom trigger — agent select with $event option

- [ ] Agent dropdown lists workspace agents.
- [ ] Last option: "— event field —". Select → text input appears.
- [ ] Type `$event.assignee_slug` → onChange propagates → Save → DB has `agent: '$event.assignee_slug'`.

### 26. Custom trigger — JSON payload

- [ ] Payload textarea accepts valid JSON like `{"foo":"bar"}`.
- [ ] Invalid JSON like `{not json` shows `aria-invalid` red border.
- [ ] Save respects the dirty check.

### 27. Backfill script idempotent

For an older workspace without builtins (e.g. via a backup restore):

```bash
bun run scripts/backfill-builtin-triggers.ts
# First run: inserts 4 triggers per missing workspace.
bun run scripts/backfill-builtin-triggers.ts
# Second run: 0 workspaces touched, 0 inserts.
```

### 28. MCP create_agent (one-time agent_token reveal)

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer <pat-with-agents:write>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_agent","arguments":{"workspace_slug":"acme","title":"Helper","frontmatter":{"system_prompt":"help","provider":"anthropic","model":"claude-sonnet-4-6","tools":["list_documents"]}}}}'
```

- [ ] Response includes `agent_token`. Save it — won't be re-shown.
- [ ] `list_agents` MCP call shows the new agent.
- [ ] DB has an `api_tokens` row linked to the agent.

### 29. MCP delete_agent

- [ ] Call `delete_agent` with the agent from above. Verify row gone + cascade deleted token.

### 30. MCP get_agent_self requires agent-bound token

- [ ] Using a user-minted PAT (no agent_id binding), `get_agent_self` returns `-32602 no_agent_bound_to_token`.
- [ ] Using the agent's own token, `get_agent_self` returns the agent doc.

### 31. MCP update_agent allow-list widening rejected

- [ ] As agent A with `projects: [prA]`, try to update agent B's `projects` to `[prA, prB]`.
- [ ] Returns `-32602` with `allow_list_widening_forbidden`.

### 32. MCP delete_agent self-delete rejected

- [ ] As agent A, call `delete_agent` with own slug → `-32602 cannot_delete_self`.

### 33. Tokens UI exposes agents:write

- [ ] Workspace Settings → API tokens → + Create token.
- [ ] `agents:write` checkbox present.
- [ ] "Read + write" preset checks it. "Read-only" does not. "Full access" does.

---

## Sub-phase E — Reconciler

### 34. Reconciler scrubs orphan project ids

- [ ] Seed a workspace with an agent that has `projects: [p1, p2]`.
- [ ] Delete `p2` directly via SQL (bypassing the cascade hook).
- [ ] Trigger the reconciler (or wait for next interval, or call programmatically):
```bash
bun -e "import { db } from './apps/server/src/db/client.ts'; import { reconcileAllowLists } from './apps/server/src/lib/reconciler.ts'; await reconcileAllowLists(db); process.exit(0)"
```
- [ ] Agent's `frontmatter.projects` is now `[p1]`.
- [ ] An `agent.allow_list.reconciled` event was emitted.

### 35. Reconciler skips wildcards

- [ ] An agent with `projects: ['*']` is never modified by the reconciler.

### 36. Reconciler boot log

- [ ] Start the server outside test mode. First lines include `[folio] reconciler enabled (interval: 3600000ms)`.

---

## Polish + accessibility

### 37. ESC closes inner picker, not the slideover

- [ ] Open slideover → start typing `@` → MentionPicker open.
- [ ] Press ESC → picker closes, slideover stays.

### 38. Tab focus rings visible

- [ ] Click around with keyboard only. Focus rings visible on every interactive element (composer, picker rows, tab strip, payload textarea, save button).

### 39. Dark mode

- [ ] Toggle dark mode. Spot-check: TabStrip, CommentComposer, TriggerForm, builtin banner all render with correct contrast.

### 40. Copy-as-MD includes new comment metadata

- [ ] Copy-as-MD on a work item that has comments + an approval. The copied markdown contains the comment thread + the approval kind.

---

## Sign-off

When every checkbox is ticked (or its anomaly is filed as a shake-out bug), the manual QA gate is passed. Merge with `--no-ff`.
