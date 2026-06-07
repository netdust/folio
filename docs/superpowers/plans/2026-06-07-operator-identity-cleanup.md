# Operator Identity Architectural Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse two pieces of operator-identity debt — the operator's synthetic FK-shaped `agentId` sentinel (finding #8) and the silent-omission `eventActor` default (finding #7) — into structural shapes where the class of bug cannot recur.

**Architecture:** Two independent refactors of the Folio server authority/event surfaces, executed as two review clusters.
- **Finding #8 (Shape B):** The operator's ephemeral conversation token stops carrying `OPERATOR_AGENT_ID` in `token.agentId`; it gets `agentId: null` instead. The operator is re-discriminated from a human PAT by the EXISTING `isOperatorToken(token)` marker (`workspaceId === null && createdBy === null`). A new `isAgentBound(token)` helper (`token.agentId !== null || isOperatorToken(token)`) replaces every `if (token.agentId)` agent-vs-human branch. `resolveAgentDocForToken` / `resolveCallingAgent` check `isOperatorToken` first. The `OPERATOR_AGENT_ID` FK-shaped sentinel is deleted; the `dispatchAsCaller` null-hack disappears.
- **Finding #7:** `eventActor?: string` → `eventActor: string` (required) on `create/update/deleteDocument`. Omission becomes a compile error, not a silent autonomy-gate disable. The FK-actor (`serviceActor`) split is untouched.

These close the documented residuals on ARCHITECTURE-INVARIANTS.md invariants 13 (operator sentinel resolution) and 15 (eventActor default).

**Tech Stack:** Bun, Hono, Drizzle, SQLite, TypeScript (strict). Tests: `bun test` from `apps/server`. Typecheck: `bun x tsc --noEmit` from `apps/server`.

---

## Ground-truth surface (verified against `main` 2026-06-07, NOT from summary)

**Finding #8 — sentinel sites:**
- `apps/server/src/lib/operator.ts:38` — `OPERATOR_AGENT_ID = 'operator:_operator'` (definition + its doc comment). Also `operator.ts:94` — `getOperatorDocument()` stamps `id: OPERATOR_AGENT_ID`.
- `apps/server/src/services/conversation-runs.ts:201` — THE mint site: `agentId: OPERATOR_AGENT_ID`.
- `apps/server/src/lib/agent-tools-registry.ts:210` — `resolveAgentDocForToken`: `if (token.agentId === OPERATOR_AGENT_ID) return getOperatorDocument()`.
- `apps/server/src/lib/agent-guards.ts:36` — `resolveCallingAgent`: same sentinel check (cycle-bound twin — cannot import the registry helper).
- `apps/server/src/lib/folio-api-tool.ts:210-211` — `dispatchAsCaller`: `const mintedAgentId = caller.agentId === OPERATOR_AGENT_ID ? null : caller.agentId` (the null-hack).
- Sentinel imports: `agent-tools-registry.ts:50`, `agent-guards.ts:21`, `folio-api-tool.ts` (top), `folio-api-tool.test.ts:5`.

**Finding #8 — `token.agentId` agent-vs-human branch sites (the blast radius — each needs `isAgentBound`):**
- `agent-tools-registry.ts:188` — `humanPatProjectCeiling`: `if (token.agentId) return null` (agent-bound: agent allow-list governs). **Operator already safe via the `!token.createdBy` guard on the next line** — but for clarity it should read `isAgentBound`. VERIFY no behavior change.
- `agent-tools-registry.ts:239` — `resolveProjectInWorkspace`: `if (token.agentId) {...allow-list...} else if (token.createdBy && ...) {...human...}`. Operator (agentId null, createdBy null) must take the AGENT branch, not fall through to neither.
- `agent-tools-registry.ts:277` — `resolveAuthorContextForToken`: `if (token.agentId) {...agent...} if (!token.createdBy) throw {...}`. Operator must resolve as agent (slug `_operator`), not throw "unknown_author".
- `agent-tools-registry.ts:352` — `resolveAgentAllowListForToken`: `if (!token.agentId) return null`. Operator IS agent-bound but `projects: ['*']` ⇒ the correct return is `null` (no narrowing) anyway. VERIFY the `isAgentBound` path still returns `null` for the operator (it resolves the doc → `['*']` → `null`).

**Finding #8 — `token.agentId` nullable-check sites (NOT agent-vs-human — leave as raw null checks):**
- `agent-tools-registry.ts:212` (`token.agentId!` after sentinel resolved), `:536/:666/:722/:1640/:1666/:1819`, `agent-guards.ts:37/:85/:167/:215/:250`, `routes/comments.ts:91/:100`, `routes/workspaces.ts:261/:263`, `trigger-matcher.ts:176`, `mcp-errors.ts:55`. These read agentId for lookup/nullability, NOT to distinguish operator-vs-human. They stay correct when the operator's agentId is null (operator falls into the human/null branch, which is what those sites already do for the operator today only because the sentinel was truthy — **EACH MUST BE AUDITED in Task 8b**, see the Sibling-site audit block).

