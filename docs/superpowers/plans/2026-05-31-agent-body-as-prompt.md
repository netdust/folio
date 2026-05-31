# Agent Body-as-Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent's **markdown body** its system prompt (what the runner sends as `system`), instead of the `frontmatter.system_prompt` field — so the obvious, full-size editor is where you write the prompt, not a cramped frontmatter input.

**Architecture:** The runner snapshots the prompt onto each run at create-time (`createRun`, for run reproducibility). Today it snapshots `agentFm.system_prompt`; we change it to snapshot `agent.body`. The `agent_run` frontmatter keeps its `system_prompt` field (it's the per-run *snapshot* — runs stay self-contained), only its SOURCE changes. The agent frontmatter's `system_prompt` becomes optional/ignored; the web agent Fields form drops the `system_prompt` row and labels the body editor as the prompt. A one-time migration copies each existing agent's `frontmatter.system_prompt` into its `body` (only when the body is empty), then drops the now-unused frontmatter key.

**Tech Stack:** Bun, Hono, Drizzle, SQLite (server); React + Vite + Tailwind (web); Bun test + Vitest.

---

## Why (the UX problem this fixes)

Reported 2026-05-31: on the agent slideover, the `system_prompt` frontmatter field renders as a cramped one-line input (easy to miss), while the large markdown body editor below looks like the place to write the prompt — but the runner ignores the body and reads `frontmatter.system_prompt`. Two surfaces that look like "the prompt"; only one is real, and it's the wrong-feeling one. Decision (2026-05-31): **flip it — the body IS the prompt.** The body editor is the natural full-size prompt surface; the frontmatter loses its prompt field.

## Ground-truth (verified 2026-05-31 against HEAD)

| Fact | Reality |
|---|---|
| Runner prompt source | `apps/server/src/lib/runner.ts:565` — `provider.stream({ system: ctx.fm.system_prompt, ... })`. `ctx.fm` is the RUN's `AgentRunFrontmatter`, NOT the agent's. |
| Where the run's `system_prompt` comes from | `apps/server/src/services/agent-runs.ts:115` — `const systemPrompt = agentFm.system_prompt as string;` then `:128` writes it onto `runFm.system_prompt`. SNAPSHOT at run-create (mitigation 23: the run is its own scope, immune to later agent edits). |
| `createRun` has the agent doc | `agent-runs.ts:107` — `const { workspace, project, runsTable, agent, actor, input } = args;`. `agent` is the full `Document`, so `agent.body` is available. |
| Run frontmatter schema | `apps/server/src/lib/agent-run-schema.ts:70` — `system_prompt: z.string()`. KEEP (it's the per-run snapshot; only its source changes). |
| Agent frontmatter schema | `apps/server/src/lib/agent-schema.ts:7` — `system_prompt: z.string().min(1)` (REQUIRED). This is what we relax. |
| Runner uses the agent's body anywhere? | NO. `runner.ts` builds messages from the PARENT doc body (`buildInitialMessages` :460) + comment thread. The AGENT doc's body is currently unused by the runner. |
| Body messages | `runner.ts:460` `ctx.parent.body` → user message (the task). UNCHANGED by this plan — that's the work-item, not the agent. |
| Web agent form | `apps/web/src/components/slideover/frontmatter-form.tsx:26` `AGENT_FIELDS[0]` = `system_prompt` (description "Instructions the agent receives on every run…"). Renders via `FieldRenderer` (a short value → one-line input). |
| Web create-defaults | `apps/web/src/components/agent-panel/agent-list.tsx` `onCreate` seeds `frontmatter: { system_prompt: 'Describe what this agent does.', model, provider, tools: [] }`, title 'Untitled'. NO body seeded. |
| Server-side seed of system_prompt | NONE (grep clean). The web `onCreate` is the only place a default prompt string is set. |
| Body editor on agent Fields | `workspace-document-slideover.tsx` — Fields tab (agent branch) renders FrontmatterForm (capped) + the BodyEditor below. The body editor has NO label today. |
| Migration journal | Every new `.sql` MUST also be added to `apps/server/src/db/migrations/meta/_journal.json` ([[drizzle-migration-journal]]) or `migrate()` silently skips it. |

## Threat model

This change moves the runner's `system` prompt source from a frontmatter string to the agent doc's body, and migrates operator-sensitive data. Inherits the Phase-3 threat model (66 mitigations); the relevant deltas:

- **Mitigation 23 (run is its own scope) — PRESERVED.** The prompt is still SNAPSHOTTED onto the run at `createRun` (now from `agent.body` instead of `agentFm.system_prompt`). A later edit of the agent body does NOT mutate historical runs. The run schema's `system_prompt` field is unchanged; only its source moves. **Verify in a test.**
- **The agent body is operator-authored, same trust level as the old `system_prompt`.** No new untrusted-input surface: an agent's body was already writable by the same actors who could write `frontmatter.system_prompt` (workspace operators / `agents:write` token holders). The prompt's trust boundary is unchanged.
- **Empty-prompt guard.** Old schema enforced `system_prompt: z.string().min(1)` (non-empty). Body has no such floor. The runner must not send an empty `system` (some providers reject it; an empty prompt is also a footgun). `createRun` MUST reject (or the runner MUST fail the run with a clear reason) when the resolved prompt (agent body) is empty/whitespace. **New mitigation — Task 2 enforces it.**
- **Migration safety.** Copying `system_prompt` → `body` must NEVER overwrite a non-empty existing body (data loss). Only fill when body is empty/whitespace. Idempotent (re-runnable). **Task 5.**
- **System-prompt exposure (mitigation: `AGENT_RUN_REQUIRES_RUNNER_PATH`, the C1 fix) — UNAFFECTED.** The run's `system_prompt` snapshot is still walled off from `GET /documents`; the agent BODY is served via the normal agent-doc endpoint (it always was — agents' bodies aren't secret, they're operator-visible config). No change to what's exposed.

No new outbound requests, no new user-supplied URLs, no new parsing of external input. The change is confined to "which field of an operator-authored doc becomes the prompt." No threat-model EXTENSION required beyond the empty-prompt guard (Task 2) and migration-no-clobber (Task 5).

---

## File Structure

**Server (modify):**
- `apps/server/src/services/agent-runs.ts` — `createRun`: snapshot `agent.body` (trimmed) as the prompt instead of `agentFm.system_prompt`; reject empty.
- `apps/server/src/lib/agent-schema.ts` — `system_prompt` becomes `.optional()` (legacy/ignored), so existing + new agents validate without it.
- `apps/server/src/db/migrations/0013_agent_body_as_prompt.sql` (new) + `meta/_journal.json` (append) — copy `system_prompt` → `body` where body empty; remove the `system_prompt` key from agent frontmatter.

**Web (modify):**
- `apps/web/src/components/slideover/frontmatter-form.tsx` — drop the `system_prompt` row from `AGENT_FIELDS` (it's no longer a frontmatter field the user edits).
- `apps/web/src/components/agent-panel/agent-list.tsx` — `onCreate`: drop `system_prompt` from seeded frontmatter; seed a starter `body` instead.
- `apps/web/src/components/slideover/workspace-document-slideover.tsx` — label the agent Fields body editor as the **Prompt** (a small heading above the editor) so it reads as the prompt field.

**Runner:** `runner.ts:565` needs NO change — it still reads `ctx.fm.system_prompt` (the run snapshot). Only the snapshot's SOURCE (in `createRun`) changes. This keeps the run self-contained (mitigation 23).

---

### Task 1: Runner reads the agent body as the prompt snapshot

**Files:** Modify `apps/server/src/services/agent-runs.ts` (the `createRun` snapshot, ~line 115). Test: `apps/server/src/services/agent-runs.test.ts`.

**Scope:** `createRun` currently snapshots `agentFm.system_prompt` onto `runFm.system_prompt`. Change it to snapshot the agent's **body** (trimmed). The run frontmatter field name stays `system_prompt` (it's the snapshot the runner reads); only the source changes.

- [ ] **Step 1: Write the failing test** — add to `agent-runs.test.ts`. (Read the file's existing `createRun` test for the exact fixture shape — how it builds the `agent` Document, workspace, project, runsTable; reuse that harness.) Assert the run's `system_prompt` snapshot equals the agent's BODY, not its `frontmatter.system_prompt`:

```ts
test('createRun snapshots the agent BODY as the run system prompt (not frontmatter.system_prompt)', async () => {
  // Build an agent whose body and frontmatter.system_prompt DIFFER, so the
  // assertion proves the source is the body.
  const agent = /* ...existing fixture helper... */ {
    /* type:'agent', slug, frontmatter: { provider:'anthropic', model:'…',
       system_prompt:'LEGACY FM PROMPT', max_tokens_per_run: 5000, tools: [], projects: ['*'] },
       body: 'You are the body prompt.' */
  };
  const result = await createRun({ /* workspace, project, runsTable, agent, actor, input */ });
  const runFm = result.run.frontmatter as { system_prompt: string };
  expect(runFm.system_prompt).toBe('You are the body prompt.');
  expect(runFm.system_prompt).not.toContain('LEGACY FM PROMPT');
});
```

- [ ] **Step 2: RED** — `cd apps/server && bun test src/services/agent-runs.test.ts` → fails (snapshot still equals the frontmatter value).

- [ ] **Step 3: Implement** — in `agent-runs.ts`, change the snapshot source:

```ts
  // The agent's BODY is its system prompt (the markdown editor is the prompt
  // surface). Snapshot it onto the run at create-time so a later edit of the
  // agent body doesn't mutate historical runs (mitigation 23). `system_prompt`
  // remains the run-frontmatter field name (the runner reads ctx.fm.system_prompt).
  const systemPrompt = (agent.body ?? '').trim();
```

(Leave the `runFm.system_prompt: systemPrompt` line as-is — only the assignment of `systemPrompt` changed.)

- [ ] **Step 4: GREEN** — `cd apps/server && bun test src/services/agent-runs.test.ts`.

> **⚠️ Step 2.5:** Read `createRun`'s exact arg destructuring + the existing test's agent fixture (does it set `.body`? it may default to `''`). Confirm `agent.body` is on the `Document` type the test passes. Confirm no OTHER caller of `createRun` relies on `agentFm.system_prompt` being the source.

- [ ] **Step 5: Commit**

```bash
cd apps/server && bun x tsc --noEmit -p . 2>/dev/null || true
git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts
git commit -m "feat(runner): snapshot the agent BODY as the run system prompt (was frontmatter.system_prompt)"
```

---

### Task 2: Reject an empty prompt at run creation

**Files:** Modify `apps/server/src/services/agent-runs.ts` (`createRun`). Test: `agent-runs.test.ts`.

**Scope:** The old `system_prompt: z.string().min(1)` guaranteed a non-empty prompt. The body has no such floor — an agent with an empty body would send an empty `system` to the provider (some reject it; silent footgun). `createRun` must reject when the resolved prompt is empty/whitespace, with a clear error.

- [ ] **Step 1: Failing test**

```ts
test('createRun rejects an agent whose body (the prompt) is empty', async () => {
  const agent = /* ...fixture... body: '   ' (whitespace) */;
  await expect(createRun({ /* ...args, agent... */ })).rejects.toThrow(/empty|prompt/i);
});
```

- [ ] **Step 2: RED** — run it; today it would create a run with an empty `system_prompt`.

- [ ] **Step 3: Implement** — right after computing `systemPrompt` in `createRun`:

```ts
  if (systemPrompt.length === 0) {
    throw new HTTPError(
      'AGENT_PROMPT_EMPTY',
      'This agent has no prompt. Write the agent\'s instructions in its document body before running it.',
      422,
    );
  }
```

(Use the same `HTTPError` import + code style already in `agent-runs.ts` — read the file's top for the exact error class/import. If the service throws a different error type than routes' `HTTPException`, match the SERVICE's convention.)

> **⚠️ Step 2.5:** Confirm the error class used in `agent-runs.ts` (it may throw `HTTPError`, a domain error, or return a Result — match it). Confirm 422 is the right status for "operator misconfigured the agent" (consistent with other createRun validation errors in the file). Check whether any existing test creates a run with an empty-body agent fixture — it would now fail and must seed a body.

- [ ] **Step 4: GREEN** — `cd apps/server && bun test src/services/agent-runs.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts
git commit -m "feat(runner): reject run creation when the agent prompt (body) is empty"
```

---

### Task 3: Relax the agent schema — `system_prompt` optional

**Files:** Modify `apps/server/src/lib/agent-schema.ts:7`. Test: the schema's existing test (find it: `agent-schema.test.ts` or wherever `agentFrontmatterSchema` is asserted).

**Scope:** `system_prompt: z.string().min(1)` is required today, so existing agents (and new ones created without it) would fail validation once the web form drops the field. Make it optional + legacy (no longer the prompt source). New agents won't carry it; old ones validate until the migration strips it.

- [ ] **Step 1: Failing test** — assert an agent frontmatter WITHOUT `system_prompt` parses:

```ts
test('agent frontmatter validates without system_prompt (body is the prompt now)', () => {
  const result = agentFrontmatterSchema.safeParse({
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    tools: [],
    projects: ['*'],
  });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: RED** — fails: `system_prompt` required.

- [ ] **Step 3: Implement** — `agent-schema.ts:7`:

```ts
  // Legacy: the agent's prompt now lives in its document BODY (snapshotted onto
  // each run at create-time). Kept optional so pre-migration agents still
  // validate; migration 0013 strips it. New agents don't carry it.
  system_prompt: z.string().optional(),
```

- [ ] **Step 4: GREEN** — `cd apps/server && bun test src/lib/agent-schema.test.ts` (or the file you found).

> **⚠️ Step 2.5:** Find the schema's test file (grep `agentFrontmatterSchema`). Check whether any OTHER test or service treats `system_prompt` as required-present (e.g. a `.system_prompt as string` cast that would now be `string | undefined`). The `createRun` cast was already removed in Task 1. Grep `agentFm.system_prompt` / `frontmatter.system_prompt` across the server for casts that assume presence.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-schema.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "feat(agents): system_prompt frontmatter is now optional/legacy (body is the prompt)"
```

---

### Task 4: Web — drop the `system_prompt` form field; seed + label the body as the prompt

**Files:** Modify `apps/web/src/components/slideover/frontmatter-form.tsx` (AGENT_FIELDS), `apps/web/src/components/agent-panel/agent-list.tsx` (onCreate), `apps/web/src/components/slideover/workspace-document-slideover.tsx` (label the body editor). Tests: the respective `.test.tsx` for any that assert `system_prompt`.

**Scope:** The frontmatter form should no longer show a `system_prompt` row. New agents seed a starter BODY (the prompt) instead of a `system_prompt` frontmatter value. The agent Fields body editor gets a small "Prompt" heading so it reads as the prompt surface.

- [ ] **Step 1: Failing test** (form) — assert the agent FrontmatterForm renders NO `system_prompt` field. (Find `frontmatter-form.test.tsx`; if it asserts the system_prompt row exists, invert it.) Minimal new assertion:

```tsx
// In frontmatter-form.test.tsx, rendering an agent:
expect(screen.queryByText('system_prompt')).toBeNull();
```

- [ ] **Step 2: RED → implement** — in `frontmatter-form.tsx`, remove the first `AGENT_FIELDS` entry:

```ts
const AGENT_FIELDS: AgentFieldMeta[] = [
  // system_prompt removed — the agent's prompt is now its document body
  // (rendered by the body editor on the Fields tab), not a frontmatter field.
  { key: 'provider', description: 'AI provider + model. Needs a configured API key in workspace settings.' },
  { key: 'tools', description: 'MCP tools this agent can call. Read tools list/get; write tools create/update; delete removes documents.' },
  { key: 'projects', description: 'Projects this agent can act on. "Select all" = every workspace project, current and future.' },
  { key: 'max_delegation_depth', description: 'How many levels of agent-to-agent assignment this agent can trigger. 0 = cannot delegate.' },
  { key: 'max_tokens_per_run', description: 'Hard cap on token spend per agent run. Prevents runaway loops.' },
  { key: 'requires_approval', description: 'When true, the agent\'s writes wait for a human "## Approved" line in the work item body.' },
];
```

- [ ] **Step 3: Update create-defaults** — `agent-list.tsx` `onCreate`:

```ts
const created = await create.mutateAsync({
  type: 'agent',
  title: 'Untitled',
  // The body IS the prompt — seed a starter so the editor isn't blank and the
  // empty-prompt guard (server) doesn't block the first run.
  body: '# Prompt\n\nDescribe this agent: its role, and what it should do on every run.',
  frontmatter: {
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    tools: [],
  },
});
```

- [ ] **Step 4: Label the body editor as the Prompt** — in `workspace-document-slideover.tsx`, the agent Fields branch (`tab === 'fields' && doc.type !== 'trigger'`) renders FrontmatterForm + the `workspace-slideover-editor` div. Add a small heading above the editor so it reads as the prompt field:

```tsx
          <div
            data-testid="workspace-slideover-editor"
            className="folio-scroll flex-1 min-h-0 overflow-y-auto border-t border-border-light pt-4 focus-within:border-fg-3"
          >
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-fg-3">
              Prompt
            </div>
            {mode === 'rich' ? (
              <BodyEditor /* …unchanged… */ />
            ) : (
              <RawMdEditor /* …unchanged… */ />
            )}
          </div>
```

- [ ] **Step 5: GREEN** — `cd apps/web && bun run test src/components/slideover/frontmatter-form.test.tsx src/components/agent-panel/agent-list.test.tsx src/components/slideover/workspace-document-slideover.test.tsx`.

> **⚠️ Step 2.5:** Grep web tests for `system_prompt` — `agent-list.test.tsx` (asserts the create frontmatter — must drop `system_prompt`, may assert the new `body`), `frontmatter-form.test.tsx`, and any agent-create flow test. Update each to the new shape. Confirm `useCreateWorkspaceDocument`'s vars type accepts `body` (it does — Task 5 of the cockpit plan used it). Confirm the "Prompt" heading doesn't break the editor's flex layout (it's a shrink-0 label above a flex-1 editor).

- [ ] **Step 6: Commit**

```bash
cd apps/web && bun x tsc --noEmit
git add apps/web/src/components/slideover/frontmatter-form.tsx apps/web/src/components/agent-panel/agent-list.tsx apps/web/src/components/slideover/workspace-document-slideover.tsx apps/web/src/components/slideover/frontmatter-form.test.tsx apps/web/src/components/agent-panel/agent-list.test.tsx
git commit -m "ui(agents): drop system_prompt field; the body editor is the prompt (labelled)"
```

---

### Task 5: Migration — copy `system_prompt` → body for existing agents

> **⚠ Plan correction (shipped in `6a5e3c9`):** the plan calls this migration **`0013`** throughout — that number is WRONG. `0013_workspace_provider_health`, `0014_worker_started_at_z_check`, and `0015_reactor_cursors` already exist; the journal's last entry is `idx:16 / tag:0015_reactor_cursors`. The migration SHIPPED as **`0016_agent_body_as_prompt.sql`** with journal **`idx:17`** (`when:1780910000000`). Read every `0013` below as `0016`. Everything else (the SQL, the no-clobber guard, the 0012a test pattern) shipped verbatim.

**Files:** Create `apps/server/src/db/migrations/0013_agent_body_as_prompt.sql` + append to `apps/server/src/db/migrations/meta/_journal.json`. Test: a migration test (find the pattern in `apps/server/src/db/migrations/` tests, e.g. how 0012/0012a are tested — per [[feedback_drizzle-migrate-is-idempotent]], seed rows then `sqlite.exec(readFileSync(<migration>))`).

**Scope:** For every existing `type='agent'` document: if its body is empty/whitespace AND its `frontmatter.system_prompt` is non-empty, set `body = frontmatter.system_prompt`. Then remove the `system_prompt` key from every agent's frontmatter. NEVER clobber a non-empty body (data-loss guard). Idempotent.

- [ ] **Step 1: Failing test** — seed two agents (one with empty body + a `system_prompt`; one with a non-empty body + a `system_prompt`), run the migration SQL, assert: agent A's body becomes its old `system_prompt` and its frontmatter loses `system_prompt`; agent B's body is UNCHANGED (no clobber) and its frontmatter loses `system_prompt`. (Mirror the existing migration-test harness — read how `0012a` is tested for the seed-then-exec pattern + the `_journal.json` caveat.)

- [ ] **Step 2: RED** — no migration file yet.

- [ ] **Step 3: Write the migration SQL** — `0013_agent_body_as_prompt.sql`. SQLite JSON functions (`json_extract`, `json_remove`). Body column is `body` on `documents`; frontmatter is the JSON `frontmatter` column.

```sql
-- Agent prompt moves from frontmatter.system_prompt to the document body.
-- 1) Backfill body from system_prompt ONLY where body is empty/blank (no clobber).
UPDATE documents
SET body = json_extract(frontmatter, '$.system_prompt')
WHERE type = 'agent'
  AND TRIM(COALESCE(body, '')) = ''
  AND TRIM(COALESCE(json_extract(frontmatter, '$.system_prompt'), '')) <> '';

-- 2) Strip the now-legacy system_prompt key from every agent's frontmatter.
UPDATE documents
SET frontmatter = json_remove(frontmatter, '$.system_prompt')
WHERE type = 'agent'
  AND json_extract(frontmatter, '$.system_prompt') IS NOT NULL;
```

- [ ] **Step 4: Append to the journal** — add the `0013_agent_body_as_prompt` entry to `apps/server/src/db/migrations/meta/_journal.json` (copy the shape of the 0012 entry: `idx`, `version`, `when` (use a fixed integer timestamp consistent with the existing entries — read the last entry and increment plausibly), `tag`, `breakpoints`). **Per [[drizzle-migration-journal]], `migrate()` silently skips files not in the journal — this step is mandatory.**

- [ ] **Step 5: GREEN** — run the migration test; assert both the backfill-when-empty and the no-clobber-when-present behaviors, and that `system_prompt` is gone from frontmatter in both.

> **⚠️ Step 2.5:** Read an existing migration (`0012_*.sql`) + its `_journal.json` entry for the exact format. Confirm `documents` has a `body` column (not `content`). Confirm SQLite build here supports `json_extract`/`json_remove` (bun:sqlite does). Verify the pre-commit migration-journal hook (per CLAUDE.md `./scripts/hooks/install.sh`) passes. Run the FULL server migration test (boot-migrate path) to confirm 0013 applies cleanly after 0012a.

- [ ] **Step 6: Commit**

```bash
cd apps/server && bun test src/db
git add apps/server/src/db/migrations/0013_agent_body_as_prompt.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/db/migrations/<the test file>
git commit -m "feat(db): migration 0013 — agent system_prompt -> body (no-clobber, strips legacy key)"
```

---

### Task 6: Integration gate

- [ ] Server suite green: `cd apps/server && bun test` (count should not drop; new tests in Tasks 1/2/3/5 add to it).
- [ ] Web suite green: `cd apps/web && bun run test`.
- [ ] tsc clean: `cd apps/server && bun x tsc --noEmit` (note: scripts/ + shared test-file `bun:test`-type noise is pre-existing) and `cd apps/web && bun x tsc --noEmit`.
- [ ] Grep: no remaining `agentFm.system_prompt` / `frontmatter.system_prompt as string` casts that assume presence in the server (Task 3's Step 2.5 surfaced them; confirm zero).
- [ ] Boot-migrate smoke: the server's auto-migrate-on-boot path applies 0013 after 0012a without error (run the migration test that exercises the full journal, or boot the server against a fresh DB).
- [ ] Manual smoke (or shake-out note): create a new agent → its body editor shows the "# Prompt" starter + a "Prompt" label; the Fields tab has NO `system_prompt` row; the header has no Edit/Raw clutter (those moved to ⋯). An existing agent (post-migration) shows its old system_prompt as the body. Launching an agent with an empty body → 422 "no prompt" (not a silent empty-system run).
- [ ] `/code-review --base=<this cluster's base> --effort=medium`.

---

## Self-Review

**Spec coverage:** body becomes the runner's prompt (Task 1) ✅ · empty-prompt guard (Task 2, threat-model mitigation) ✅ · agent schema relaxed (Task 3) ✅ · web form drops system_prompt + seeds/labels body (Task 4) ✅ · migration no-clobber + strip key + journal (Task 5) ✅ · run-snapshot reproducibility preserved (Task 1 keeps the snapshot, just changes its source — asserted) ✅ · integration gate (Task 6) ✅.

**Placeholder scan:** the test bodies in Tasks 1/2/5 reference "existing fixture helper / harness" rather than inlining the full fixture — that's a deliberate Step-2.5 ground-truth instruction (reuse the file's real fixture, which the implementer must read), not a TODO, because the agent/run fixture shape is verbose and file-specific. Every code CHANGE step has complete code. The ⚠️ notes are reconciliation gates naming the exact files to verify.

**Type consistency:** `system_prompt` stays a field on BOTH `AgentRunFrontmatter` (run snapshot, unchanged — `agent-run-schema.ts:70`) and becomes optional on `agentFrontmatterSchema` (Task 3). The runner reads `ctx.fm.system_prompt` (run fm) — UNCHANGED. `createRun` sources it from `agent.body` (Task 1). `useCreateWorkspaceDocument` vars accept `body` (used in the cockpit plan's AgentList). The "Prompt" label + body-editor wiring matches `workspace-document-slideover.tsx`'s current agent Fields branch.

**Decomposition note:** Tasks 1→2→3 are server-sequential (same file, build on each other); Task 4 is web-independent; Task 5 (migration) is independent of 1–4 but should land with them so a deployed instance migrates as the new code ships. Order: 1 → 2 → 3 → 5 (server) then 4 (web), or 4 in parallel. Task 6 gates.

---

## Execution Handoff

Dispatch via **`netdust-core:ntdst-execute-with-tests`** (upstream = `subagent-driven-development`), Step 2.5 per task (each ⚠️ note names the reconciliation target), two-stage review per task, re-verify suite counts ([[feedback_verify-subagent-test-counts]]). The migration (Task 5) is the highest-risk task — give it the migration-test + journal scrutiny ([[feedback_drizzle-migration-journal]], [[feedback_drizzle-migrate-is-idempotent]]).
