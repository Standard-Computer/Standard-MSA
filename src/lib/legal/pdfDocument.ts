import "server-only";

import type { LegalDocument, LegalDocumentVersion } from "@prisma/client";

import { prisma } from "@/lib/db";
import { mspValuesFrom } from "./embedAssemble";
import { markdownToPdfBlocks } from "./pdfBlocks";
import { pdfFilename, renderPdf } from "./pdfRender";
import { parseVersionDefaults, renderLegalBody } from "./variables";

// One version of one document as a downloadable PDF (SHA-4501).
//
// Every PDF surface goes through this function, and it takes NO render mode:
// it always renders in `public` mode. That is the point. A download has no
// recipient — not from /documents, not from /legal, not from the embed — so
// MSP identity fills and every client/signer token renders the generic
// wording from src/lib/legal/variables.ts, exactly as the public /legal page
// shows it. A recipient-filled PDF would be a different function with a
// different input (a send), and does not exist yet by design: there is no
// argument here that could carry a recipient value, so no call site can leak
// one by passing the wrong flag.
//
// Drafts are reachable only through the operator route, which passes one in
// explicitly. Public callers resolve versions through
// ./documents.ts, which never returns an unpublished one.

export interface PdfDownload {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

/** A version's `publishedAt` as the effective date the cover shows. */
function effectiveDate(version: LegalDocumentVersion): string | null {
  return version.publishedAt === null ? null : version.publishedAt.toISOString().slice(0, 10);
}

/**
 * Render one version as a PDF.
 *
 * `generatedAt` is the caller's clock, threaded through so the renderer stays
 * deterministic for tests. `requestOrigin` is the origin the download was
 * fetched from — the REQUEST's own ahead of APP_BASE_URL, for the reason
 * src/app/legal/embed/frame/route.ts gives: a self-hosted install is reached
 * on whatever hostname its operator chose, and a printed copy should cite the
 * one the reader used. Callers derive it with src/lib/http/requestOrigin.ts
 * rather than from `req.url` directly: behind a proxy `req.url` is the
 * container's bind address, which shipped a cover line citing
 * https://0.0.0.0:8080 on the Railway deploy. A null origin — nothing
 * reachable could be determined — cites nothing, per the note below.
 */
export async function documentVersionPdf(
  doc: Pick<LegalDocument, "slug" | "title">,
  version: Pick<LegalDocumentVersion, "version" | "bodyMarkdown" | "variablesJson" | "publishedAt">,
  options: { readonly generatedAt?: Date; readonly requestOrigin?: string | null } = {},
): Promise<PdfDownload> {
  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const msp = mspValuesFrom(identity);
  const draft = version.publishedAt === null;

  const rendered = renderLegalBody(
    version.bodyMarkdown,
    "public",
    msp,
    parseVersionDefaults(version.variablesJson),
  );
  const blocks = markdownToPdfBlocks(rendered);

  // The published path, so a printed copy says where to find the live text.
  // A draft gets none: the path it would name does not serve the draft, and
  // citing a URL that 404s is worse than citing nothing.
  const origin = options.requestOrigin?.replace(/\/+$/, "") ?? null;
  const sourceUrl =
    draft || origin === null || origin === "" ? null : `${origin}/legal/${doc.slug}/${version.version}`;

  const bytes = await renderPdf(blocks, {
    title: doc.title,
    version: version.version,
    effectiveDate: effectiveDate(version as LegalDocumentVersion),
    draft,
    mspName: identity?.name || null,
    sourceUrl,
    generatedAt: options.generatedAt ?? new Date(),
  });

  return { bytes, filename: pdfFilename(doc.slug, version.version, draft) };
}

/**
 * The response headers for a PDF download.
 *
 * `attachment` on every surface: clicking the link saves the file, which is
 * what Sean asked for, and it also means a crafted document body is never
 * rendered inline in the operator's or a visitor's browser.
 */
export function pdfHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    // The filename is built by pdfFilename() from a validated slug, so it
    // carries no quote, newline or non-ASCII byte that could split the
    // header.
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** A rendered PDF as a Response. */
export function pdfResponse(download: PdfDownload): Response {
  // Copied into a plain ArrayBuffer-backed view: pdf-lib's output is already
  // one, and `BodyInit` wants bytes rather than a Node Buffer view with an
  // offset into a pooled allocation.
  return new Response(new Uint8Array(download.bytes), { headers: pdfHeaders(download.filename) });
}
