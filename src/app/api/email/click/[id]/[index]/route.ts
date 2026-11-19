// Click-wrapped link redirect (SHA-2958). Targets come ONLY from the stored
// per-send link list, so this can never be used as an open redirect.

import { prisma } from "@/lib/db";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const n = Number(index);
  const outbound = await prisma.emailOutbound.findUnique({ where: { id } });
  if (!outbound || !Number.isInteger(n) || n < 0) {
    return new Response("Not found", { status: 404 });
  }
  let links: string[] = [];
  try {
    links = JSON.parse(outbound.linksJson) as string[];
  } catch {
    // Unreadable list — treat as no links.
  }
  const target = links[n];
  if (typeof target !== "string") {
    return new Response("Not found", { status: 404 });
  }
  await prisma.emailDeliveryEvent.create({
    data: {
      outboundId: id,
      type: "clicked",
      source: "click",
      metaJson: JSON.stringify({ index: n, url: target }),
    },
  });
  return Response.redirect(target, 302);
}
