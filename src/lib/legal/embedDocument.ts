import { escapeHtml } from "./html";
import { markdownToEmbedHtml } from "./embedMarkdown";
import {
  EMBED_MSG_HASH,
  EMBED_MSG_HEIGHT,
  EMBED_MSG_SCROLL,
  EMBED_MSG_STYLE,
  type EmbedTheme,
} from "./embed";
import { VISIT_API_PATH, VISIT_PING_SECONDS } from "../visits/constants";

// The embed frame's HTML document (SHA-2957; ported from ShadowPSA STA-9323).
//
// A COMPLETE standalone document, built here rather than rendered as a Next
// page, and that is the decision in this file worth defending. A page would
// inherit the root layout: its stylesheets, its client bundle, and — the
// disqualifier — any future session read. On a frame that lands inside the
// MSP's marketing site that is wrong four ways:
//
//   1. COOKIES. The frame touches no cookie at all, in either direction,
//      and that is checkable rather than asserted. A cookie-reading
//      third-party frame sits in the path of every tracking-prevention
//      feature shipping in browsers.
//   2. WEIGHT. A framework bundle, to render static prose, on somebody
//      else's page-load budget.
//   3. HEADERS. The frame needs its own `Content-Security-Policy:
//      frame-ancestors` (computed from a settings row) and a cache policy
//      that differ from every other page in the app. A route handler owns
//      its headers; a page does not.
//   4. THEME. The embed's light/dark is the HOST SITE's business, not
//      whatever theme the operator last picked inside the app.
//
// The markdown half lives in ./embedMarkdown.ts (remark parses, an explicit
// node allow-list serialises) and only the document SHELL is assembled here.
// Every interpolation below is escaped with the one canonical escapeHtml —
// there is no second escaper in this lane.
//
// NEW relative to the upstream: the in-frame script carries the VISIT BEACON
// (SHA-2957's visitor log). The frame is served from this install's own
// origin, so a fetch() to /api/legal/visit is same-origin — no CORS surface,
// no cookie, and a random per-load visitId instead of any identifier that
// could follow a person across visits.

export type EmbedVersionLine = {
  version: number;
  effective: string | null;
  /** Anchor id — "msa-v2". Deep links must survive. */
  anchor: string;
  href: string;
};

export type EmbedDoc = {
  slug: string;
  title: string;
  /** Already rendered in "public" mode — no client data, no raw tokens. */
  body: string;
  current: EmbedVersionLine | null;
  history: EmbedVersionLine[];
};

export type EmbedDocumentInput = {
  docs: EmbedDoc[];
  introParagraphs: string[];
  footerLines: string[];
  accentColor: string;
  theme: EmbedTheme;
  /** Absolute link to the full public index, for the "All agreements" link. */
  indexHref: string;
  /**
   * Emit the visit beacon + read-timer. On for the live frame; off for the
   * operator's preview, whose own staff views would otherwise pollute the
   * visit log the MSP shows a client.
   */
  recordVisits?: boolean;
};

// The embed's two palettes, each spelled ONCE. Each is used twice — in the
// `prefers-color-scheme` block that resolves theme="auto" before first
// paint, and in the attribute selector that pins theme="light"/"dark".
// Writing them out at both sites is how the pinned dark theme and the
// automatic one drift apart over a couple of tweaks.
//
// These are literals, not CSS vars from any app stylesheet: the frame is a
// STANDALONE DOCUMENT served to somebody else's website and loads none of
// the app's CSS, so there is nothing for a var() to resolve against.
//
// `--legal-bg` belongs to BOTH palettes, not to `:root` alone. The pinned
// light rule outranks the prefers-color-scheme block on fg but would not
// touch a bg declared only on `:root` — so a dark-OS visitor reading a
// theme="light" embed would get light-palette #0f172a text on the dark
// palette's #0f172a surface: invisible instead of merely low-contrast. Each
// palette carries its own surface so the pair can never be split across two
// rules. The light palette's transparent bg is what "inherit the host page"
// means; the dark palette MUST override it, because #e2e8f0 text on a white
// host page measured 1.23:1 against WCAG AA's 4.5:1 — unreadable contract
// text reachable from the default snippet plus a dark-mode OS.
const EMBED_LIGHT_VARS =
  "--legal-fg:#0f172a;--legal-muted:#475569;--legal-faint:#64748b;--legal-rule:#e2e8f0;--legal-link:#1d4ed8;--legal-bg:transparent;";
