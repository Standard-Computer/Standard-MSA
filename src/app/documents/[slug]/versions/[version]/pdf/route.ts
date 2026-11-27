// The operator's own PDF download, for ANY version — draft included
// (SHA-4501).
//
// This is the "see and save the same text the website will show when there is
// no named client" half of the ask: it renders through the identical
// public-mode pipeline as /legal, so an operator can read the generic wording
// of a draft before it is published anywhere.
//
// Operator-only, refused as `status` rather than a redirect (it is a
// download, not a screen) — classified that way in src/lib/auth/surfaces.ts
// ahead of the `/documents/**` entry.
//
// A draft is reachable HERE and nowhere else. The public routes resolve
// versions through src/lib/legal/documents.ts, which never returns one.

import { guardOperatorRequest } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { requestOrigin } from "@/lib/http/requestOrigin";
import { documentVersionPdf, pdfResponse } from "@/lib/legal/pdfDocument";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  // Refused before the slug is read: a draft is unpublished text, and the
  // refusal must not differ between a document that exists and one that does
  // not.
  const refusal = await guardOperatorRequest(req);
  if (refusal) return refusal;

  const { slug, version: versionRaw } = await ctx.params;
  // Digits only — see the note in the public version route: "2abc" would
  // otherwise parse to 2 and serve a version from a path that is not its own.
  if (!/^[0-9]{1,9}$/.test(versionRaw)) {
    return new Response("Not found", { status: 404 });
  }
  const version = Number.parseInt(versionRaw, 10);
  if (version < 1) return new Response("Not found", { status: 404 });

  const doc = await prisma.legalDocument.findUnique({ where: { slug } });
  if (doc === null) return new Response("Not found", { status: 404 });
  const ver = await prisma.legalDocumentVersion.findUnique({
    where: { documentId_version: { documentId: doc.id, version } },
  });
  if (ver === null) return new Response("Not found", { status: 404 });

  const download = await documentVersionPdf(doc, ver, {
    requestOrigin: requestOrigin(req),
  });
  return pdfResponse(download);
}
