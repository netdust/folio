/**
 * Whitelist-sanitize a provider SDK error before surfacing it.
 * NEVER echo e.message, NEVER echo caller-supplied baseUrl/model/apiKey.
 *
 * Shared by all provider testKey + stream startup error paths per
 * threat model mitigation 5 (apps/server/src/lib/ai/anthropic.ts,
 * openai.ts, openrouter.ts, ollama.ts).
 *
 * Round 4 enriched mitigation 5 with per-site enumeration of stream()
 * startup throws but only ollama.stream wrapped its throws in code.
 * Round 5 extracts this helper and applies it to the three missing
 * SDK-backed providers. SDK error strings can embed:
 *  - partial credentials ("Incorrect API key provided: sk-real-0123...")
 *  - the upstream URL (reveals any stored attacker baseUrl)
 *  - request IDs + proxy hostnames
 *
 * The whitelist takes only the HTTP status; the providerName is the only
 * caller-supplied piece included in the surfaced message (no key, no URL,
 * no model name, no SDK message body).
 */
export function sanitizeProviderError(err: unknown, providerName: string): string {
  const e = err as { status?: number };
  if (e.status === 401 || e.status === 403) {
    return `Unauthorized (${e.status}): key rejected by ${providerName}.`;
  }
  if (e.status === 429) {
    return 'Rate limited (429). Try again shortly.';
  }
  if (typeof e.status === 'number' && e.status >= 500) {
    return `Server error (${e.status}). The provider may be down.`;
  }
  if (typeof e.status === 'number') {
    return `Error (${e.status}).`;
  }
  return 'Network error or unreachable host.';
}