const EMBED_DARK_VARS =
  "--legal-fg:#e2e8f0;--legal-muted:#cbd5e1;--legal-faint:#94a3b8;--legal-rule:#334155;--legal-link:#93c5fd;--legal-bg:#0f172a;";

/**
 * The style block.
 *
 * `font: inherit` on the root is the FIRST half of "inherit host-page
 * fonts" — it makes the frame's own default typography neutral so the
 * handshake's value has nothing to fight. The second half is the
 * EMBED_MSG_STYLE listener in the script below, which is what actually
 * carries the host's computed font across the frame boundary.
 *
 * Colours are CSS custom properties with a `prefers-color-scheme` block, so
 * theme="auto" needs no JavaScript and cannot flash: the browser resolves it
 * before first paint. theme="light"/"dark" pin it by overriding the
 * properties on an attribute selector, which outranks the media block.
 */
export function embedCss(accentColor: string): string {
  // The accent is operator-entered and lands in a CSS value, so settings.ts
  // validates it as a hex before it ever reaches here. Escaped anyway:
  // defence in depth costs one call.
  const accent = escapeHtml(accentColor);
  return `
:root{${EMBED_LIGHT_VARS}--legal-accent:${accent};}
@media (prefers-color-scheme: dark){:root{${EMBED_DARK_VARS}}}
html[data-sm-embed-theme="light"]{${EMBED_LIGHT_VARS}}
html[data-sm-embed-theme="dark"]{${EMBED_DARK_VARS}}
html,body{margin:0;padding:0;background:var(--legal-bg);}
body{font:inherit;font-family:inherit;color:var(--legal-fg);line-height:1.65;
  -webkit-text-size-adjust:100%;}
.sm-l-root{max-width:46rem;margin:0 auto;padding:0 0 2rem;}
.sm-l-doc{padding:1.25rem 0;border-top:1px solid var(--legal-rule);}
.sm-l-doc:first-child{border-top:0;}
.sm-l-title{margin:0;font-size:1.25em;font-weight:700;color:var(--legal-fg);
  display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;}
.sm-l-meta{margin:.35rem 0 0;font-size:.8em;color:var(--legal-faint);}
.sm-l-meta b{font-weight:600;}
.sm-l-links{margin:.6rem 0 0;font-size:.85em;display:flex;flex-wrap:wrap;gap:1rem;}
.sm-l-links a,.sm-l-a{color:var(--legal-link);}
.sm-l-body{margin-top:1rem;color:var(--legal-fg);overflow-wrap:anywhere;}
.sm-l-h1{font-size:1.15em;font-weight:700;margin:1.6em 0 .5em;
  padding-bottom:.3em;border-bottom:1px solid var(--legal-rule);}
.sm-l-body>.sm-l-h1:first-child{margin-top:0;}
.sm-l-h2{font-size:1em;font-weight:600;margin:1.4em 0 .4em;}
.sm-l-h3{font-size:.85em;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--legal-muted);margin:1.2em 0 .4em;}
.sm-l-p{margin:0 0 .9em;color:var(--legal-muted);}
.sm-l-strong{font-weight:600;color:var(--legal-fg);}
.sm-l-ol{margin:0 0 .9em;padding-left:1.5em;list-style:decimal;color:var(--legal-muted);}
.sm-l-ul{margin:0 0 .9em;padding-left:1.5em;list-style:disc;color:var(--legal-muted);}
.sm-l-li{margin:0 0 .4em;padding-left:.15em;}
.sm-l-quote{margin:0 0 .9em;padding-left:1em;font-style:italic;
  border-left:2px solid var(--legal-rule);color:var(--legal-muted);}
.sm-l-em{font-style:italic;}
.sm-l-hr{border:0;border-top:1px solid var(--legal-rule);margin:1.5em 0;}
.sm-l-pre{margin:0 0 .9em;overflow-x:auto;}
.sm-l-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.9em;border:1px solid var(--legal-rule);border-radius:3px;padding:0 .3em;}
.sm-l-table-wrap{overflow-x:auto;margin:0 0 .9em;}
.sm-l-table{border-collapse:collapse;width:100%;font-size:.9em;}
.sm-l-th,.sm-l-td{border:1px solid var(--legal-rule);padding:.3em .5em;text-align:left;}
.sm-l-th{font-weight:600;}
.sm-l-img-omitted{font-size:.8em;font-style:italic;color:var(--legal-faint);}
.sm-l-history{margin-top:1rem;font-size:.85em;color:var(--legal-muted);}
.sm-l-history summary{cursor:pointer;color:var(--legal-link);}
.sm-l-history ul{list-style:none;margin:.5rem 0 0;padding:0;}
.sm-l-history li{padding:.25rem 0;border-top:1px solid var(--legal-rule);}
.sm-l-history li:first-child{border-top:0;}
.sm-l-footer{margin-top:1.75rem;padding-top:1rem;border-top:1px solid var(--legal-rule);
  font-size:.8em;color:var(--legal-faint);}
.sm-l-footer p{margin:0 0 .2em;}
.sm-l-accent{height:3px;background:var(--legal-accent);border-radius:3px;margin-bottom:1.25rem;}
.sm-l-intro{margin:0 0 1.25rem;font-size:.95em;color:var(--legal-muted);}
.sm-l-intro p{margin:0 0 .75em;}
.sm-l-intro p:last-child{margin-bottom:0;}
.sm-l-empty{color:var(--legal-faint);font-size:.9em;padding:1rem 0;}
/* A deep-linked section gets a brief accent rule so the jump is visible —
   an iframe scroll with no visual change reads as "the link did nothing". */
.sm-l-doc:target .sm-l-title,.sm-l-history li:target{outline:2px solid var(--legal-accent);
  outline-offset:4px;border-radius:2px;}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth;}}
`.trim();
}

