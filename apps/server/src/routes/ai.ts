import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { aiKeys } from '../db/schema.ts';
import { env } from '../env.ts';
import { providerSchema } from '../lib/agent-run-schema.ts';
import { buildCompletionPrompt } from '../lib/ai-complete.ts';
import { getProvider } from '../lib/ai/provider.ts';
import { sanitizeProviderError } from '../lib/ai/sanitize-error.ts';
import type { ProviderName } from '../services/agent-runs.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { getOperatorDefinition } from '../lib/operator.ts';
import { resolveKeyMaterial, resolveOperatorRunModel } from '../lib/runner.ts';
import { validatePublicUrl } from '../lib/url-allow-list.ts';
import { getOperatorModelSetting } from '../services/instance-settings.ts';
import { type AuthContext, requireSessionUser } from '../middleware/auth.ts';
import type { ScopeContext } from '../middleware/scope.ts';

const aiRoute = new Hono<AuthContext & ScopeContext>();

// UI-only key test action: session callers only — never API tokens.
//
// attachToken (upstream on wScope) hydrates c.user from token.createdBy when
// a Bearer token is present and no session exists. The round-2 guard checked
// cookie-header presence — but Bun forwards garbage/expired cookie headers
// verbatim, so `Cookie: folio_session=garbage` + `Authorization: Bearer …`
// would slip through (attachUser sets user=null, attachToken hydrates user
// from the token). The B round 3 fix gated on the authMethod flag inline;
// B round 5 #1 refactored that inline gate into the shared `requireSession`
// helper so the contract is enumerated in one place (threat model 11).
//
// Round 6 #6 — codified as `requireSessionUser` (one composite) so all 4
// session-only routes have the same ordering: token → 403, no user → 401.
// Pre-fix ai.ts was the only file that wired both gates at the router level;
// the other 3 wired them asymmetrically (router + per-handler). Now uniform.
aiRoute.use('*', requireSessionUser);

const TestKeyBody = z
  .object({
    provider: providerSchema,
    model: z.string().min(1),
    api_key: z.string().min(1),
    base_url: z.string().url().optional(),
  })
  .strict()
  // Fix #2: base_url is only valid for ollama. For openai/anthropic/openrouter
  // the route forwards it to the SDK constructor's baseURL, which would send
  // the Bearer key to attacker-controlled hosts that pass validatePublicUrl
  // (any public host). zValidator returns 400 on .refine() failures.
  .refine((b) => b.base_url === undefined || b.provider === 'ollama', {
    message: 'base_url is only allowed for the ollama provider',
    path: ['base_url'],
  });

// POST /test-key — validates a provider key by calling provider.testKey().
// Does NOT persist the key (that lives in settings.ts POST /ai-keys).
aiRoute.post('/test-key', zValidator('json', TestKeyBody), async (c) => {
  const { provider, model, api_key, base_url } = c.req.valid('json');

  // claude-code is a keyless/local backend — there is no API key to validate.
  if (provider === 'claude-code') {
    throw new HTTPError(
      'INVALID_BODY',
      'claude-code does not use an API key and cannot be tested here',
      422,
    );
  }

  // Fix #5: explicit base_url is required for ollama. The provider's
  // testKey() falls back to DEFAULT_BASE = 'http://localhost:11434' when no
  // baseUrl is supplied, which would bypass validatePublicUrl entirely and
  // let a session caller probe the server's loopback Ollama.
  if (provider === 'ollama' && base_url === undefined) {
    throw new HTTPError(
      'INVALID_BODY',
      'base_url is required for the ollama provider',
      422,
    );
  }

  if (base_url !== undefined) {
    // LOOPBACK ESCAPE HATCH — mirrors POST /ai-keys. Permit localhost/127.x
    // ONLY for ollama AND only when FOLIO_ALLOW_LOOPBACK_AI=1. Lets a self-
    // hosted operator test their local Ollama; closed by default otherwise.
    const allowLoopback = provider === 'ollama' && env.FOLIO_ALLOW_LOOPBACK_AI;
    const v = validatePublicUrl(base_url, { allowLoopback });
    if (!v.ok) {
      throw new HTTPError('INVALID_BODY', v.reason, 422);
    }
  }
  const result = await getProvider(provider).testKey({
    apiKey: api_key,
    model,
    baseUrl: base_url,
  });
  return jsonOk(c, result);
});

// ---------------------------------------------------------------------------
// POST /complete — one-shot, READ-ONLY editor slash-command completions
// ---------------------------------------------------------------------------
//
// Backs the `/draft`, `/summarize`, `/decompose` slash commands in the body
// editor. Session-only (inherited from the router gate above). The endpoint:
//   - takes the CONTENT directly (no document_id) — the server NEVER reads any
//     document; it only transforms the text the client sends (read-only is a
//     structural property, not a check). It performs NO write and emits NO
//     event (not a mutation — invariant 5 N/A; threat-model mitigation 5).
//   - resolves the SAME instance-default AI model the operator uses (Settings →
//     AI "Use for operator", else the anthropic default) — there is no
//     per-request provider choice. (do NOT hardcode a provider.)
//   - frames the caller's `content` as UNTRUSTED DATA (buildCompletionPrompt /
//     mitigation 8) and accumulates the provider stream into a single string.
//   - returns `{ text }` ONLY. The decrypted key flows into the provider call
//     and nowhere else; provider errors are sanitized so a failure can't leak
//     the key or upstream URL (mitigation 6).

