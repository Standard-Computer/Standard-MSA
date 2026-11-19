// Email queue sweep (SHA-2958): GET /api/cron/email, guarded by CRON_SECRET
// like every /api/cron/* route (architecture § Request surfaces).

import { timingSafeEqual } from "node:crypto";
import { processEmailQueue } from "@/lib/email/queue";

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
  const result = await processEmailQueue();
  return Response.json(result);
}
