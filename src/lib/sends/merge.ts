// Recipient details -> document merge variables (SHA-2959). PURE.
//
// The vocabulary is the `client_*` / `signer_name` / `*_date` half of the
// token set already understood by src/lib/legal/variables.ts — this lane adds
// no new token names, it supplies VALUES for the ones the public surface
// renders generically.
//
// Empty values are OMITTED rather than written as "". That is what makes the
// progressive form work: a token with no captured value falls through to the
// version default and then to the generic public wording, so an MSA sent on
// an email address alone still reads as a complete agreement about "the
// Client" instead of showing holes where the optional fields were.

import type { RecipientInput } from "./fields";

export type MergeVars = Record<string, string>;

/** First non-empty candidate, or undefined if every candidate is blank. */
function firstFilled(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

/**
 * Recipient-sourced tokens. The fallback chains are what a human would do
 * reading the form back: a send that captured only a company name still
 * names that company as the Client, rather than falling through to "the
 * Client" when we actually know who it is.
 */
export function recipientMergeVars(recipient: RecipientInput): MergeVars {
  const candidates: Record<string, string | undefined> = {
    client_name: firstFilled(recipient.fullName, recipient.companyName, recipient.legalName),
    client_legal_name: firstFilled(recipient.legalName, recipient.companyName, recipient.fullName),
    client_company: firstFilled(recipient.companyName, recipient.legalName),
    client_address: firstFilled(recipient.address),
    client_email: firstFilled(recipient.email),
    client_phone: firstFilled(recipient.phone),
    // The signatory is a PERSON. A company name is not a signatory, so this
    // does not fall back to one — unsigned, it stays generic prose.
    signer_name: firstFilled(recipient.fullName),
  };
  const out: MergeVars = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Acceptance-sourced tokens. Not known at send time, so these are layered on
 * at render time: before acceptance the date tokens render as generic prose
 * ("the date of acceptance"), and after it they render the real date.
 */
export function acceptanceMergeVars(acceptedAt: Date | null): MergeVars {
  if (!acceptedAt) return {};
  const date = acceptedAt.toISOString().slice(0, 10);
  return { accepted_date: date, effective_date: date };
}

/** mergedVarsJson (frozen at send time) -> a safe record. */
export function parseMergeVars(json: string): MergeVars {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: MergeVars = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
    }
    return out;
  } catch {
    return {};
  }
}
