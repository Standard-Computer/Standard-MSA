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

// ── Per-recipient stages ────────────────────────────────────────────────────
//
// The operator list needs a different question answered than `Send.status`
// answers. Status is "how far along is this one send", a single monotonic
// rung; the list has to say, per recipient, DID each thing happen and WHEN.
// Those are not the same shape, and the status column structurally cannot
// carry the second one: `clicked` and `viewed` fold onto `opened` above, so
// no value of `status` can ever read "clicked".
//
// So these stages are read off the append-only trail, exactly like the
// funnel is, and the status roll-up is left alone. A late bounce still
// cannot un-accept a signed agreement, and it also cannot erase the
// `accepted` cell — the trail keeps both facts and this shows both.

/**
 * Stages shown per recipient, in lifecycle order, with the label the
 * operator sees.
 *
 * `delivered` is labelled "Received" and `accepted` "Signed" because that is
 * how the people reading this screen describe them; the stored event names
 * do not change. `always` stages hold a column even when empty, so the
 * headline question ("did they sign it?") has a fixed place to look; the
 * rest appear only for a group that has them, which keeps the common table
 * narrow without hiding anything that happened.
 */
export const RECIPIENT_STAGES = [
  { type: "sent", label: "Sent", always: true },
  { type: "delivered", label: "Received", always: true },
  { type: "opened", label: "Opened", always: true },
  { type: "clicked", label: "Clicked", always: true },
  { type: "viewed", label: "Viewed", always: false },
  { type: "accepted", label: "Signed", always: true },
  { type: "declined", label: "Declined", always: false },
  { type: "bounced", label: "Bounced", always: false },
] as const satisfies readonly { type: SendEventType; label: string; always: boolean }[];

export type RecipientStage = (typeof RECIPIENT_STAGES)[number];

export type StageCell = {
  type: SendEventType;
  label: string;
  /** When this stage was FIRST reached, or null if it never was. */
  at: Date | null;
};

type TrailEvent = { type: string; occurredAt: Date };

/**
 * When each stage was first reached. FIRST, not last: three opens of the
 * same email are one "Opened", and the honest answer to when it was opened
 * is the first time, not whenever the pixel was last fetched. Computed as a
 * minimum rather than by taking the head of the list, so a caller that hands
 * over an unsorted trail still gets the right answer.
 */
export function stageTimes(events: readonly TrailEvent[]): Map<SendEventType, Date> {
  const first = new Map<SendEventType, Date>();
  for (const event of events) {
    if (!isSendEventType(event.type)) continue;
    const seen = first.get(event.type);
    if (!seen || event.occurredAt < seen) first.set(event.type, event.occurredAt);
  }
  return first;
}

/**
 * One recipient's stages in display order, every stage present whether or
 * not it happened — the caller decides which cells to render.
 *
 * `acceptedAt` is an optional second source for the Signed cell. The
 * acceptance record and the `accepted` event are written in one transaction,
 * so they agree; this reads the column too rather than letting a trail that
 * somehow lost its event report an accepted agreement as unsigned.
 */
export function recipientStages(
  events: readonly TrailEvent[],
  acceptedAt?: Date | null,
): StageCell[] {
  const first = stageTimes(events);
  return RECIPIENT_STAGES.map(({ type, label }) => {
    const at = first.get(type) ?? (type === "accepted" ? acceptedAt ?? null : null);
    return { type, label, at };
  });
}

/**
 * The stage columns a group of sends shows: the `always` ones, plus any
 * optional stage at least one of these sends actually reached.
 */
export function visibleStages(
  sends: readonly { events: readonly { type: string }[] }[],
): RecipientStage[] {
  const reached = new Set<string>();
  for (const send of sends) {
    for (const event of send.events) reached.add(event.type);
  }
  return RECIPIENT_STAGES.filter((stage) => stage.always || reached.has(stage.type));
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