/**
 * The in-frame script: height, the style handshake, hash sync — and the
 * visit beacon.
 *
 * Inline, and tiny, because an external file would be a second request from
 * the MSP's page for ~2KB and would need its own cache story.
 *
 * ── WHY IT POSTS TO "*" AND WHY THAT IS SAFE ──
 *
 * The frame does not know its host's origin: `document.referrer` is unset
 * when the host sends no referrer, and `parent.origin` is cross-origin by
 * definition. So the outbound posts target "*". That is acceptable HERE
 * because of what is in the messages: a NUMBER (our rendered height) and a
 * HASH FRAGMENT the host itself just gave us. Neither is a secret. The rule
 * that matters is the INBOUND one, and it is enforced below: the style
 * handshake only ever reads a known message type and only applies values it
 * has shape-checked, so a hostile frame posting at us can change a font and
 * nothing else.
 *
 * ── THE BEACON ──
 *
 * One POST on load creates the LegalVisit row (random visitId, the rendered
 * slugs, the theme, document.referrer — which inside the frame is the HOST
 * page URL, i.e. where the snippet lives). Then a PacketReadTimer-style
 * heartbeat: accrue wall-clock seconds only while the document is VISIBLE,
 * flush whole seconds every VISIT_PING_SECONDS via PATCH. A dropped ping
 * costs one interval, not the session; the server clamps each ping so a
 * client that lies can at worst inflate by one interval per call. Visibility
 * is part of the measurement: "open in a background tab" is not reading.
 * fetch(..., keepalive) so the pagehide flush survives navigation.
 */
