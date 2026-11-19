// The request-surface registry (SHA-3047).
//
// docs/ARCHITECTURE.md § Request surfaces already divides this app into
// "public, no auth" and "operator UI — everything else". Before this lane
// that split lived only in prose, so `/sends/[id]` shipped the accept token
// on an enumerable integer path and nothing failed. This file makes the
// split executable, and tests/auth/coverage.test.ts holds the file system to
// it: every route under src/app must be matched by an entry here, and every
// `operator` entry must actually call the guard.
//
// Deny by default is the point. An unrecognised path classifies as operator,
// so a route that nobody thought about is refused rather than served.

/** How a surface is authorised. */
export type SurfaceKind =
  /** No auth by design — the recipient token or the public legal site. */
  | "public"
  /** Operator-only: a human session (see ./session.ts). */
  | "operator"
  /** Machine caller carrying its own credential (bearer, webhook secret, uuid). */
  | "machine";

/** What an operator surface returns to a caller without a session. */
export type RefusalStyle =
  /** A browser screen: send it to the login page. */
  | "redirect"
  /** A download or data response: 401 with no body worth having. */
  | "status";

export interface Surface {
  /**
   * A Next route path, dynamic segments in `[param]` form, optionally ending
   * in `/**` to cover everything below it.
   */
  readonly pattern: string;
  readonly kind: SurfaceKind;
  /** Only meaningful when `kind` is `operator`. */
  readonly refusal?: RefusalStyle;
  /** Why it needs no operator session. Required for public/machine entries. */
  readonly because?: string;
}

/**
 * Every request surface in the app.
 *
 * Order matters: the FIRST matching entry wins, so a specific path can carve
 * itself out of a `/**` entry above it. Keep specific before general.
 */
export const SURFACES: readonly Surface[] = [
  // ── Public by design ──────────────────────────────────────────────────────
  {
    pattern: "/login",
    kind: "public",
    because: "The sign-in screen itself. Renders no operator data.",
  },
  {
    pattern: "/msa/**",
    kind: "public",
    because:
      "The recipient's own agreement. The 256-bit send token IS the authorisation " +
      "here (src/lib/sends/tokens.ts) — there is deliberately no recipient login.",
  },
  {
    pattern: "/legal/**",
    kind: "public",
    because: "The MSP's public legal site, including the embed script and frame.",
  },
  {
    pattern: "/legal",
    kind: "public",
    because: "The MSP's public legal index.",
  },

  // ── Machine callers: credential carried in the request ────────────────────
  {
    pattern: "/api/cron/**",
    kind: "machine",
    because: "CRON_SECRET bearer token, checked in the handler.",
  },
  {
    pattern: "/api/email/webhooks/[provider]",
    kind: "machine",
    because: "EMAIL_WEBHOOK_SECRET / SendGrid signature, checked in the handler.",
  },
  {
    pattern: "/api/email/open/[id]",
    kind: "machine",
    because:
      "Tracking pixel keyed on the EmailOutbound uuid — unguessable, and the " +
      "recipient's mail client is the caller.",
  },
  {
    pattern: "/api/email/click/[id]/[index]",
    kind: "machine",
    because:
      "Click redirect keyed on the EmailOutbound uuid — unguessable, and the " +
      "recipient clicking their own link is the caller.",
  },
  {
    pattern: "/api/legal/visit",
    kind: "machine",
    because: "Visit beacon from the public legal site / embed frame.",
  },
  {
    pattern: "/api/sends/view",
    kind: "machine",
    because: "Read-ping beacon from the recipient's own /msa/[token] page.",
  },
  {
    pattern: "/api/v1/**",
    kind: "machine",
    because: "Public REST API: `Authorization: Bearer <api key>` (SHA-2960).",
  },
  {
    pattern: "/api/**",
    kind: "machine",
    because:
      "Fallback for the machine surface. A new /api route must authenticate " +
      "its own caller; it gets no operator session from a browser cookie.",
  },

  // ── Operator UI: everything else ──────────────────────────────────────────
  { pattern: "/", kind: "operator", refusal: "redirect" },
  { pattern: "/onboarding", kind: "operator", refusal: "redirect" },
  { pattern: "/embed", kind: "operator", refusal: "redirect" },
  { pattern: "/settings/**", kind: "operator", refusal: "redirect" },
  { pattern: "/sends", kind: "operator", refusal: "redirect" },
  { pattern: "/sends/new", kind: "operator", refusal: "redirect" },
  { pattern: "/sends/notices", kind: "operator", refusal: "redirect" },
  // Specific before general: the evidence download is data, not a screen.
  { pattern: "/sends/[id]/evidence", kind: "operator", refusal: "status" },
  { pattern: "/sends/[id]", kind: "operator", refusal: "redirect" },
  { pattern: "/visits/export", kind: "operator", refusal: "status" },
  { pattern: "/visits", kind: "operator", refusal: "redirect" },
] as const;

/** What an unmatched path gets: operator, refused as a screen. Deny by default. */
export const UNMATCHED: Surface = { pattern: "*", kind: "operator", refusal: "redirect" };

function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/**
 * Does `pattern` cover `pathname`?
 *
 * Segment-wise, so matching is prefix-safe by construction: `/legal` never
 * matches `/legalish`, and `/sends/**` never matches `/sendsx/1`. A `[param]`
 * segment matches exactly one non-empty segment; a trailing `/**` matches one
 * or more further segments.
 */
export function matchesPattern(pattern: string, pathname: string): boolean {
  const want = segments(pattern);
  const got = segments(pathname);
  const deep = want[want.length - 1] === "**";
  const fixed = deep ? want.slice(0, -1) : want;

  if (deep ? got.length <= fixed.length : got.length !== fixed.length) return false;

  for (let i = 0; i < fixed.length; i++) {
    const w = fixed[i];
    if (w.startsWith("[") && w.endsWith("]")) continue; // one dynamic segment
    if (w !== got[i]) return false;
  }
  return true;
}

/** The governing surface for a request path. Never null — unknown is operator. */
export function classifyPath(pathname: string): Surface {
  // Normalise away the query/hash and any trailing slash, so `/sends/` and
  // `/sends?ok=1` classify as `/sends` rather than falling through to
  // UNMATCHED (which is safe, but would refuse as the wrong style).
  const path = pathname.split("?")[0].split("#")[0];
  for (const surface of SURFACES) {
    if (matchesPattern(surface.pattern, path)) return surface;
  }
  return UNMATCHED;
}

/** True when a request to `pathname` needs an operator session. */
export function requiresOperator(pathname: string): boolean {
  return classifyPath(pathname).kind === "operator";
}

/**
 * Is `target` a safe place to send someone after they sign in?
 *
 * Only a same-origin operator SCREEN qualifies. This rejects `//evil.test`
 * and `https://evil.test` (open redirect), and rejects public and machine
 * paths so the login form cannot be used to bounce a visitor somewhere
 * surprising. Anything else falls back to the console root.
 */
export function safeRedirectTarget(target: unknown, fallback = "/"): string {
  if (typeof target !== "string") return fallback;
  if (!target.startsWith("/") || target.startsWith("//")) return fallback;
  // A backslash is a path separator to some browsers; refuse rather than guess.
  if (target.includes("\\")) return fallback;
  const surface = classifyPath(target);
  if (surface.kind !== "operator" || surface.refusal !== "redirect") return fallback;
  return target;
}