**Finding #7 — eventActor sites:**
- `apps/server/src/services/documents.ts` — `createDocument` (sig ~470, `eventActor?: string` field ~482-487, default `args.eventActor ?? user.id` ~509), `updateDocument` (sig ~789, field ~792-800, default ~833), `deleteDocument` (sig ~1080, field ~1080-1085, default ~1086).
- 6 caller sites in `agent-tools-registry.ts`: `:911`, `:1004`, `:1054`, `:1520`, `:1597`, `:1650` (all pass `eventActor: ctx.actor`).
- HTTP/human-MCP callers that DON'T currently pass eventActor (rely on the `?? user.id` default) — these become compile errors and must be made explicit. **Task 1's first step is to grep them ALL.**

**Marker helper (already exists, REUSED):** `apps/server/src/lib/token-reach.ts:25` — `isOperatorToken(token) = token.workspaceId === null && token.createdBy === null`. Verified: the ONLY token with this shape is the operator conversation token (`conversation-runs.ts:193-201`). A human instance PAT goes through `mintToken` which always stamps `createdBy` (token-reach.ts:113), so it is never `isOperatorToken`. The helper is currently used only at `routes/workspaces.ts:120`.

---

## Threat model

> This refactor touches the operator's token identity, the agent-vs-human authority branch on every MCP tool, and the autonomy-gate event-actor — all security boundaries. Written 2026-06-07, BEFORE task breakdown. It is the `/code-review` convergence target for both clusters. The properties being preserved are EXISTING invariants (13, 15, 7-adjacent); this refactor changes the *shape* that enforces them, so the threat model is "did the new shape preserve every authority/suppression property the old shape had?"

### What we're defending

1. **The operator's project/scope ceiling** — the operator acts with `agent ∩ caller` authority (`projects: ['*']` clamped to the conversation owner's reach upstream in `createConversationRun`). A refactor that lets the operator's reach WIDEN (e.g. by taking a "no narrowing" path it shouldn't) is a privilege escalation.
2. **The agent-chain autonomy gate** (`FOLIO_AGENT_CHAINS_ENABLED`, default off) — an agent/operator write must emit an event with an `agent:<slug>` actor so `isAgentOriginated` (trigger-matcher.ts:152) suppresses downstream trigger firing. A write whose event actor silently becomes the human user defeats the gate (uncontrolled agent chains).
3. **FK integrity of `api_tokens.agent_id` and `documents.created_by/updated_by`** — `agent_id` FK-references `documents.id`; `created_by/updated_by` FK-reference `users.id`. Writing a non-FK sentinel/slug to either throws SQLite errno 787. The whole point of Shape B is to STOP storing a non-FK value in `agent_id`.
4. **Anti-impersonation of the operator** — no client may craft a token that resolves to `getOperatorDocument()` (the operator has full tools + `['*']` projects). Today the guard is "the sentinel value can't be stored in the FK column." Under Shape B the guard becomes "`isOperatorToken` requires `workspaceId === null && createdBy === null`, and that token shape is ONLY minted server-side in `createConversationRun` — never via any `POST /tokens` route (which always stamps `createdBy`)."

### Who we're defending against

