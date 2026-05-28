import { openai } from './openai.ts';
import type { AIProvider } from './provider.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter exposes an OpenAI-compatible API. We reuse the OpenAI provider
 * with a base-URL override. Model strings pass through verbatim — caller is
 * expected to format them as "anthropic/claude-haiku-4-5" or whatever route
 * they want.
 */
export const openrouter: AIProvider = {
  stream: (opts) => openai.stream({ ...opts, baseUrl: OPENROUTER_BASE }),
  testKey: (opts) => openai.testKey({ ...opts, baseUrl: OPENROUTER_BASE }),
};
