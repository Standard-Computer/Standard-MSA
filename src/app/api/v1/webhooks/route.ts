// /api/v1/webhooks (SHA-2960): list and subscribe.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { WebhookCreateSchema } from "@/lib/api/schemas";
import { serializeWebhook } from "@/lib/api/serializers";
import { createWebhook, webhookUrlProblem } from "@/lib/api/webhooks";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "webhooks:manage", endpoint: "GET /webhooks" },
  async () => {
    const rows = await prisma.webhook.findMany({ orderBy: { id: "asc" } });
    return { status: 200, body: { webhooks: rows.map(serializeWebhook) } };
  },
);

export const POST = apiHandler(
  { scope: "webhooks:manage", endpoint: "POST /webhooks", idempotent: true },
  async ({ json }) => {
    const body = WebhookCreateSchema.parse(json ?? {});
    const problem = webhookUrlProblem(body.url);
    if (problem) {
      throw new ApiError("validation_failed", "That webhook URL cannot be used.", {
        details: [{ path: "url", message: problem }],
      });
    }
    const { secret, record } = await createWebhook(body.url, body.events ?? []);
    return { status: 201, body: { ...serializeWebhook(record), secret } };
  },
);
