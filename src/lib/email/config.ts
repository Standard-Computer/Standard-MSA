// Email configuration resolution (SHA-2958).
//
// Secrets are env-only (architecture principle 3): the EmailProviderConfig
// row stores provider choice and non-secret settings, never a key value.
// Env wins over the DB row so a self-hoster can configure everything from
// the environment without touching the UI.

import { prisma } from "@/lib/db";
import type { EmailConfigState, ResolvedEmailConfig } from "./types";
import { getProvider, providerSlugs } from "./registry";

type Env = Record<string, string | undefined>;

interface DbEmailSettings {
  provider?: string;
  fromAddress?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpSecure?: boolean;
}

/**
 * Pure resolution from env + optional non-secret DB settings; unit-testable.
 * Returns an explicit unconfigured state with a human-usable reason — this
 * is what every send surface shows instead of silently doing nothing.
 */
export function resolveEmailConfig(env: Env, db: DbEmailSettings = {}): EmailConfigState {
  const provider = env.EMAIL_PROVIDER?.trim() || db.provider;
  if (!provider) {
    return {
      configured: false,
      reason:
        "No email provider configured. Set EMAIL_PROVIDER (smtp2go, sendgrid or smtp) " +
        "or pick a provider in Settings → Email.",
    };
  }
  if (!getProvider(provider)) {
    return {
      configured: false,
      reason: `Unknown email provider "${provider}". Supported: ${providerSlugs().join(", ")}.`,
    };
  }

  const fromAddress = env.EMAIL_FROM?.trim() || db.fromAddress;
  if (!fromAddress) {
    return {
      configured: false,
      reason: "No from-address configured. Set EMAIL_FROM or fill it in Settings → Email.",
    };
  }

  const config: ResolvedEmailConfig = {
    provider,
    fromAddress,
    secrets: {
      smtp2goApiKey: env.SMTP2GO_API_KEY || undefined,
      sendgridApiKey: env.SENDGRID_API_KEY || undefined,
      smtpPassword: env.SMTP_PASSWORD || undefined,
      webhookSecret: env.EMAIL_WEBHOOK_SECRET || undefined,
      sendgridWebhookPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY || undefined,
    },
    smtp: {
      host: env.SMTP_HOST?.trim() || db.smtpHost,
      port: parsePort(env.SMTP_PORT) ?? db.smtpPort ?? 587,
      username: env.SMTP_USERNAME || db.smtpUsername,
      secure: env.SMTP_SECURE !== undefined ? env.SMTP_SECURE === "true" : (db.smtpSecure ?? false),
    },
    baseUrl: (env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
  };

  // Per-provider required pieces, named precisely so misconfiguration fails
  // loudly with the fix — but never with a value.
  if (provider === "smtp2go" && !config.secrets.smtp2goApiKey) {
    return { configured: false, reason: "SMTP2GO selected but SMTP2GO_API_KEY is not set in the environment." };
  }
  if (provider === "sendgrid" && !config.secrets.sendgridApiKey) {
    return { configured: false, reason: "SendGrid selected but SENDGRID_API_KEY is not set in the environment." };
  }
  if (provider === "smtp" && !config.smtp.host) {
    return { configured: false, reason: "SMTP selected but no host is set. Set SMTP_HOST or fill it in Settings → Email." };
  }

  return { configured: true, config };
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** DB-backed wrapper: merges the active EmailProviderConfig row (non-secret). */
export async function getEmailConfig(): Promise<EmailConfigState> {
  const row = await prisma.emailProviderConfig.findFirst({
    where: { active: true },
    orderBy: { id: "desc" },
  });
  let db: DbEmailSettings = {};
  if (row) {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(row.settingsJson) as Record<string, unknown>;
    } catch {
      // Corrupt settings JSON: fall back to the row's scalar fields only.
    }
    db = {
      provider: row.provider,
      fromAddress: row.fromAddress,
      smtpHost: typeof settings.smtpHost === "string" ? settings.smtpHost : undefined,
      smtpPort: typeof settings.smtpPort === "number" ? settings.smtpPort : undefined,
      smtpUsername: typeof settings.smtpUsername === "string" ? settings.smtpUsername : undefined,
      smtpSecure: typeof settings.smtpSecure === "boolean" ? settings.smtpSecure : undefined,
    };
  }
  return resolveEmailConfig(process.env, db);
}
