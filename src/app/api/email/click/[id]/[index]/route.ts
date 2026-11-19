// Click-wrapped link redirect (SHA-2958). Targets come from the stored
// per-send link list, AND the route enforces absolute http(s) URLs below —
// trackLinks is a public field on EmailMessage, so the no-open-redirect
// guarantee must hold here, not in the callers.

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
  // Only absolute http(s) targets are redirectable: a javascript:/data:
  // scheme must never reach a Location header, and a relative target would
  // make Response.redirect throw a 500 at the recipient.
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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
