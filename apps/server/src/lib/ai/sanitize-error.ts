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
  // Round 6 #2 — null/undefined falls through to the network-error branch
  // (same shape as a fetch that failed before producing a Response object).
  // Pre-fix, `const e = err as { status?: number }` then `e.status` threw
  // 'null is not an object' at runtime, leaking through the outer catch and
  // defeating the whitelist intent.
  if (err == null) return 'Network error or unreachable host.';

  const e = err as { status?: number };
  // Round 6 #7 — distinguish 401 (key rejected) from 403 (key valid but
  // missing scope/permission). The round-5 helper collapsed them into one
  // line; the inline whitelists in anthropic.testKey / openai.testKey
  // distinguished them. The 403 case is semantically distinct and worth
  // preserving (helps the AI tab's ✗ chip explain "your key works, but the
  // model is gated"). NEVER echo the upstream's `e.message` body.
  if (e.status === 401) {
    return `Unauthorized (401): key rejected by ${providerName}.`;
  }
  if (e.status === 403) {
    return `Forbidden (403): key lacks required permissions on ${providerName}.`;
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
