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
 *
 * LOOPBACK ESCAPE HATCH (`opts.allowLoopback`): self-hosted / dev installs run
 * Ollama on the same box, so `http://localhost:11434` (and 127.0.0.1) is the
 * canonical base_url — exactly what the SSRF guard otherwise blocks. The two
 * AI-config call sites (POST /ai/test-key, POST /ai-keys) pass `allowLoopback`
 * ONLY when BOTH the `FOLIO_ALLOW_LOOPBACK_AI` env flag is set AND the provider
 * is `ollama`. The flag is unset in any normal deploy, so the guard stays fully
 * closed by default. When the hatch is open it permits loopback (localhost,
 * 127/8, ::1, and the IPv4-mapped loopback forms) ONLY — every other private /
 * link-local / metadata range (10/8, 192.168/16, 169.254/16, …) stays blocked,
 * since those are the genuine SSRF targets and a local Ollama never needs them.
 */
export type UrlValidationResult = { ok: true } | { ok: false; reason: string };

export type UrlValidationOpts = {
  /** Permit loopback-only hosts. See the LOOPBACK ESCAPE HATCH note above. */
  allowLoopback?: boolean;
};

/**
 * B round 5 #11 — exported as named symbols so the regex itself can be
 * unit-tested directly. The existing expanded-IPv6 tests pass via Bun's URL
 * parser canonicalization (`[0:0:0:0:0:0:0:1]` → `::1`), so a regression in
 * the expanded regex would NOT have failed those tests — the canonical regex
 * was doing the work. Direct tests on the regexes themselves give an honest
 * signal of expanded-form coverage. Threat model mitigation 15.
 */
export const EXPANDED_IPV6_LOOPBACK = /^(?:0{1,4}:){7}0{0,3}1$/i;
export const EXPANDED_IPV6_UNSPECIFIED = /^(?:0{1,4}:){7}0{0,4}$/i;

const BLOCKED_IPV4_PREFIXES = [
  /^0\./, // 0.0.0.0/8 unspecified
  /^10\./, // 10.0.0.0/8 private
  /^127\./, // 127.0.0.0/8 loopback
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./, // 192.168.0.0/16 private
  /^::1$/, // IPv6 loopback (canonical)
  /^::$/, // IPv6 unspecified (canonical)
  // B round 4 fix #4 — expanded-form IPv6 zero-segments for ::1 and ::.
  // Round 3 only added the IPv4-mapped expanded form; pure ::1 and :: were
  // left exact-match. Bun's URL parser canonicalizes both today, but a
  // future runtime / proxy may not. Defense in depth.
  //   `0:0:0:0:0:0:0:1` → ::1   (any number of leading-zero quibbles, last quibble = 0-prefix + 1)
  //   `0:0:0:0:0:0:0:0` → ::    (any number of leading-zero quibbles, last quibble = 0-prefix)
  EXPANDED_IPV6_LOOPBACK,
  EXPANDED_IPV6_UNSPECIFIED,
  /^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
  /^fc[0-9a-f]{2}:/i, // IPv6 unique-local fc00::/7
  /^fd[0-9a-f]{2}:/i, //   "
];

function looksLikeIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Loopback-only matcher for the escape hatch. A strict SUBSET of the blocked
 * set — waives ONLY 127/8, localhost, ::1 (canonical + expanded), and the
 * IPv4-mapped-IPv6 loopback forms. The broader private/link-local/metadata
 * ranges (10/8, 192.168/16, 169.254/16, ::, fc00::/7, …) are NOT loopback and
 * stay blocked even when the hatch is open. `host` is the already-canonicalized
 * (lowercased, bracket-stripped, trailing-dot-stripped) hostname.
 */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host)) return true; // 127.0.0.0/8
  if (/^::1$/.test(host) || EXPANDED_IPV6_LOOPBACK.test(host)) return true;
  // IPv4-mapped IPv6 loopback: ::ffff:7f00:x (hex) + expanded form.
  const mapped =
    host.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i) ??
    host.match(/^(?:0:){5}ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i);
  if (mapped && ((Number.parseInt(mapped[1] ?? '0', 16) >> 8) & 0xff) === 127) return true;
  // Dotted IPv4-mapped form ::ffff:127.x.x.x (canonical + expanded).
  return (
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(host) ||
    /^(?:0:){5}ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(host)
  );
}

