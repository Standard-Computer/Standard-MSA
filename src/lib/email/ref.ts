// Caller references on EmailOutbound.refJson (SHA-3030 review follow-up). PURE.
//
// `sendEmail()` stores an arbitrary caller reference as JSON — {"sendId":12}
// for an agreement, {"updateNoticeId":4,"recipientId":9} for an update
// notice. Two lanes now read it back as a join key (the lifecycle projection
// and the notice ledger), so the defensive parse lives here once instead of
// being written out again per reader.
//
// Deliberately strict: a non-integer, a numeric string, or an unparseable
// blob is null rather than a coerced guess. These values decide which
// agreement an event belongs to and who has already been mailed, so a wrong
// join is worse than no join.

export function refNumber(refJson: string, key: string): number | null {
  try {
    const parsed: unknown = JSON.parse(refJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}
