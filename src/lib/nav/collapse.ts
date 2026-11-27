// How the left nav remembers that it was collapsed (SHA-4496, GH #17 AC 4).
//
// The state lives in localStorage and is applied to <html> by a tiny inline
// script that runs before the nav is parsed, rather than by a React effect
// after hydration. An effect works, but it means every page load paints the
// expanded rail first and then snaps it shut — a visible jump on every
// navigation for anyone who collapsed it. Doing it pre-paint costs one line
// of inline script and removes the jump entirely.
//
// A cookie read in the root layout would also avoid the jump, and was
// rejected: calling cookies() in a root layout opts the WHOLE app into
// dynamic rendering, including the public /legal pages that are deliberately
// cacheable. A nav preference must not change how the public site is served.
//
// These three constants are in a plain module (no "use client") because the
// server layout injects the script and the client component writes the value.
// Importing a constant out of a "use client" module into a server component
// gets you a client reference, not the string.

/** localStorage key. Namespaced so it cannot collide on a shared origin. */
export const NAV_COLLAPSE_STORAGE_KEY = "standard-msa:nav-collapsed";

/** The class on <html> that CSS keys the collapsed rail off (globals.css). */
export const NAV_COLLAPSED_CLASS = "nav-collapsed";

/** The stored value meaning "collapsed". Anything else is expanded. */
export const NAV_COLLAPSED_VALUE = "1";

/**
 * The pre-paint script, injected as the first child of <body>.
 *
 * Built by interpolating the constants above through JSON.stringify, so the
 * script and the module can never drift apart and the result is a JS string
 * literal by construction — there is no path here for a `<` or a quote to
 * reach the page, which tests/nav/links.test.ts asserts outright.
 *
 * localStorage throws rather than returning null when storage is denied
 * (Safari private mode, a sandboxed iframe), so the try/catch is load-bearing:
 * without it a denied read would abort the inline script and nothing after it
 * in <body> would be... fine, actually, but the console would carry an error
 * on every page load. Collapse state is a preference; failing silently and
 * rendering expanded is the right answer.
 */
export const NAV_COLLAPSE_BOOTSTRAP =
  `try{if(localStorage.getItem(${JSON.stringify(NAV_COLLAPSE_STORAGE_KEY)})===` +
  `${JSON.stringify(NAV_COLLAPSED_VALUE)}){document.documentElement.classList.add(` +
  `${JSON.stringify(NAV_COLLAPSED_CLASS)})}}catch(e){}`;