const CompleteBody = z
  .object({
    action: z.enum(['draft', 'summarize', 'decompose']),
    content: z.string(),
    title: z.string().optional(),
    instruction: z.string().optional(),
  })
  .strict();

const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

const COMPLETE_MAX_TOKENS = 2048;

aiRoute.post('/complete', zValidator('json', CompleteBody), async (c) => {
  const { action, content, title, instruction } = c.req.valid('json');

  // Resolve the instance default model the same way an operator run does: the
  // configured `operator_model` setting if present, else the operator def's
  // anthropic default. There is no per-request provider choice in this UI.
  const opModel = resolveOperatorRunModel(
    await getOperatorModelSetting(db),
    getOperatorDefinition(),
  );

  // claude-code is a keyless/local backend with no provider-stream registry
  // entry; it can't serve a one-shot API completion. (getProvider would throw
  // 'Unknown AI provider' — surface a clear 409 instead.)
  if (opModel.provider === 'claude-code') {
    throw new HTTPError(
      'AI_NOT_CONFIGURED',
      'The configured AI provider does not support one-shot completions.',
      409,
    );
  }
  const provider = opModel.provider as ProviderName;

  // Resolve the instance AI key by (provider, label). A missing/undecryptable
  // key → AI_NOT_CONFIGURED (mitigation 7). ollama is legitimately keyless, but
  // it still requires a configured ROW (which carries the validated baseUrl);
  // a missing row blocks for every provider so there is no silent loopback
  // fallback (mirrors loadConversationContext).
  const keyRow = await db.query.aiKeys.findFirst({
    where: and(eq(aiKeys.provider, provider), eq(aiKeys.label, opModel.aiKeyLabel)),
  });
  if (!keyRow) {
    throw new HTTPError('AI_NOT_CONFIGURED', 'No AI key is configured for this instance.', 409);
  }
  // Delegate the decrypt-swallow to the runner's shared primitive so the
  // "a decrypt error must NOT leak key bytes" mitigation lives in ONE place
  // (threat-model mitigation 6 / runner's mitigation 5). A decryptFailed flag
  // here → the same not-configured 409, never the raw error.
  const { apiKey, decryptFailed } = resolveKeyMaterial(keyRow);
  if (decryptFailed) {
    throw new HTTPError('AI_NOT_CONFIGURED', 'The configured AI key could not be decrypted.', 409);
  }
  // A non-ollama provider with an empty key is not usable.
  if (apiKey.length === 0 && provider !== 'ollama') {
    throw new HTTPError('AI_NOT_CONFIGURED', 'No AI key is configured for this instance.', 409);
  }
  const baseUrl = keyRow.baseUrl ?? undefined;

  const { system, userContent } = buildCompletionPrompt(action, { content, title, instruction });

  // One-shot: there is no non-streaming provider method, so accumulate every
  // `text` delta into a single string and return it. No tools (read-only — the
  // model cannot act, only transform). The key goes ONLY into this call.
  //
  // The terminal `done` event carries the stop reason — we MUST honor it.
  // Accumulating only `text` and ignoring `done` would return `{ text: '' }`
  // for a refusal or an empty stop, which the editor then inserts silently as
  // a no-op (findings 189/466). Track the reason and fail loudly on those.
  let text = '';
  let doneReason: 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | undefined;
  try {
    for await (const ev of getProvider(provider).stream({
      system,
      messages: [{ role: 'user', content: userContent }],
      tools: [],
      maxTokens: COMPLETE_MAX_TOKENS,
      apiKey,
      model: opModel.model,
      baseUrl,
    })) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'done') doneReason = ev.reason;
    }
  } catch (err) {
    // sanitize: a provider SDK error string can embed partial credentials or the
    // upstream URL. Never echo it; surface only the whitelisted status line.
    throw new HTTPError('AI_ERROR', sanitizeProviderError(err, PROVIDER_LABEL[provider]), 502);
  }

  // Refusal wins regardless of any partial text — the model declined the
  // request, so there is nothing useful to insert.
  if (doneReason === 'refusal') {
    throw new HTTPError('AI_REFUSED', 'The AI declined to complete this request.', 422);
  }

  // An empty (or whitespace-only) accumulation would insert nothing — surface a
  // clear error instead of a silent no-op. `max_tokens`/`pause_turn` truncation
  // that still produced text falls through and returns the partial draft (200):
  // a truncated draft is still useful for v1.
  if (text.trim().length === 0) {
    throw new HTTPError('AI_EMPTY_RESPONSE', 'The AI returned an empty response.', 422);
  }

  return jsonOk(c, { text });
});

export { aiRoute };
