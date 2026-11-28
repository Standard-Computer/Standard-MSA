// The citable public version ID (SHA-4708, GH #33 §6).
//
// PURE — no Prisma, no server-only, following ./variables.ts, because the
// publish path, the public pages and the tests all need the same formula and
// must never disagree about it.
//
// FORM: "{slug}-v{version}-{YYYYMMDD}", e.g. "msa-v2-20261101". It extends
// the embed's existing "{slug}-v{version}" anchor rather than inventing a
// second naming scheme, and it is unique by construction: LegalDocument.slug
// is unique and @@unique([documentId, version]) already holds, so the
// slug+version prefix alone identifies the row. The date is the citable part
// — "the MSA in force on 1 Nov 2026" is how a customer refers to an
// agreement — not part of what makes it unique.
//
// NOT the autoincrement `id`: that is not human-readable, and it renumbers
// across a fresh template database, so two installs would cite different IDs
// for the same agreement.
//
// WRITE-ONCE is enforced at the call site (markPublished) and by the unique
// constraint, not here: this module only computes. See the comment on
// LegalDocumentVersion.publicId in prisma/schema.prisma.

/**
 * The UTC calendar date as YYYYMMDD.
 *
 * UTC, not local: the ID is printed on a public page and cited back to us,
 * so it must not depend on the server's zone. A version published at
 * 23:30 US/Central is stamped with the following UTC day, and that is the
 * correct and stable answer — the alternative is an ID that changes meaning
 * when the install moves zone.
 *
 * `toISOString` is the UTC formatter: it always renders Z-time, which is why
 * slicing its first 10 characters is a UTC date and not a local one.
 */
export function publicVersionIdDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** "{slug}-v{version}-{YYYYMMDD}" from the UTC date of `date`. */
export function publicVersionId(slug: string, version: number, date: Date): string {
  return `${slug}-v${version}-${publicVersionIdDate(date)}`;
}
