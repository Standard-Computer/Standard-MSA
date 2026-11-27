import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { legalSettings } from "@/lib/legal/settings";
import {
  clampPingSeconds,
  clampTotalSeconds,
  isValidVisitId,
  visitIpSalt,
  visitorColumns,
} from "@/lib/visits/visits";

// The visitor-log beacon (SHA-2957). First-party only: the embed frame is
// served from this install's origin, so this endpoint needs no CORS, reads
// no cookie and sets none. POST creates the visit row; PATCH accrues
// read-timer seconds onto it, server-clamped.
//
// Every response is 204 — including shape failures. This endpoint's caller
// is a beacon on a public page; an error body teaches nobody anything and a
// distinguishable failure mode invites probing.
export const dynamic = "force-dynamic";

const POST_SCHEMA = z.object({
  visitId: z.string(),
  docs: z.array(z.string().max(80)).max(20).optional(),
  theme: z.string().max(16).optional(),
  embedded: z.boolean().optional(),
  referrer: z.string().max(1000).optional(),
});

const PATCH_SCHEMA = z.object({
  visitId: z.string(),
  seconds: z.number(),
});

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = POST_SCHEMA.safeParse(await req.json());
  } catch {
    return noContent();
  }
  if (!parsed.success || !isValidVisitId(parsed.data.visitId)) return noContent();
  const body = parsed.data;

  const get = (name: string) => req.headers.get(name);
  const settings = await legalSettings();

  try {
    await prisma.legalVisit.create({
      data: {
        path: "/legal/embed/frame",
        visitId: body.visitId,
        embedded: body.embedded ?? true,
        theme: body.theme?.slice(0, 16) ?? null,
        docsJson: JSON.stringify((body.docs ?? []).slice(0, 20)),
        // The host page's URL, posted by our own frame — not this request's
        // Referer, which is the frame itself.
        referer: body.referrer?.slice(0, 1000) || null,
        // Raw IP or salted hash per the operator toggle, decided in one
        // place for this route and the direct page view alike.
        ...visitorColumns(get, settings.hashVisitorIps, visitIpSalt()),
      },
    });
  } catch {
    // Duplicate visitId (replayed beacon) or a closed db: a lost visit row
    // is never worth an error on a public page.
  }
  return noContent();
}

export async function PATCH(req: NextRequest) {
  let parsed;
  try {
    parsed = PATCH_SCHEMA.safeParse(await req.json());
  } catch {
    return noContent();
  }
  if (!parsed.success || !isValidVisitId(parsed.data.visitId)) return noContent();

  const add = clampPingSeconds(parsed.data.seconds);
  if (add <= 0) return noContent();

  try {
    const row = await prisma.legalVisit.findUnique({
      where: { visitId: parsed.data.visitId },
      select: { id: true, secondsOnPage: true },
    });
    if (row) {
      await prisma.legalVisit.update({
        where: { id: row.id },
        data: { secondsOnPage: clampTotalSeconds(row.secondsOnPage, add) },
      });
    }
  } catch {
    // Same posture as POST: a dropped ping costs one interval, nothing more.
  }
  return noContent();
}
