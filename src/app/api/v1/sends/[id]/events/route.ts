// /api/v1/sends/{id}/events (SHA-2960): the full lifecycle log.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { intPathParam } from "@/lib/api/params";
import { serializeSendEvent } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "sends:read", endpoint: "GET /sends/{id}/events" },
  async ({ params }) => {
    const id = intPathParam(params.id, "send");
    const send = await prisma.send.findUnique({
      where: { id },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    if (!send) throw new ApiError("not_found", "No such send.");
    return {
      status: 200,
      body: { sendId: send.id, events: send.events.map(serializeSendEvent) },
    };
  },
);
