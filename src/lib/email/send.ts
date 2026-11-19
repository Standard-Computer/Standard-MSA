// sendEmail() — the ONE way any lane sends mail (architecture § Module
// boundaries). Creates the outbound row (delivery log), attempts immediate
// delivery, and leaves retryable failures for the queue sweep.

import { prisma } from "@/lib/db";
import { getEmailConfig } from "./config";
import { attemptDelivery } from "./queue";
import type { EmailMessage, SendEmailResult } from "./types";

export async function sendEmail(message: EmailMessage): Promise<SendEmailResult> {
  const state = await getEmailConfig();
  if (!state.configured) {
    // Failures are data (architecture principle 5): callers store this as
    // the skip reason; nothing is queued while unconfigured.
    return { ok: false, error: state.reason };
  }

  const outbound = await prisma.emailOutbound.create({
    data: {
      toAddress: message.to,
      subject: message.subject,
      bodyText: message.text,
      bodyHtml: message.html,
      kind: message.kind ?? "transactional",
      refJson: JSON.stringify(message.ref ?? {}),
      linksJson: JSON.stringify(message.trackLinks ?? []),
      status: "sending",
      events: { create: { type: "queued", source: "app" } },
    },
  });

  const result = await attemptDelivery(outbound, state.config);
  if (result.sent) return { ok: true, outboundId: outbound.id };

  const after = await prisma.emailOutbound.findUnique({ where: { id: outbound.id } });
  return {
    ok: false,
    outboundId: outbound.id,
    error: after?.lastError ?? "Send failed; see the delivery log.",
  };
}

/** Delivery log reader for other modules (sends, notices, settings UI). */
export async function getDeliveryLog(outboundId: string) {
  return prisma.emailOutbound.findUnique({
    where: { id: outboundId },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
}
