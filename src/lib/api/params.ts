// Shared query/path parsing for /api/v1 routes (SHA-2960). PURE.

import { ApiError } from "./errors";

/** A positive-integer path segment, or a 404 — an id that cannot exist is
 *  indistinguishable from one that does not. */
export function intPathParam(raw: string | undefined, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError("not_found", `No such ${what}.`);
  }
  return n;
}

export type Page = { take: number; skip: number };

export function pageFrom(searchParams: URLSearchParams): Page {
  const limit = Number(searchParams.get("limit") ?? "");
  const offset = Number(searchParams.get("offset") ?? "");
  return {
    take: Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50,
    skip: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  };
}
