import { EMBED_LOADER_JS } from "@/lib/legal/embedLoader";
import { legalSettings } from "@/lib/legal/settings";

// /legal/embed.js — the loader half of the white-label embed (SHA-2957).
//
// The snippet the operator pastes on the MSP's website:
//
//   <div id="sm-legal"></div>
//   <script src="https://{msa_host}/legal/embed.js" async></script>
//
// This file serves that script. Its entire job is to inject
// /legal/embed/frame as an iframe and talk to it — it renders no agreement
// text and carries no MSP data, which is what lets it be cached hard and
// served to anyone (a classic <script src> sends no Origin header, so it
// could not be origin-checked even if it were worth doing; see the note in
// src/lib/legal/embed.ts).
//
// PUBLIC and unauthenticated. The directory really is named "embed.js" — a
// dotted path segment — so the URL in the snippet is the URL this serves,
// with no rewrite in between.
export const dynamic = "force-dynamic";

export async function GET() {
  // Embed off => a valid, parseable, no-op script — NOT a 404 and NOT an
  // empty body with a JS content type, both of which put a red error in the
  // console of the MSP's website over a setting an operator flipped.
  const settings = await legalSettings();
  if (!settings.embedEnabled) {
    return script("/* Standard-MSA legal embed: not enabled. */\n");
  }
  return script(EMBED_LOADER_JS);
}

function script(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Longer than the frame's five minutes on purpose: this file is a
      // loader whose content changes only when WE deploy, while the frame
      // carries the agreements and has to follow a publish. Caching the
      // loader hard and the content lightly is what makes "cached + auto
      // updates on publish" true without a cache-buster in a snippet nobody
      // can re-paste.
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      // Any domain, no credentials. A classic <script src> needs no CORS at
      // all, so this is for the OTHER ways a host page can reach the loader —
      // a bundler fetching it, a CSP-strict site injecting it as text. `*`
      // is the only correct value: the response is identical for every
      // caller and carries no MSP data, and Access-Control-Allow-Credentials
      // is deliberately absent, which makes `*` legal and keeps cookies out
      // of the exchange.
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
