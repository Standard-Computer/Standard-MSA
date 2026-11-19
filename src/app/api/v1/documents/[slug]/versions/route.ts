// /api/v1/documents/{slug}/versions (SHA-2960).

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { serializeDocumentVersion } from "@/lib/api/serializers";
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
