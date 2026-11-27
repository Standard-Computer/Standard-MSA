// Download the CURRENT published version of one document as a PDF
// (SHA-4501).
//
// Public by design, like the page it mirrors: a visitor reading an MSP's
// agreement on /legal/[slug] can save the copy they read. `publishedDocument`
// is the only way in, so a draft has no public existence here any more than
// it does on the page.
//
// The static `pdf` segment wins over the sibling `[version]` route in Next's
// matcher, and `[version]` only ever accepted an integer anyway — see the
// version-scoped sibling at ./[version]/pdf for one historical version.

import { publishedDocument } from "@/lib/legal/documents";
import { documentVersionPdf, pdfResponse } from "@/lib/legal/pdfDocument";
import { recordPageVisit } from "@/lib/visits/record";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const published = await publishedDocument(slug);
  if (published === null) return new Response("Not found", { status: 404 });
  const { doc, current } = published;

  // A download of an agreement is a read of it, logged like the page read
  // (SHA-2957) so the visitor log does not go quiet when a reader saves the
  // file instead of scrolling it.
  await recordPageVisit(`/legal/${doc.slug}/pdf`, doc.slug, current.version, req.headers);

  const download = await documentVersionPdf(doc, current, {
    requestOrigin: new URL(req.url).origin,
  });
  return pdfResponse(download);
}
