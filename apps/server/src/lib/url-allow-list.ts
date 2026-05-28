/**
 * SSRF guard: synchronously rejects URLs that point at loopback, link-local,
 * or private networks. Used at the boundary of any route that accepts a
 * caller-supplied URL and fetches it server-side (today: POST /ai/test-key
 * for Ollama base_url).
 *
 * KNOWN GAP: does not resolve DNS. A hostname that resolves to a private IP
 * is NOT blocked here. Defending against DNS-rebinding requires async lookup
 * + revalidation at fetch time. Logged as a follow-up; the easy-attack
 * surface (typing 127.0.0.1, localhost, 169.254.169.254 directly) is closed.
 */
export type UrlValidationResult = { ok: true } | { ok: false; reason: string };

const BLOCKED_IPV4_PREFIXES = [
  /^0\./, // 0.0.0.0/8 unspecified
  /^10\./, // 10.0.0.0/8 private
  /^127\./, // 127.0.0.0/8 loopback
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./, // 192.168.0.0/16 private
  /^::1$/, // IPv6 loopback
  /^::$/, // IPv6 unspecified
  /^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
  /^fc[0-9a-f]{2}:/i, // IPv6 unique-local fc00::/7
  /^fd[0-9a-f]{2}:/i, //   "
];

function looksLikeIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function validatePublicUrl(input: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'base_url is not a valid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `base_url scheme must be http or https, got ${parsed.protocol}` };
  }

  // Strip IPv6 brackets if present.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'base_url localhost is not allowed' };
  }

  for (const re of BLOCKED_IPV4_PREFIXES) {
    if (re.test(host)) {
      return { ok: false, reason: `base_url points at a private or loopback address (${host})` };
    }
  }

  // Defensive: any IPv4 octet outside 0-255 is invalid; URL parser allows it
  // through some platforms. Catch with a quick numeric range check.
  if (looksLikeIpv4(host)) {
    const octets = host.split('.').map((s) => Number.parseInt(s, 10));
    if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return { ok: false, reason: 'base_url is not a valid IPv4 address' };
    }
  }

  return { ok: true };
}
