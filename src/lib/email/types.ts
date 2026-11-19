// Email delivery contract (SHA-2958).
//
// `sendEmail()` in send.ts is the ONLY way any lane sends mail (architecture
// § Module boundaries). Everything here follows architecture principle 5:
// email failures are data, not exceptions — adapters return a result object
// and never throw for delivery problems.

/** What a caller hands to sendEmail(). */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Caller tag for the delivery log, e.g. "send", "notice", "test". */
  kind?: string;
  /** Caller reference stored on the outbound row, e.g. { sendId: 12 }. */
  ref?: Record<string, unknown>;
  /**
   * URLs to click-wrap for tracking. Each occurrence in the html body is
   * rewritten to /api/email/click/<outboundId>/<index>; the real targets are
   * stored on the outbound row, so no open-redirect surface exists.
   */
  trackLinks?: string[];
}

/** What an adapter actually transmits (already tracked/wrapped). */
export interface OutboundPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
}

export type AdapterSendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; permanent: boolean };

/** Normalised webhook/provider signal, written to EmailDeliveryEvent. */
export interface DeliveryEvent {
  /** Our per-send id, recovered from the provider's custom header/metadata. */
  outboundId?: string;
  /** Provider's own message id, fallback correlation key. */
  providerMessageId?: string;
  type: "delivered" | "bounced" | "complained" | "opened" | "clicked" | "failed";
  occurredAt?: Date;
  meta?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  webhooks: boolean;
  bounces: boolean;
  complaints: boolean;
  opens: boolean;
  clicks: boolean;
}

/** One adapter = one file under providers/. Adding a provider is one file plus one registry line. */
export interface EmailProvider {
  slug: string;
  label: string;
  capabilities: ProviderCapabilities;
  /** Transmit one message. Never throws for delivery failures. */
  send(payload: OutboundPayload, config: ResolvedEmailConfig): Promise<AdapterSendResult>;
  /**
   * Parse a provider webhook request body into normalised events.
   * Returns null when the request fails verification.
   */
  parseWebhook?(
    body: string,
    headers: Record<string, string>,
    config: ResolvedEmailConfig,
  ): DeliveryEvent[] | null;
}

/** Non-secret provider settings (DB/env). Secret VALUES never appear here. */
export interface ResolvedEmailConfig {
  provider: string;
  fromAddress: string;
  /** Secrets, read from env at send time. Never logged, never stored. */
  secrets: {
    smtp2goApiKey?: string;
    sendgridApiKey?: string;
    smtpPassword?: string;
    webhookSecret?: string;
    sendgridWebhookPublicKey?: string;
  };
  smtp: {
    host?: string;
    port: number;
    username?: string;
    secure: boolean;
  };
  baseUrl: string;
}

export type EmailConfigState =
  | { configured: true; config: ResolvedEmailConfig }
  | { configured: false; reason: string };

/** Result of sendEmail(): failures are data the caller stores, not exceptions. */
export type SendEmailResult =
  | { ok: true; outboundId: string }
  | { ok: false; outboundId?: string; error: string };

/** Header stamped on every outbound message; webhooks use it to correlate. */
export const OUTBOUND_ID_HEADER = "X-StandardMSA-Outbound-Id";
