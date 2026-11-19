// The white-label /legal embed (SHA-2957; ported from ShadowPSA STA-9323,
// root STA-9319).
//
// PURE and db-free — tests and three surfaces (the operator panel, the embed
// script, the frame) need identical answers.
//
// ── THE ARCHITECTURE ──
//
// There is ONE renderer — /legal/embed/frame — and the script's whole job is
// to INJECT that iframe and talk to it. Three reasons, in the order they bite:
//
//   1. Two renderers drift. The fallback is by definition the path nobody
//      looks at; the only way one test covers both paths is to make them the
//      same code.
//   2. No CORS surface at all. A JSON endpoint read cross-origin needs CORS,
//      a preflight, and an allow-list that has to be right or the embed is
//      dead. An iframe needs none of that — the only control is
//      `frame-ancestors`, which is declarative and cannot be got subtly
//      wrong in a way that still half-works.
//   3. Style isolation. The container lives in somebody else's stylesheet. An
//      inline render inherits whatever a site builder's CSS does to <ol> and
//      <table>, and a numbered-clause agreement rendered through a theme that
//      restyles lists is a legal document that reads wrong.
//
// What the iframe costs is font inheritance. That is bought back by the
// HANDSHAKE: the script reads the computed font off the container and posts
// it in, and the frame applies it. The <iframe> fallback is not a second
// implementation — it is the SAME URL, pasted by hand, with the handshake
// absent: fixed height, its own font. A site builder that strips scripts gets
// a correct, complete, slightly less adaptive embed — the right failure mode.
//
// Everything is `sm-legal`-prefixed (Standard-MSA), never anything
// ShadowPSA/OrangeBoard-branded: the snippet lands on the MSP's own website
// and must read as theirs. Unlike the upstream, there is no `data-brand`
// attribute: Standard-MSA is single-tenant by principle (one install, one
// MSP — see docs/ARCHITECTURE.md), so the host in the script src is the
// complete selector and an extra attribute would be a knob that selects
// nothing.

/** The element the snippet drops on the page; the script fills it. */
export const EMBED_CONTAINER_ID = "sm-legal";

/** Message type for the frame -> host height post. */
export const EMBED_MSG_HEIGHT = "sm-legal:height";
/** Message type for the host -> frame style handshake. */
export const EMBED_MSG_STYLE = "sm-legal:style";
/** Message type for the frame -> host deep-link post (hash sync). */
export const EMBED_MSG_HASH = "sm-legal:hash";
/**
 * Message type for the frame -> host SCROLL request, carrying an offset in
 * frame-document pixels.
 *
 * Auto-height makes the iframe exactly as tall as its content, so the frame
 * document has NO scrollable overflow — its own `scrollY` is permanently 0
 * and `scrollIntoView` inside it moves nothing. The element that actually
 * scrolls is the HOST page. So a deep link cannot be resolved inside the
 * frame: the frame computes WHERE the target sits in its own document and
 * posts that offset out; the host adds the iframe's position in its own
 * layout and scrolls itself. The `scrollIntoView` call stays as the fallback
 * for the hand-pasted <iframe>, which has a fixed height and therefore
 * really does scroll internally.
 */
export const EMBED_MSG_SCROLL = "sm-legal:scroll";

export type EmbedTheme = "light" | "dark" | "auto";

export const EMBED_THEMES: EmbedTheme[] = ["light", "dark", "auto"];

export function asEmbedTheme(raw: string | null | undefined): EmbedTheme {
  // A switch over literals rather than `includes() ? raw : "light"`: the
  // return value is a FRESH literal, never the query-string value itself, so
  // taint tracking (CodeQL js/reflected-xss) can see that nothing
  // request-controlled flows onward. Same semantics, provable sanitizer.
  switch (raw) {
    case "dark":
      return "dark";
    case "auto":
      return "auto";
    default:
      return "light";
  }
}

// ── Origins ───────────────────────────────────────────────────────────
//
// ── WHY AN EMPTY LIST MEANS "ANY", AND WHY THAT IS NOT A HOLE ──
//
// Everything the embed serves is ALREADY public and unauthenticated at
// /legal — that is the entire point of a published agreement. An origin
// allow-list therefore cannot prevent disclosure: anyone who wants the text
// fetches /legal directly, with no browser involved and nothing to check.
// What it CAN do is stop the MSP's agreements being framed inside somebody
// else's site as though they were that site's terms — a passing-off concern
// rather than a confidentiality one. That is what `frame-ancestors` below
// delivers.
//
// So: empty ships as "any origin", because the alternative is an embed that
// is dead on arrival until an operator finds a settings box, and a dead
// embed teaches people the feature is broken. A non-empty list is an
// operator opting INTO breakage for everyone they did not name — a sensible
// thing to opt into, and a terrible default.
//
// One honest limit, written down because it is invisible otherwise: the
// <script src> that loads embed.js cannot be origin-checked at all. Browsers
// send no Origin header on a classic script load, and Referer is both
// spoofable and routinely stripped. So the allow-list is enforced where it
// is enforceable — frame-ancestors on the frame, and the postMessage
// handshake — and embed.js itself is served to anyone. It contains no MSP
// data; it is a loader.

