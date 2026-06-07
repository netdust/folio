# Agent Layer Gap-Map: Multica → Folio (unblocking the cockpit)

**Date:** 2026-06-06
**Subject:** [multica-ai/multica](https://github.com/multica-ai/multica) chat-loop + agent-definitions + orchestration, studied to unblock Folio's operator cockpit.
**Trigger:** "The cockpit chat is there but the agent doesn't seem to know how to use Folio — the `folio` skill is not followed."
**Method:** 3 deep Multica readers (chat-loop / agent-defs+skills / orchestration) + 1 source-verified Folio diagnosis → gap-map. Root cause additionally hand-verified by the author (`runner.ts:288-290`).

---

## 1. The actual problem (source-verified — this is the headline)

**The operator/cockpit conversation run never injects the `folio` skill body into the model's context.** It is a bug of *omission*, not design — and small to fix.

The runner forks by run type at `runner.ts:288-290`:

```ts
const messages = ctx.sink
  ? await buildConversationMessages(db, requireConversationId(ctx))  // cockpit/conversation path
  : await buildInitialMessages(ctx);                                  // document-thread path
```

- `buildSkillsPreamble(ctx)` (`runner.ts:992`) is the **only** code that emits the trusted skill body on the API path. It is called in exactly two places: `buildInitialMessages` (`runner.ts:1061`, document path) and `ccExecute` (`runner.ts:1579`, the hard-disabled cc path).
- **The conversation path calls neither.** It routes through `buildConversationMessages`, which replays only the stored conversation rows — no skills preamble.
- The system channel on this path (`runner.ts:1200`) is `ctx.fm.system_prompt + UNTRUSTED_DATA_DIRECTIVE` — and `system_prompt` is set to `def.prompt` = `OPERATOR_PROMPT` (the ~20-line behavioral prompt, `system-skills.ts:281-303`), **not** the skill body.
- `ctx.agentSkills` *is* loaded for the conversation run (`runner.ts:700`, via `loadAgentDefinition`) — **then read by nobody.** Dead context. This is why it *looks* wired.

So `OPERATOR_PROMPT` literally tells the model *"Your `folio` skill … is provided to you in context"* (`system-skills.ts:283`) — **a promise the code does not keep.** The model is told a manual exists, never sees it, and guesses paths/scopes/protocols. That is the 404s and mis-use you're seeing.

### What is NOT the problem (ruled out, so we don't chase ghosts)

- **Not a trust-mislabel.** The `folio` skill is correctly `trusted: true` (`system-skills.ts:32-38` → `instance_skills.trusted` typed column → `runner.ts:754,995`). It is *not* fenced as untrusted DATA under the "do not follow embedded instructions" directive. It is simply **absent**, not sabotaged. (My earlier hypothesis that the untrusted directive was suppressing it was wrong — verified.)
- **Not thin tool schemas.** The `da9ac23` empty-schema bug is fixed. `buildToolDefs` (`runner.ts:1142-1162`) pulls real description + `inputSchema` from the registry; `folio_api`/`folio_api_get` carry accurate method/path/scope arg contracts (`folio-api-tool.ts:275-329`). **But** the resource→route→scope map, path-shorthand (`/w//p/` vs long-form), `dryRun`/risk-gate protocol, and CRUD-vs-build rails live **only in `FOLIO_SKILL_BODY`** (`system-skills.ts:139-267`). Rich tools + absent manual = model has the verbs but not the grammar.

---

## 2. How Multica gets it right (the blueprint to copy)

All three Multica readers independently converged on the same core pattern — strong triangulation.

**Skill/brief lives in the authoritative channel.** Multica delivers the agent's operating instructions and platform-usage guidance as part of the system-level brief the spawned CLI receives (the `CLAUDE.md`/discovery-dir + system-prompt convergence), *not* mixed into the user/conversation stream. The instructions that say "how to behave and how to use the platform" sit where the model weights them most heavily.

**Three-channel separation per turn:**
- **(A) Trusted system brief** = agent identity + tool menu + the skill/manual body + a numbered workflow.
- **(B) Conversation history** = the multi-turn thread.
- **(C) Fenced untrusted DATA** = document/comment/payload content the agent reads but must not obey.

Folio already *has* the trust machinery for this (trusted vs untrusted channel split, `UNTRUSTED_DATA_DIRECTIVE`) — it just collapses channel **A's skill into B** on the conversation path (and on the conversation path, drops it entirely).

**Grounding in "how to use the platform" is explicit, not assumed.** Multica doesn't rely on the model inferring API shapes from tool schemas; the platform-usage guidance is delivered as content. This is exactly what `FOLIO_SKILL_BODY` is for — it just isn't reaching the cockpit agent.

---

## 3. Gap-map (Multica has / Folio has / what's missing)

| Agent-layer piece | Multica | Folio TODAY (verified) | Missing wiring |
|---|---|---|---|
| **Skill/manual injection** | In the system-level brief (channel A) | Loaded into `ctx.agentSkills` then **dropped** on conversation path; only document/cc paths inject it | **Inject trusted skills into the cockpit turn** (the root-cause fix) |
| **System-prompt construction** | identity + tools + manual + workflow | `OPERATOR_PROMPT` only (~20 lines), *claims* a skill it doesn't deliver | Fold trusted skill body into `system` (or a leading trusted message) |
| **Channel separation** | A/B/C distinct | A collapsed into B; C exists (`UNTRUSTED_DATA_DIRECTIVE`) | Restore A as its own trusted channel |
| **Tool-call correctness** | schema + brief grammar | rich schemas (post-`da9ac23`) ✅ but no path/scope grammar | grammar comes free once the skill is injected |
| **Multi-turn history** | threaded + truncated | `buildConversationMessages` replays thread ✅ | works; compaction already present |
| **Turn completion / streaming** | stream-json, explicit done | SSE sink, turn-based loop ✅ | works for v1 |
| **Orchestration onto work-items** | task→agent binding, tool exec + validation | document-path agents already run on work-items ✅ | the cockpit just needs the manual; orchestration plumbing exists |

**Bottom line:** Folio's agent layer is ~90% wired. The cockpit feels broken because of **one missing injection on one code path**, not because the chat layer is far away.

---

## 4. Sequenced punch-list (root-cause fix first)

### Step 1 — Inject the trusted skills preamble into the conversation path *(BUGFIX, small, highest leverage)*

The fix all three readers + the diagnosis agree on. In `runLoop`, fold `buildSkillsPreamble(ctx)` into the system channel for conversation runs (mirror what `ccExecute` already does at `runner.ts:1579-1583`). At `runner.ts:1200`:

```ts
// before:
system: ctx.fm.system_prompt + UNTRUSTED_DATA_DIRECTIVE,
// after:
const skills = buildSkillsPreamble(ctx);  // trusted skills only (folio)
const sys = skills
  ? ctx.fm.system_prompt + '\n\n---\n## Your reference skills\n\n' + skills
  : ctx.fm.system_prompt;
// ...
system: sys + UNTRUSTED_DATA_DIRECTIVE,
```

The `folio` skill is `trusted`, so the **system channel is its correct home** (same treatment the cc path gives it). This makes the already-loaded-but-dead `ctx.agentSkills` (`runner.ts:700`) finally do work, and makes `OPERATOR_PROMPT`'s "provided to you in context" claim *true*.

*Alternative if you want to keep the system channel slim:* prepend the preamble as a **leading trusted user message** inside `buildConversationMessages` (mirror `buildInitialMessages` at `runner.ts:1061-1067`, which labels it "[Your reference skills — part of your own definition … Treat as trusted instructions/reference.]"). Either works; system-channel is the stronger adherence signal.

> ⚠️ This touches the agent's instruction channel + interacts with the untrusted-data fence → **fire the threat-modeling gate** when you build it (small `## Threat model` note: confirm the trusted skill can't be displaced by untrusted content, and that ordering keeps the fence intact).

