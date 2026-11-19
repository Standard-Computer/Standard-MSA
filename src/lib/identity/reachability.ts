// Website reachability probe (SHA-2956).
//
// The issue asks that the website "is a reachable URL". Format is a hard
// validation error (fields.ts); reachability is a PROBE whose failure is
// DATA, not an exception (architecture principle 5): a site that happens to
// be down while its owner runs onboarding should produce a visible warning
// the operator can override, not a wall. The server action blocks the save
// until the operator either fixes the URL or explicitly accepts the warning.
//
// ── SSRF guard ──
//
// The probe fetches a URL a form submitted, from the server — the textbook
// server-side request forgery shape (CodeQL js/request-forgery flagged it on
// this PR, correctly). Single-operator self-hosted app or not, the probe
// must never be usable to poke loopback services, the LAN, or a cloud
// metadata endpoint. So: every hostname is DNS-resolved and every resolved
// address must be public BEFORE we connect, and redirects are followed
// MANUALLY with the same check per hop — a public site redirecting to
// http://169.254.169.254/ is the classic laundering step. The same guard is
// what SHA-2957's liveness checker should reuse.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ReachabilityResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export type LookupFn = (hostname: string) => Promise<string[]>;

const MAX_REDIRECTS = 5;

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/** True for any address the probe must never connect to: loopback, RFC1918,
 *  link-local (incl. the cloud metadata range), CGNAT, unspecified, ULA. */
export function isPrivateAddress(address: string): boolean {
  const addr = address.toLowerCase();
  const family = isIP(addr);

  if (family === 4) return ipv4IsPrivate(addr);
  if (family === 6) {
    // IPv4-mapped IPv6 ("::ffff:10.0.0.1") hides a v4 address.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4IsPrivate(mapped[1]);
    if (addr === "::" || addr === "::1") return true;
    if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // ULA fc00::/7
    if (addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    return false;
  }
  // Not an IP literal at all — treat as unsafe; callers resolve first.
  return true;
}

function ipv4IsPrivate(addr: string): boolean {
  const octets = addr.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/** Resolve the URL's host and refuse it unless every address is public. */
async function checkUrlTarget(url: URL, lookupFn: LookupFn): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "is not an http(s) URL";
  }
  // URL brackets IPv6 literals; strip them so isIP/lookup see the address.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookupFn(host);
    } catch {
      return "could not be reached (DNS failure)";
    }
  }
  if (addresses.length === 0) return "could not be reached (DNS failure)";
  if (addresses.some((a) => isPrivateAddress(a))) {
    return "resolves to a private or internal address, which the probe will not contact";
  }
  return null;
}

/**
 * One GET per hop with a short timeout. GET rather than HEAD: enough real
 * sites answer HEAD with 405/403 that a HEAD-only probe would cry wolf, and
 * we read no body either way. Redirects are followed by hand so every hop
 * passes the private-address check. `fetchFn`/`lookupFn` are injectable so
 * tests never touch the network.
 */
export async function probeWebsite(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
  lookupFn: LookupFn = defaultLookup,
): Promise<ReachabilityResult> {
  let current: URL;
  try {
    current = new URL(url.trim());
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refused = await checkUrlTarget(current, lookupFn);
    if (refused) return { ok: false, reason: refused };

    let res: Response;
    try {
      res = await fetchFn(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "Standard-MSA onboarding check" },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, reason: `did not respond within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, reason: "could not be reached (DNS or connection failure)" };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: `redirected (HTTP ${res.status}) without a destination` };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: `redirected (HTTP ${res.status}) to an invalid URL` };
      }
      continue;
    }

    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: `responded with HTTP ${res.status}` };
  }

  return { ok: false, reason: `redirected more than ${MAX_REDIRECTS} times` };
}
