/**
 * SSRF guard utilities.
 *
 * Validates outbound URLs to prevent server-side request forgery attacks
 * where tenant-controlled URLs could be used to scan or interact with
 * internal network services (loopback, RFC1918, link-local, cloud metadata).
 *
 * Two layers of protection are provided:
 *
 *   1. `assertSafeUrl()` — synchronous, checks URL syntax, protocol, and
 *      whether the hostname is an obvious IP literal or known-private name.
 *      Suitable for use in Zod `.refine()` predicates (schema validation).
 *
 *   2. `assertSafeUrlResolved()` — asynchronous, extends the sync check by
 *      resolving the hostname via DNS and verifying that every returned
 *      address is in a public range. Call this immediately before any
 *      outbound `fetch()` that targets a tenant-supplied URL.
 *
 * Defence-in-depth: even with both checks an attacker who controls DNS TTLs
 * could attempt a rebind between resolution and connect (TOCTOU). The only
 * complete mitigation is a custom Node http.Agent that re-validates the
 * socket remote address; the two-layer approach here raises the cost
 * significantly for unallowlisted destinations (webhook / Teams channels)
 * while keeping ERP adapters protected via schema-level domain allowlists.
 */

import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";

/**
 * Private/reserved IPv4 prefixes that must never be targeted by
 * outbound requests driven by tenant-supplied URLs.
 *
 *   127.0.0.0/8    — loopback
 *   10.0.0.0/8     — RFC1918 private
 *   172.16.0.0/12  — RFC1918 private
 *   192.168.0.0/16 — RFC1918 private
 *   169.254.0.0/16 — link-local / cloud metadata (e.g. 169.254.169.254)
 *   0.0.0.0/8      — "this" network
 *   100.64.0.0/10  — CGNAT shared address space
 */
const BLOCKED_IPV4_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Native IPv6 loopback, link-local (fe80::/10), and ULA (fc00::/7) patterns.
 * IPv4-mapped IPv6 addresses are handled separately in `extractEmbeddedIpv4`.
 */
const BLOCKED_IPV6_NATIVE_RE =
  /^(::1$|fe[89ab][0-9a-f]:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

/**
 * Hostnames that unambiguously resolve to the local machine or a
 * private-network alias — matched case-insensitively.
 */
const BLOCKED_HOSTNAME_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.corp|.*\.home\.arpa|.*\.test|.*\.example|.*\.invalid)$/i;

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * If `addr` (already lower-cased, brackets stripped) is an IPv4-mapped or
 * IPv4-compatible IPv6 address, return the embedded IPv4 dotted string;
 * otherwise return null.
 *
 * Handles the two canonical forms produced by URL parsers:
 *
 *   Mixed notation  ::ffff:w.x.y.z  or  0:0:0:0:0:ffff:w.x.y.z
 *   Pure hex        ::ffff:aabb:ccdd  (two 16-bit groups = 32-bit IPv4)
 *   IPv4-compatible ::w.x.y.z         (deprecated, RFC 4291 §2.5.5.1)
 */
