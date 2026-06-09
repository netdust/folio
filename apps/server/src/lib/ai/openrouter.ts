import { streamOpenAICompatible } from './openai.ts';
import type { AIProvider } from './provider.ts';
import { sanitizeProviderError } from './sanitize-error.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter exposes an OpenAI-compatible API. We reuse the OpenAI provider's
 * `stream` (via the exported `streamOpenAICompatible` helper) with a base-URL
 * override AND a `providerName: 'OpenRouter'` thread-through so sanitized
 * error messages correctly name the upstream (B round 5 #6 — pre-fix a
 * 401 from OpenRouter surfaced as 'key rejected by OpenAI' which misled
 * operators on which provider was failing). Model strings pass through
 * verbatim — caller is expected to format them as "anthropic/claude-haiku-4-5"
 * or whatever route they want.
 *
 * B round 3 fix #6 — testKey is overridden, NOT delegated to openai.testKey.
 * OpenRouter serves `/api/v1/models` WITHOUT authentication, so the OpenAI
 * provider's `c.models.list()` returns ok for ANY apiKey value (including the
 * empty string). Use `/api/v1/key` which requires a Bearer header — it returns
 * 401 for unknown keys, 200 with the key's metadata for valid ones.
 */
export const openrouter: AIProvider = {
  // G6 — streamOpenAICompatible sends `max_tokens` (the OpenAI convention). Some
  // OpenRouter upstreams (o1/o3-class routes) require `max_completion_tokens` and
  // IGNORE `max_tokens`, so the per-request output cap is not enforced upstream on
  // those routes. The run is still bounded by the G2 budget meter + MAX_TOOL_ROUNDS
  // (and G2 warns loudly if such a route also omits usage → unmetered). A per-route
  // token-param map is deferred (threat model G6 deferral — moving target, low value).
  stream: (opts) =>
    streamOpenAICompatible({ ...opts, baseUrl: OPENROUTER_BASE, providerName: 'OpenRouter' }),
  testKey: async ({ apiKey }) => {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      // Round 6 #7 — migrated to the shared sanitizeProviderError helper.
      // `Response` has a `.status` field, so the helper's `{ status?: number }`
      // shape accepts it directly. Helper distinguishes 401 from 403 (round 6).
      return { ok: false, reason: sanitizeProviderError(res, 'OpenRouter') };
    } catch (err) {
      // Round 6 #7 — keep the helper for symmetry. Network errors have no
      // .status field; the helper returns the network-error branch.
      return { ok: false, reason: sanitizeProviderError(err, 'OpenRouter') };
    }
  },
};
