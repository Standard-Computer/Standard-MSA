// Merge variables for legal bodies (SHA-2957 — the public-mode slice).
//
// Bodies are Markdown with {{variable}} placeholders. Three render modes
// exist in the architecture (docs/ARCHITECTURE.md § Data model): `blanks`,
// `public` and `filled`. This lane ships `public` — the ONLY mode the public
// /legal surface and the embed ever use, which is the guarantee that client
// data can never leak there: MSP-sourced variables fill from MspIdentity,
// recipient- and acceptance-sourced variables render neutral generic prose,
// and nothing on the public path can pass a recipient value in because
// nothing on it HAS one. SHA-2959 (sends) adds `filled` on top of this
// vocabulary without changing the public behaviour.
//
// The invariant the tests pin: NO raw {{token}} ever survives rendering. An
// unknown token renders as a labelled blank — visible and inert — because
// silently deleting words from an agreement is never ours to do, and leaking
// template syntax onto an MSP's website reads as broken.

export type RenderMode = "public";

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
 * Render a body for the public surface.
 *
 * Resolution order per token: MSP value → per-version default
 * (variablesJson) → generic public wording → labelled blank. The labelled
 * blank is `[unset: key]` — visible in a preview, obviously wrong in a way
 * an operator reports, and incapable of reading as agreed terms.
 */
export function renderLegalBody(
  body: string,
  _mode: RenderMode,
  msp: MspValues,
  versionDefaults: Record<string, string> = {},
): string {
  return body.replace(TOKEN_RE, (_m, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const fromMsp = mspTokenValue(key, msp);
    if (fromMsp) return fromMsp;
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
