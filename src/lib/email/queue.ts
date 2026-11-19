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
// A row stuck in "sending" longer than this was stranded by a process death
// mid-attempt; the sweep re-queues it (see processEmailQueue).
export const STUCK_SENDING_AFTER_MS = 15 * 60 * 1000;

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
      // outbound.attempts (pre-increment) so the first failure waits
      // retryDelayMs(0) = 1m, matching the documented schedule.
      nextAttemptAt: exhausted ? undefined : new Date(Date.now() + retryDelayMs(outbound.attempts)),
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
 *
 * Delivery is at-least-once: the reaper below re-queues rows stranded in
 * "sending" by a process death mid-attempt, so a crash after the provider
 * accepted but before the status flip re-sends that message. For a
 * transactional mailer that is the right trade — the alternative is silent
 * permanent loss.
 */
export async function processEmailQueue(limit = 20): Promise<{ attempted: number; sent: number }> {
  const state = await getEmailConfig();
  if (!state.configured) return { attempted: 0, sent: 0 };

  // Reaper: nothing else ever selects status:"sending", so without this a
  // row stranded there (deploy, OOM, SIGTERM during a provider call) is
  // lost forever. updatedAt is @updatedAt, so the claim itself stamps it.
  await prisma.emailOutbound.updateMany({
    where: { status: "sending", updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_AFTER_MS) } },
    data: { status: "queued" },
  });

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
    try {
      const result = await attemptDelivery(outbound, state.config);
      if (result.sent) sent += 1;
    } catch (err) {
      // One throwing row (e.g. SQLITE_BUSY inside attemptDelivery) must not
      // abort the batch or strand this row in "sending".
      await prisma.emailOutbound.update({
        where: { id: outbound.id },
        data: { status: "queued", lastError: redactSecrets(`Sweep error: ${String(err)}`) },
      });
    }
  }
  return { attempted, sent };
}
