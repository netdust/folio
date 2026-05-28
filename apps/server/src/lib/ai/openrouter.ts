import { openai } from './openai.ts';
import type { AIProvider } from './provider.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter exposes an OpenAI-compatible API. We reuse the OpenAI provider's
 * `stream` with a base-URL override. Model strings pass through verbatim —
 * caller is expected to format them as "anthropic/claude-haiku-4-5" or
 * whatever route they want.
 *
 * B round 3 fix #6 — testKey is overridden, NOT delegated to openai.testKey.
 * OpenRouter serves `/api/v1/models` WITHOUT authentication, so the OpenAI
 * provider's `c.models.list()` returns ok for ANY apiKey value (including the
 * empty string). Use `/api/v1/key` which requires a Bearer header — it returns
 * 401 for unknown keys, 200 with the key's metadata for valid ones.
 */
export const openrouter: AIProvider = {
  stream: (opts) => openai.stream({ ...opts, baseUrl: OPENROUTER_BASE }),
  testKey: async ({ apiKey }) => {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403)
        return {
          ok: false,
          reason: `Unauthorized (${res.status}): key rejected by OpenRouter.`,
        };
      if (res.status === 429)
        return { ok: false, reason: 'Rate limited (429). Try again shortly.' };
      if (res.status >= 500)
        return { ok: false, reason: `Server error (${res.status}). The provider may be down.` };
      return { ok: false, reason: `Error (${res.status}).` };
    } catch {
      // Never surface err.message — see the Fix #9 / Fix #3 contract.
      return { ok: false, reason: 'Network error or unreachable host.' };
    }
  },
};