export function validatePublicUrl(
  input: string,
  opts?: UrlValidationOpts,
): UrlValidationResult {
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
  let host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // B round 3 fix #4 — strip a trailing dot before any host-equality / endsWith
  // comparison. The root-anchored DNS form `localhost.` (or `foo.localhost.`)
  // resolves to the same address but bypassed a strict equality check.
  // Bun's URL parser preserves the trailing dot (verified). Strip BEFORE every
  // downstream comparison so the IPv4-prefix / IPv6-mapped paths also see the
  // canonicalized form.
  //
  // B round 4 fix #3 — greedy strip. Pre-fix used `slice(0, -1)` which only
  // removed ONE trailing dot — `localhost..` survived as `localhost.` and
  // slipped the equality check. Linux resolves any-trailing-dots form to the
  // same address; `.replace(/\.+$/, '')` matches that behavior.
  host = host.replace(/\.+$/, '');

  // B round 5 #7 — reject empty host after the trailing-dot strip. Bare-dot
  // inputs (http://., http://..) parse successfully in Bun's URL parser but
  // become empty strings after the greedy strip; without this check they
  // would slip every host-equality + IP prefix guard and return ok:true.
  // On a host where the resolver maps empty/root-dot to loopback this would
  // re-open the SSRF round 3 was supposed to close. Threat mitigation 18.
  if (host === '') {
    return { ok: false, reason: 'base_url host is empty' };
  }

  // LOOPBACK ESCAPE HATCH — see the module header. When the caller opts in
  // (FOLIO_ALLOW_LOOPBACK_AI + ollama provider), waive ONLY loopback hosts.
  // Placed AFTER scheme/empty-host validation so non-http and bare-dot inputs
  // still reject; placed BEFORE the loopback + private blocks so localhost /
  // 127.x / ::1 pass. Broader private/link-local ranges fall through to the
  // blocks below and stay rejected even with the hatch open.
  if (opts?.allowLoopback && isLoopbackHost(host)) {
    return { ok: true };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'base_url localhost is not allowed' };
  }

  for (const re of BLOCKED_IPV4_PREFIXES) {
    if (re.test(host)) {
      return { ok: false, reason: `base_url points at a private or loopback address (${host})` };
    }
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh).
  // Bun's URL parser canonicalizes both forms to ::ffff:hhhh:hhhh — and the
  // expanded form `0:0:0:0:0:ffff:hhhh:hhhh` to the same 2-segment shape
  // (verified via `bun --eval`). The expanded regex below is defense-in-depth
  // against any future runtime / proxy that DOESN'T canonicalize (B round 3
  // fix #5) — Linux routes these forms to the underlying IPv4 address, so a
  // mapped loopback/private IPv4 reaches the same target even though the host
  // string is IPv6.
  const mappedMatch =
    host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i) ??
    host.match(/^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedMatch) {
    const hi = Number.parseInt(mappedMatch[1] ?? '0', 16);
    const lo = Number.parseInt(mappedMatch[2] ?? '0', 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    for (const re of BLOCKED_IPV4_PREFIXES) {
      if (re.test(ipv4)) {
        return {
          ok: false,
          reason: `base_url IPv4-mapped IPv6 points at a private/loopback address (${host} → ${ipv4})`,
        };
      }
    }
  }

  // Also block the dotted IPv4-mapped form ::ffff:a.b.c.d if the parser kept it.
  // (Bun normalizes to the hex form above; other runtimes may not.) Match the
  // expanded form too as defense-in-depth (B round 3 fix #5).
  const dottedMappedMatch =
    host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i) ??
    host.match(/^(?:0:){5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dottedMappedMatch) {
    const ipv4 = dottedMappedMatch[1]!;
    for (const re of BLOCKED_IPV4_PREFIXES) {
      if (re.test(ipv4)) {
        return {
          ok: false,
          reason: `base_url IPv4-mapped IPv6 points at a private/loopback address (${host} → ${ipv4})`,
        };
      }
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