function embedScript(input: { recordVisits: boolean; docSlugs: string[]; theme: EmbedTheme }): string {
  const beacon = !input.recordVisits
    ? ""
    : `
  var visitId=(function(){
    var a="";try{var b=new Uint8Array(12);crypto.getRandomValues(b);
    for(var i=0;i<b.length;i++)a+="0123456789abcdef"[b[i]>>4]+"0123456789abcdef"[b[i]&15];
    }catch(e){a=String(Math.random()).slice(2)+String(Date.now());}
    return a;
  })();
  try{
    fetch(${JSON.stringify(VISIT_API_PATH)},{method:"POST",keepalive:true,
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({visitId:visitId,docs:${JSON.stringify(input.docSlugs)},
        theme:${JSON.stringify(input.theme)},embedded:true,referrer:d.referrer||""})});
  }catch(e){}
  var accrued=0,since=null;
  function visible(){return d.visibilityState==="visible";}
  if(visible())since=Date.now();
  function flushSeconds(){
    if(since!==null){accrued+=(Date.now()-since)/1000;since=visible()?Date.now():null;}
    var whole=Math.floor(accrued);
    if(whole<=0)return;
    accrued-=whole;
    try{
      fetch(${JSON.stringify(VISIT_API_PATH)},{method:"PATCH",keepalive:true,
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({visitId:visitId,seconds:whole})});
    }catch(e){}
  }
  d.addEventListener("visibilitychange",function(){
    if(visible()){since=Date.now();}else{flushSeconds();since=null;}
  });
  setInterval(flushSeconds,${VISIT_PING_SECONDS * 1000});
  window.addEventListener("pagehide",flushSeconds);`;

  return `
(function(){
  var d=document,de=d.documentElement,last=0;
  function height(){
    var h=Math.ceil(d.body.scrollHeight);
    if(h&&h!==last){last=h;parent.postMessage({type:${JSON.stringify(EMBED_MSG_HEIGHT)},height:h},"*");}
  }
  // ResizeObserver catches reflow from the font handshake and from a <details>
  // opening; the load/timeout pair covers the first paint before any observer
  // has fired. Both, because either alone leaves a real gap.
  if(window.ResizeObserver){new ResizeObserver(height).observe(d.body);}
  window.addEventListener("load",height);
  d.addEventListener("toggle",height,true);
  setTimeout(height,0);setTimeout(height,250);setTimeout(height,1000);
  window.addEventListener("message",function(e){
    var m=e.data;
    if(!m||!m.type)return;
    if(m.type===${JSON.stringify(EMBED_MSG_HASH)}){
      // The host forwarding its own fragment (its "#msa" is not ours until it
      // is copied across). Shape-checked to "#word" so this channel can only
      // ever move our scroll position, never navigate the frame.
      if(typeof m.hash==="string"&&/^#[A-Za-z0-9_-]{1,64}$/.test(m.hash)){
        jumpTo(m.hash.slice(1));
      }
      return;
    }
    if(m.type!==${JSON.stringify(EMBED_MSG_STYLE)})return;
    // Shape-checked, not trusted. Only these three properties, only strings,
    // and length-capped so a megabyte of CSS cannot be pushed through a font
    // name. Applied to <html> so 'font:inherit' on <body> picks them up.
    var f=m.fontFamily,s=m.fontSize,c=m.color;
    if(typeof f==="string"&&f.length<300)de.style.fontFamily=f;
    if(typeof s==="string"&&s.length<32)de.style.fontSize=s;
    if(typeof c==="string"&&c.length<64)de.style.color=c;
    if(m.theme==="light"||m.theme==="dark")de.setAttribute("data-sm-embed-theme",m.theme);
    else if(m.theme==="auto")de.removeAttribute("data-sm-embed-theme");
    height();
  });
  // Deep links. TWO mechanisms, because the frame has two shapes. Under the
  // loader, auto-height makes this document exactly as tall as its content,
  // so it has no scrollable overflow and scrollIntoView moves nothing — the
  // HOST page is what scrolls, and only it knows where the iframe sits in
  // its layout. So the offset is posted OUT. In the hand-pasted <iframe>
  // fallback the height is fixed and the frame really does scroll, so
  // scrollIntoView is the right call there. Doing both is correct in both
  // shapes: the host ignores the message it did not ask for, and a
  // fixed-height frame scrolls itself.
  function jumpTo(id){
    if(!id)return;
    var el=d.getElementById(id);
    if(!el)return;
    var top=el.getBoundingClientRect().top+(window.scrollY||0);
    parent.postMessage({type:${JSON.stringify(EMBED_MSG_SCROLL)},offset:Math.round(top)},"*");
    el.scrollIntoView({block:"start"});
  }
  function jump(){ jumpTo(location.hash.replace(/^#/,"")); }
  window.addEventListener("hashchange",function(){jump();height();});
  window.addEventListener("load",function(){setTimeout(jump,50);});
  // Tell the host when an in-frame link moves the fragment, so the customer's
  // address bar can carry the deep link.
  d.addEventListener("click",function(e){
    var a=e.target&&e.target.closest?e.target.closest("a[href^='#']"):null;
    if(!a)return;
    parent.postMessage({type:${JSON.stringify(EMBED_MSG_HASH)},hash:a.getAttribute("href")},"*");
  });${beacon}
})();
`.trim();
}

