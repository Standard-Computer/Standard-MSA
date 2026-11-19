import "server-only";

import type { LegalDocument, LegalDocumentVersion } from "@prisma/client";
import { prisma } from "@/lib/db";

// Published-document reads for the public /legal surface and the embed
// (SHA-2957). One rule everything here enforces: ONLY published versions
// have a public existence. Drafts (publishedAt === null) are invisible to
// every public caller — the operator previews them elsewhere.

export type PublishedDocument = {
  doc: LegalDocument;
  /** Highest published version — what is "in force" and rendered in full. */
  current: LegalDocumentVersion;
  /** Older published versions, newest first. Listed, not rendered. */
  history: LegalDocumentVersion[];
};

/**
 * Every document with at least one published version, with its current
 * version and published history. Type-agnostic by principle 1: the MSA, the
 * HIPAA BAA and any type an MSP adds all come back from this one read —
 * never a hard-coded slug.
 */
export async function publishedDocuments(): Promise<PublishedDocument[]> {
  const docs = await prisma.legalDocument.findMany({
    orderBy: { id: "asc" },
    include: {
      versions: {
        where: { publishedAt: { not: null } },
        orderBy: { version: "desc" },
      },
    },
  });
  return docs
    .filter((d) => d.versions.length > 0)
    .map((d) => ({
      doc: d,
      current: d.versions[0],
      history: d.versions.slice(1),
    }));
}

/** One published document by slug, or null (drafts stay invisible). */
export async function publishedDocument(slug: string): Promise<PublishedDocument | null> {
  const all = await publishedDocuments();
  return all.find((p) => p.doc.slug === slug) ?? null;
}

/** A specific PUBLISHED version of a document, or null. */
export async function publishedVersion(
  slug: string,
  version: number,
): Promise<{ doc: LegalDocument; ver: LegalDocumentVersion } | null> {
  const doc = await prisma.legalDocument.findUnique({ where: { slug } });
  if (!doc) return null;
  const ver = await prisma.legalDocumentVersion.findUnique({
    where: { documentId_version: { documentId: doc.id, version } },
  });
  if (!ver || ver.publishedAt === null) return null;
  return { doc, ver };
}
