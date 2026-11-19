import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { csvCell, parseVisitFilters, visitWhere } from "@/lib/visits/query";

// CSV export of the visitor log (SHA-2957), honouring the same filters as
// the /visits screen. Streamed in pages so a year of visits does not buy the
// whole table into memory.
export const dynamic = "force-dynamic";

const CHUNK = 1000;

export async function GET(req: NextRequest) {
  const filters = parseVisitFilters({
    slug: req.nextUrl.searchParams.get("slug") ?? undefined,
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
  });
  const where = visitWhere(filters);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          "occurredAtUtc,path,slug,version,docs,country,region,ip,ipHash,userAgent,referer,secondsOnPage,embedded,visitId\n",
        ),
      );
      let cursor: number | undefined;
      for (;;) {
        const rows = await prisma.legalVisit.findMany({
          where,
          orderBy: { id: "asc" },
          take: CHUNK,
          ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (rows.length === 0) break;
        for (const v of rows) {
          controller.enqueue(
            encoder.encode(
              [
                v.occurredAt.toISOString(),
                csvCell(v.path),
                csvCell(v.slug),
                csvCell(v.version),
                csvCell(v.docsJson !== "[]" ? v.docsJson : ""),
                csvCell(v.country),
                csvCell(v.region),
                csvCell(v.ip),
                csvCell(v.ipHash),
                csvCell(v.userAgent),
                csvCell(v.referer),
                String(v.secondsOnPage),
                v.embedded ? "yes" : "no",
                csvCell(v.visitId),
              ].join(",") + "\n",
            ),
          );
        }
        cursor = rows[rows.length - 1].id;
        if (rows.length < CHUNK) break;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="legal-visits.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
