import "server-only";

import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { legalSettings } from "@/lib/legal/settings";
import { clientIpFrom, geoFromHeaders, hashIp } from "./visits";

/**
 * Server-side visit record for the direct (non-embedded) /legal pages
 * (SHA-2957). The embed frame uses the first-party beacon instead, which
 * additionally carries the read-timer; a plain page view records once at
 * render with no client script.
 */
export async function recordPageVisit(path: string, slug?: string, version?: number): Promise<void> {
  try {
    const h = await headers();
    const get = (name: string) => h.get(name);
    const settings = await legalSettings();
    const ip = clientIpFrom(get);
    const geo = geoFromHeaders(get);
    const salt = process.env.VISIT_IP_HASH_SALT || "standard-msa";
    await prisma.legalVisit.create({
      data: {
        path,
        slug: slug ?? null,
        version: version ?? null,
        embedded: false,
        userAgent: h.get("user-agent")?.slice(0, 400) ?? null,
        referer: h.get("referer")?.slice(0, 1000) ?? null,
        ip: settings.hashVisitorIps ? null : ip,
        ipHash: settings.hashVisitorIps && ip ? hashIp(ip, salt) : null,
        country: geo.country,
        region: geo.region,
      },
    });
  } catch {
    // A lost visit row is never worth a 500 on a public legal page.
  }
}
