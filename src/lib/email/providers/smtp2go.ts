// SMTP2GO adapter (SHA-2958) — HTTP API, https://apidoc.smtp2go.com/
// One file per provider; registered in ../registry.ts.

import { redactSecrets } from "../redact";
import {
  OUTBOUND_ID_HEADER,
  type AdapterSendResult,
  type DeliveryEvent,
  type EmailProvider,
  type OutboundPayload,
  type ResolvedEmailConfig,
} from "../types";

const API_URL = "https://api.smtp2go.com/v3/email/send";

export const smtp2goProvider: EmailProvider = {
  slug: "smtp2go",
  label: "SMTP2GO",
  capabilities: { webhooks: true, bounces: true, complaints: true, opens: true, clicks: true },

  async send(payload: OutboundPayload, config: ResolvedEmailConfig): Promise<AdapterSendResult> {
    const apiKey = config.secrets.smtp2goApiKey;
    if (!apiKey) {
      return { ok: false, error: "SMTP2GO_API_KEY is not set in the environment.", permanent: true };
    }
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Smtp2go-Api-Key": apiKey,
        },
        body: JSON.stringify({
          sender: payload.from,
          to: [payload.to],
          subject: payload.subject,
          text_body: payload.text,
          ...(payload.html ? { html_body: payload.html } : {}),
          custom_headers: Object.entries(payload.headers).map(([header, value]) => ({
            header,
            value,
          })),
        }),
      });
    } catch (err) {
      return { ok: false, error: redactSecrets(`SMTP2GO request failed: ${String(err)}`), permanent: false };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response; fall through to status handling.
    }
    const data =
      body && typeof body === "object" && "data" in body
        ? ((body as { data: Record<string, unknown> }).data ?? {})
        : {};

    if (res.ok && typeof data.succeeded === "number" && data.succeeded > 0) {
      return {
        ok: true,
        providerMessageId: typeof data.email_id === "string" ? data.email_id : undefined,
      };
    }
    const detail =
      typeof data.error === "string"
        ? data.error
        : typeof data.error_code === "string"
          ? data.error_code
          : `HTTP ${res.status}`;
    return {
      ok: false,
      error: redactSecrets(`SMTP2GO rejected the send: ${detail}`),
      permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
    };
  },

  // SMTP2GO webhook events (configured in their dashboard to POST here).
  // Authenticity comes from the shared-secret check in the webhook route;
  // SMTP2GO does not sign payloads.
  parseWebhook(body: string): DeliveryEvent[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const out: DeliveryEvent[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const type = mapEventType(typeof e.event === "string" ? e.event : "");
      if (!type) continue;
      out.push({
        type,
        outboundId: headerFromEvent(e),
        providerMessageId: typeof e.email_id === "string" ? e.email_id : undefined,
        occurredAt: typeof e.time === "string" ? new Date(e.time) : undefined,
        meta: { provider: "smtp2go", event: e.event },
      });
    }
    return out;
  },
};

function mapEventType(event: string): DeliveryEvent["type"] | null {
  switch (event) {
    case "delivered":
      return "delivered";
    case "bounce":
    case "bounced":
    case "reject":
      return "bounced";
    case "spam":
    case "spam_complaint":
      return "complained";
    case "open":
      return "opened";
    case "click":
      return "clicked";
    default:
      return null;
  }
}

// Our outbound id travels as a custom header; SMTP2GO echoes message headers
// back on webhook events when configured to include them. Header names are
// case-insensitive (and transports re-case them), so match accordingly.
function headerFromEvent(e: Record<string, unknown>): string | undefined {
  const headers = e.headers;
  if (headers && typeof headers === "object") {
    const wanted = OUTBOUND_ID_HEADER.toLowerCase();
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() === wanted && typeof value === "string") return value;
    }
  }
  return undefined;
}
