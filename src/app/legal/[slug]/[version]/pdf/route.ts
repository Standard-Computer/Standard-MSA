// Download one specific PUBLISHED version as a PDF (SHA-4501).
//
// The download half of the history page: a customer who accepted v1 must be
// able to keep a copy of v1 after v2 ships, which is the whole reason the
// version pages exist. `publishedVersion` refuses a draft and an unknown
// version alike.

import { publishedVersion } from "@/lib/legal/documents";
import { requestOrigin } from "@/lib/http/requestOrigin";
import { documentVersionPdf, pdfResponse } from "@/lib/legal/pdfDocument";
import { recordPageVisit } from "@/lib/visits/record";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const { slug, version: versionRaw } = await ctx.params;
  // Digits only, and only then parsed. `Number.parseInt` alone accepts
  // "2abc" as 2, which would serve v2 from a URL that is not v2's — one
  // document reachable at unboundedly many paths, each of which a search
  // engine, a bookmark or a customer's email would then cite. The page this
  // mirrors is laxer; this route is not.
  if (!/^[0-9]{1,9}$/.test(versionRaw)) {
    return new Response("Not found", { status: 404 });
  }
  const version = Number.parseInt(versionRaw, 10);
  if (version < 1) return new Response("Not found", { status: 404 });

  const found = await publishedVersion(slug, version);
  if (found === null) return new Response("Not found", { status: 404 });
  const { doc, ver } = found;

  await recordPageVisit(`/legal/${doc.slug}/${ver.version}/pdf`, doc.slug, ver.version, req.headers);

  const download = await documentVersionPdf(doc, ver, {
    requestOrigin: requestOrigin(req),
  });
  return pdfResponse(download);
}
