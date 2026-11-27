// Operator setup copy for Settings → Email (SHA-4509, GH #20 item 2).
//
// Pure data plus small functions, env-injected the same way
// resolveEmailConfig(env, db) is, so everything here unit-tests with a fake
// env — the suite only collects tests/**/*.test.ts, so operator copy inside
// a .tsx page would be untestable (the same reason the nav map lives in
// src/lib/nav/operatorNav.ts). page.tsx renders from this module and holds
// no hard-coded provider copy.
//
// This module NEVER reads a secret value: it deals exclusively in env var
// NAMES. Presence (set / not set) stays the page's job via describeSecret().

import { getProvider } from "./registry";

type Env = Record<string, string | undefined>;

export interface ProviderSetupGuide {
  slug: string;
  /**
   * The one secret env var this provider needs to send. For "smtp" this is
   * SMTP_PASSWORD even though resolveEmailConfig() refuses on a missing HOST
   * rather than a missing password — the password is used only when a
   * username is set and the server demands login, so a missing one fails at
   * send time, not at save time. `blockingNote` states that honestly.
   */
  requiredSecret: string;
  /** Whether this provider reads the SMTP host/port/username fieldset. */
  usesSmtpFields: boolean;
  /** Ordered operator steps from nothing to a delivered test email. */
  steps: readonly string[];
  /** What actually blocks a send, when it is not simply the secret. */
  blockingNote?: string;
}

const GUIDES: readonly ProviderSetupGuide[] = [
  {
    slug: "smtp2go",
    requiredSecret: "SMTP2GO_API_KEY",
    usesSmtpFields: false,
    steps: [
      "Pick SMTP2GO as the provider and fill a from-address on a domain you have verified with SMTP2GO.",
      "Set SMTP2GO_API_KEY in the environment (SMTP2GO console → Sending → API Keys). It is never stored in the database.",
      "Save settings, then send a test email below.",
    ],
  },
  {
    slug: "sendgrid",
    requiredSecret: "SENDGRID_API_KEY",
    usesSmtpFields: false,
    steps: [
      "Pick SendGrid as the provider and fill a from-address on a sender identity you have verified with SendGrid.",
      "Set SENDGRID_API_KEY in the environment (SendGrid console → Settings → API Keys, Mail Send permission). It is never stored in the database.",
      "Save settings, then send a test email below.",
    ],
  },
  {
    slug: "smtp",
    requiredSecret: "SMTP_PASSWORD",
    usesSmtpFields: true,
    steps: [
      "Pick SMTP as the provider.",
      "Fill Host, Port and Username below.",
      "Tick Implicit TLS only when your server uses it on port 465; leave it off for STARTTLS (the usual choice on port 587).",
      "Set SMTP_PASSWORD in the environment. The password is never stored in the database.",
      "Save settings, then send a test email below.",
    ],
    blockingNote:
      "A missing Host is what blocks sending. SMTP_PASSWORD is used only when a " +
      "Username is set and your server demands login, so a missing password " +
      "fails at send time with the server's own error, not at save time.",
  },
];

/** The setup guide for a registry slug, or undefined for an unknown one. */
export function setupGuideFor(slug: string): ProviderSetupGuide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** The required-secret env var NAME for a slug (never a value). */
export function requiredSecretFor(slug: string): string | undefined {
  return setupGuideFor(slug)?.requiredSecret;
}

/** Slugs this module carries copy for — tested 1:1 against the registry. */
export function setupGuideSlugs(): string[] {
  return GUIDES.map((g) => g.slug);
}

// ---------------------------------------------------------------------------
// Key-presence qualifiers (GH #20 failure (a)): which of the four displayed
// env vars the CURRENT provider actually needs, so `SMTP2GO_API_KEY  not set`
// stops reading as broken for an operator running generic SMTP.

export interface SecretPresenceRow {
  /** Env var NAME. The page looks presence up itself via describeSecret(). */
  envVar: string;
  /** Operator-facing qualifier rendered next to the presence. */
  note: string;
  /** True when the current provider cannot deliver without this variable. */
  requiredForCurrent: boolean;
}

export const WEBHOOK_SECRET_NOTE =
  "optional for every provider — gates webhook ingestion (bounces, complaints), not sending";

/**
 * The rows for the key-presence list, qualified for `currentSlug` (pass the
 * resolved provider; undefined when none is chosen yet).
 */