/**
 * An operator-entered website, normalised to an ORIGIN, or null if it is not
 * one.
 *
 * `new URL` rather than a regex, so a `javascript:` value cannot be shaped
 * into a pass. A bare hostname is accepted and assumed https, because
 * "www.example.com" is what an operator types and refusing it would be
 * pedantry that reads as a bug.
 *
 * Returns the ORIGIN only: scheme + host + non-default port. A path or a
 * trailing slash in the stored value would match nothing, since an origin is
 * the only thing a browser ever compares against.
 */
export function normalizeEmbedOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // A bare "*" is how an operator says "any" without emptying the box.
  // Accepted and normalised to the empty list by parseEmbedOrigins, so there
  // is one representation of "any" downstream rather than two.
  if (s === "*") return "*";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!isHostname(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Is this actually a host name?
 *
 * `new URL` alone is NOT enough: the WHATWG parser happily accepts
 * `https://!!!` and reports a hostname of `!!!`. Two things go wrong when
 * that lands, and the second is the serious one:
 *
 *   1. It silently matches nothing, so the operator sees a saved value and
 *      an embed that refuses to render, with no connection between the two.
 *   2. It is interpolated into `Content-Security-Policy: frame-ancestors`.
 *      A junk token there can invalidate the WHOLE directive — one typo
 *      taking out every site the MSP actually configured.
 *
 * So the shape is checked explicitly: dot-separated LDH labels, or an
 * IP-literal (`[::1]`, `127.0.0.1`), or bare `localhost`. A single label
 * with no dot is refused — "intranet" is far more likely to be a half-typed
 * "intranet.example.com" than a real public origin.
 */
function isHostname(host: string): boolean {
  if (!host) return false;
  if (host === "localhost") return true;
  // IPv6 literals arrive bracketed from `new URL`; IPv4 passes the LDH rule
  // below on its own, since digits and dots are all it contains.
  if (host.startsWith("[") && host.endsWith("]")) return /^[0-9a-f:.]+$/i.test(host.slice(1, -1));
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  // Length and the leading/trailing-hyphen rule are checked in plain code
  // rather than folded into the pattern: the obvious single regex nests a
  // bounded quantifier inside an optional group, which
  // `security/detect-unsafe-regex` refuses, and lint runs --max-warnings 0.
  return labels.every(
    (l) =>
      l.length >= 1 &&
      l.length <= 63 &&
      !l.startsWith("-") &&
      !l.endsWith("-") &&
      /^[a-z0-9-]+$/i.test(l),
  );
}

/**
 * A textarea's worth of websites -> the stored origin list.
 *
 * One per line or comma-separated, because an operator will do both.
 * Unparseable lines are DROPPED rather than throwing: refusing the whole
 * save over one typo'd domain would lose the other edits. The settings page
 * shows what was actually stored, which is the feedback that matters.
 *
 * A list containing "*" collapses to empty — one representation of "any".
 */
export function parseEmbedOrigins(raw: string): string[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const o = normalizeEmbedOrigin(p);
    if (o === "*") return [];
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/** Is this host origin allowed to frame us? Empty list = everyone. */
export function isAllowedEmbedOrigin(origin: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;
  const o = normalizeEmbedOrigin(origin);
  return o !== null && o !== "*" && allowed.includes(o);
}

/**
 * The `Content-Security-Policy: frame-ancestors` value for the frame route.
 *
 * `*` when nothing is configured. Note what this deliberately does NOT do:
 * send `X-Frame-Options`. That header has no allow-list form — it is
 * DENY/SAMEORIGIN only — so emitting it alongside a frame-ancestors list
 * would mean the restrictive one wins in every browser and the embed never
 * renders anywhere. frame-ancestors supersedes it and is what every current
 * browser honours.
 */
export function frameAncestorsValue(allowed: string[]): string {
  return allowed.length === 0 ? "frame-ancestors *" : `frame-ancestors ${allowed.join(" ")}`;
}

// ── The snippet ───────────────────────────────────────────────────────

export type EmbedSnippetOptions = {
  /** Absolute origin of this install — "https://msa.example.com". */
  baseUrl: string;
  theme?: EmbedTheme;
};

/** The script snippet — what the Copy button puts on the clipboard. */
export function embedScriptSnippet(opts: EmbedSnippetOptions): string {
  const theme = opts.theme ?? "light";
  const themeAttr = theme === "light" ? "" : ` data-theme="${theme}"`;
  return [
    `<div id="${EMBED_CONTAINER_ID}"></div>`,
    `<script src="${trimSlash(opts.baseUrl)}/legal/embed.js"${themeAttr} async></script>`,
  ].join("\n");
}

/** The no-script fallback — the same frame, pasted by hand. */
export function embedIframeSnippet(opts: EmbedSnippetOptions): string {
  const theme = opts.theme ?? "light";
  const q = theme === "light" ? "" : `?theme=${theme}`;
  return [
    `<iframe src="${trimSlash(opts.baseUrl)}/legal/embed/frame${q}"`,
    `        title="Legal agreements"`,
    `        style="width:100%;border:0;height:1200px"`,
    `        loading="lazy"></iframe>`,
  ].join("\n");
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
