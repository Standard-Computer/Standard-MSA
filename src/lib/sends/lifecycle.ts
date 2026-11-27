// Send lifecycle vocabulary and status roll-up (SHA-2959). PURE.
//
// SendEvent is append-only — it is acceptance evidence, so an event is never
// edited or deleted. Send.status is therefore a DERIVED cache of "furthest
// along this send has got", and the only legal move on it is forward.
//
// Monotonic ranks are what make that true. The alternative — "last event
// wins" — lets a provider's late bounce webhook for the notification email
// un-accept a signed agreement, which is a data-loss bug in the one table
// that exists to be evidence.

/** Every type that may appear in SendEvent.type (matches the schema comment). */
export const SEND_EVENT_TYPES = [
  "created",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "viewed",
  "accepted",
  "declined",
  "bounced",
] as const;

export type SendEventType = (typeof SEND_EVENT_TYPES)[number];

export function isSendEventType(raw: unknown): raw is SendEventType {
  return typeof raw === "string" && (SEND_EVENT_TYPES as readonly string[]).includes(raw);
}

/** Statuses Send.status may hold (matches the schema comment). */
export const SEND_STATUSES = [
  "created",
  "sent",
  "delivered",
  "opened",
  "bounced",
  "declined",
  "accepted",
] as const;

export type SendStatus = (typeof SEND_STATUSES)[number];

/**
 * How far along each status is. Terminal outcomes outrank delivery progress,
 * and `accepted` outranks everything: once an agreement is signed, no later
 * channel signal describes the send better than that.
 */
const STATUS_RANK: Record<SendStatus, number> = {
  created: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  bounced: 4,
  declined: 5,
  accepted: 6,
};

/**
 * The status an event implies. `clicked` and `viewed` map onto `opened`:
 * both are strictly stronger evidence of a human reading it, but the status
 * vocabulary has no rung between opened and the terminal outcomes, and
 * inventing one here would put a value in the column that no other reader
 * of this schema expects.
 */
const EVENT_STATUS: Record<SendEventType, SendStatus> = {
  created: "created",
  sent: "sent",
  delivered: "delivered",
  opened: "opened",
  clicked: "opened",
  viewed: "opened",
  accepted: "accepted",
  declined: "declined",
  bounced: "bounced",
};

export function statusForEvent(type: SendEventType): SendStatus {
  return EVENT_STATUS[type];
}

export function statusRank(status: string): number {
  return status in STATUS_RANK ? STATUS_RANK[status as SendStatus] : -1;
}

/**
 * The status after `type` lands on a send currently at `current`. Never goes
 * backwards; an unrecognised stored status is treated as behind everything,
 * so a hand-edited row heals on the next event instead of freezing.
 */
export function advanceStatus(current: string, type: SendEventType): SendStatus {
  const next = statusForEvent(type);
  return statusRank(next) > statusRank(current) ? next : (current as SendStatus);
}

/** The status implied by a whole event trail — the rebuild path for evidence. */
export function rollUpStatus(events: readonly { type: string }[]): SendStatus {
  let status: SendStatus = "created";
  for (const event of events) {
    if (isSendEventType(event.type)) status = advanceStatus(status, event.type);
  }
  return status;
}

// ── Funnel ──────────────────────────────────────────────────────────────────

/** Funnel stages, in display order. */
export const FUNNEL_STAGES = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "viewed",
  "accepted",
  "declined",
  "bounced",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type Funnel = Record<FunnelStage, number> & { total: number };

export function emptyFunnel(): Funnel {
  const funnel = { total: 0 } as Funnel;
  for (const stage of FUNNEL_STAGES) funnel[stage] = 0;
  return funnel;
}

/**
 * How many sends REACHED each stage — counted from the event trail, not from
 * the status column. A send that was opened and then accepted must count in
 * both rungs, which a status tally cannot express since a row holds one
 * status. Each stage is counted at most once per send, so three opens of the
 * same email are one opened send.
 */
export function funnelFor(sends: readonly { events: readonly { type: string }[] }[]): Funnel {
  const funnel = emptyFunnel();
  funnel.total = sends.length;
  for (const send of sends) {
    const reached = new Set<string>();
    for (const event of send.events) reached.add(event.type);
    for (const stage of FUNNEL_STAGES) {
      if (reached.has(stage)) funnel[stage] += 1;
    }
  }
  return funnel;
}

// ── Per-recipient trail columns (SHA-4504 / GH #21) ─────────────────────────
//
// The status column cannot show "clicked" — clicked and viewed fold onto
// opened above, on purpose. These helpers are the other read of the same
// append-only trail: WHEN each stage first happened, per recipient, derived
// on render and never stored, so the evidence rules and the monotonic
// roll-up stay untouched.

/** First time each event type occurred in a trail, or null when it never did. */
export type FirstEventTimes = Record<SendEventType, Date | null>;

/**
 * Earliest occurrence per event type. Scans for the minimum rather than
 * trusting trail order, so a provider webhook projected late with an earlier
 * `occurredAt` still reports the true first time.
 */
export function firstEventTimes(
  events: readonly { type: string; occurredAt: Date }[],
): FirstEventTimes {
  const first = {} as FirstEventTimes;
  for (const type of SEND_EVENT_TYPES) first[type] = null;
  for (const event of events) {
    if (!isSendEventType(event.type)) continue;
    const held = first[event.type];
    if (held === null || event.occurredAt < held) first[event.type] = event.occurredAt;
  }
  return first;
}

/**
 * The per-recipient timestamp columns on /sends, in display order. "Received"
 * is Sean's word for the `delivered` event and "Signed" for `accepted`; the
 * labels are UI vocabulary, the events are the schema's. Declined and bounced
 * are deliberately not columns — they are rare terminal outcomes, shown as a
 * compact per-recipient trail cell instead.
 */
export const RECIPIENT_COLUMNS = [
  { label: "Sent", event: "sent" },
  { label: "Received", event: "delivered" },
  { label: "Opened", event: "opened" },
  { label: "Clicked", event: "clicked" },
  { label: "Viewed", event: "viewed" },
  { label: "Signed", event: "accepted" },
] as const satisfies readonly { label: string; event: SendEventType }[];

/** Total read time across a send's `viewed` events, in seconds. */
export function readSeconds(events: readonly { type: string; metaJson: string }[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type !== "viewed") continue;
    try {
      const meta: unknown = JSON.parse(event.metaJson);
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const seconds = (meta as { seconds?: unknown }).seconds;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
          total += Math.floor(seconds);
        }
      }
    } catch {
      // A malformed meta blob costs this one event's contribution, nothing more.
    }
  }
  return total;
}