export function secretPresenceRows(currentSlug: string | undefined): SecretPresenceRow[] {
  const current = currentSlug ? setupGuideFor(currentSlug) : undefined;
  const rows: SecretPresenceRow[] = GUIDES.map((guide) => {
    if (current) {
      const required = guide.slug === current.slug;
      return {
        envVar: guide.requiredSecret,
        note: required
          ? `required for ${providerLabel(current.slug)}`
          : `not needed for ${providerLabel(current.slug)}`,
        requiredForCurrent: required,
      };
    }
    return {
      envVar: guide.requiredSecret,
      note: `required when the provider is ${providerLabel(guide.slug)}`,
      requiredForCurrent: false,
    };
  });
  rows.push({ envVar: "EMAIL_WEBHOOK_SECRET", note: WEBHOOK_SECRET_NOTE, requiredForCurrent: false });
  return rows;
}

function providerLabel(slug: string): string {
  return getProvider(slug)?.label ?? slug;
}

// ---------------------------------------------------------------------------
// Generic-SMTP fieldset copy (GH #20 failure (b)).

export const SMTP_FIELDSET_LEGEND = "Any SMTP server";

export const SMTP_FIELDSET_INTRO =
  "These fields speak plain SMTP, so they work with any mail server or relay " +
  "that gives you a host, port, username and password — Microsoft 365, Google " +
  "Workspace, Postfix, or a hosting provider's relay.";

export const SMTP_FIELDS_IGNORED_NOTE =
  "Ignored when the provider is SMTP2GO or SendGrid — those send through their own APIs.";

// ---------------------------------------------------------------------------
// Env-override honesty (GH #20 failure (c)): resolveEmailConfig() lets the
// environment win over the saved row, so a field pinned by env silently
// ignores what the operator saves. These predicates mirror config.ts's
// resolution EXACTLY — if config.ts changes, the matching test breaks.

export interface EnvPin {
  /** Form field name in page.tsx. */
  field: "provider" | "fromAddress" | "smtpHost" | "smtpPort" | "smtpUsername" | "smtpSecure";
  /** Operator-facing field label. */
  label: string;
  /** NAME of the env var doing the pinning. Never its value. */
  envVar: string;
}

const OVERRIDABLE: readonly (Omit<EnvPin, "envVar"> & {
  envVar: string;
  /** Does this env value actually win over the DB row in resolveEmailConfig()? */
  pins: (raw: string | undefined) => boolean;
})[] = [
  // env.EMAIL_PROVIDER?.trim() || db.provider
  { field: "provider", label: "Provider", envVar: "EMAIL_PROVIDER", pins: (raw) => !!raw?.trim() },
  // env.EMAIL_FROM?.trim() || db.fromAddress
  { field: "fromAddress", label: "From address", envVar: "EMAIL_FROM", pins: (raw) => !!raw?.trim() },
  // env.SMTP_HOST?.trim() || db.smtpHost
  { field: "smtpHost", label: "Host", envVar: "SMTP_HOST", pins: (raw) => !!raw?.trim() },
  // parsePort(env.SMTP_PORT) ?? db.smtpPort ?? 587 — an unparsable port does NOT win.
  { field: "smtpPort", label: "Port", envVar: "SMTP_PORT", pins: (raw) => isValidPort(raw) },
  // env.SMTP_USERNAME || db.smtpUsername
  { field: "smtpUsername", label: "Username", envVar: "SMTP_USERNAME", pins: (raw) => !!raw },
  // env.SMTP_SECURE !== undefined ? env.SMTP_SECURE === "true" : db — ANY set value wins, even "".
  { field: "smtpSecure", label: "Implicit TLS", envVar: "SMTP_SECURE", pins: (raw) => raw !== undefined },
];

/** Mirrors parsePort() in config.ts: trimmed, integer, 1–65535. */
function isValidPort(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/**
 * Which non-secret settings are currently pinned by the environment, and the
 * var NAME doing the pinning. Pass the real environment at the call site —
 * this module never reads it itself. The result carries no values, only
 * names and labels.
 */
export function envPinnedSettings(env: Env): EnvPin[] {
  return OVERRIDABLE.filter(({ envVar, pins }) => pins(env[envVar])).map(
    ({ field, label, envVar }) => ({ field, label, envVar }),
  );
}

/** The sentence the page renders under a pinned field. */
export function envPinNote(envVar: string): string {
  return `Set by ${envVar} in the environment — it overrides whatever is saved here.`;
}

// ---------------------------------------------------------------------------
// Empty state (GH #20 failure (d)).

export const GETTING_STARTED_TITLE = "Getting started";

export const GETTING_STARTED_STEPS: readonly string[] = [
  "Choose a provider below — SMTP2GO, SendGrid, or any SMTP server.",
  "Set that provider's one required key in the environment (the list above shows which, and whether it is set).",
  "Fill the from-address and save.",
  "Send a test email to prove delivery before anything relies on it.",
];
