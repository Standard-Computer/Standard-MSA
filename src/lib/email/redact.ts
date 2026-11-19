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

// Values worth masking while KEEPING the surrounding shape, so the delivery
// log still says what kind of thing was removed.
const MASKED_PATTERNS: readonly { readonly pattern: RegExp; readonly mask: string }[] = [
  // A send token inside an agreement link (SHA-3047). The token is the whole
  // authorisation to read and accept one agreement; the MSA email body
  // carries it verbatim, and an SMTP rejection routinely quotes the message
  // back at us — which would park it in EmailOutbound.lastError, which the
  // operator UI renders. Anchored on the /msa/ path so only our own links
  // match and ordinary base64-ish provider noise is left readable.
  { pattern: /(\/msa\/)[A-Za-z0-9_-]{22,64}/g, mask: `$1${REDACTED}` },
];

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
  for (const { pattern, mask } of MASKED_PATTERNS) {
    out = out.replace(pattern, mask);
  }
  return out;
}

/** Presence-only echo for the settings screen: never the value. */
export function describeSecret(value: string | undefined): string {
  if (!value) return "not set";
  return `set (${value.length} chars)`;
}
