import Link from "next/link";
import { prisma } from "@/lib/db";
import { parseVisitFilters, visitWhere } from "@/lib/visits/query";
import { requireOperator } from "@/lib/auth/page";

// Operator screen: the visitor log (SHA-2957) — list, filter by document and
// date, CSV export. Behind the operator gate (SHA-3047): the rows carry
// visitor IPs and user agents.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  await requireOperator("/visits");
  const filters = parseVisitFilters(params);
  const where = visitWhere(filters);

  const [visits, total, slugs] = await Promise.all([
    prisma.legalVisit.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: PAGE_SIZE,
    }),
    prisma.legalVisit.count({ where }),
    prisma.legalVisit.findMany({
      where: { slug: { not: null } },
      select: { slug: true },
      distinct: ["slug"],
    }),
  ]);

  const exportQs = new URLSearchParams();
  if (filters.slug) exportQs.set("slug", filters.slug);
  if (typeof params.from === "string") exportQs.set("from", params.from);
  if (typeof params.to === "string") exportQs.set("to", params.to);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-bold">Legal page visits</h1>
      <p className="mt-1 text-sm text-slate-500">
        {total} visit{total === 1 ? "" : "s"} match
        {total === 1 ? "es" : ""} · showing latest {Math.min(total, PAGE_SIZE)} ·{" "}
        <a className="text-blue-700" href={`/visits/export?${exportQs.toString()}`}>
          Export CSV
        </a>
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          Document
          <select name="slug" defaultValue={filters.slug ?? ""} className="ml-2 rounded border border-slate-300 p-1">
            <option value="">all</option>
            {slugs
              .map((s) => s.slug)
              .filter((s): s is string => s !== null)
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            name="from"
            defaultValue={typeof params.from === "string" ? params.from : ""}
            className="ml-2 rounded border border-slate-300 p-1"
          />
        </label>
        <label>
          To
          <input
            type="date"
            name="to"
            defaultValue={typeof params.to === "string" ? params.to : ""}
            className="ml-2 rounded border border-slate-300 p-1"
          />
        </label>
        <button type="submit" className="rounded bg-blue-700 px-3 py-1 text-white">
          Filter
        </button>
        <Link href="/visits" className="text-blue-700">
          Reset
        </Link>
      </form>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="p-2">When (UTC)</th>
              <th className="p-2">Path</th>
              <th className="p-2">Doc</th>
              <th className="p-2">Where</th>
              <th className="p-2">IP</th>
              <th className="p-2">Referrer</th>
              <th className="p-2">Secs</th>
              <th className="p-2">Embed</th>
            </tr>
          </thead>
          <tbody>
            {visits.map((v) => (
              <tr key={v.id} className="border-b border-slate-100">
                <td className="p-2 whitespace-nowrap">{v.occurredAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                <td className="p-2">{v.path}</td>
                <td className="p-2">
                  {v.slug ?? (v.docsJson !== "[]" ? JSON.parse(v.docsJson).join(", ") : "—")}
                  {v.version ? ` v${v.version}` : ""}
                </td>
                <td className="p-2">{[v.region, v.country].filter(Boolean).join(", ") || "—"}</td>
                <td className="p-2">{v.ip ?? (v.ipHash ? `${v.ipHash.slice(0, 12)}… (hashed)` : "—")}</td>
                <td className="p-2 max-w-60 truncate">{v.referer ?? "—"}</td>
                <td className="p-2">{v.secondsOnPage || "—"}</td>
                <td className="p-2">{v.embedded ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visits.length === 0 && <p className="mt-4 text-sm text-slate-500">No visits match.</p>}
      </div>
    </main>
  );
}
