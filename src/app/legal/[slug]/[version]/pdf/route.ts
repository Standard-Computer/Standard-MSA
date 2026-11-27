// Download a specific PUBLISHED version as a PDF (GH #22 / SHA-4505).
//
// The PDF twin of /legal/[slug]/[version]: a customer who accepted v1 can
// still save v1 after v2 ships. Drafts stay invisible — publishedVersion()
// refuses them — and rendering is public-mode only (src/lib/legal/pdfRoute.ts).

import { publishedVersion } from "@/lib/legal/documents";
import { agreementPdfResponse } from "@/lib/legal/pdfRoute";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const { slug, version: versionRaw } = await ctx.params;
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isInteger(version) || version < 1) {
    return new Response("Not found", { status: 404 });
  }
  const found = await publishedVersion(slug, version);
  if (!found) return new Response("Not found", { status: 404 });
  return agreementPdfResponse(found.doc, found.ver);
}
