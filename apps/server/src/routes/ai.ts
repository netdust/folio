import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { providerSchema } from '../lib/agent-run-schema.ts';
import { getProvider } from '../lib/ai/provider.ts';
import { jsonOk } from '../lib/http.ts';
import { type AuthContext, requireUser } from '../middleware/auth.ts';
import type { ScopeContext } from '../middleware/scope.ts';

const aiRoute = new Hono<AuthContext & ScopeContext>();

// UI-only key test action: requires a session, not a token. Mounted under
// wScope so attachToken + requireUserOrToken + resolveWorkspace have already
// run upstream; requireUser here narrows to "session present" and rejects
// agent/PAT callers.
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
