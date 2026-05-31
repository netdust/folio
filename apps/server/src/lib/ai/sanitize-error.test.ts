/**
 * Unit tests for the shared provider-error sanitization helper.
 *
 * Round 6 #2 introduced the null/undefined guard. Round 5 extracted the
 * helper from inline whitelists in anthropic/openai/openrouter stream().
 * The whitelist contract (threat-model mitigation 5) is:
 *   401|403 → "Unauthorized (...)"
 *   429     → "Rate limited (429)"
 *   5xx     → "Server error (status)"
 *   other   → "Error (status)"
 *   no status / null / undefined → "Network error or unreachable host."
 *
 * NEVER echo `e.message`, NEVER echo caller-supplied baseUrl/model/apiKey.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeProviderError } from './sanitize-error.ts';

describe('sanitizeProviderError', () => {
  // Round 6 #2 — the regression: reading e.status on a value cast as
  // { status?: number } threw 'null is not an object' at runtime when the
  // SDK / underlying library threw null or undefined (e.g. Promise.reject(null),
  // some fetch polyfills, abort signals). That throw escaped the outer catch
  // and leaked into the response shape, defeating the whitelist.
  test('returns the network-error branch for null', () => {
    expect(sanitizeProviderError(null, 'OpenAI')).toBe('Network error or unreachable host.');
  });

  test('returns the network-error branch for undefined', () => {
    expect(sanitizeProviderError(undefined, 'OpenAI')).toBe('Network error or unreachable host.');
  });

  test('returns the network-error branch when the error has no status', () => {
    expect(sanitizeProviderError(new Error('connection reset'), 'Anthropic')).toBe(
      'Network error or unreachable host.',
    );
  });

  // Round 6 #7 — 401 and 403 are distinct cases. The round-5 helper collapsed
  // them; the inline whitelists in anthropic/openai testKey distinguished
  // them. 401 = key rejected; 403 = key valid but missing scope. Worth
  // preserving — the UX chip in the AI tab can explain "your key works but
  // the model is gated" rather than just "unauthorized".
  test('returns 401-specific message naming the provider', () => {
    const msg = sanitizeProviderError({ status: 401 }, 'OpenAI');
    expect(msg).toMatch(/unauthorized/i);
    expect(msg).toMatch(/401/);
    expect(msg).toMatch(/openai/i);
    expect(msg).not.toMatch(/forbidden/i);
  });

  test('returns 403-specific message naming the provider', () => {
    const msg = sanitizeProviderError({ status: 403 }, 'Anthropic');
    expect(msg).toMatch(/forbidden/i);
    expect(msg).toMatch(/403/);
    expect(msg).toMatch(/anthropic/i);
    expect(msg).not.toMatch(/unauthorized/i);
  });

  test('returns the rate-limited message for 429', () => {
    expect(sanitizeProviderError({ status: 429 }, 'OpenAI')).toMatch(/rate limited.*429/i);
  });

  test('returns the server-error message for 5xx', () => {
    expect(sanitizeProviderError({ status: 503 }, 'OpenAI')).toMatch(/server error.*503/i);
  });

  test('returns the generic-status message for other statuses', () => {
    expect(sanitizeProviderError({ status: 418 }, 'OpenAI')).toBe('Error (418).');
  });

  // Defense in depth: never echo a caller-supplied URL or model or key
  // even if present on the error object. The function takes only providerName
  // as a string argument; the rest of the error object is ignored.
  test('never echoes SDK message body even when status is missing', () => {
    const leaky = new Error('Incorrect API key provided: sk-real-0123...');
    const msg = sanitizeProviderError(leaky, 'OpenAI');
    expect(msg).not.toContain('sk-real');
    expect(msg).not.toContain('Incorrect API key');
  });
});
