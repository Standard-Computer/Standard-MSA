// Update-notice audience resolution (SHA-2959). PURE.
//
// Sean's rule for update notices is that the option is PRESENTED and never
// fires automatically. This file is the other half of that promise: once an
// operator has chosen, the audience is derived only from people this install
// has ALREADY sent this document to.
//
// Hence the intersection in the `selected` branch. A posted recipient id is
// request input; without the intersection, a crafted or stale form could
// mail an agreement update to somebody who never received the agreement.

export const NOTICE_AUDIENCES = ["all", "accepted", "selected"] as const;

export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

export function isNoticeAudience(raw: unknown): raw is NoticeAudience {
  return typeof raw === "string" && (NOTICE_AUDIENCES as readonly string[]).includes(raw);
}

export const NOTICE_AUDIENCE_LABELS: Record<NoticeAudience, string> = {
  all: "All prior recipients",
  accepted: "Only recipients who accepted",
  selected: "Selected recipients",
};

/** The slice of a prior send this decision needs. */
export type PriorSend = { recipientId: number; status: string };

/**
 * Recipient ids to notify. Always a subset of `priorSends`, de-duplicated
 * and ordered, so a recipient who received the document twice is mailed once.
 */
export function resolveAudience(
  audience: NoticeAudience,
  priorSends: readonly PriorSend[],
  selectedRecipientIds: readonly number[] = [],
): number[] {
  const eligible = new Set<number>();
  for (const send of priorSends) {
    if (audience === "accepted" && send.status !== "accepted") continue;
    eligible.add(send.recipientId);
  }
  if (audience !== "selected") return [...eligible].sort((a, b) => a - b);

  const chosen = new Set(selectedRecipientIds);
  return [...eligible].filter((id) => chosen.has(id)).sort((a, b) => a - b);
}

/** Checkbox ids off a form -> integer recipient ids, junk dropped. */
export function parseSelectedRecipientIds(raw: readonly string[]): number[] {
  const out = new Set<number>();
  for (const value of raw) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) out.add(id);
  }
  return [...out].sort((a, b) => a - b);
}

// ── Which documents have an update worth offering ───────────────────────────

/** One published document's current state, as the candidate scan needs it. */
export type DocumentHead = {
  documentId: number;
  slug: string;
  title: string;
  currentVersionId: number;
  currentVersion: number;
};

/** One send, as the candidate scan needs it. */
export type SendRow = PriorSend & { documentId: number; version: number };

export type NoticeCandidate = DocumentHead & {
  /**
   * The audience POOL: prior sends behind the current version, by recipients
   * who are not also on the current version. This is exactly what gets
   * handed to `resolveAudience` — one field rather than a raw list plus a
   * filter the caller has to remember, because a caller that forgot the
   * filter would mail "the terms changed" to someone already holding the new
   * terms.
   */
  pool: SendRow[];
  staleRecipients: number[];
  acceptedRecipients: number[];
};

/**
 * Documents where somebody holds an older version than the one now in force.
 *
 * This is the "offer, never fire" half of Sean's update-notice rule. Nothing
 * in the publish path calls it: it is a READ that an operator screen runs to
 * decide what to present. A candidate is a question for a human, not a queued
 * job — the only code that sends a notice is the explicit operator action.
 *
 * Recipients already on the current version are excluded: they have the new
 * terms, so telling them the terms changed would be wrong, not merely noisy.
 */
export function noticeCandidates(
  heads: readonly DocumentHead[],
  sends: readonly SendRow[],
): NoticeCandidate[] {
  const candidates: NoticeCandidate[] = [];
  for (const head of heads) {
    const mine = sends.filter((s) => s.documentId === head.documentId);
    const onCurrent = new Set(
      mine.filter((s) => s.version >= head.currentVersion).map((s) => s.recipientId),
    );
    const pool = mine.filter((s) => s.version < head.currentVersion && !onCurrent.has(s.recipientId));
    if (pool.length === 0) continue;

    const staleRecipients = [...new Set(pool.map((s) => s.recipientId))].sort((a, b) => a - b);
    const acceptedRecipients = [
      ...new Set(pool.filter((s) => s.status === "accepted").map((s) => s.recipientId)),
    ].sort((a, b) => a - b);

    candidates.push({ ...head, pool, staleRecipients, acceptedRecipients });
  }
  return candidates;
}
