// /api/v1/openapi.json (SHA-2960): the published spec, generated from the
// same zod schemas the handlers enforce. Unauthenticated by design — the
// spec describes a public product's public API and contains no instance
// data; an AI caller fetches it before it has a key.

import { buildOpenApiDocument } from "@/lib/api/openapi";
import { apiBaseUrl } from "@/lib/api/serializers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return Response.json(buildOpenApiDocument(apiBaseUrl(req)), {
    headers: { "Cache-Control": "no-store" },
  });
}
