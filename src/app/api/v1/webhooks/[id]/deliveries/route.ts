// /api/v1/webhooks/{id}/deliveries (SHA-2960): recent delivery outcomes.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { serializeWebhookDelivery } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "webhooks:manage", endpoint: "GET /webhooks/{id}/deliveries" },
  async ({ params }) => {
    const id = intPathParam(params.id, "webhook");
    const row = await prisma.webhook.findUnique({ where: { id } });
    if (!row) throw new ApiError("not_found", "No such webhook.");
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { id: "desc" },
      take: 100,
    });
    return { status: 200, body: { deliveries: deliveries.map(serializeWebhookDelivery) } };
  },
);
