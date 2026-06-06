# Shake-out manifest — operator-model selection (`spec/operator-cockpit-chat`)

Date: 2026-06-06. Swept the operator-model feature end-to-end against a FRESH-migrated
DB (server on :3943, owner-registered, real HTTP). Plan:
`docs/superpowers/plans/2026-06-06-operator-model-selection.md`.

## Verified WORKING end-to-end (Track A — automated, real HTTP)

- **Smoke**: server boots on the fresh schema; migration 0031 applied (instance_settings
  table present); `/auth/me` owner → 200.
- **GET /instance/ai-keys** surfaces `operator_model` (null when unset) alongside the
  key roster; **no secret leaked** (encryptedKey stripped, hasEnc:false).
- **Keyless Ollama save → 201** (no apiKey required — the project_provider-setup-gap
  is closed).
- **PUT /operator-model → 200** when the (provider, aiKeyLabel) key exists; GET then
  surfaces the selection.
- **#4 dangling-key → 422** with a clear "add it in Settings → AI first" message.
- **#5 paid-no-key → 400** (refine); **#9 whitespace-key → 400** (trim).
- **SSRF**: an ollama baseUrl at 169.254.169.254 (AWS metadata link-local) → 422 (the
  guard holds for ollama).
- **M3/M4**: bearer → 401, unauthenticated → 401 on the operator-model write (session-
  only). Malformed provider → 400 ZodError (closed enum), NOT 500.
- **Durability**: a failed (422) operator-model write did NOT corrupt the stored
  setting — it survived as the prior value.
- **e2e**: settings-screen Playwright spec (the AI tab's host surface) 10/10 pass.

## Bugs found

### CRITICAL (0)
_None._

### IMPORTANT (0)
_None._

### MINOR (0)
_None._

The feature was already through `/code-review` (9 server findings incl. an M2 BLOCKER
+ 6 web findings), `/security-review` (3 findings), and a `/test-effectiveness` audit
(2 blind paths → fixed). The real-environment sweep found nothing new — every
dangerous path behaves as the unit tests assert.

## Track B — manual checks for the human (model-dependent)

The keystone "operator actually RUNS on the selected model" is model-dependent and is
the deferred real-key gate (Ollama must be running + a tool-call-capable model — see
[[project_operator-model-and-toolschema]]). With a working model configured:

1. [ ] Settings → AI: add an Ollama key (keyless, with a baseUrl), then click
       "Use for operator" on its row with a model → badge shows "operator · <model>".
2. [ ] Run the operator (cockpit chat) → confirm it streams via the SELECTED provider
       (not the anthropic default) — the M2 fix in the real run path.
3. [ ] Delete the operator's key → next operator turn BLOCKS loudly ("No AI key…"),
       does NOT silently fall back to localhost (the #1 security-review fix).
4. [ ] The loopback-hint: with FOLIO_ALLOW_LOOPBACK_AI unset, saving an ollama
       localhost baseUrl shows the "set FOLIO_ALLOW_LOOPBACK_AI=true" hint (Track A ran
       with the flag ON, so the accept-path was exercised; the hint path is unit-tested).
