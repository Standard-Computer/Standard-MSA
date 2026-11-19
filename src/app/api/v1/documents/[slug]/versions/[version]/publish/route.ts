// /api/v1/documents/{slug}/versions/{version}/publish (SHA-2960).
//
// Publishing is naturally idempotent — a published version republishing is
// a no-op reported as `alreadyPublished` — and update notices stay OPT-IN
// per Sean's rule: they go only when the request explicitly asks, and a
// notice failure (email unconfigured, nobody stale) is reported in the
// body, never thrown, because the publish itself succeeded.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { PublishSchema } from "@/lib/api/schemas";
import { serializeDocument, serializeDocumentVersion } from "@/lib/api/serializers";
import { enqueueWebhookEvent } from "@/lib/api/webhooks";
import { prisma } from "@/lib/db";
import { sendUpdateNotice } from "@/lib/sends/notices";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  { scope: "documents:publish", endpoint: "POST /documents/{slug}/versions/{version}/publish" },
  async ({ params, json }) => {
    const body = PublishSchema.parse(json ?? {});
    const versionNumber = intPathParam(params.version, "document version");
    const doc = await prisma.legalDocument.findUnique({ where: { slug: params.slug ?? "" } });
    if (!doc) throw new ApiError("not_found", "No such document.");
    const version = await prisma.legalDocumentVersion.findUnique({
      where: { documentId_version: { documentId: doc.id, version: versionNumber } },
    });
    if (!version) throw new ApiError("not_found", "No such document version.");

    const alreadyPublished = version.publishedAt !== null;
    const published = alreadyPublished
      ? version
      : await prisma.legalDocumentVersion.update({
          where: { id: version.id },
          data: { publishedAt: new Date() },
        });
    if (!alreadyPublished) {
      await enqueueWebhookEvent("document.published", {
        document: { slug: doc.slug, title: doc.title, version: published.version },
      });
    }

    let notices: { ok: boolean; notified: number; skipped: number; error: string | null } | null =
      null;
    if (body.sendUpdateNotices) {
      const result = await sendUpdateNotice({
        documentId: doc.id,
        audience: body.audience ?? "all",
      });
      notices = result.ok
        ? { ok: true, notified: result.notified, skipped: result.skipped, error: null }
        : { ok: false, notified: 0, skipped: 0, error: result.error };
    }

    return {
      status: 200,
      body: {
        document: serializeDocument(doc, published.version),
        version: serializeDocumentVersion(published),
        alreadyPublished,
        notices,
      },
    };
  },
);
