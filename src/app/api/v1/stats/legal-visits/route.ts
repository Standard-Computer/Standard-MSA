// /api/v1/stats/legal-visits (SHA-2960): the visitor-log numbers, filtered
// exactly like the /visits screen (same parseVisitFilters), aggregated in
// process — self-host scale, and SQLite groupBy would buy nothing portable.

import { apiHandler } from "@/lib/api/handler";
import { VisitStatsSchema } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";
import { parseVisitFilters, visitWhere } from "@/lib/visits/query";
import type { z } from "zod";

export const dynamic = "force-dynamic";

type VisitStats = z.infer<typeof VisitStatsSchema>;

export const GET = apiHandler(
  { scope: "stats:read", endpoint: "GET /stats/legal-visits" },
  async ({ req }) => {
    const url = new URL(req.url);
    const q = (name: string) => url.searchParams.get(name) ?? undefined;
    const filters = parseVisitFilters({ slug: q("slug"), from: q("from"), to: q("to") });
    const groupBy = q("groupBy") === "region" ? "region" : "day";

    const rows = await prisma.legalVisit.findMany({
      where: visitWhere(filters),
      select: { occurredAt: true, country: true, region: true, secondsOnPage: true, embedded: true },
      orderBy: { occurredAt: "asc" },
    });

    const buckets = new Map<string, { visits: number; seconds: number }>();
    const stats: VisitStats = { total: 0, totalSeconds: 0, embedded: 0, groups: [] };
    for (const row of rows) {
      stats.total += 1;
      stats.totalSeconds += row.secondsOnPage;
      if (row.embedded) stats.embedded += 1;
      const key =
        groupBy === "day"
          ? row.occurredAt.toISOString().slice(0, 10)
          : [row.country, row.region].filter(Boolean).join(" / ") || "unknown";
      const bucket = buckets.get(key) ?? { visits: 0, seconds: 0 };
      bucket.visits += 1;
      bucket.seconds += row.secondsOnPage;
      buckets.set(key, bucket);
    }
    stats.groups = [...buckets.entries()].map(([key, b]) => ({ key, ...b }));
    return { status: 200, body: stats };
  },
);
