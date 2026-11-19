// /api/v1/sends/{id} (SHA-2960): current status.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { apiBaseUrl, serializeSend } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "sends:read", endpoint: "GET /sends/{id}" },
  async ({ req, params }) => {
    const id = intPathParam(params.id, "send");
    const send = await prisma.send.findUnique({
      where: { id },
      include: {
        recipient: true,
        acceptance: true,
        documentVersion: { include: { document: true } },
      },
    });
    if (!send) throw new ApiError("not_found", "No such send.");
    return { status: 200, body: serializeSend(send, apiBaseUrl(req)) };
  },
);