function versionMeta(v: EmbedVersionLine): string {
  const bits = [`<b>v${v.version}</b>`];
  if (v.effective) bits.push(`effective ${escapeHtml(v.effective)}`);
  return bits.join(" · ");
}

function docSection(doc: EmbedDoc): string {
  const parts: string[] = [];
  parts.push(`<section class="sm-l-doc" id="${escapeHtml(doc.slug)}">`);
  parts.push(`<h2 class="sm-l-title">${escapeHtml(doc.title)}</h2>`);
  if (doc.current) {
    parts.push(`<p class="sm-l-meta" id="${escapeHtml(doc.current.anchor)}">${versionMeta(doc.current)}</p>`);
    parts.push(
      `<p class="sm-l-links"><a href="${escapeHtml(doc.current.href)}" target="_blank" rel="noreferrer noopener">Open full page</a></p>`,
    );
  }

  // The body is embedMarkdown's output: already HTML, already escaped by the
  // renderer, and carrying no raw HTML from the source. It is the ONE
  // interpolation here that is deliberately not re-escaped — escaping it
  // would print the tags.
  parts.push(doc.body);

  if (doc.history.length > 0) {
    const items = doc.history
      .map(
        (v) =>
          `<li id="${escapeHtml(v.anchor)}">${versionMeta(v)} · ` +
          `<a class="sm-l-a" href="${escapeHtml(v.href)}" target="_blank" rel="noreferrer noopener">Read v${v.version}</a></li>`,
      )
      .join("");
    parts.push(
      `<details class="sm-l-history"><summary>Version history (${doc.history.length})</summary>` +
        `<ul>${items}</ul></details>`,
    );
  }
  parts.push(`</section>`);
  return parts.join("");
}

/** Render a body's Markdown to the embed's HTML. */
export function renderEmbedBody(source: string): string {
  return markdownToEmbedHtml(source);
}

/** The complete frame document. */
export function embedDocumentHtml(input: EmbedDocumentInput): string {
  const sections = input.docs.map(docSection).join("");
  const intro =
    input.introParagraphs.length === 0
      ? ""
      : `<div class="sm-l-intro">${input.introParagraphs
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")}</div>`;
  const footer = input.footerLines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  const body =
    input.docs.length === 0
      ? `<p class="sm-l-empty">No agreements have been published yet.</p>`
      : sections;

  // theme="auto" renders NO attribute, so the prefers-color-scheme block in
  // the stylesheet decides and resolves before first paint. Writing
  // data-sm-embed-theme="auto" would match neither pinned selector and read
  // as a typo to the next person.
  const themeAttr = input.theme === "auto" ? "" : ` data-sm-embed-theme="${escapeHtml(input.theme)}"`;

  return `<!doctype html>
<html lang="en-US"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Legal agreements</title>
<style>${embedCss(input.accentColor)}</style>
</head>
<body>
<div class="sm-l-root">
<div class="sm-l-accent" aria-hidden="true"></div>
${intro}${body}
<footer class="sm-l-footer">${footer}
<p><a class="sm-l-a" href="${escapeHtml(input.indexHref)}" target="_blank" rel="noreferrer noopener">All agreements</a></p>
</footer>
</div>
<script>${embedScript({
    recordVisits: input.recordVisits ?? true,
    docSlugs: input.docs.map((d) => d.slug),
    theme: input.theme,
  })}</script>
</body>
</html>`;
}

/**
 * The embed-off body: a 200 with an empty document, NOT a 404 and not an
 * error page. The snippet is sitting on the MSP's live website; an embed an
 * operator switched off for an afternoon must leave a blank space there,
 * never a browser error frame with our app's name in it.
 */
export function embedDocumentOffHtml(): string {
  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title></title>
<style>html,body{margin:0;padding:0;background:transparent}</style></head>
<body><script>try{parent.postMessage({type:${JSON.stringify(EMBED_MSG_HEIGHT)},height:0},"*");}catch(e){}</script></body></html>`;
}
