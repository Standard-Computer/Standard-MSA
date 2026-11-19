// /api/v1/documents (SHA-2960): every document, drafts included — this is
// the operator's authenticated API, not the public /legal surface.

import { apiHandler } from "@/lib/api/handler";
import { serializeDocument } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "documents:read", endpoint: "GET /documents" },
  async () => {
    const docs = await prisma.legalDocument.findMany({
      orderBy: { id: "asc" },
      include: {
        versions: { where: { publishedAt: { not: null } }, orderBy: { version: "desc" }, take: 1 },
      },
    });
    return {
      status: 200,
      body: {
        documents: docs.map((d) => serializeDocument(d, d.versions[0]?.version ?? null)),
      },
    };
  },
);
