// Document authoring (SHA-3086): the write half of the legal module.
//
// src/lib/legal/documents.ts is the read side and only ever sees published
// versions; this file is the only place documents and versions are CREATED
// or EDITED, shared by the /documents operator screens and the /api/v1
// authoring endpoints so the two surfaces cannot disagree on the rules
// (authoringRules.ts). The invariants:
//
//   - a slug is fixed at creation (it is a public URL),
//   - at most one open draft per document, enforced inside the same
//     transaction that inserts the next one,
//   - published versions are immutable: every edit path refuses a version
//     with publishedAt set,
//   - publishing here never sends anything — update notices stay opt-in on
//     their own screen (Sean's rule, src/lib/sends/notices.ts).
//
// No `server-only` marker, matching the other DB modules — the DB-backed
// tests import this under plain node.

import type { LegalDocument, LegalDocumentVersion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueWebhookEvent } from "@/lib/api/webhooks";
import {
  isValidDocumentSlug,
  nextVersionNumber,
  openDraft,
  serializeVersionDefaults,
  DOCUMENT_SLUG_RULE,
} from "./authoringRules";

/** Failures a caller renders to a human or maps to an API error code. */
export type AuthoringFailure =
  | { ok: false; reason: "invalid_input"; message: string }
  | { ok: false; reason: "conflict"; message: string }
  | { ok: false; reason: "not_found"; message: string };

export type CreateDocumentInput = {
  slug: string;
  title: string;
  kind: string;
};

export type CreateDocumentResult = { ok: true; document: LegalDocument } | AuthoringFailure;

export async function createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
  const slug = input.slug.trim();
  const title = input.title.trim();
  const kind = input.kind.trim() || "msa";
  if (!isValidDocumentSlug(slug)) {
    return { ok: false, reason: "invalid_input", message: DOCUMENT_SLUG_RULE };
  }
  if (title === "") {
    return { ok: false, reason: "invalid_input", message: "A title is required." };
  }
  const existing = await prisma.legalDocument.findUnique({ where: { slug } });
  if (existing) {
    return { ok: false, reason: "conflict", message: `A document with slug "${slug}" already exists.` };
  }
  const document = await prisma.legalDocument.create({ data: { slug, title, kind } });
  return { ok: true, document };
}

export type DraftInput = {
  bodyMarkdown: string;
  /** Editable defaults for {{tokens}}; stored as variablesJson. */
  variables?: Record<string, string>;
  changelog?: string | null;
};

export type CreateDraftResult =
  | {
      ok: true;
      /** The document with its versions AS OF BEFORE the insert. */
      document: LegalDocument & { versions: LegalDocumentVersion[] };
      version: LegalDocumentVersion;
    }
  | AuthoringFailure;

/**
 * Open the next draft version of a document.
 *
 * The one-open-draft check and the insert share a transaction: SQLite
 * serialises writers, so two concurrent creates cannot both pass the check
 * and leave two drafts behind.
 */
export async function createDraft(slug: string, input: DraftInput): Promise<CreateDraftResult> {
  if (input.bodyMarkdown.trim() === "") {
    return { ok: false, reason: "invalid_input", message: "A draft needs a body." };
  }
  return prisma.$transaction(async (tx) => {
    const document = await tx.legalDocument.findUnique({
      where: { slug },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!document) {
      return { ok: false as const, reason: "not_found" as const, message: "No such document." };
    }
    const draft = openDraft(document.versions);
    if (draft) {
      return {
        ok: false as const,
        reason: "conflict" as const,
        message: `"${document.title}" already has an open draft (v${draft.version}). Edit or publish that draft instead.`,
      };
    }
    const version = await tx.legalDocumentVersion.create({
      data: {
        documentId: document.id,
        version: nextVersionNumber(document.versions),
        bodyMarkdown: input.bodyMarkdown,
        variablesJson: serializeVersionDefaults(input.variables ?? {}),
        changelog: input.changelog?.trim() || null,
      },
    });
    return { ok: true as const, document, version };
  });
}

export type UpdateDraftResult = { ok: true; version: LegalDocumentVersion } | AuthoringFailure;

/** Re-save an open draft. Published versions are immutable — refused here. */
export async function updateDraft(versionId: number, input: DraftInput): Promise<UpdateDraftResult> {
  if (input.bodyMarkdown.trim() === "") {
    return { ok: false, reason: "invalid_input", message: "A draft needs a body." };
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.legalDocumentVersion.findUnique({ where: { id: versionId } });
    if (!existing) {
      return { ok: false as const, reason: "not_found" as const, message: "No such draft." };
    }
    if (existing.publishedAt !== null) {
      return {
        ok: false as const,
        reason: "conflict" as const,
        message: `v${existing.version} is published and immutable. Open a new draft to change the text.`,
      };
    }
    const version = await tx.legalDocumentVersion.update({
      where: { id: versionId },
      data: {
        bodyMarkdown: input.bodyMarkdown,
        variablesJson: serializeVersionDefaults(input.variables ?? {}),
        changelog: input.changelog?.trim() || null,
      },
    });
    return { ok: true as const, version };
  });
}

export type MarkPublishedResult = {
  version: LegalDocumentVersion;
  alreadyPublished: boolean;
};

/**
 * Publish a version: stamp publishedAt and emit the webhook event, once.
 * Idempotent — republishing is a reported no-op. Shared by the publish API
 * route and the operator publish action so "published" means one thing.
 * Sends NOTHING: update notices are a separate, explicit operator decision.
 */
export async function markPublished(
  doc: Pick<LegalDocument, "slug" | "title">,
  version: LegalDocumentVersion,
): Promise<MarkPublishedResult> {
  if (version.publishedAt !== null) {
    return { version, alreadyPublished: true };
  }
  const published = await prisma.legalDocumentVersion.update({
    where: { id: version.id },
    data: { publishedAt: new Date() },
  });
  await enqueueWebhookEvent("document.published", {
    document: { slug: doc.slug, title: doc.title, version: published.version },
  });
  return { version: published, alreadyPublished: false };
}
