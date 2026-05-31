import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { providerSchema } from '../lib/agent-run-schema.ts';
import { getProvider } from '../lib/ai/provider.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { validatePublicUrl } from '../lib/url-allow-list.ts';
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
    const v = validatePublicUrl(base_url);
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

export { aiRoute };