function extractEmbeddedIpv4(addr: string): string | null {
  const dotted = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

  // Mixed notation (::ffff: or full expanded 0:0:0:0:0:ffff: prefix).
  // Matches: ::ffff:w.x.y.z  |  0:…:0:ffff:w.x.y.z
  const mixedFfff = addr.match(
    /^(?:[0:]*:)?ffff:((?:\d{1,3}\.){3}\d{1,3})$/i,
  );
  if (mixedFfff && dotted.test(mixedFfff[1]!)) return mixedFfff[1]!;

  // IPv4-compatible (deprecated): ::w.x.y.z
  const ipv4compat = addr.match(/^::((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (ipv4compat && dotted.test(ipv4compat[1]!)) return ipv4compat[1]!;

  // Pure-hex IPv4-mapped: ::ffff:hhhh:hhhh (e.g. ::ffff:7f00:1 → 127.0.0.1)
  // Also handles full expanded form (0:0:0:0:0:ffff:hhhh:hhhh).
  const hexFfff = addr.match(
    /^(?:[0:]*:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,
  );
  if (hexFfff) {
    const hi = parseInt(hexFfff[1]!.padStart(4, "0"), 16);
    const lo = parseInt(hexFfff[2]!.padStart(4, "0"), 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

/**
 * Return true if `ip` is in a private, loopback, link-local, or otherwise
 * reserved range that must not be targeted by outbound requests.
 *
 * Handles:
 *   - IPv4 literals (dotted decimal)
 *   - Native IPv6 loopback, link-local, and ULA
 *   - IPv4-mapped IPv6 in mixed notation (::ffff:127.0.0.1)
 *   - IPv4-mapped IPv6 in pure hex form (::ffff:7f00:1)
 *   - Deprecated IPv4-compatible IPv6 (::127.0.0.1)
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.toLowerCase();

  if (addr === "0.0.0.0" || addr === "::" || addr === "::1") return true;

  // Extract embedded IPv4 from mapped/compatible IPv6 forms and recurse.
  const embedded = extractEmbeddedIpv4(addr);
  if (embedded !== null) return isBlockedIp(embedded);

  // Plain IPv4 literal checks.
  for (const re of BLOCKED_IPV4_RE) {
    if (re.test(addr)) return true;
  }

  // Native IPv6 loopback / link-local / ULA.
  if (BLOCKED_IPV6_NATIVE_RE.test(addr)) return true;

  return false;
}

/**
 * Parse the hostname from a URL string and normalise it (strip IPv6 brackets).
 */
function extractHost(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }
  const rawHost = parsed.hostname.toLowerCase();
  return rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
}

/**
 * Assert that a URL is safe to make outbound requests to.
 *
 * Checks performed (synchronous):
 *   1. URL is syntactically valid.
 *   2. Protocol is HTTPS (or HTTP when `requireHttps` is false).
 *   3. Hostname is not a known-private/loopback/link-local hostname.
 *   4. Hostname is not a private/reserved IPv4 or IPv6 literal,
 *      including IPv4-mapped IPv6 forms (::ffff:127.0.0.1 etc.).
 *
 * Limitation: does NOT resolve DNS. Use {@link assertSafeUrlResolved} before
 * making the actual outbound request to close the DNS-indirection bypass.
 *
 * @throws {SsrfBlockedError} if the URL is considered unsafe.
 */
export function assertSafeUrl(
  rawUrl: string,
  options: { requireHttps?: boolean } = {},
): void {
  const { requireHttps = true } = options;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }

  if (requireHttps) {
    if (parsed.protocol !== "https:") {
      throw new SsrfBlockedError(
        `Only HTTPS URLs are permitted; got "${parsed.protocol}"`,
      );
    }
  } else {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SsrfBlockedError(
        `Only HTTP(S) URLs are permitted; got "${parsed.protocol}"`,
      );
    }
  }

  const host = extractHost(rawUrl);

  if (host === "" || host === "0.0.0.0" || host === "::") {
    throw new SsrfBlockedError(`Disallowed URL hostname: "${host}"`);
  }

  if (BLOCKED_HOSTNAME_RE.test(host)) {
    throw new SsrfBlockedError(
      `URL hostname "${host}" is a disallowed local/internal hostname`,
    );
  }

  if (isBlockedIp(host)) {
    throw new SsrfBlockedError(
      `URL hostname "${host}" is a private or reserved address`,
    );
  }
}

/**
 * Async extension of {@link assertSafeUrl} that additionally resolves the
 * hostname via DNS (using the OS resolver, which mirrors what Node fetch
 * will use at connect time) and verifies that every returned address is
 * in a publicly-routable range.
 *
 * This closes the DNS-indirection bypass that the synchronous check cannot
 * catch (e.g., an attacker-controlled hostname that resolves to 10.x or
 * 169.254.169.254 at request time).
 *
 * Call this immediately before each `fetch()` to a tenant-supplied URL.
 * For ERP connector adapters the vendor-domain Zod allowlists provide
 * equivalent protection at schema-validation time; this function is most
 * important for alert webhook / Teams channels which accept arbitrary
 * HTTPS destinations.
 *
 * @throws {SsrfBlockedError} if the URL is unsafe or resolves to a blocked address.
 */
export async function assertSafeUrlResolved(
  rawUrl: string,
  options: { requireHttps?: boolean } = {},
): Promise<void> {
  assertSafeUrl(rawUrl, options);

  const host = extractHost(rawUrl);

  // If the host is already an IP literal the sync check above has already
  // validated it (including IPv4-mapped IPv6 forms); no DNS lookup needed.
  // Use node:net's isIP() which returns 4 (IPv4), 6 (IPv6), or 0 (not an IP)
  // — the only reliable way to distinguish true IP literals from look-alike
  // hostnames (e.g. hex names like "deadbeef" are valid DNS labels, not
  // IPv6 literals, so isIP("deadbeef") returns 0 and DNS is performed).
  if (isIP(host) !== 0) return;

  // Resolve hostname → IP addresses using the OS resolver (same path that
  // Node's fetch will use). `{ all: true }` returns every address record.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsPromises.lookup(host, { all: true });
  } catch (err) {
    // If DNS resolution fails we cannot confirm the destination is safe,
    // so we reject the request.
    throw new SsrfBlockedError(
      `DNS resolution failed for "${host}": ${(err as Error).message}`,
    );
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`DNS returned no addresses for "${host}"`);
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError(
        `"${host}" resolves to a private or reserved address: ${address}`,
      );
    }
  }
}

/**
 * Returns a Zod `.refine()` predicate that passes only when the value
 * is a URL that passes {@link assertSafeUrl}.
 */
export function ssrfSafeRefine(
  options: { requireHttps?: boolean } = {},
): (url: string) => boolean {
  return (url: string): boolean => {
    try {
      assertSafeUrl(url, options);
      return true;
    } catch {
      return false;
    }
  };
}
