# Folio — Harden & Build for the Real Flows

> Grounded in a direct read of the `netdust/folio` repo (2026-06-07), not the prior LLM
> audits. Scope is deliberately narrow: harden the engine you have, and add only what the
> **two user flows you actually run** need. This is not a platform-evolution plan. The
> definition of "done" for the first track is *one real person used it end-to-end on real
> work* — not "the feature shipped."

---

## 0. Reality check — what the code already gives you (do not rebuild)

The prior audits under- and over-stated this. From source:

- **Security/authz core is genuinely strong and done.** One `AuthContext`, `executeTool`
  scope intersection, `txWithEvents` atomic write+event, fail-closed. The 9/10 was the one
  finding based on reading the actual repo. Leave it alone.
- **Transition-actions exist.** A `trigger` document fires an agent `on_event` + `event_filter`
  (or on `schedule`). "Card hits `drafting` → run the drafter" is already expressible. You do
  **not** need to build a state machine for this.
- **A human-gate primitive exists.** `internal_action: resume_run / reject_run` + the
  `pending_ops` confirm gate already give you "pause for a human, then resume or reject."
- **Multi-model is done**, including local: `ai/` has anthropic, openai, openrouter, **ollama**.
- **Board/Kanban is supported** (`documents.boardPosition`, fractional rank).
- **Agent visibility is started** (`agent-event-visibility.ts`).
- **An SMTP transport exists** (`email.ts`) — currently magic-links only, but the pipe is there.

The two genuine gaps the code confirmed:
1. Agent runs append a `kind=result` comment on the parent — they don't **edit the target
   artifact in place**. ("Improve THIS dossier until I'm happy" is not yet a thing.)
2. **No `derived_from`** link anywhere. `parentId` is containment ("nested pages"), not
   derivation. One source → blog + newsletter + PDF has no lineage.

---

## 1. Harden (short — because the core is already the strong part)

Only four items earn the word "hardening." Resist adding more.

- **MCP / external token lifecycle.** Static bearer tokens, no expiry / rotation / revocation
  lifecycle. This is your highest external attack surface as agents touch more. Add token
  TTL + rotation + revoke. *(Watch-item already in your invariants/retro notes.)*
- **External-content injection boundary.** You already tag tool results as untrusted data in
  the runner. Extend that same discipline to the new ingress points below (inbound email, any
  web/research content an agent ingests) — those are where injected instructions will arrive.
- **PII minimisation at intake** *(only if the case flow handles sensitive inbound — it does).*
  Anonymise *before* the content is persisted or seen by an agent, not after. This is both a
  feature (below) and a data-handling guarantee. Treat it as a boundary, not a step.
- **Promote 1–2 load-bearing invariants from doc-first to structural** *(opportunistic)* —
  only the ones the work below will touch (e.g. the new re-entry write path). The traceability
  checker is rung-2; this walks the most important ones to rung-1. Don't do a sweep.

That's the whole hardening list. If it feels short, that's the point — the prior audits
already confirmed the core is solid.

---

## 2. Build, by flow — pick ONE track first

Your real use is two products sharing this engine. Do **one track end-to-end** and put it in
front of one real user before starting the other. Do not run both in parallel.

### Track A — Content Studio  *(sponsor dossiers, SEO, newsletters, blogs — your bulk use)*

The spine. Three items, in order:

1. **Agent re-entry (edit-in-place).** Let an agent run *target a document and rewrite its
   body*, not just append a result comment. This is the "correct the dossier until satisfied"
   loop — your single most-used motion. Largest item here; everything else leans on it.
2. **`derived_from` lineage.** Add a link {source document + deriving run} so a newsletter can
   declare it came from the research, and a dossier from the sponsor data. Enables one source →
   many outputs, and "regenerate the newsletter from the updated source."
3. **Designed output / export.** Markdown doc → a designed PDF/HTML dossier (templated). The
   content exists; the *designed deliverable* is the gap. Keep it to one good template first.

### Track B — Team Case Manager  *(email → board → reply; the one with a team already using it)*

The board, triggers, and human-gate already cover the lifecycle. This track is almost entirely
the I/O ends you flagged as untouched:

1. **Inbound email → work_item**, with **anonymisation at ingress** (see §1). New.
2. **Outbound: send the answer to the contact** — generalise the existing `email.ts` transport
   beyond magic links. The pipe exists; this is wiring.
3. **(Optional) one pre-send guard** — *only if* "no answer goes out without review" is a real
   rule. A synchronous check on the →sent transition (reactive triggers can't stop an
   irreversible send in time). One check on one transition. Not a state-machine engine.

---

## 3. The hard part you already named — the agentic UX layer

This is where the real effort goes, and what none of the audits addressed. It spans whichever
track you pick:

- **Re-entry as a UX, not just a write path.** "Fix this paragraph / make it less salesy"
  needs to feel like one tap, on the artifact, for a non-technical person — not a re-prompt
  from scratch.
- **Agent visibility.** Finish `agent-event-visibility.ts` into real "here's what it's doing /
  it's waiting on you" feedback. People trust agents they can watch.
- **Operator as the single front door.** The operator substrate (16 tools) exists. The work is
  making "tell it what you want, steer the result" the way a non-technical user drives the
  whole thing — so breadth lives behind one conversational surface instead of six screens.

Good UX is only achievable once you've fixed the *one user* this is for. You can't design it
for "everyone doing six things."

---

## 4. Explicitly NOT now

- **Heavy work-item state machine** (configurable transition guards as an enforced invariant).
  Your flows don't need it; triggers + the board + the human-gate cover the real need. Revisit
  only if a future flow genuinely needs enforced multi-role transitions.
- **Agent orchestration / multi-agent / planning engines.** You trigger stages by hand; that's
  fine. Don't become LangGraph.
- **Agent memory.** Keep memory on artifacts/projects, as you decided.

---

## 5. Sequence & the gate that actually matters

1. Do the §1 hardening items that touch your chosen track (the others can wait).
2. Pick **Track A or Track B** — decided by which flow has a real user you can name, not by
   which is more elegant. (Track B already has a team on it; Track A is the cleaner "non-tech,
   easy" play with no named buyer yet. That tension is the real decision.)
3. Build the **thinnest slice** of that track that lets one person do one real piece of work
   start to finish.
4. **Put it in front of that person.** The next assessment of Folio should come from them
   using it — not from another model reading the code. That is the one input every report so
   far has been unable to give you.

Done = a real person completed real work on it. Not = the feature is built.
