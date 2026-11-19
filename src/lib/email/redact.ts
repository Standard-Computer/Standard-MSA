// Central redaction (SHA-2958). Every error path, settings echo and log line
// that could carry provider output goes through here, so a key value can
// never leak into the delivery log, the UI, or a thrown message.

// SMTP_USERNAME is deliberately absent: it is not a secret, and common
// values ("apikey" for SendGrid, "postmaster") would shred the very
// diagnostics the delivery log exists to keep.
const SECRET_ENV_VARS = [
  "SMTP2GO_API_KEY",
  "SENDGRID_API_KEY",
  "SMTP_PASSWORD",
  "EMAIL_WEBHOOK_SECRET",
  "CRON_SECRET",
] as const;

// Provider key shapes, caught even if the value reached us some way other
// than our own env (e.g. echoed back inside a provider error payload).
const SECRET_PATTERNS: RegExp[] = [
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid API key
  /api-[A-Za-z0-9]{24,}/g, // SMTP2GO API key
];

export const REDACTED = "[redacted]";

/** Replace any known secret value or secret-shaped substring with [redacted]. */
export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  let out = text;
  const values = [
    ...extraSecrets,
    ...SECRET_ENV_VARS.map((name) => process.env[name]),
  ].filter((v): v is string => typeof v === "string" && v.length >= 6);
  // Longest first so a value that contains another is fully removed.
  values.sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Presence-only echo for the settings screen: never the value. */
export function describeSecret(value: string | undefined): string {
  if (!value) return "not set";
  return `set (${value.length} chars)`;
}
