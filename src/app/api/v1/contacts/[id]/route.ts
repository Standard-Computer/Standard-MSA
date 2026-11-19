// /api/v1/contacts/{id} (SHA-2960).

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { serializeContact } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "contacts:read", endpoint: "GET /contacts/{id}" },
  async ({ params }) => {
    const id = intPathParam(params.id, "contact");
    const row = await prisma.recipient.findUnique({ where: { id } });
    if (!row) throw new ApiError("not_found", "No such contact.");
    return { status: 200, body: serializeContact(row) };
  },
);
