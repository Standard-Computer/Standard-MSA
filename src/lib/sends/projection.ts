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
import { refNumber } from "@/lib/email/ref";
import { serializeByKey } from "@/lib/serialize";
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
  return refNumber(refJson, "sendId");
}

/** The EmailDeliveryEvent id a projected SendEvent came from, if it was one. */
export function projectedFrom(metaJson: string): number | null {
  return refNumber(metaJson, "deliveryEventId");
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
 * Idempotent across CONCURRENT calls too, which "check the trail, then
 * insert" is not on its own: two operator tabs loading the same send at once
 * both see an empty projection and both write it. There is no DB constraint
 * to lean on (an append-only event log has no natural unique key) and adding
 * one is a schema change, so the check and the writes share one critical
 * section per send — and the dedup set is read from the database inside it
 * rather than from the caller's snapshot.
 *
 * Returns how many events it appended, so a caller can decide to re-read.
 */
export async function projectDeliverySignals(send: SendWithTrail): Promise<number> {
  return serializeByKey(`send-projection:${send.id}`, () => projectUnguarded(send));
}

/**
 * Project for a whole list of sends — the operator list screen (SHA-4500),
 * which shows Received / Opened / Clicked per recipient and so needs the
 * same trail the detail screen needs.
 *
 * One query decides which of these sends have any outbound email at all, and
 * only those pay for a projection pass. That matters because the alternative
 * is three queries per row on a screen that renders every send: a fresh
 * install with twenty sends and no mail configured would do sixty pointless
 * round trips per page load, and here it does one.
 *
 * Sequential, not `Promise.all`: these are independent sends, so there is no
 * correctness reason to serialise them, but a list of a thousand sends
 * firing a thousand concurrent projections at once would exhaust the
 * connection pool — and the page is `force-dynamic`, so that is per request.
 *
 * Returns how many events were appended across all of them.
 */
export async function projectDeliverySignalsForSends(
  sends: readonly SendWithTrail[],
): Promise<number> {
  if (sends.length === 0) return 0;

  const outbounds = await prisma.emailOutbound.findMany({
    where: { toAddress: { in: sends.map((s) => s.recipient.email) }, kind: SEND_EMAIL_KIND },
    select: { refJson: true },
  });
  const withMail = new Set<number>();
  for (const outbound of outbounds) {
    const id = refSendId(outbound.refJson);
    if (id !== null) withMail.add(id);
  }

  let projected = 0;
  for (const send of sends) {
    if (!withMail.has(send.id)) continue;
    projected += await projectDeliverySignals(send);
  }
  return projected;
}

async function projectUnguarded(send: SendWithTrail): Promise<number> {
  const outbounds = await prisma.emailOutbound.findMany({
    where: { toAddress: send.recipient.email, kind: SEND_EMAIL_KIND },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
  const mine = outbounds.filter((o) => refSendId(o.refJson) === send.id);
  if (mine.length === 0) return 0;

  // Re-read rather than trusting `send.events`: the operator screens hand us
  // a send they loaded earlier in the request, and a snapshot taken before
  // another request's projection committed would re-project all of it.
  const trail = await prisma.sendEvent.findMany({
    where: { sendId: send.id },
    select: { metaJson: true },
  });
  const alreadyProjected = new Set<number>();
  for (const event of trail) {
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
