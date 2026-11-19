// Provider webhook ingestion (SHA-2958): normalise provider signals into the
// append-only EmailDeliveryEvent log and roll terminal states (bounce,
// complaint) onto the outbound row so other modules can read them.

import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getProvider } from "./registry";
import type { DeliveryEvent, ResolvedEmailConfig } from "./types";

export type WebhookIngestResult =
  | { ok: true; ingested: number }
  | { ok: false; status: number; error: string };

/**
 * Authenticity gate. At least one mechanism must be configured — an
 * unverifiable webhook endpoint is rejected loudly, never silently ingested:
 * - EMAIL_WEBHOOK_SECRET: shared secret the provider is given in the webhook
 *   URL (?key=...); compared constant-time. Works for every provider.
 * - SendGrid signed webhook: ECDSA signature verified in the adapter when
 *   SENDGRID_WEBHOOK_PUBLIC_KEY is set.
 */
export function isWebhookAuthorized(
  providerSlug: string,
  suppliedKey: string | null,
  config: ResolvedEmailConfig,
): boolean {
  const secret = config.secrets.webhookSecret;
  if (secret) {
    if (!suppliedKey) return false;
    const a = Buffer.from(suppliedKey);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // No shared secret: only a provider that verifies its own signature may pass.
  return providerSlug === "sendgrid" && Boolean(config.secrets.sendgridWebhookPublicKey);
}

export async function ingestWebhook(
  providerSlug: string,
  body: string,
  headers: Record<string, string>,
  config: ResolvedEmailConfig,
): Promise<WebhookIngestResult> {
  const provider = getProvider(providerSlug);
  if (!provider?.parseWebhook) {
    return { ok: false, status: 404, error: `No webhook support for provider "${providerSlug}".` };
  }
  const events = provider.parseWebhook(body, headers, config);
  if (events === null) {
    return { ok: false, status: 403, error: "Webhook payload failed verification or parsing." };
  }
  let ingested = 0;
  for (const event of events) {
    if (await recordEvent(event)) ingested += 1;
  }
  return { ok: true, ingested };
}

const TERMINAL_STATUS: Partial<Record<DeliveryEvent["type"], string>> = {
  bounced: "bounced",
  complained: "complained",
};

async function recordEvent(event: DeliveryEvent): Promise<boolean> {
  const outbound = event.outboundId
    ? await prisma.emailOutbound.findUnique({ where: { id: event.outboundId } })
    : event.providerMessageId
      ? await prisma.emailOutbound.findFirst({ where: { providerMessageId: event.providerMessageId } })
      : null;
  if (!outbound) return false; // signal for a message we did not send — drop

  await prisma.emailDeliveryEvent.create({
    data: {
      outboundId: outbound.id,
      type: event.type,
      source: "webhook",
      occurredAt: event.occurredAt ?? new Date(),
      metaJson: JSON.stringify(event.meta ?? {}),
    },
  });
  const status = TERMINAL_STATUS[event.type];
  if (status) {
    await prisma.emailOutbound.update({ where: { id: outbound.id }, data: { status } });
  }
  return true;
}
