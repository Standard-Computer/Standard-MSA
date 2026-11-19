import {
  EMBED_CONTAINER_ID,
  EMBED_MSG_HASH,
  EMBED_MSG_HEIGHT,
  EMBED_MSG_SCROLL,
  EMBED_MSG_STYLE,
} from "./embed";

// The embed LOADER, as a string (SHA-2957; ported from ShadowPSA STA-9323).
//
// Lifted out of the route so it can be EXERCISED: while it was a
// module-private const inside the route, the only way to reach it was an
// HTTP request to a running app — so the one piece of this lane that runs in
// a browser, on a third-party page, was also the one piece nothing could
// test. It is imported by tests/legal and by the frame-marker check the
// liveness monitor uses.
//
// Hand-written ES5-compatible JavaScript rather than a bundled module: it
// runs on an unknown website whose build pipeline, framework and browser
// support floor are all none of our business, and a 2KB script with no
// dependencies cannot break any of them. No cookies, no storage, and no
// network call of its own — the iframe does the fetching.

export const EMBED_LOADER_JS = `(function(){
  "use strict";
  var me = document.currentScript ||
    (function(){ var s=document.querySelectorAll('script[src*="/legal/embed.js"]'); return s[s.length-1]; })();
  if(!me) return;

  // The install's origin is derived from the script's OWN src, never
  // hardcoded and never read from the host page. That is what makes the
  // snippet portable: the host in the src is the only thing that differs
  // between installs.
  var origin;
  try { origin = new URL(me.src, location.href).origin; } catch(e) { return; }

  var container = document.getElementById(${JSON.stringify(EMBED_CONTAINER_ID)}) ||
    document.querySelector("[data-sm-legal]");
  // No container is not an error worth shouting about: a site builder that
  // reorders blocks can run the script before the div exists. Fall back to
  // inserting one where the script tag sits, which is where the author put it.
  if(!container){
    container = document.createElement("div");
    container.id = ${JSON.stringify(EMBED_CONTAINER_ID)};
    if(me.parentNode) me.parentNode.insertBefore(container, me);
  }
  if(container.getAttribute("data-sm-legal-ready")) return; // double-paste guard
  container.setAttribute("data-sm-legal-ready","1");

  var theme = me.getAttribute("data-theme") || "light";

  var src = origin + "/legal/embed/frame?theme=" + encodeURIComponent(theme);
  // Carry the HOST page's fragment into the frame. A fragment belongs to the
  // document that owns the URL, so the customer's "#msa" is not ours until
  // we copy it across — this is what makes deep links (#msa, #msa-v2)
  // survive through an iframe.
  if(location.hash) src += location.hash;

  var f = document.createElement("iframe");
  f.src = src;
  f.title = "Legal agreements";
  f.setAttribute("loading","lazy");
  f.setAttribute("scrolling","no");
  f.style.cssText = "width:100%;border:0;display:block;height:600px;overflow:hidden";
  container.appendChild(f);

  // THE FAILSAFE. Auto-height depends on postMessage surviving the host
  // page, and there are real environments where it does not — a CSP without
  // our origin in frame-src never loads the frame at all, an extension can
  // intercept the channel, and a very old browser may not fire it.
  //
  // Without this, every one of those failures renders a legal agreement
  // silently CLIPPED at 600px with scrolling off: the customer reads two
  // thirds of an MSA and has no way to reach the rest, and nothing looks
  // broken enough for anyone to report it. Three seconds of no height message
  // means the handshake is not coming, so hand scrolling back to the frame
  // and give it room. Ugly beats truncated when the content is a contract.
  var sized = false;
  setTimeout(function(){
    if(sized) return;
    f.setAttribute("scrolling","auto");
    f.style.height = "1400px";
    f.style.overflow = "auto";
  }, 3000);

  // A NO-OP until the frame's real document exists.
  //
  // A freshly created iframe's contentWindow is an initial about:blank that
  // inherits the HOST PAGE's origin, not ours. Posting to it with our origin
  // as targetOrigin therefore drops the message and puts a cross-origin
  // postMessage error in the console of somebody else's website. Dropping
  // the early sends costs nothing: the load handler below sends the style
  // again and re-forwards the hash, so the frame ends up with both.
  var loaded = false;
  function post(msg){
    if(!loaded) return;
    try { if(f.contentWindow) f.contentWindow.postMessage(msg, origin); } catch(e){}
  }

  // The font handshake — the half of "inherit host-page fonts" that an
  // iframe cannot get for free. Read the COMPUTED style off the container
  // (not off <body>), because that is the element the author placed in their
  // own layout and therefore the one carrying the typography they expect the
  // agreements to match.
  function sendStyle(){
    try {
      var cs = window.getComputedStyle(container);
      post({ type:${JSON.stringify(EMBED_MSG_STYLE)}, fontFamily: cs.fontFamily,
             fontSize: cs.fontSize, color: cs.color, theme: theme });
    } catch(e){}
  }

  window.addEventListener("message", function(e){
    // Origin-checked, and this is the one check that matters: the frame
    // posts to "*" (it cannot know the host), so the HOST has to be the side
    // that refuses messages from anywhere other than the install it actually
    // embedded. Without this, any other frame on the page could resize our
    // iframe or push a fragment at it.
    if(e.origin !== origin) return;
    var m = e.data;
    if(!m || !m.type) return;
    if(m.type === ${JSON.stringify(EMBED_MSG_HEIGHT)}){
      var h = Number(m.height);
      // Clamped. An unbounded height out of a message is how one bad render
      // turns into a 200,000px scrollbar on somebody's homepage.
      if(isFinite(h) && h >= 0 && h <= 50000){ sized = true; f.style.height = Math.max(h, 0) + "px"; }
      return;
    }
    if(m.type === ${JSON.stringify(EMBED_MSG_SCROLL)}){
      // A deep link inside the frame. The frame cannot scroll itself under
      // auto-height (it is exactly as tall as its content), so it tells us
      // HOW FAR DOWN its own document the target sits and we scroll the host
      // page — adding the iframe's own position in our layout, which is the
      // half only this side knows. See EMBED_MSG_SCROLL in lib/legal/embed.ts.
      var off = Number(m.offset);
      if(isFinite(off) && off >= 0 && off <= 50000){
        var box = f.getBoundingClientRect();
        // 16px of air, so a heading does not sit flush against the viewport
        // edge or under a host site's sticky header.
        var target = box.top + (window.scrollY || window.pageYOffset || 0) + off - 16;
        window.scrollTo({ top: Math.max(target, 0), behavior: "smooth" });
      }
      return;
    }
    if(m.type === ${JSON.stringify(EMBED_MSG_HASH)} && typeof m.hash === "string"){
      // Mirror the frame's deep link into the host URL so the customer can
      // copy the address bar and land back on the same clause. Shape-checked:
      // only "#word" is accepted, so nothing can drive the host page to
      // another URL through this channel.
      if(/^#[A-Za-z0-9_-]{1,64}$/.test(m.hash)){
        try { history.replaceState(null, "", m.hash); } catch(e){}
      }
      return;
    }
  });

  // The ONLY place "loaded" is set, and the only moment the frame's own
  // document is addressable at our origin. Everything the host wanted to tell
  // the frame before now is re-sent here. (No backticks in these comments:
  // this whole script is a template literal, and one would end it.)
  f.addEventListener("load", function(){
    loaded = true;
    sendStyle();
    // Any fragment the host picked up between f.src being built and the frame
    // finishing its load. jumpTo() on the frame side only ever moves scroll
    // position, so re-forwarding is idempotent.
    if(location.hash) post({ type:${JSON.stringify(EMBED_MSG_HASH)}, hash: location.hash });
  });
  window.addEventListener("hashchange", function(){
    if(location.hash) post({ type:${JSON.stringify(EMBED_MSG_HASH)}, hash: location.hash });
  });
  // Re-send the style if the host's own fonts load late (a webfont swap after
  // first paint is the normal case, not the edge case).
  if(document.fonts && document.fonts.ready && document.fonts.ready.then){
    document.fonts.ready.then(sendStyle).catch(function(){});
  }
  window.addEventListener("resize", sendStyle);
})();
`;
