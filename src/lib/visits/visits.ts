import { createHash } from "node:crypto";
import { VISIT_MAX_PING_SECONDS, VISIT_MAX_TOTAL_SECONDS } from "./constants";

// Visitor-log helpers (SHA-2957). The PURE half — header parsing, geo
// derivation, clamps, hashing — lives here so tests need no database; the
// route owns the Prisma writes.
//
// Privacy posture (documented for operators in README § Visitor log):
//   · No cookies, no localStorage, no fingerprinting. The visitId is random
//     per page load and cannot follow a person across visits.
//   · Region/country come from standard proxy geo HEADERS when the
//     operator's proxy provides them (Cloudflare, Vercel, or a self-managed
//     nginx/caddy geo module). There is NO external lookup call, ever — a
//     self-hosted legal tool must not ship visitor IPs to a third party.
//   · `hashVisitorIps` (default off) stores a salted SHA-256 instead of the
//     raw IP. Retention is `visitRetentionDays` with a purge job; the
//     self-hosting MSP owns the GDPR/CCPA obligation for what they keep.

/** Headers → best-effort client IP. First hop of x-forwarded-for wins. */
export function clientIpFrom(get: (name: string) => string | null): string | null {
  const xff = get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = get("x-real-ip");
  if (real) return real.trim().slice(0, 64);
  return null;
}

export type GeoHint = { country: string | null; region: string | null };

/**
 * Headers → country/region, from whichever proxy is in front. Checked in
 * order of specificity; all are operator-controlled infrastructure, so this
 * is derivation, not trust in the visitor.
 */
export function geoFromHeaders(get: (name: string) => string | null): GeoHint {
  const country =
    get("cf-ipcountry") ??
    get("x-vercel-ip-country") ??
    get("x-geo-country") ??
    get("x-country-code");
  const region =
    get("x-vercel-ip-country-region") ?? get("x-geo-region") ?? get("x-region-code");
  const clean = (v: string | null): string | null => {
    if (!v) return null;
    const s = v.trim().toUpperCase().slice(0, 8);
    // "XX" is Cloudflare's "unknown"; storing it would read as a country.
    return s && s !== "XX" ? s : null;
  };
  return { country: clean(country), region: clean(region) };
}

/** Salted SHA-256 of an IP, for the hashVisitorIps option. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

/**
 * The salt behind `hashVisitorIps`. One read of the env var, in one place.
 *
 * The fallback buys exactly one thing: an install that enables the toggle
 * without setting the var must not silently fall back to storing raw IPs.
 * That is the whole of it. A hash under the default salt is NOT a pseudonym
 * — the default is a public constant, committed to a public repo and shipped
 * in the Railway template (SHA-4455), so anyone can sweep the 2^32 IPv4
 * space against `sha256("standard-msa:" + ip)` and read the address straight
 * back out. Measured under SHA-4514: ~8.7 core-hours on one CPython core,
 * well under a second on a commodity GPU. It is the address with extra
 * steps, which is what tests/legal/salt-exposure.test.ts says and what the
 * test below pins this comment to.
 *
 * Only an operator-set salt, never published, makes the stored value a
 * pseudonym. `.env.example` and docs/SELF-HOSTING.md name the var so it can
 * be set; nothing here should be read as a reason not to.
 *
 * Never logged, never rendered, never put in the embed snippet — the salt is
 * an input to a one-way function here and nowhere else. tests/legal/
 * salt-exposure.test.ts holds every public surface to that.
 */
export function visitIpSalt(): string {
  return process.env.VISIT_IP_HASH_SALT || "standard-msa";
}

/** The visitor-identity columns of a LegalVisit row: raw address XOR hash. */
export type VisitIpColumns = { ip: string | null; ipHash: string | null };

/**
 * THE decision about what a visit row keeps of the visitor's address.
 *
 * Sean's ruling of 2026-11-27 (mail 4895, SHA-4497) is that the default
 * stays "track IPs and timestamps" — `hashVisitorIps: false` in
 * src/lib/legal/settings.ts DEFAULTS — with the operator toggle left in
 * place. Two call sites write visit rows (the direct /legal page view in
 * ./record.ts and the embed beacon in src/app/api/legal/visit/route.ts), and
 * before this they each carried their own copy of the ternary. Two copies of
 * a product ruling is one copy too many: a change to either would move the
 * default for half the visits and nothing would fail.
 *
 * So the ternary lives here once, both sites call it, and
 * tests/legal/visits.test.ts pins both branches. The columns are exclusive by
 * construction — never both, so a row can't carry the address twice.
 */
export function visitIpColumns(
  ip: string | null,
  hashVisitorIps: boolean,
  salt: string,
): VisitIpColumns {
  if (!hashVisitorIps) return { ip, ipHash: null };
  return { ip: null, ipHash: ip ? hashIp(ip, salt) : null };
}

/** What both visit-row writers derive from the request headers alone. */
export type VisitorColumns = VisitIpColumns & {
  userAgent: string | null;
  country: string | null;
  region: string | null;
};

/**
 * Headers → the columns every visit row shares, however it was triggered.
 *
 * `referer` is NOT here: the page view reads the request header, while the
 * beacon is posted by our own frame and so carries the host page's URL in
 * its body instead. Same column, genuinely different source.
 */
export function visitorColumns(
  get: (name: string) => string | null,
  hashVisitorIps: boolean,
  salt: string,
): VisitorColumns {
  const geo = geoFromHeaders(get);
  return {
    userAgent: get("user-agent")?.slice(0, 400) ?? null,
    ...visitIpColumns(clientIpFrom(get), hashVisitorIps, salt),
    country: geo.country,
    region: geo.region,
  };
}

/** Clamp one read-timer ping to what a real interval can contain. */
export function clampPingSeconds(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, Math.min(n, VISIT_MAX_PING_SECONDS));
}

/** Clamp the accumulated total so no row can claim more than a day. */
export function clampTotalSeconds(current: number, add: number): number {
  return Math.min(Math.max(current, 0) + Math.max(add, 0), VISIT_MAX_TOTAL_SECONDS);
}

/** A visitId from the beacon: shape-checked, never trusted. */
export function isValidVisitId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw);
}

/** The purge cutoff for retention of N days. */
export function purgeCutoff(retentionDays: number, now: Date): Date {
  const days = Math.max(1, Math.floor(retentionDays));
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
