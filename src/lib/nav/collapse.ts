// Where the nav's collapsed/expanded preference lives (SHA-4503, GH #17).
//
// A cookie rather than `localStorage`, for one reason: `src/app/layout.tsx` is
// a server component and can read it, so the FIRST paint is already the
// operator's chosen width. `localStorage` is only readable after hydration, so
// a collapsed rail would render expanded and then jump on every navigation and
// every reload — a flash on the one piece of chrome that is on every screen.
// The cost is a request header of about 20 bytes; nothing here is static, every
// page in this app is already `force-dynamic`, so reading it loses no caching.
//
// Deliberately not a server action: this is a display preference, and a
// round-trip to toggle a sidebar would be worse than the problem. The client
// writes it with `document.cookie`, which is also why the cookie is not
// `HttpOnly`. Nothing authorises anything on this value — the operator gate
// never reads it, and the worst a forged value can do is open or close the
// reader's own menu.

/** Cookie name. Not security-relevant; see the note above. */
export const NAV_COLLAPSED_COOKIE = "msa_nav_collapsed";

/** A year. A UI preference should outlive the session that set it. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read the preference. Anything other than an explicit `"1"` means expanded,
 * so a missing, empty or junk cookie gives the documented default rather than
 * a hidden menu (AC4: "default may be expanded").
 */
export function parseNavCollapsed(raw: string | undefined): boolean {
  return raw === "1";
}

/**
 * The `document.cookie` assignment that persists `collapsed`.
 *
 * `secure` is passed in rather than sniffed here so this stays pure and
 * testable: the caller knows its protocol, and hard-coding `Secure` would
 * silently drop the cookie — i.e. break persistence — on a plain-HTTP
 * self-host or `localhost` dev server.
 */
export function navCollapsedCookie(collapsed: boolean, secure: boolean): string {
  const parts = [
    `${NAV_COLLAPSED_COOKIE}=${collapsed ? "1" : "0"}`,
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
