// /api/v1/webhooks/{id} (SHA-2960): revoke.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { serializeWebhook } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  { scope: "webhooks:manage", endpoint: "DELETE /webhooks/{id}" },
  async ({ params }) => {
    const id = intPathParam(params.id, "webhook");
    const row = await prisma.webhook.findUnique({ where: { id } });
    if (!row) throw new ApiError("not_found", "No such webhook.");
    const revoked = row.revokedAt
      ? row
      : await prisma.webhook.update({
          where: { id },
          data: { active: false, revokedAt: new Date() },
        });
    return { status: 200, body: serializeWebhook(revoked) };
  },
);
