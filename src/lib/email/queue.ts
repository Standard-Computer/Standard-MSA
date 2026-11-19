// Outbound queue (SHA-2958): claim, attempt, retry with exponential backoff.

import { prisma } from "@/lib/db";
import type { EmailOutbound } from "@prisma/client";
import { getEmailConfig } from "./config";
import { getProvider } from "./registry";
import { redactSecrets } from "./redact";
import { appendOpenPixel, wrapLinks } from "./tracking";
import { OUTBOUND_ID_HEADER, type OutboundPayload, type ResolvedEmailConfig } from "./types";

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** Exponential backoff: 1m, 2m, 4m, 8m… capped at 6h. Pure, unit-tested. */
export function retryDelayMs(attemptsSoFar: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attemptsSoFar, MAX_DELAY_MS);
}

/** Build what the adapter transmits: tracked html, stamped correlation header. */
export function buildPayload(outbound: EmailOutbound, config: ResolvedEmailConfig): OutboundPayload {
  let html = outbound.bodyHtml ?? undefined;
  if (html) {
    let links: string[] = [];
    try {
      links = JSON.parse(outbound.linksJson) as string[];
    } catch {
      // Unreadable links list: send without click wrapping.
    }
    if (links.length > 0) html = wrapLinks(html, links, config.baseUrl, outbound.id);
    html = appendOpenPixel(html, config.baseUrl, outbound.id);
  }
  return {
    to: outbound.toAddress,
    from: config.fromAddress,
    subject: outbound.subject,
    text: outbound.bodyText,
    html,
    headers: { [OUTBOUND_ID_HEADER]: outbound.id },
  };
}

/**
 * Run one delivery attempt for a claimed outbound row and record the result.
 * Never throws for delivery problems; the row carries the (redacted) error.
 */
export async function attemptDelivery(
  outbound: EmailOutbound,
  config: ResolvedEmailConfig,
): Promise<{ sent: boolean }> {
  const provider = getProvider(config.provider);
  if (!provider) {
    await recordFailure(outbound, `Unknown provider "${config.provider}".`, true);
    return { sent: false };
  }
  const result = await provider.send(buildPayload(outbound, config), config);
  if (result.ok) {
    await prisma.emailOutbound.update({
      where: { id: outbound.id },
      data: {
        status: "sent",
        provider: provider.slug,
        providerMessageId: result.providerMessageId,
        attempts: { increment: 1 },
        lastError: null,
        events: {
          create: { type: "sent", source: "app", metaJson: JSON.stringify({ provider: provider.slug }) },
        },
      },
    });
    return { sent: true };
  }
  await recordFailure(outbound, result.error, result.permanent, provider.slug);
  return { sent: false };
}

async function recordFailure(
  outbound: EmailOutbound,
  error: string,
  permanent: boolean,
  providerSlug?: string,
): Promise<void> {
  const attempts = outbound.attempts + 1;
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
  const safeError = redactSecrets(error);
  await prisma.emailOutbound.update({
    where: { id: outbound.id },
    data: {
      status: exhausted ? "failed" : "queued",
      provider: providerSlug,
      attempts,
      lastError: safeError,
      nextAttemptAt: exhausted ? undefined : new Date(Date.now() + retryDelayMs(attempts)),
      events: {
        create: {
          type: "failed",
          source: "app",
          metaJson: JSON.stringify({ error: safeError, permanent, attempts, final: exhausted }),
        },
      },
    },
  });
}

/**
 * Process due queued messages (cron sweep). Claims each row by flipping
 * queued→sending so concurrent sweeps never double-send.
 */
export async function processEmailQueue(limit = 20): Promise<{ attempted: number; sent: number }> {
  const state = await getEmailConfig();
  if (!state.configured) return { attempted: 0, sent: 0 };

  const due = await prisma.emailOutbound.findMany({
    where: { status: "queued", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  let attempted = 0;
  let sent = 0;
  for (const outbound of due) {
    const claimed = await prisma.emailOutbound.updateMany({
      where: { id: outbound.id, status: "queued" },
      data: { status: "sending" },
    });
    if (claimed.count === 0) continue; // another sweep took it
    attempted += 1;
    const result = await attemptDelivery(outbound, state.config);
    if (result.sent) sent += 1;
  }
  return { attempted, sent };
}
