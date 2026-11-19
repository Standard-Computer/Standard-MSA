// Open-tracking pixel (SHA-2958). Always returns the gif — a wrong id must
// not reveal whether an outbound id exists.

import { prisma } from "@/lib/db";
import { TRANSPARENT_GIF } from "@/lib/email/tracking";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const outbound = await prisma.emailOutbound.findUnique({ where: { id } });
  if (outbound) {
    await prisma.$transaction([
      prisma.emailDeliveryEvent.create({
        data: {
          outboundId: id,
          type: "opened",
          source: "pixel",
          metaJson: JSON.stringify({ userAgent: req.headers.get("user-agent") ?? undefined }),
        },
      }),
      ...(outbound.openedAt
        ? []
        : [prisma.emailOutbound.update({ where: { id }, data: { openedAt: new Date() } })]),
    ]);
  }
  return new Response(new Uint8Array(TRANSPARENT_GIF), {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
