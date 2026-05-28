import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { providerSchema } from '../lib/agent-run-schema.ts';
import { getProvider } from '../lib/ai/provider.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { type AuthContext, requireUser } from '../middleware/auth.ts';
import type { ScopeContext } from '../middleware/scope.ts';

const aiRoute = new Hono<AuthContext & ScopeContext>();

// UI-only key test action: session callers only — never API tokens.
//
// attachToken (upstream on wScope) hydrates c.user from token.createdBy when
// a Bearer token is present and no session exists, so requireUser alone would
// accept bearer-only requests. Explicitly reject anything carrying a token
// before delegating to requireUser. Order matters: the token guard runs
// first so a bearer-only request gets a precise 403 (not the generic 401
// requireUser would emit if attachToken had failed to hydrate a user).
aiRoute.use('*', async (c, next) => {
  if (c.get('token')) {
    throw new HTTPError(
      'FORBIDDEN',
      'AI key management is session-only (no API tokens)',
      403,
    );
  }
  return next();
});
aiRoute.use('*', requireUser);

const TestKeyBody = z
  .object({
    provider: providerSchema,
    model: z.string().min(1),
    api_key: z.string().min(1),
    base_url: z.string().url().optional(),
  })
  .strict();

// POST /test-key — validates a provider key by calling provider.testKey().
// Does NOT persist the key (that lives in settings.ts POST /ai-keys).
aiRoute.post('/test-key', zValidator('json', TestKeyBody), async (c) => {
  const { provider, model, api_key, base_url } = c.req.valid('json');
  const result = await getProvider(provider).testKey({
    apiKey: api_key,
    model,
    baseUrl: base_url,
  });
  return jsonOk(c, result);
});

export { aiRoute };
