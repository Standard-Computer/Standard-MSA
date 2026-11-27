import "server-only";

import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { legalSettings } from "@/lib/legal/settings";
import { visitIpSalt, visitorColumns } from "./visits";

/**
 * Server-side visit record for the direct (non-embedded) /legal pages
 * (SHA-2957). The embed frame uses the first-party beacon instead, which
 * additionally carries the read-timer; a plain page view records once at
 * render with no client script.
 *
 * `requestHeaders` is for callers that HAVE a Request — the PDF route
 * handlers (SHA-4501). Without it this reaches for next/headers, which
 * exists only inside a request scope, so the catch below swallows the throw
 * and the visit vanishes when a test calls the real handler directly. Same
 * split, and the same reason, as src/lib/auth/guard.ts (Request) against
 * src/lib/auth/page.ts (next/headers).
 */
export async function recordPageVisit(
  path: string,
  slug?: string,
  version?: number,
  requestHeaders?: Headers,
): Promise<void> {
  try {
    const h = requestHeaders ?? (await headers());
    const get = (name: string) => h.get(name);
    const settings = await legalSettings();
    await prisma.legalVisit.create({
      data: {
        path,
        slug: slug ?? null,
        version: version ?? null,
        embedded: false,
        // `occurredAt` is the row's @default(now()) — the timestamp half of
        // "track IPs and timestamps" is the database's, not ours to set.
        referer: h.get("referer")?.slice(0, 1000) ?? null,
        ...visitorColumns(get, settings.hashVisitorIps, visitIpSalt()),
      },
    });
  } catch {
    // A lost visit row is never worth a 500 on a public legal page.
  }
}
