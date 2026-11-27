// Operator PDF download for ANY version, drafts included (GH #22 / SHA-4505).
//
// This is the Documents screens' "download as the website will show it"
// action: it renders the same public-mode wording the /legal pages and the
// embed serve — generic client language, MSP identity filled — so the
// operator can see and save exactly what a visitor with no named client
// gets. Drafts are allowed HERE (and only here) because the operator owns
// them; the PDF itself carries a DRAFT marker and the filename says -draft.

import { guardOperatorRequest } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { agreementPdfResponse } from "@/lib/legal/pdfRoute";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  // Refused BEFORE the params are read: drafts are operator-only material
  // (SHA-3047 posture, same as the evidence download).
  const refusal = await guardOperatorRequest(req);
  if (refusal) return refusal;

  const { slug, version: versionRaw } = await ctx.params;
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isInteger(version) || version < 1) {
    return new Response("Not found", { status: 404 });
  }
  const doc = await prisma.legalDocument.findUnique({ where: { slug } });
  if (!doc) return new Response("Not found", { status: 404 });
  const ver = await prisma.legalDocumentVersion.findUnique({
    where: { documentId_version: { documentId: doc.id, version } },
  });
  if (!ver) return new Response("Not found", { status: 404 });
  return agreementPdfResponse(doc, ver);
}
