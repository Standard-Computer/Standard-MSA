import type { Prisma } from "@prisma/client";

// Shared filter parsing for the visits screen and its CSV export
// (SHA-2957): one interpretation of slug/from/to, so the export can never
// disagree with the list the operator is looking at.

export type VisitFilters = { slug: string | null; from: Date | null; to: Date | null };

export function parseVisitFilters(params: {
  slug?: string | string[];
  from?: string | string[];
  to?: string | string[];
}): VisitFilters {
  const one = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const day = (v: string | null, endOfDay: boolean): Date | null => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    slug: one(params.slug)?.slice(0, 80) ?? null,
    from: day(one(params.from), false),
    to: day(one(params.to), true),
  };
}

export function visitWhere(f: VisitFilters): Prisma.LegalVisitWhereInput {
  const where: Prisma.LegalVisitWhereInput = {};
  if (f.slug) where.slug = f.slug;
  if (f.from || f.to) {
    where.occurredAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lte: f.to } : {}),
    };
  }
  return where;
}

/** RFC 4180-ish CSV escaping; prefixed to defang spreadsheet formulas. */
export function csvCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);
  // A visitor-controlled value (referrer, UA) starting with = + - @ executes
  // as a formula in Excel; the leading quote keeps it text.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
