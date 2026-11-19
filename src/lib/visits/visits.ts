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
