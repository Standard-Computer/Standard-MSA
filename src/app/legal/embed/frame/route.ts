import type { NextRequest } from "next/server";
import { asEmbedTheme, frameAncestorsValue } from "@/lib/legal/embed";
import { embedData } from "@/lib/legal/embedData";
import { embedDocumentHtml, embedDocumentOffHtml } from "@/lib/legal/embedDocument";

// /legal/embed/frame — the ONE renderer behind both embed paths (SHA-2957).
//
// embed.js injects this URL as an iframe; the no-script fallback is the same
// URL pasted by hand. There is no second renderer, which is what makes the
// acceptance list testable once instead of twice — see the architecture note
// in src/lib/legal/embed.ts.
//
// PUBLIC and unauthenticated. It reads no cookie, writes no cookie, and runs
// no session read — see src/lib/legal/embedDocument.ts for why the document
// is assembled by hand rather than rendered as a page.
//
// force-dynamic: "cached + auto-updates on publish" is served by the
// Cache-Control below, not by Next's route cache. A statically cached frame
// would still be naming v3 after v4 went live, on somebody else's website,
// with no way for them to bust it.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const theme = asEmbedTheme(req.nextUrl.searchParams.get("theme"));

  // The request's own origin, not APP_BASE_URL. Every link in the frame is
  // followed from somebody else's page, so they have to point at the host
  // the visitor's browser actually reached us on — an install served behind
  // a hostname the env does not name would otherwise emit dead links.
  const base = req.nextUrl.origin;
  const data = await embedData(base);

  // The embed gate, as an EMPTY 200 rather than a 404. The snippet is on the
  // MSP's live website: an operator switching the embed off for an afternoon
  // must leave a blank space there, never a browser error frame with our app
  // name in it.
  if (!data.embedEnabled) {
    return offResponse();
  }

  const html = embedDocumentHtml({
    docs: data.docs,
    introParagraphs: data.introParagraphs,
    footerLines: data.footerLines,
    accentColor: data.accentColor,
    theme,
    indexHref: data.indexHref,
    recordVisits: true,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The embed's only real access control. `frame-ancestors` is where an
      // origin allow-list is actually enforceable for this content — see the
      // long note in src/lib/legal/embed.ts for why it is a passing-off
      // control rather than a confidentiality one, and why an empty list
      // correctly means "any".
      //
      // Deliberately NO X-Frame-Options: that header has no allow-list form,
      // so emitting it beside a frame-ancestors list would mean the
      // restrictive one wins everywhere and the embed never renders at all.
      //
      // In ShadowPSA this header silently never reached the wire for eleven
      // months: the app-wide headers() entry in next.config.ts matched
      // /:path*, and a Next config header REPLACES a route handler's header
      // of the same key. Our next.config.ts scopes the app-wide entry with
      // the regex derived in src/lib/legal/embedRoutes.ts, and
      // tests/legal/embedRoutes.test.ts pins the two to each other. If you
      // are ever debugging "the route sets the right header and the browser
      // disagrees", that asymmetry is the first thing to check, and
      // `curl -sI` against a real deploy is the only thing that can tell
      // you.
      "Content-Security-Policy": frameAncestorsValue(data.embedOrigins),
      "Access-Control-Allow-Origin": "*",
      // "Cached + auto-updates on publish". Five minutes is the trade: a
      // publish reaches every embedded page within one coffee break, and the
      // MSP's homepage does not hit us per visitor.
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      // Agreements are already indexed at /legal under this install's own
      // canonical URL. Letting a frame be indexed separately would compete
      // with it and surface a chrome-less fragment in search results.
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
    },
  });
}

function offResponse(): Response {
  return new Response(embedDocumentOffHtml(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // No frame-ancestors restriction on the empty document: there is
      // nothing in it to protect, and an embed-off frame that refuses to
      // load would surface a console error on the MSP's site instead of the
      // blank space the off state promises.
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
