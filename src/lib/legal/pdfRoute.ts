import "server-only";

import type { LegalDocument, LegalDocumentVersion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { mspValuesFrom } from "./embedAssemble";
import { parseVersionDefaults, renderLegalBody } from "./variables";
import { agreementPdfFilename, renderAgreementPdf } from "./pdf";

// The shared half of every PDF route handler (GH #22 / SHA-4505).
//
// One function serves all three download surfaces — the public /legal pages
// and the operator Documents screens — and it renders in "public" mode
// unconditionally. That is deliberate, not a default: every surface this
// serves is a no-known-client surface, so MSP identity fills from
// MspIdentity and client/signer tokens render the generic wording
// (variables.ts GENERIC_PUBLIC). No recipient value is read anywhere in
// this file, so none can leak into a download. A later per-recipient send
// PDF is a different call site rendering "filled" through the same
// renderer — not a mode switch here.

/** The version's agreement, rendered public-mode, as a PDF file response. */
export async function agreementPdfResponse(
  doc: LegalDocument,
  ver: LegalDocumentVersion,
): Promise<Response> {
  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const msp = mspValuesFrom(identity);
  const rendered = renderLegalBody(
    ver.bodyMarkdown,
    "public",
    msp,
    parseVersionDefaults(ver.variablesJson),
  );
  const draft = ver.publishedAt === null;
  const bytes = await renderAgreementPdf(
    {
      title: doc.title,
      version: ver.version,
      effectiveDate: ver.publishedAt ? ver.publishedAt.toISOString().slice(0, 10) : null,
      draft,
    },
    rendered,
  );
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      // Slugs are locked to lowercase-kebab (authoringRules.ts), so the
      // filename needs no quoting beyond the quotes themselves.
      "Content-Disposition": `attachment; filename="${agreementPdfFilename(doc.slug, ver.version, draft)}"`,
      "Cache-Control": "no-store",
    },
  });
}
