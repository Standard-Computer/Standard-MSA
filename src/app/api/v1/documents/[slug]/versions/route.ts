// /api/v1/documents/{slug}/versions (SHA-2960; POST added by SHA-3086).

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { DocumentVersionCreateSchema } from "@/lib/api/schemas";
import { serializeDocument, serializeDocumentVersion } from "@/lib/api/serializers";
import { createDraft } from "@/lib/legal/authoring";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "documents:read", endpoint: "GET /documents/{slug}/versions" },
  async ({ params }) => {
    const doc = await prisma.legalDocument.findUnique({
      where: { slug: params.slug ?? "" },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!doc) throw new ApiError("not_found", "No such document.");
    return { status: 200, body: { versions: doc.versions.map(serializeDocumentVersion) } };
  },
);

// SHA-3086: open the next draft version (API parity with the /documents
// editor). Drafts stay publicly invisible; publishing is its own endpoint.
export const POST = apiHandler(
  { scope: "documents:write", endpoint: "POST /documents/{slug}/versions", idempotent: true },
  async ({ params, json }) => {
    const body = DocumentVersionCreateSchema.parse(json ?? {});
    const result = await createDraft(params.slug ?? "", {
      bodyMarkdown: body.bodyMarkdown,
      variables: body.variables,
      changelog: body.changelog ?? null,
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new ApiError("not_found", result.message);
      if (result.reason === "conflict") throw new ApiError("conflict", result.message);
      throw new ApiError("validation_failed", result.message);
    }
    // currentVersion is still the highest PUBLISHED version — the new row
    // is a draft and must not read as in force.
    const currentVersion = result.document.versions
      .filter((v) => v.publishedAt !== null)
      .reduce<number | null>((max, v) => (max === null || v.version > max ? v.version : max), null);
    return {
      status: 201,
      body: {
        document: serializeDocument(result.document, currentVersion),
        version: serializeDocumentVersion(result.version),
      },
    };
  },
);
