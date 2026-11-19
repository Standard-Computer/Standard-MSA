// Generic SMTP adapter (SHA-2958) — nodemailer over any RFC 5321 server.
// One file per provider; registered in ../registry.ts.
//
// SMTP has no provider webhook, so this adapter declares no bounce/complaint
// capabilities and the UI reports degraded tracking honestly. Opens/clicks
// still work — they go through our own pixel and click routes, not the
// provider.

import nodemailer from "nodemailer";
import { redactSecrets } from "../redact";
import type {
  AdapterSendResult,
  EmailProvider,
  OutboundPayload,
  ResolvedEmailConfig,
} from "../types";

export const smtpProvider: EmailProvider = {
  slug: "smtp",
  label: "SMTP",
  capabilities: { webhooks: false, bounces: false, complaints: false, opens: true, clicks: true },

  async send(payload: OutboundPayload, config: ResolvedEmailConfig): Promise<AdapterSendResult> {
    if (!config.smtp.host) {
      return { ok: false, error: "SMTP selected but SMTP_HOST is not set.", permanent: true };
    }
    // Created inside the try: EmailProvider.send never throws, and a
    // createTransport error must go through redactSecrets like every other
    // path (the config it receives carries the SMTP password).
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    try {
      transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        ...(config.smtp.username
          ? { auth: { user: config.smtp.username, pass: config.secrets.smtpPassword ?? "" } }
          : {}),
      });
      const info = await transport.sendMail({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        headers: payload.headers,
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      return {
        ok: false,
        error: redactSecrets(`SMTP send failed: ${String(err)}`),
        // 5xx SMTP replies are permanent rejections; everything else
        // (connection refused, timeout, 4xx greylisting) is retryable.
        permanent: typeof code === "number" && code >= 500,
      };
    } finally {
      transport?.close();
    }
  },
};
