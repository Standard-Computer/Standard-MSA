// Merge variables for legal bodies (SHA-2957 public mode; SHA-2959 filled).
//
// Bodies are Markdown with {{variable}} placeholders. Three render modes
// exist in the architecture (docs/ARCHITECTURE.md § Data model): `blanks`,
// `public` and `filled`.
//
// `public` is the ONLY mode the public /legal surface and the embed ever
// use, which is the guarantee that client data can never leak there:
// MSP-sourced variables fill from MspIdentity, and recipient- and
// acceptance-sourced variables render neutral generic prose.
//
// `filled` (SHA-2959) is the per-recipient send. It adds no token NAMES — it
// supplies values for the ones public mode renders generically.
//
// That separation is structural, not a convention call sites must remember:
// `renderLegalBody` discards `recipientValues` outright unless the mode is
// `filled` (the single line that does it is below). So no public call site
// can leak a recipient value by passing one — not by mistake, and not if a
// later refactor threads the argument through everywhere.
//
// The invariant the tests pin: NO raw {{token}} ever survives rendering. An
// unknown token renders as a labelled blank — visible and inert — because
// silently deleting words from an agreement is never ours to do, and leaking
// template syntax onto an MSP's website reads as broken.

export type RenderMode = "public" | "filled";

/** MSP-sourced values, resolved from MspIdentity (+ settings) by the caller. */
export type MspValues = {
  mspName: string;
  mspLegalName: string | null;
  mspAddress: string | null;
  mspOwnerName: string | null;
  mspEmail: string | null;
  mspWebsite: string | null;
  venue: string | null;
};

/**
 * The public-mode wording for recipient/acceptance-sourced variables.
 * Generic on purpose: the public surface describes the offer to ANY client,
 * so "the Client" is the honest value, not a blank.
 */
const GENERIC_PUBLIC: Record<string, string> = {
  client_name: "the Client",
  client_legal_name: "the Client",
  client_company: "the Client",
  client_address: "the Client's address of record",
  client_email: "the Client's email address of record",
  client_phone: "the Client's phone number of record",
  signer_name: "the Client's authorized signatory",
  accepted_date: "the date of acceptance",
  effective_date: "the date of acceptance",
};

/** MSP-sourced token -> value, from resolved MspValues. Null/empty falls through. */
function mspTokenValue(key: string, msp: MspValues): string | null {
  switch (key) {
    case "msp_name":
      return msp.mspName || null;
    case "msp_legal_name":
      // The legal entity falls back to the trading name: an MSP that has not
      // filled the legal name in should read as itself, not as a blank.
      return msp.mspLegalName || msp.mspName || null;
    case "msp_address":
      return msp.mspAddress;
    case "msp_owner_name":
      return msp.mspOwnerName;
    case "msp_email":
      return msp.mspEmail;
    case "msp_website":
      return msp.mspWebsite;
    case "venue":
      return msp.venue;
    default:
      return null;
  }
}

const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * Render a body.
 *
 * Resolution order per token: MSP value → recipient value (`filled` only) →
 * per-version default (variablesJson) → generic public wording → labelled
 * blank. The labelled blank is `[unset: key]` — visible in a preview,
 * obviously wrong in a way an operator reports, and incapable of reading as
 * agreed terms.
 *
 * Recipient values beat version defaults on purpose: a version default for
 * a `client_*` token is a template placeholder the author wrote not knowing
 * who would receive it, and we now know.
 */
export function renderLegalBody(
  body: string,
  mode: RenderMode,
  msp: MspValues,
  versionDefaults: Record<string, string> = {},
  recipientValues: Record<string, string> = {},
): string {
  // The structural half of the public-mode guarantee: on any surface that is
  // not an individual send, recipient values do not exist from here on.
  const recipient = mode === "filled" ? recipientValues : {};
  return body.replace(TOKEN_RE, (_m, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const fromMsp = mspTokenValue(key, msp);
    if (fromMsp) return fromMsp;
    const fromRecipient = recipient[key];
    if (typeof fromRecipient === "string" && fromRecipient.trim() !== "") return fromRecipient;
    const fromDefaults = versionDefaults[key];
    if (typeof fromDefaults === "string" && fromDefaults.trim() !== "") return fromDefaults;
    const generic = GENERIC_PUBLIC[key];
    if (generic) return generic;
    return `[unset: ${key}]`;
  });
}

/** variablesJson (a JSON object of string defaults) → a safe record. */
export function parseVersionDefaults(variablesJson: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(variablesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Does any raw {{token}} survive? (Test + preview guard.) */
export function hasRawTokens(rendered: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(rendered);
}
