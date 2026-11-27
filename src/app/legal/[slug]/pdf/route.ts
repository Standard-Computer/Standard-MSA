// Download the CURRENT published version as a PDF (GH #22 / SHA-4505).
//
// Public by design, like the page it sits beside: a website visitor reading
// /legal/[slug] can save the agreement they are reading. Only published
// versions exist here — publishedDocument() never returns a draft — and the
// body renders in public mode, so no client name and no raw {{token}} can
// appear (see src/lib/legal/pdfRoute.ts).

import { publishedDocument } from "@/lib/legal/documents";
import { agreementPdfResponse } from "@/lib/legal/pdfRoute";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const published = await publishedDocument(slug);
  if (!published) return new Response("Not found", { status: 404 });
  return agreementPdfResponse(published.doc, published.current);
}