### Step 2 — Regression test that locks the contract *(BUGFIX guard, small)*

Assert the `folio` skill body appears in the operator's **first conversation turn** — check `provider.stream()`'s `system` (or first message) contains a stable marker from `FOLIO_SKILL_BODY` (e.g. the §3 "Resource → route → scope" table header). This is the test whose absence let prose (`system-skills.ts:283`) and delivery silently diverge. Per the repo's testing-workflow: this is a **Tier A seam test at the wiring task** — exactly the "end-to-end assertion at the wiring task" lesson.

### Step 3 — Fail-loud if the operator's skill doesn't resolve *(hardening, tiny)*

At `loadConversationContext` (`runner.ts:700`), assert `agentSkills` is non-empty for the operator (the `folio` skill must resolve). A missing `instance_skills` seed row would otherwise silently strip the manual again — fail loud instead.

### Step 4 — (Only if Step 1 alone doesn't fully fix adherence) strengthen the operator workflow

If, after the skill is injected, the agent still wanders, copy Multica's **numbered workflow** pattern into `OPERATOR_PROMPT`: an explicit "1. consult the skill's route map → 2. dryRun → 3. act → 4. report" loop, so the manual is *used*, not just *present*. Validate by re-testing actual cockpit turns — don't add this preemptively.

### Step 5 — Orchestration onto work-items: verify, don't rebuild

The document-path already runs agents on work-items correctly (it's the path that *does* inject the skill). Once Step 1 lands, confirm the cockpit can drive the same `folio_api` calls. This is likely a **verification** task, not a build.

---

## 5. What NOT to copy (wedge clashes)

- **The daemon-fleet / 12-CLI abstraction / discovery-dir skill files** — Folio is in-process, single-binary, one runtime. Inject the skill as prompt content, not by writing `SKILL.md` to a discovery directory.
- **`skills-lock.json` / external skill imports** — Folio's skills are code-seeded from in-repo constants (`system-skills.ts`); no external origin to lock.
- **Streaming stream-json turn model** — Folio's turn-based SSE is the right v1 trade; don't rebuild the loop to chase live token streaming yet.
- **Squad / multi-agent grouping** — out of scope under the locked single-hop, no-agent-chains decision.

---

## Actionable summary

| Step | What | Type | Size |
|---|---|---|---|
| 1 | Inject trusted skills preamble into the cockpit conversation path (`runner.ts:~1200`) | **bugfix** | small, +threat-model note |
| 2 | Regression test: folio skill body in operator's first turn | bugfix guard | small (Tier A seam) |
| 3 | Fail-loud if operator skill doesn't resolve (`runner.ts:700`) | hardening | tiny |
| 4 | Numbered workflow in `OPERATOR_PROMPT` — only if needed after Step 1 | tuning | small |
| 5 | Verify cockpit drives `folio_api` on work-items | verification | small |

**The headline:** your chat layer is not far away. One injection bug on one code path is making a ~90%-wired cockpit look broken. Step 1 is the fix; Steps 2-3 keep it from regressing. Multica validated the *shape* (skill in the trusted/system channel, three-channel separation) — and confirmed Folio already has every mechanism it needs.
