// The two public embed routes, and the ONE place that decides which paths
// are exempt from the app-wide framing headers (SHA-2957; ported from
// ShadowPSA STA-9551, where this pattern fixed an 11-month silent prod bug).
//
// ── WHY A MODULE AND NOT TWO STRING LITERALS ──
//
// The exemption has to be spelled in two dialects:
//
//   · next.config.ts — a path-to-regexp `source` with a negative lookahead,
//     so the app-wide `X-Frame-Options: SAMEORIGIN` + `frame-ancestors
//     'self'` entry does not match the embed routes (a Next config header
//     REPLACES a route handler's header of the same key — in ShadowPSA that
//     meant prod answered `frame-ancestors 'self'` for eleven months while
//     the route source read `*`)
//   · runtime code — an exact-path check for anything that must special-case
//     the embed (no session, no cookies)
//
// Two spellings of one list is exactly the shape that drifts, so the list
// lives here once and the regex is DERIVED from it, never hand-written.
//
// next.config.ts deliberately does NOT import this file — a Next config
// import graph is loaded before the app's module resolution and a bad import
// there fails the build, not a test. Instead tests/legal/embedRoutes.test.ts
// asserts that the literal in next.config.ts is character-identical to what
// this module produces, and compiles the regex to check its MATCH BEHAVIOUR
// against a path table. Text equality alone would pass on a regex that
// matches nothing.

/**
 * Every path that is framed by, or fetched by, a third-party page.
 *
 * EXACT paths, never prefixes. `/legal/embed` is not a real route, but if it
 * ever becomes one it must opt in here on purpose rather than inherit the
 * exemption from a `/legal/embed/*` prefix. The same goes for anything
 * nested under the frame.
 */
export const EMBED_PUBLIC_ROUTES = ["/legal/embed/frame", "/legal/embed.js"] as const;

/**
 * The only one of those that is actually loaded INTO an iframe.
 *
 * embed.js is a classic `<script src>`, so it needs the CORS header and the
 * no-session treatment but never needs to be frameable. Kept separate so the
 * frame-ancestors exemption stays as small as the thing that needs it.
 */
export const EMBED_FRAMED_ROUTE = "/legal/embed/frame";

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A `headers()` source that matches every path EXCEPT the embed routes — the
 * app-wide security headers keep applying everywhere else.
 *
 * Shape: `/:path((?!legal/embed/frame$|legal/embed\.js$).*)`
 *
 * The trailing `$` inside each alternative is what makes this EXACT-route
 * scoping rather than prefix scoping: `/legal/embed/frame/anything` fails
 * the lookahead alternatives, so the negative lookahead SUCCEEDS and the
 * app-wide headers still apply to it. A `(?!legal/embed)` without the
 * anchors would hand the exemption to every future path under that prefix.
 *
 * `.*` (not `[^/]*`) so the one param spans slashes, and it matches the
 * empty string so `/` is still covered.
 */
export const NON_EMBED_HEADER_SOURCE = `/:path((?!${EMBED_PUBLIC_ROUTES.map(
  (route) => `${escapeForRegex(route.slice(1))}$`,
).join("|")}).*)`;

/**
 * The same decision as `NON_EMBED_HEADER_SOURCE`, in plain JS, for anything
 * that has a real pathname in hand rather than a route pattern.
 *
 * Deliberately a `===` over the list and not a `startsWith`, for the reason
 * in `EMBED_PUBLIC_ROUTES`.
 */
export function isPublicEmbedRoute(pathname: string): boolean {
  return (EMBED_PUBLIC_ROUTES as readonly string[]).includes(pathname);
}
