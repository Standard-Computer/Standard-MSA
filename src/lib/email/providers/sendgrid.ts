// SendGrid adapter (SHA-2958) — v3 mail send API.
// One file per provider; registered in ../registry.ts.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { redactSecrets } from "../redact";
import type {
  AdapterSendResult,
  DeliveryEvent,
  EmailProvider,
  OutboundPayload,
  ResolvedEmailConfig,
} from "../types";

const API_URL = "https://api.sendgrid.com/v3/mail/send";

export const sendgridProvider: EmailProvider = {
  slug: "sendgrid",
  label: "SendGrid",
  capabilities: { webhooks: true, bounces: true, complaints: true, opens: true, clicks: true },

  async send(payload: OutboundPayload, config: ResolvedEmailConfig): Promise<AdapterSendResult> {
    const apiKey = config.secrets.sendgridApiKey;
    if (!apiKey) {
      return { ok: false, error: "SENDGRID_API_KEY is not set in the environment.", permanent: true };
    }
    const outboundId = payload.headers["X-StandardMSA-Outbound-Id"];
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [{ email: payload.to }],
              // custom_args come back verbatim on every webhook event —
              // this is how we correlate without trusting header echo.
              ...(outboundId ? { custom_args: { outbound_id: outboundId } } : {}),
            },
          ],
          from: { email: payload.from },
          subject: payload.subject,
          content: [
            { type: "text/plain", value: payload.text },
            ...(payload.html ? [{ type: "text/html", value: payload.html }] : []),
          ],
          headers: payload.headers,
        }),
      });
    } catch (err) {
      return { ok: false, error: redactSecrets(`SendGrid request failed: ${String(err)}`), permanent: false };
    }

    if (res.status === 202) {
      return { ok: true, providerMessageId: res.headers.get("x-message-id") ?? undefined };
    }
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { errors?: Array<{ message?: string }> };
      const first = body.errors?.[0]?.message;
      if (first) detail = `${detail}: ${first}`;
    } catch {
      // Keep the status-only detail.
    }
    return {
      ok: false,
      error: redactSecrets(`SendGrid rejected the send: ${detail}`),
      permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
    };
  },

  // SendGrid Event Webhook. When SENDGRID_WEBHOOK_PUBLIC_KEY is set we verify
  // the ECDSA signature (headers x-twilio-email-event-webhook-signature /
  // -timestamp); otherwise the route's shared-secret check is the gate.
  parseWebhook(
    body: string,
    headers: Record<string, string>,
    config: ResolvedEmailConfig,
  ): DeliveryEvent[] | null {
    const publicKeyB64 = config.secrets.sendgridWebhookPublicKey;
    if (publicKeyB64) {
      const signature = headers["x-twilio-email-event-webhook-signature"];
      const timestamp = headers["x-twilio-email-event-webhook-timestamp"];
      if (!signature || !timestamp) return null;
      if (!verifySignature(publicKeyB64, timestamp + body, signature)) return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out: DeliveryEvent[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const type = mapEventType(typeof e.event === "string" ? e.event : "");
      if (!type) continue;
      out.push({
        type,
        outboundId: typeof e.outbound_id === "string" ? e.outbound_id : undefined,
        providerMessageId: typeof e.sg_message_id === "string" ? e.sg_message_id.split(".")[0] : undefined,
        occurredAt: typeof e.timestamp === "number" ? new Date(e.timestamp * 1000) : undefined,
        meta: { provider: "sendgrid", event: e.event, reason: typeof e.reason === "string" ? e.reason : undefined },
      });
    }
    return out;
  },
};

function verifySignature(publicKeyB64: string, signedPayload: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      "sha256",
      Buffer.from(signedPayload),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

function mapEventType(event: string): DeliveryEvent["type"] | null {
  switch (event) {
    case "delivered":
      return "delivered";
    case "bounce":
    case "blocked":
    case "dropped":
      return "bounced";
    case "spamreport":
      return "complained";
    case "open":
      return "opened";
    case "click":
      return "clicked";
    default:
      return null;
  }
}
