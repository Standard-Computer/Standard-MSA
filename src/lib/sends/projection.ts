// Email signals -> send lifecycle (SHA-2959).
//
// SHA-2958 already landed the whole outbound tracking channel: the open
// pixel, the click wrapper, provider webhooks, and `EmailDeliveryEvent` as
// an append-only log with replay dedup. This lane does NOT rebuild any of
// that. It projects those signals onto the send they belong to, so the
// operator funnel and the acceptance evidence read from one trail.
//
// The join is `EmailOutbound.refJson.sendId`, which `sendEmail()` already
// persists for us — no schema change, and the link survives a send whose
// first delivery attempt failed and was retried by the queue hours later.

import { prisma } from "@/lib/db";
import { SEND_EMAIL_KIND } from "./constants";
import type { SendEventType } from "./lifecycle";
import { appendSendEvent, type SendWithTrail } from "./sends";

/**
 * Delivery-event types that mean something in the SEND vocabulary.
 *
 * `queued`, `failed` and `complained` are deliberately absent. They are
 * facts about the email CHANNEL, not about the agreement's life, and the
 * send status column has no rung for them — inventing one would put values
 * in that column no other reader of this schema expects. They stay visible:
 * the send detail screen renders the outbound row's own status and last
 * error next to the trail, so nothing is hidden, only kept in its own log.
 */
const PROJECTED_TYPES: Record<string, SendEventType> = {
  sent: "sent",
  delivered: "delivered",
  opened: "opened",
  clicked: "clicked",
  bounced: "bounced",
};

/** `{"sendId":12}` -> 12. Anything else -> null. */
export function refSendId(refJson: string): number | null {
  try {
    const parsed: unknown = JSON.parse(refJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as { sendId?: unknown }).sendId;
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** The EmailDeliveryEvent id a projected SendEvent came from, if it was one. */
export function projectedFrom(metaJson: string): number | null {
  try {
    const parsed: unknown = JSON.parse(metaJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as { deliveryEventId?: unknown }).deliveryEventId;
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function metaRecord(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Project every not-yet-projected delivery signal for one send.
 *
 * IDEMPOTENT, which is the whole design constraint: this runs on every
 * operator page load, so it must be safe to call a hundred times. Each
 * projected SendEvent carries its source `deliveryEventId` in meta, and that
 * is the dedup key — not a timestamp or a type, both of which legitimately
 * repeat (a recipient opening the same email three times is three opens).
 *
 * Returns how many events it appended, so a caller can decide to re-read.
 */
export async function projectDeliverySignals(send: SendWithTrail): Promise<number> {
  const outbounds = await prisma.emailOutbound.findMany({
    where: { toAddress: send.recipient.email, kind: SEND_EMAIL_KIND },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
  const mine = outbounds.filter((o) => refSendId(o.refJson) === send.id);
  if (mine.length === 0) return 0;

  const alreadyProjected = new Set<number>();
  for (const event of send.events) {
    const id = projectedFrom(event.metaJson);
    if (id !== null) alreadyProjected.add(id);
  }

  let projected = 0;
  for (const outbound of mine) {
    for (const event of outbound.events) {
      const type = PROJECTED_TYPES[event.type];
      if (!type || alreadyProjected.has(event.id)) continue;
      const meta = metaRecord(event.metaJson);
      const userAgent = typeof meta.userAgent === "string" ? meta.userAgent : null;
      await appendSendEvent(send.id, {
        type,
        occurredAt: event.occurredAt,
        userAgent,
        meta: {
          ...meta,
          deliveryEventId: event.id,
          outboundId: outbound.id,
          deliverySource: event.source,
        },
      });
      alreadyProjected.add(event.id);
      projected += 1;
    }
  }
  return projected;
}

/** The outbound rows behind one send — the delivery log the detail screen shows. */
export async function outboundsForSend(send: SendWithTrail) {
  const outbounds = await prisma.emailOutbound.findMany({
    where: { toAddress: send.recipient.email },
    orderBy: { createdAt: "desc" },
  });
  return outbounds.filter((o) => refSendId(o.refJson) === send.id);
}
