// The origin a request actually arrived on, as seen from outside the proxy
// (SHA-4501 follow-up).
//
// Why this exists: `new URL(req.url).origin` inside a route handler is the
// origin the Node server bound to, not the one the reader typed. On the
// Railway production deploy that is `https://0.0.0.0:8080`, so the PDF cover
// line that cites where to find the live text shipped pointing at a dead URL.
// Caught on the live site, not in CI: a local `next dev` and the DB tests
// both bind the hostname they are fetched on, which is exactly why no unit
// test could have noticed.
//
// The derivation is the one already in src/app/embed/page.tsx — forwarded
// headers first, because a self-hosted install is reached on whatever
// hostname its operator chose and the env may not name it — with two
// additions that matter once the result is printed into a document somebody
// keeps:
//
//   1. A host that is a WILDCARD BIND address (0.0.0.0, ::, [::]) is not a
//      reachable hostname, so it is rejected rather than cited. That is the
//      production bug itself.
//   2. A candidate host is validated before use. `x-forwarded-host` and
//      `host` are visitor-controllable when nothing is in front of the app,
//      and the output here ends up inside a PDF of a legal agreement. A
//      malformed or injected value is dropped, never substituted.
//
// When nothing usable survives, this returns null, and the callers treat a
// null origin as "cite no URL at all" — see src/lib/legal/pdfDocument.ts,
// where a dead citation is explicitly held to be worse than none.

/**
 * Addresses a server binds to in order to accept ANY connection. They are
 * never where a reader reached it, so they are never worth printing.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]"]);

/** Characters a DNS label may be made of. Flat, so it is linear-time. */
const LABEL_CHARS = /^[a-zA-Z0-9-]+$/;
/** Characters an IPv6 literal may be made of, inside its brackets. */
const V6_CHARS = /^[0-9A-Fa-f:.]+$/;
/** A port, as written. Range-checked separately. */
const PORT = /^[0-9]{1,5}$/;

/**
 * Split `host[:port]` with the IPv6 bracket form handled, since those are
 * full of colons. Returns null when the shape itself is wrong.
 *
 * Deliberately string operations rather than one regex: a nested-quantifier
 * hostname pattern is a ReDoS surface on a header a visitor controls, and
 * eslint-plugin-security rejects it in this repo.
 */
function splitHostPort(host: string): { hostname: string; port: string | null } | null {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return null;
    const rest = host.slice(close + 1);
    if (rest === "") return { hostname: host.slice(0, close + 1), port: null };
    if (!rest.startsWith(":")) return null;
    return { hostname: host.slice(0, close + 1), port: rest.slice(1) };
  }
  const colon = host.indexOf(":");
  if (colon === -1) return { hostname: host, port: null };
  // A second colon outside brackets is not a host:port — it is an unbracketed
  // IPv6 literal or junk, and either way not something to print.
  if (host.indexOf(":", colon + 1) !== -1) return null;
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

function isHostname(hostname: string): boolean {
  if (hostname.startsWith("[")) {
    if (!hostname.endsWith("]")) return false;
    const inner = hostname.slice(1, -1);
    return inner !== "" && V6_CHARS.test(inner);
  }
  if (hostname === "" || hostname.length > 253) return false;
  const labels = hostname.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      !label.startsWith("-") &&
      !label.endsWith("-") &&
      LABEL_CHARS.test(label),
  );
}

/** A host good enough to print: well-formed, and somewhere a reader could be. */
export function isUsableHost(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = value.trim();
  if (host === "" || host.length > 255) return false;
  const parts = splitHostPort(host);
  if (parts === null) return false;
  if (!isHostname(parts.hostname)) return false;
  if (parts.port !== null) {
    if (!PORT.test(parts.port)) return false;
    const port = Number.parseInt(parts.port, 10);
    if (port < 1 || port > 65535) return false;
  }
  return !WILDCARD_HOSTS.has(parts.hostname.toLowerCase());
}

/** The first entry of a comma-separated proxy header, e.g. `x-forwarded-host`. */
function firstValue(raw: string | null): string | null {
  if (raw === null) return null;
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

export interface OriginOptions {
  /** `new URL(req.url).origin` — the server's own view, used only if sound. */
  readonly fallbackOrigin?: string | null;
  /** `APP_BASE_URL`, the operator's declared public base, used last. */
  readonly configuredBaseUrl?: string | null;
}

/**
 * Headers (+ the handler's own fallbacks) → the public origin, or null.
 *
 * PURE: takes the same `get` shape as src/lib/visits/visits.ts so it is
 * testable without a Request, a server or a proxy.
 */
export function originFromHeaders(
  get: (name: string) => string | null,
  options: OriginOptions = {},
): string | null {
  const forwardedHost = firstValue(get("x-forwarded-host"));
  const hostHeader = firstValue(get("host"));
  const host = isUsableHost(forwardedHost)
    ? forwardedHost
    : isUsableHost(hostHeader)
      ? hostHeader
      : null;

  if (host !== null) {
    const forwardedProto = firstValue(get("x-forwarded-proto"))?.toLowerCase();
    const proto =
      forwardedProto === "https" || forwardedProto === "http"
        ? forwardedProto
        : // No forwarded protocol: follow whatever the server itself is
          // serving, and only then assume plain http (a self-hosted install
          // behind no TLS terminator is a supported deployment).
          protocolOf(options.fallbackOrigin) ?? "http";
    return `${proto}://${host}`;
  }

  // No usable header. The server's own origin is still right for a direct,
  // unproxied request — but only when it is not a wildcard bind.
  const fallback = normalizeOrigin(options.fallbackOrigin);
  if (fallback !== null) return fallback;
  return normalizeOrigin(options.configuredBaseUrl);
}

function parse(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function protocolOf(value: string | null | undefined): "http" | "https" | null {
  const url = parse(value);
  if (url === null) return null;
  return url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
}

/** An absolute http(s) origin with no trailing slash, or null. */
function normalizeOrigin(value: string | null | undefined): string | null {
  const url = parse(value);
  if (url === null) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isUsableHost(url.host)) return null;
  return url.origin;
}

/**
 * The public origin for a route handler's Request.
 *
 * Thin wrapper: the decision is in `originFromHeaders`, this only supplies
 * the two fallbacks a handler has access to.
 */
export function requestOrigin(req: Request): string | null {
  let fallbackOrigin: string | null = null;
  try {
    fallbackOrigin = new URL(req.url).origin;
  } catch {
    fallbackOrigin = null;
  }
  return originFromHeaders((name) => req.headers.get(name), {
    fallbackOrigin,
    configuredBaseUrl: process.env.APP_BASE_URL || null,
  });
}
