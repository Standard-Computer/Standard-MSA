// Outbound webhooks (SHA-2960): subscriptions, signing, queue, delivery.
//
// A PSA subscribes a URL and reacts to send lifecycle events without
// polling. Enqueueing is a ROW WRITE (safe inside the lifecycle
// transaction); the network happens later in deliverPendingWebhooks, driven
// by /api/cron/webhooks — the same queue-then-sweep shape as outbound email.
//
// Deliveries are signed (HMAC-SHA256 over `<timestamp>.<body>`) so the
// receiver can authenticate us, and the POST goes through the same
// vet-then-pin SSRF guard as every other URL this app dials: an operator
// typo — or a hostile value in a restored database — must not let the
// delivery loop poke loopback, the LAN, or a metadata endpoint.

import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { Prisma, Webhook } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isPrivateAddress } from "@/lib/identity/reachability";
import { apiBaseUrl, serializeSend, webhookEvents } from "./serializers";

type Db = Prisma.TransactionClient;

// ── Event vocabulary ────────────────────────────────────────────────────────

/** send.* mirrors SendEvent.type; document.published fires on API publishes. */
export const WEBHOOK_EVENT_TYPES = [
  "send.created",
  "send.sent",
  "send.delivered",
  "send.opened",
  "send.clicked",
  "send.viewed",
  "send.accepted",
  "send.declined",
  "send.bounced",
  "document.published",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(raw: unknown): raw is WebhookEventType {
  return typeof raw === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(raw);
}

// ── Subscriptions ───────────────────────────────────────────────────────────

export const WEBHOOK_SECRET_PREFIX = "whsec_";

export type CreatedWebhook = {
  /** Returned ONCE by the create call; needed to verify signatures. */
  secret: string;
  record: Webhook;
};

export async function createWebhook(url: string, events: WebhookEventType[]): Promise<CreatedWebhook> {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record = await prisma.webhook.create({
    data: { url, eventsJson: JSON.stringify(events), secret },
  });
  return { secret, record };
}

/** Creation-time URL gate: http(s) only, and a literal-IP host must be
 *  public. Hostnames are vetted again at every delivery (DNS can change). */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http(s)";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) {
    return "url points at a private or internal address";
  }
  return null;
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** `t=<unix>,v1=<hex hmac of "<unix>.<body>">` — verifiable, replay-datable. */
export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`, "utf8").digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

// ── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Queue `eventType` for every active subscription that wants it. Row writes
 * only — callable from inside the send lifecycle transaction.
 */
export async function enqueueWebhookEvent(
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
  db: Db = prisma,
): Promise<number> {
  const hooks = await db.webhook.findMany({ where: { active: true, revokedAt: null } });
  const matching = hooks.filter((h) => {
    const wanted = webhookEvents(h);
    return wanted.length === 0 || wanted.includes(eventType);
  });
  if (matching.length === 0) return 0;

  const body = JSON.stringify({ event: eventType, occurredAt: new Date().toISOString(), ...payload });
  for (const hook of matching) {
    await db.webhookDelivery.create({
      data: { webhookId: hook.id, eventType, payloadJson: body },
    });
  }
  return matching.length;
}

/**
 * The send-lifecycle hook `appendSendEvent` calls after writing an event:
 * loads the send's wire shape and queues `send.<type>`. Skips the read
 * entirely when nothing subscribes.
 */
export async function enqueueSendEventWebhooks(
  sendId: number,
  type: string,
  db: Db = prisma,
): Promise<void> {
  const eventType = `send.${type}`;
  if (!isWebhookEventType(eventType)) return;
  const anyHook = await db.webhook.findFirst({ where: { active: true, revokedAt: null } });
  if (!anyHook) return;

  const send = await db.send.findUnique({
    where: { id: sendId },
    include: {
      recipient: true,
      acceptance: true,
      documentVersion: { include: { document: true } },
    },
  });
  if (!send) return;
  await enqueueWebhookEvent(eventType, { send: serializeSend(send, apiBaseUrl()) }, db);
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Minutes before attempt N+1, after N failures. Exhausted past the end. */
export const WEBHOOK_BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720, 1440] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MINUTES.length + 1;

export function nextAttemptDelayMs(attemptsSoFar: number): number | null {
  const minutes = WEBHOOK_BACKOFF_MINUTES[attemptsSoFar - 1];
  return minutes === undefined ? null : minutes * 60_000;
}

export type WebhookPostResult = { ok: boolean; statusCode: number | null; error: string | null };

export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<WebhookPostResult>;

/** Vetted POST: resolve the host, refuse any private answer, pin the socket
 *  to the vetted address. Redirects are failures — a webhook endpoint that
 *  redirects is misconfigured, and following one would launder the vetting. */
export const defaultWebhookTransport: WebhookTransport = async (url, body, headers, timeoutMs) => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, statusCode: null, error: "invalid URL" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, statusCode: null, error: "not an http(s) URL" };
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dnsLookup(host, { all: true })).map((r) => r.address);
    } catch {
      return { ok: false, statusCode: null, error: "DNS failure" };
    }
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a))) {
    return { ok: false, statusCode: null, error: "resolves to a private or internal address" };
  }
  const pinned = addresses[0];
  const family = isIP(pinned);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned, family }]);
    } else {
      (callback as (err: Error | null, address: string, family: number) => void)(null, pinned, family);
    }
  };

  return new Promise((resolve) => {
    const https = target.protocol === "https:";
    const req = (https ? httpsRequest : httpRequest)(
      {
        hostname: host,
        port: target.port ? Number(target.port) : https ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body, "utf8") },
        timeout: timeoutMs,
        lookup: pinnedLookup,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(
          status >= 200 && status <= 299
            ? { ok: true, statusCode: status, error: null }
            : { ok: false, statusCode: status, error: `HTTP ${status}` },
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on("error", (err) => resolve({ ok: false, statusCode: null, error: err.message.slice(0, 200) }));
    req.write(body, "utf8");
    req.end();
  });
};

export type SweepResult = { attempted: number; delivered: number; failed: number; exhausted: number };

/**
 * Attempt every due pending delivery once. Per-delivery outcomes update the
 * row: success stamps deliveredAt, failure schedules the next attempt or
 * marks the row exhausted after WEBHOOK_MAX_ATTEMPTS.
 */
export async function deliverPendingWebhooks(
  transport: WebhookTransport = defaultWebhookTransport,
  now: Date = new Date(),
  timeoutMs = 10_000,
): Promise<SweepResult> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    include: { webhook: true },
    orderBy: { id: "asc" },
    take: 100,
  });

  const result: SweepResult = { attempted: 0, delivered: 0, failed: 0, exhausted: 0 };
  for (const delivery of due) {
    // A subscription revoked after enqueue voids its queue — nobody wants
    // deliveries from a hook they deleted.
    if (!delivery.webhook.active || delivery.webhook.revokedAt) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "exhausted", lastError: "webhook revoked" },
      });
      continue;
    }

    result.attempted += 1;
    const unix = Math.floor(now.getTime() / 1000);
    let post: WebhookPostResult;
    try {
      post = await transport(
        delivery.webhook.url,
        delivery.payloadJson,
        {
          "content-type": "application/json",
          "user-agent": "Standard-MSA webhooks",
          "x-standardmsa-event": delivery.eventType,
          "x-standardmsa-delivery": String(delivery.id),
          "x-standardmsa-signature": signWebhookBody(delivery.webhook.secret, delivery.payloadJson, unix),
        },
        timeoutMs,
      );
    } catch (err) {
      // The default transport resolves its failures, but a transport that
      // throws must cost only this delivery's attempt, not the sweep.
      post = {
        ok: false,
        statusCode: null,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    }

    const attempts = delivery.attempts + 1;
    if (post.ok) {
      result.delivered += 1;
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "delivered",
          attempts,
          deliveredAt: now,
          lastStatusCode: post.statusCode,
          lastError: null,
        },
      });
      continue;
    }

    const delayMs = attempts >= WEBHOOK_MAX_ATTEMPTS ? null : nextAttemptDelayMs(attempts);
    if (delayMs === null) result.exhausted += 1;
    else result.failed += 1;
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: delayMs === null ? "exhausted" : "pending",
        attempts,
        nextAttemptAt: delayMs === null ? delivery.nextAttemptAt : new Date(now.getTime() + delayMs),
        lastStatusCode: post.statusCode,
        lastError: post.error,
      },
    });
  }
  return result;
}