1. **A prompt-injected operator run** (IN scope) — the operator reads untrusted document/conversation content; an attacker steers its tool calls. Bounded by the caller ceiling, which this refactor must not loosen.
2. **A holder of a human instance PAT** (`workspaceId: null`, `createdBy: <human>`) trying to be mistaken for the operator (IN scope) — must NEVER satisfy `isOperatorToken` (it has `createdBy` set) and must never resolve to `getOperatorDocument()`.
3. **A future developer adding a new write service / new token consumer** (IN scope — this is finding #7's whole point) — the new shape must make "forgot to pass the agent event-actor" a COMPILE error, and "open-coded the operator resolution" a clearly-wrong bypass of the named convergence point.
4. **An external attacker with no account** (OUT of scope for this refactor — they can't mint any token; covered by upstream auth).
5. **An insider with a stolen DB / master key** (OUT of scope — acknowledged, not defended by this work).

### Attacks to defend against

1. **Operator-resolution miss → degraded-to-wildcard authority.** If, under Shape B, a site that used to resolve the operator via the truthy sentinel now sees `agentId: null` and silently treats the operator as "no agent / no narrowing," the operator could skip an allow-list intersection it should apply. (Manifestation: `resolveProjectInWorkspace:239` — operator falls into neither the agent branch nor the human branch.)
2. **Human PAT mis-resolved as operator.** A bug in the `isOperatorToken`-first ordering lets a `createdBy`-null-but-not-really token, or a mis-shaped human PAT, hit `getOperatorDocument()`.
3. **Autonomy-gate silent disable (finding #7 core).** A new (or existing-but-missed) caller of `create/update/deleteDocument` omits `eventActor`; the old default `?? user.id` makes the event human-actored; `isAgentOriginated` returns false; the gate doesn't suppress an agent-originated chain.
4. **FK-787 regression.** Shape B nulls `agentId` at mint — but if any code path now writes the operator's slug or sentinel into an FK column (because a branch flipped), the run strands. (Especially: does `serviceActor` still resolve an FK-valid user for the operator? It uses `ctx.confirmerId ?? ctx.token.createdBy ?? ctx.actor` — the operator's `ctx.confirmerId` is the conversation owner, FK-valid. This is UNCHANGED by Shape B and must stay so.)
5. **`isAgentBound` over- or under-classifies.** If `isAgentBound` returns true for a human PAT, the human takes an agent code path (wrong author context / wrong ceiling). If it returns false for the operator, attack #1 fires.

### Mitigations required

1. **`isAgentBound(token)` helper, ONE definition** in `token-reach.ts`: `return token.agentId !== null || isOperatorToken(token)`. Every former `if (token.agentId)` agent-vs-human branch (registry :188, :239, :277, :352) routes through it. A RED-first test proves: operator (agentId null, ws null, createdBy null) → true; human PAT (agentId null, createdBy set) → false; workspace agent (agentId UUID) → true.
2. **`resolveAgentDocForToken` and `resolveCallingAgent` check `isOperatorToken(token)` FIRST**, returning `getOperatorDocument()`; only then fall to `findFirst({id: token.agentId})`. RED-first test: operator token → operator doc (no DB read); human PAT → NOT operator doc; missing agent → still throws `agent_missing`.
3. **`eventActor: string` is REQUIRED** on all 3 `documents.ts` service signatures (drop the `?`, drop the `?? user.id` default). `bun x tsc --noEmit` is the gate — every caller must pass it explicitly. The 6 agent-tools sites already do; the HTTP/human callers get `eventActor: user.id` made explicit (Task 1's grep enumerates them). A seam test asserts an agent update still emits `agent:<slug>` and `isAgentOriginated` is true.
4. **`serviceActor` UNCHANGED** — Task verifies (does not edit) that the operator's FK-write actor still resolves via `ctx.confirmerId` to the conversation owner. A test asserts an operator document write lands `updated_by = <owner user id>` (FK-valid), not the slug.
5. **`isOperatorToken` ordering + collision proof.** The plan's Task 5 (Shape B mint flip) includes a test that a human instance PAT (`reach: null` via `mintToken`, createdBy set) is NOT `isOperatorToken` and does NOT resolve to the operator doc. Anti-impersonation: a test that no `POST /tokens` / `POST /instance/tokens` path can produce a `createdBy: null` token.

### Out of scope (explicit deferrals)

- **The headless-MCP confirm-gate bypass (invariant 12 KNOWN GAP)** — unrelated surface; not touched here.
- **The HTTP-route autonomy-gate gap** (retro-follow-up 2026-06-06: routes/documents.ts + workspace-documents.ts pass `actor: user`, no eventActor, so agent-PAT HTTP writes aren't chain-suppressed). Finding #7's required-eventActor change will surface these as compile sites — **but the DECISION of whether HTTP agent-PAT writes SHOULD be chain-suppressed is a separate locked-`FOLIO_AGENT_CHAINS_ENABLED` question (deferred).** Task 1 will make these callers pass `eventActor: user.id` EXPLICITLY (preserving today's behavior — human-actored, NOT suppressed), with a code comment pointing at the retro-follow-up. We do NOT change HTTP suppression semantics in this refactor; we only make the existing choice explicit-and-visible instead of a silent default.
- **`agent-guards.ts` / `agent-tools-registry.ts` cycle** — invariant 13 already accepts the two twin resolvers (`resolveAgentDocForToken` / `resolveCallingAgent`) as a deliberate cycle-bound exception. We keep both; we do NOT attempt to merge them (out of scope, would require a module extraction). They stay in lockstep (both check `isOperatorToken` first).
- **`api_tokens.agent_id` DB-level CHECK constraint** (a retro-follow-up "assert agentId-null⟹createdBy-null" idea) — not added here; Shape B makes the operator's agentId null at mint, which removes the need, but a structural DB assertion is a separate hardening.

### How to use this section

- Controller pre-flight: verify each mitigation's named test exists in the task's RED step before dispatching.
- `/code-review` on both clusters: "Verify code against the threat model in `docs/superpowers/plans/2026-06-07-operator-identity-cleanup.md`. Check each numbered mitigation. Confirm no operator-resolution miss (attack 1), no human-PAT-as-operator (attack 2), no autonomy-gate silent disable (attack 3), no FK-787 (attack 4), `isAgentBound` correct both ways (attack 5)."
- `/evaluate`: any mitigation not implemented = plan-correction defect.

---

## Architecture invariants touched

This refactor **sharpens** three named convergence points in `ARCHITECTURE-INVARIANTS.md` and CLOSES the residuals two of them document:

- **Invariant 13 (agent-doc resolution from a token):** today resolves the FK-shaped `OPERATOR_AGENT_ID` sentinel. After Shape B it resolves `isOperatorToken(token)` instead (no sentinel). The invariant text + the un-forgeability argument ("a real agent id is a UUID; the value can't be stored in the FK") must be REWRITTEN to the new argument ("`isOperatorToken` requires ws-null + createdBy-null, a shape only `createConversationRun` mints"). **Task 9 updates the doc.**
- **Invariant 15 (FK-actor vs event-actor):** explicitly names the residual "the optional `eventActor` defaults to `actor.id`, so a future write service that forgets it silently re-collapses the two — tracked in retro-follow-ups." Making `eventActor` required CLOSES this residual. **Task 9 updates invariant 15** to state the residual is closed (required param, omission is a compile error).
- **Invariant 4 / token authority** (agent-vs-human ceiling) — the `isAgentBound` helper becomes the single discriminator; this is additive, not a new convergence point, but the helper's home (`token-reach.ts`, alongside `isOperatorToken`/`isInstanceReach`/`effectiveReach`) is the natural authority-shape module.

A NEW deliberate-exception line is NOT needed (no convergence point is being bypassed; they're being sharpened).

---

## File Structure

| File | Responsibility | Cluster |
|---|---|---|
| `apps/server/src/lib/token-reach.ts` | ADD `isAgentBound(token)` next to `isOperatorToken`. | #8 |
| `apps/server/src/services/documents.ts` | `eventActor` required (3 sigs). | #7 |
| `apps/server/src/lib/agent-tools-registry.ts` | 6 eventActor callers (#7) + 4 `isAgentBound` branches + `resolveAgentDocForToken` operator-first (#8). | both |
| `apps/server/src/lib/agent-guards.ts` | `resolveCallingAgent` operator-first (#8). | #8 |
| `apps/server/src/lib/folio-api-tool.ts` | delete the `=== OPERATOR_AGENT_ID ? null` hack (#8). | #8 |
| `apps/server/src/services/conversation-runs.ts` | mint `agentId: null` (#8). | #8 |
| `apps/server/src/lib/operator.ts` | delete `OPERATOR_AGENT_ID`; `getOperatorDocument().id` becomes a non-FK display id (keep a stable string for the synthetic doc, but it's no longer stamped on any token). | #8 |
| Various HTTP route callers of `create/update/deleteDocument` | pass `eventActor: user.id` explicitly (#7). | #7 |
| `ARCHITECTURE-INVARIANTS.md` | sharpen invariants 13 + 15 (#8 + #7). | both |
| `tasks/retro-follow-ups.md` | mark findings #7 + #8 resolved. | both |

---

## ── CLUSTER 1: Finding #7 — required eventActor (do FIRST, smaller blast radius) ──

> Rationale for ordering: #7 is a pure signature-tightening with a compile-error gate; it's mechanically verifiable and doesn't touch the operator's token shape. Doing it first de-risks #8 (which is the subtler authority refactor). STOP-AND-REVIEW after Task 4.

### Task 1: Enumerate every `create/update/deleteDocument` caller

**Files:**
- Read-only survey (no edits this task).

- [ ] **Step 1: Grep every call site of the three services.**

```bash
cd apps/server
grep -rn "createDocument(\|updateDocument(\|deleteDocument(" src/ --include="*.ts" | grep -v ".test.ts" | grep -v "function \(create\|update\|delete\)Document"
```

- [ ] **Step 2: For each call site, record whether it currently passes `eventActor`.** Produce a table: file:line → passes-eventActor? → what value should it pass (agent runs: `ctx.actor`; HTTP/human: `user.id` / the resolved actor). The 6 known agent-tools sites already pass `ctx.actor`. Every other site that relies on the `?? user.id` default must be made explicit.

- [ ] **Step 3: No commit (survey task).** Record the table in the dispatch report so Task 2-4 callers are exhaustive.

> NOTE: this is a doc/survey task — STATUS block only, no Test-evidence block.

### Task 2: Make `eventActor` required on `updateDocument` (do one service first as the pattern)

**Files:**
- Modify: `apps/server/src/services/documents.ts` (`updateDocument` signature + default)
- Modify: every caller of `updateDocument` found in Task 1 that doesn't pass `eventActor`
- Test: `apps/server/src/services/documents.test.ts` (or the existing update test file)

- [ ] **Step 1: Write the failing test — omitting eventActor is now a type error AND an agent update still emits the agent actor.**

The compile-error half is enforced by tsc, not a runtime test. The runtime seam test asserts the autonomy-gate property is preserved:

```typescript
// in documents.test.ts (or the nearest updateDocument test)
test('updateDocument with an agent eventActor emits an agent-actored event (autonomy gate preserved)', async () => {
  const { db } = await freshTestDb(); // use the existing harness helper
  // ... seed a workspace + project + a document, and a real user `owner` ...
  await updateDocument({
    db, /* ...existing required args... */,
    actor: owner,                 // FK-valid user (serviceActor result)
    eventActor: 'agent:_operator', // REQUIRED now — explicit agent identity
    /* ...patch... */,
  });
  const ev = await db.query.events.findFirst({
    where: /* this document, kind document.updated */,
    orderBy: (c, { desc }) => [desc(c.seq)],
  });
  expect(ev?.actor).toBe('agent:_operator'); // NOT owner.id
});
```

- [ ] **Step 2: Run it to confirm it FAILS to compile first.** Before editing the signature, temporarily call `updateDocument` WITHOUT `eventActor` in a scratch line to confirm tsc would catch omission — then remove the scratch line. (The real RED is the type error; capture it.)

```bash
cd apps/server && bun x tsc --noEmit 2>&1 | grep -i eventActor | head
```
Expected after the signature change but before fixing callers: tsc errors at each caller that omits `eventActor`.

- [ ] **Step 3: Change the signature + drop the default.**

In `updateDocument`'s args type (documents.ts ~792): `eventActor: string;` (remove `?`). At the default site (~833): `const eventActor = args.eventActor;` (remove `?? user.id`). Update the doc comment to state it is REQUIRED and why (omission would silently re-collapse the FK-actor/event-actor split — invariant 15).

- [ ] **Step 4: Fix every now-erroring caller** (from Task 1's table). HTTP/human callers pass `eventActor: user.id` explicitly (or the locally-resolved actor id). Add a one-line comment at HTTP agent-PAT-reachable sites: `// eventActor = human user: HTTP writes are not chain-suppressed (see retro-follow-ups 2026-06-06, deferred).`

- [ ] **Step 5: Run tsc + the test.**

```bash
cd apps/server && bun x tsc --noEmit && bun test src/services/documents.test.ts
```
Expected: tsc clean, test passes.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "phase-op: make updateDocument eventActor required (close invariant-15 residual, part 1)"
```

### Task 3: Make `eventActor` required on `createDocument` + `deleteDocument`

**Files:**
- Modify: `apps/server/src/services/documents.ts` (`createDocument` ~482/~509, `deleteDocument` ~1080/~1086)
- Modify: any remaining callers from Task 1
- Test: assert a create + a delete by an agent emit `agent:<slug>` events.

- [ ] **Step 1: Write the failing tests** — one for create, one for delete, same shape as Task 2's seam test (assert `events.actor === 'agent:<slug>'` after an agent-actored create/delete). For delete, assert the `document.deleted` event actor.

- [ ] **Step 2: Run to confirm RED** (tsc errors at omitting callers + the seam tests fail until wired).

- [ ] **Step 3: Drop `?` + `?? user.id` on both signatures**, mirroring Task 2 (same doc-comment update).

- [ ] **Step 4: Fix remaining callers explicitly.**

- [ ] **Step 5: Run full server suite + tsc.**

```bash
cd apps/server && bun x tsc --noEmit && bun test
```
Expected: clean, full suite green, count delta = +the new tests.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "phase-op: make create/deleteDocument eventActor required (close invariant-15 residual)"
```

### Task 4: Cluster-1 integration gate

- [ ] **Step 1: Full server suite + tsc from `apps/server`.** Record count delta.
- [ ] **Step 2: Confirm no `?? user.id` eventActor default remains.**

```bash
cd apps/server && grep -rn "eventActor ?? \|eventActor?:" src/ --include="*.ts" | grep -v ".test.ts"
```
Expected: ZERO matches (all required now).

> ── REVIEW GATE: STOP. Run `/integration` on the cluster-1 diff, then hand back for `/code-review` (threat model attack #3 + #4 as input). Do NOT start Cluster 2 until clear. ──

---

## ── CLUSTER 2: Finding #8 — Shape B (operator agentId → null + marker) ──

> This is the subtler cluster (authority branches). Each task is one site; the Sibling-site audit (Task 8b) is mandatory before the mint flip ships. STOP-AND-REVIEW after Task 8b.

### Task 5: Add the `isAgentBound` helper (RED-first)

**Files:**
- Modify: `apps/server/src/lib/token-reach.ts` (add `isAgentBound`)
- Test: `apps/server/src/lib/token-reach.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { isAgentBound } from './token-reach.ts';
test('isAgentBound: operator token (ws null, createdBy null, agentId null) is agent-bound', () => {
  expect(isAgentBound({ agentId: null, workspaceId: null, createdBy: null })).toBe(true);
});
test('isAgentBound: human instance PAT (createdBy set) is NOT agent-bound', () => {
  expect(isAgentBound({ agentId: null, workspaceId: null, createdBy: 'user-123' })).toBe(false);
});
test('isAgentBound: workspace agent token (agentId UUID) is agent-bound', () => {
  expect(isAgentBound({ agentId: 'doc-uuid', workspaceId: 'ws-1', createdBy: 'user-1' })).toBe(true);
});
```

- [ ] **Step 2: Run to confirm FAIL** (`isAgentBound` not exported).

```bash
cd apps/server && bun test src/lib/token-reach.test.ts
```
Expected: FAIL — `isAgentBound is not a function`.

- [ ] **Step 3: Implement.**

```typescript
/**
 * True iff this token acts as an AGENT (its own allow-list/identity governs),
 * vs a human PAT (the human's grants govern). The operator is agent-bound but
 * carries NO agentId (it is a code singleton; its conversation token has
 * agentId null) — it is identified by isOperatorToken. A human instance PAT has
 * createdBy set, so it is NOT agent-bound. THE single discriminator for every
 * "agent path vs human path" branch (replaces scattered `if (token.agentId)`).
 */
export function isAgentBound(
  token: Pick<ApiToken, 'agentId' | 'workspaceId' | 'createdBy'>,
): boolean {
  return token.agentId !== null || isOperatorToken(token);
}
```

- [ ] **Step 4: Run to confirm PASS.**

```bash
cd apps/server && bun test src/lib/token-reach.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "phase-op: add isAgentBound helper (operator = agent-bound via isOperatorToken)"
```

### Task 6: `resolveAgentDocForToken` + `resolveCallingAgent` resolve the operator via `isOperatorToken` (RED-first)

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts:209-220` (`resolveAgentDocForToken`)
- Modify: `apps/server/src/lib/agent-guards.ts:35-41` (`resolveCallingAgent`)
- Test: `apps/server/src/lib/agent-tools.test.ts` (or the resolver's existing test) + `agent-guards` test

- [ ] **Step 1: Write the failing tests.** Operator token (ws null, createdBy null, **agentId null**) → `getOperatorDocument()` (slug `_operator`), no DB read. A human PAT (createdBy set, agentId null) → does NOT return the operator doc. A real agent UUID → its row. A missing agent UUID → throws `agent_missing`.

```typescript
test('resolveAgentDocForToken: operator token (agentId null) resolves the operator singleton', async () => {
  const doc = await resolveAgentDocForToken({ agentId: null, workspaceId: null, createdBy: null, /* ...rest ApiToken... */ } as ApiToken);
  expect(doc.slug).toBe('_operator');
});
test('resolveAgentDocForToken: human PAT (agentId null, createdBy set) is NOT the operator', async () => {
  // a human PAT should never reach resolveAgentDocForToken for an agent doc — but if it does, it must not be the operator
  await expect(resolveAgentDocForToken({ agentId: null, workspaceId: null, createdBy: 'u1', /* ... */ } as ApiToken))
    .rejects.toThrow(/agent/i); // agentId null + not operator → no agent doc
});
```

- [ ] **Step 2: Run to confirm FAIL** (current code checks `=== OPERATOR_AGENT_ID`, so an `agentId: null` operator token currently falls to `findFirst({id: null})` → miss → `agent_missing`; the operator test FAILS).

- [ ] **Step 3: Implement — check `isOperatorToken` first in BOTH twins.**

`resolveAgentDocForToken` (registry):
```typescript
async function resolveAgentDocForToken(token: ApiToken): Promise<Document> {
  if (isOperatorToken(token)) return getOperatorDocument();
  if (!token.agentId) {
    throw mcpInvalidParams('token is not agent-bound', { reason: 'not_agent_bound' });
  }
  const agent = await db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
  if (!agent) throw mcpInvalidParams('agent for this token no longer exists', { reason: 'agent_missing' });
  return agent;
}
```

`resolveCallingAgent` (agent-guards, cycle-bound twin):
```typescript
async function resolveCallingAgent(token: ApiToken): Promise<Document | undefined> {
  if (isOperatorToken(token)) return getOperatorDocument();
  if (!token.agentId) return undefined; // not agent-bound — guards fail-closed
  return db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
}
```

Import `isOperatorToken` from `token-reach.ts` in both files. Update each function's doc comment to the new resolution rule (invariant 13).

- [ ] **Step 4: Run the resolver tests + the agent-guards tests to confirm PASS.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "phase-op: resolve operator via isOperatorToken, not the agentId sentinel (invariant 13)"
```

### Task 7: Route the 4 agent-vs-human branches through `isAgentBound` (RED-first per site)

**Files:**
- Modify: `agent-tools-registry.ts:188` (`humanPatProjectCeiling`), `:239` (`resolveProjectInWorkspace`), `:277` (`resolveAuthorContextForToken`), `:352` (`resolveAgentAllowListForToken`)
- Test: extend the existing tests for each of these functions with an operator-token case.

- [ ] **Step 1: Write the failing tests — operator token takes the AGENT path at each site.**
  - `resolveAuthorContextForToken(operatorToken)` → `{ type: 'agent', agentSlug: '_operator', ... }` (NOT a throw, NOT a user).
  - `resolveProjectInWorkspace` with the operator token + a project → resolves via the agent allow-list branch (operator `['*']` ⇒ any project allowed), NOT the human-invitee branch and NOT "neither."
  - `resolveAgentAllowListForToken(operatorToken)` → `null` (operator is `['*']` ⇒ no narrowing).
  - `humanPatProjectCeiling(ws, operatorToken)` → `null` (no human narrowing — unchanged).

- [ ] **Step 2: Run to confirm RED** (with Task 6 done, the operator doc resolves, but the BRANCH conditions still key on `token.agentId` which is now null → operator wrongly takes human/neither paths).

- [ ] **Step 3: Implement — replace `if (token.agentId)` / `if (!token.agentId)` with `isAgentBound(token)` at the 4 sites.**

  - `:188` `humanPatProjectCeiling`: `if (isAgentBound(token)) return null;` (drop the now-redundant `!token.createdBy` operator special-case OR keep it — VERIFY both give `null` for the operator; prefer the single `isAgentBound` line + a comment).
  - `:239` `resolveProjectInWorkspace`: `if (isAgentBound(token)) { ...allow-list (resolveAgentDocForToken) ... } else if (token.createdBy && ...) { ...human invitee... }`.
  - `:277` `resolveAuthorContextForToken`: `if (isAgentBound(token)) { const agent = await resolveAgentDocForToken(token); return { type: 'agent', agentSlug: agent.slug, agentId: token.agentId ?? agent.id }; }` — NOTE: `agentId` field on the author context was `token.agentId`; for the operator that's now null, so fall back to `agent.id` (the synthetic display id) to keep the field populated. VERIFY consumers of `AuthorContext.agentId` tolerate the operator's display id (grep them).
  - `:352` `resolveAgentAllowListForToken`: `if (!isAgentBound(token)) return null;` then resolve doc → `['*']` → `null`.

- [ ] **Step 4: Run the per-site tests + full suite + tsc.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "phase-op: route agent-vs-human branches through isAgentBound (operator agentId null)"
```

### Task 8: Flip the mint to `agentId: null` + delete the `dispatchAsCaller` null-hack

**Files:**
- Modify: `apps/server/src/services/conversation-runs.ts:201` (mint)
- Modify: `apps/server/src/lib/folio-api-tool.ts:210-218` (delete the `=== OPERATOR_AGENT_ID ? null` hack)
- Test: `conversation-runs.test.ts` + `folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `createConversationRun` → the minted token has `agentId === null` AND `isOperatorToken(token) === true`.
  - `dispatchAsCaller` with the operator token persists a minted token with `agentId: null` (already true under Shape B — but now WITHOUT the conditional; assert the minted row's agentId is null and no FK error).
  - `folio-api-tool.test.ts:5` import of `OPERATOR_AGENT_ID` is removed; update any test that asserted the nulling behavior to assert "operator token already has null agentId."

- [ ] **Step 2: Run to confirm RED** (mint still stamps the sentinel).

- [ ] **Step 3: Implement.**
  - conversation-runs.ts: `agentId: null,` (replace `OPERATOR_AGENT_ID`); update the inline comment ("operator is identified by isOperatorToken, not an agentId sentinel"). Remove the `OPERATOR_AGENT_ID` import.
  - folio-api-tool.ts: replace `const mintedAgentId = caller.agentId === OPERATOR_AGENT_ID ? null : caller.agentId;` + `agentId: mintedAgentId,` with `agentId: caller.agentId,` (the operator's is already null). Remove the now-dead comment block + the `OPERATOR_AGENT_ID` import.

- [ ] **Step 4: Run the tests + full suite + tsc.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "phase-op: mint operator token with agentId null; drop dispatchAsCaller FK null-hack"
```

### Task 8b: Sibling-site audit — every remaining `token.agentId` reader

**Files:**
- Read + targeted-test the nullable-check sites enumerated in the ground-truth surface.

## Sibling-site audit

The operator's `agentId` flips from `'operator:_operator'` (truthy) to `null`. EVERY site that reads `token.agentId` must be checked for a behavior change. The agent-vs-human BRANCH sites are handled in Task 7; this audit covers the REMAINING readers (they were listed as "nullable-check sites" in the ground-truth surface). For each, determine: did the operator previously take the truthy path, and does the null path now give the SAME result?

| Site | Old (sentinel truthy) | New (null) | Action |
|---|---|---|---|
| `agent-tools-registry.ts:212` | `token.agentId!` after sentinel resolved — operator never reached it (returned at :210) | operator returns at isOperatorToken check (Task 6) | ✅ unaffected — verify |
| `agent-tools-registry.ts:536/:666/:722/:1640/:1666/:1819` | each: confirm what it does with agentId | — | AUDIT each: is it agent-vs-human, or lookup? If branch → isAgentBound; if lookup → confirm operator's null is handled |
| `agent-guards.ts:37/:85/:167/:215/:250` | guards fail-closed on undefined doc | operator resolves at :36 (Task 6) → real doc | AUDIT: do the widening guards behave correctly with the operator's `['*']` doc? |
| `routes/comments.ts:91/:100` | `if (token?.agentId)` | operator agentId null → takes the else | AUDIT: is the operator reachable here? (cockpit comments) — confirm the comment-author resolution still gets `_operator` |
| `routes/workspaces.ts:261/:263` | `if (token?.agentId)` | — | AUDIT: workspace-create owner uses `isOperatorToken` (`:120`) already — confirm agentId branch isn't the operator path |
| `trigger-matcher.ts:176` | `token.agentId === null && token.createdBy` | operator: agentId null + createdBy null → `&& token.createdBy` is false → skips | AUDIT: confirm operator isn't expected here (trigger-fired ≠ operator conversation) |
| `mcp-errors.ts:55` | `if (!token.agentId)` | — | AUDIT: error-shaping only — confirm benign |

- [ ] **Step 1:** For each row, Read the site, classify (agent-vs-human branch / pure lookup / nullable-guard), and confirm the operator's null gives the correct result. Where a row is an agent-vs-human branch missed by Task 7, route it through `isAgentBound` with a RED-first test.
- [ ] **Step 2:** Grep `AuthorContext.agentId` consumers (from Task 7's note) and confirm they tolerate the operator's display id / null.
- [ ] **Step 3:** Run the full server suite + tsc.
- [ ] **Step 4:** Commit any fixes found.

```bash
git add -A && git commit -m "phase-op: sibling-site audit for operator agentId null (fixes + verifications)"
```

> ── REVIEW GATE: STOP. Run `/integration` on the cluster-2 diff (Tasks 5-8b), then hand back for `/code-review` + `/security-review` (this cluster touches the token-authority boundary; threat model attacks 1,2,4,5 as input). Do NOT start Task 9 until clear. ──

### Task 9: Delete `OPERATOR_AGENT_ID` + sharpen the invariants doc + close the follow-ups

**Files:**
- Modify: `apps/server/src/lib/operator.ts` (delete `OPERATOR_AGENT_ID` export OR demote it to a private non-FK display-id constant for `getOperatorDocument().id`)
- Modify: `ARCHITECTURE-INVARIANTS.md` (invariants 13 + 15)
- Modify: `tasks/retro-follow-ups.md` (mark #7 + #8 resolved)

- [ ] **Step 1: Confirm `OPERATOR_AGENT_ID` has zero remaining importers** outside operator.ts.

```bash
cd apps/server && grep -rn "OPERATOR_AGENT_ID" src/ --include="*.ts"
```
Expected: only `operator.ts` (its own `getOperatorDocument().id` use, if kept). If `getOperatorDocument()` still needs a stable `id`, KEEP a constant but rename it to make clear it is a DISPLAY id never stamped on a token (e.g. `OPERATOR_DOC_ID`) with a comment; if nothing reads `.id`, set it to a plain string literal inline.

- [ ] **Step 2: Make the change** (delete the export or demote+rename). Run tsc.

- [ ] **Step 3: Rewrite invariant 13** in `ARCHITECTURE-INVARIANTS.md`: the operator is resolved via `isOperatorToken(token)` (ws-null + createdBy-null), NOT an FK-shaped agentId sentinel; the un-forgeability argument is "that token shape is minted ONLY in `createConversationRun`, never via any `POST /tokens` route (which always stamps `createdBy`)." Keep the cycle-bound-twin note (both resolvers check `isOperatorToken` first). Add a dated `*(sharpened 2026-06-07 — Shape B: sentinel removed from the FK field)*`.

- [ ] **Step 4: Update invariant 15:** the residual ("optional `eventActor` defaults to `actor.id` → a future write service that forgets it re-collapses the two") is CLOSED — `eventActor` is a REQUIRED param on `create/update/deleteDocument`, so omission is a compile error. Add `*(residual closed 2026-06-07)*`.

- [ ] **Step 5: Mark findings #7 + #8 resolved** in `tasks/retro-follow-ups.md` (move under a "Resolved" note with the commit range + the Shape-B / required-eventActor decisions).

- [ ] **Step 6: Run the invariants pre-commit hook check** (if installed) + full suite + tsc.

```bash
cd apps/server && bun x tsc --noEmit && bun test
cd ../.. && bun run scripts/check-invariants.ts
```

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "phase-op: remove OPERATOR_AGENT_ID sentinel; sharpen invariants 13+15; close findings #7+#8"
```

---

## Phase close (Stage 3)

After Task 9:
1. `/integration` (full server suite + tsc; web/shared unaffected — server-only blast radius, but run web tsc to be safe).
2. `netdust-core:test-effectiveness` over the full branch diff — walk the seven failure modes; the dangerous paths are the authority branches (attack 1/2/5) and the autonomy gate (attack 3). Name the test that goes RED if each breaks, or fix.
3. `/shakeout` — reviewer panel incl. `invariant-auditor` (invariants 13/15 are the convergence target) + `security-sentinel` (token authority).
4. `superpowers:finishing-a-development-branch`.

No feature-acceptance matrix: this is a pure backend refactor with NO user-facing surface change (the operator behaves identically; only its internal identity shape changes). The seam tests + invariant audit are the behavioral proof.

---

## Self-review

- **Spec coverage:** Finding #8 → Tasks 5-9 (helper, resolvers, branches, mint, sentinel-delete, doc). Finding #7 → Tasks 1-4 (survey, 2 service sigs, gate). ✅
- **Placeholder scan:** test bodies are concrete; the few `/* ... */` are "existing harness args" markers, not logic placeholders — the implementer fills from the existing test file's setup. The Sibling-site audit table rows marked "AUDIT" are deliberately investigation tasks (the finding's blast radius can't be fully enumerated without reading each site), NOT logic placeholders.
- **Type consistency:** `isAgentBound` / `isOperatorToken` signatures consistent across tasks; `eventActor: string` consistent across the 3 services.
- **Ordering:** Cluster 1 (#7) before Cluster 2 (#8) — de-risks the subtler refactor. Within Cluster 2: helper → resolvers → branches → mint → audit → doc, so the operator never resolves wrong mid-cluster (the mint flip is LAST before the audit, after every reader is taught the new shape).
