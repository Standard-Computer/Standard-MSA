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
// server-side request forgery shape (CodeQL js/request-forgery flags it on
// this PR; the flow it describes is the feature itself, so the finding can
// only be mitigated, never made to disappear). Single-operator self-hosted
// app or not, the probe must never be usable to poke loopback services, the
// LAN, or a cloud metadata endpoint. The guard:
//
//   1. Only http(s) URLs.
//   2. Every hostname is DNS-resolved and every resolved address must be
//      public BEFORE we connect.
//   3. The socket then dials EXACTLY the address we vetted — the transport
//      pins it via a custom `lookup`, so a DNS answer that changes between
//      the check and the connect (DNS rebinding) cannot redirect the
//      connection. TLS SNI and certificate validation still use the
//      hostname.
//   4. Redirects are followed MANUALLY with the same vet-then-pin per hop —
//      a public site redirecting to http://169.254.169.254/ is the classic
//      laundering step.
//
// The same guard is what SHA-2957's liveness checker should reuse.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

export type ReachabilityResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export type LookupFn = (hostname: string) => Promise<string[]>;

/** One redirect hop as the transport saw it. */
export type ProbeHop = { status: number; location: string | null };

/** Performs one GET against `url`, connecting only to `pinnedAddress`. */
export type TransportFn = (url: URL, pinnedAddress: string, timeoutMs: number) => Promise<ProbeHop>;

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

/** Resolve the URL's host; return the vetted address to pin, or a refusal.
 *  Every resolved address must be public — one private answer refuses the
 *  whole host, so a mixed public/private answer cannot be laundered. */
async function vetUrlTarget(
  url: URL,
  lookupFn: LookupFn,
): Promise<{ refused: string } | { address: string }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { refused: "is not an http(s) URL" };
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
      return { refused: "could not be reached (DNS failure)" };
    }
  }
  if (addresses.length === 0) return { refused: "could not be reached (DNS failure)" };
  if (addresses.some((a) => isPrivateAddress(a))) {
    return { refused: "resolves to a private or internal address, which the probe will not contact" };
  }
  return { address: addresses[0] };
}

/** One GET over node:http(s) with the connection pinned to `pinnedAddress`:
 *  the `lookup` handed to the socket returns only the address the caller
 *  already vetted, never a fresh DNS answer. The body is drained unread. */
function defaultTransport(url: URL, pinnedAddress: string, timeoutMs: number): Promise<ProbeHop> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === "https:";
    const family = isIP(pinnedAddress);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: pinnedAddress, family }]);
      } else {
        (callback as (err: Error | null, address: string, family: number) => void)(
          null,
          pinnedAddress,
          family,
        );
      }
    };
    const req = (https ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port ? Number(url.port) : https ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": "Standard-MSA onboarding check" },
        timeout: timeoutMs,
        lookup: pinnedLookup,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null });
      },
    );
    req.on("timeout", () => {
      const err = new Error(`no response within ${timeoutMs}ms`);
      err.name = "TimeoutError";
      req.destroy(err);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * One GET per hop with a short timeout. GET rather than HEAD: enough real
 * sites answer HEAD with 405/403 that a HEAD-only probe would cry wolf, and
 * we read no body either way. Redirects are followed by hand so every hop
 * passes the vet-then-pin guard. `transport`/`lookupFn` are injectable so
 * tests never touch the network.
 */
export async function probeWebsite(
  url: string,
  transport: TransportFn = defaultTransport,
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
    const vetted = await vetUrlTarget(current, lookupFn);
    if ("refused" in vetted) return { ok: false, reason: vetted.refused };

    let res: ProbeHop;
    try {
      res = await transport(current, vetted.address, timeoutMs);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, reason: `did not respond within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, reason: "could not be reached (DNS or connection failure)" };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.location) return { ok: false, reason: `redirected (HTTP ${res.status}) without a destination` };
      try {
        current = new URL(res.location, current);
      } catch {
        return { ok: false, reason: `redirected (HTTP ${res.status}) to an invalid URL` };
      }
      continue;
    }

    if (res.status >= 200 && res.status <= 299) return { ok: true, status: res.status };
    return { ok: false, reason: `responded with HTTP ${res.status}` };
  }

  return { ok: false, reason: `redirected more than ${MAX_REDIRECTS} times` };
}
