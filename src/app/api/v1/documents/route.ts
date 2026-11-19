// /api/v1/documents (SHA-2960): every document, drafts included — this is
// the operator's authenticated API, not the public /legal surface.
// SHA-3086 adds POST: API parity with the /documents authoring screen,
// through the same src/lib/legal/authoring.ts rules.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { DocumentCreateSchema } from "@/lib/api/schemas";
import { serializeDocument } from "@/lib/api/serializers";
import { createDocument } from "@/lib/legal/authoring";
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

export const POST = apiHandler(
  { scope: "documents:write", endpoint: "POST /documents", idempotent: true },
  async ({ json }) => {
    const body = DocumentCreateSchema.parse(json ?? {});
    const result = await createDocument({
      slug: body.slug,
      title: body.title,
      kind: body.kind ?? "msa",
    });
    if (!result.ok) {
      if (result.reason === "conflict") throw new ApiError("conflict", result.message);
      throw new ApiError("validation_failed", result.message);
    }
    return { status: 201, body: serializeDocument(result.document, null) };
  },
);
