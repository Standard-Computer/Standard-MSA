// Webhook delivery sweep (SHA-2960): GET /api/cron/webhooks, guarded by
// CRON_SECRET like every /api/cron/* route. Attempts due deliveries with
// signed POSTs and schedules retries; see src/lib/api/webhooks.ts.

import { timingSafeEqual } from "node:crypto";
import { deliverPendingWebhooks } from "@/lib/api/webhooks";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not set; cron routes are disabled." }, { status: 503 });
  }
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const result = await deliverPendingWebhooks();
  return Response.json(result);
}
