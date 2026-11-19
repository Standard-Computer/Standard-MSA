// Recipient fields for the ad-hoc send form (SHA-2959). PURE: the progressive
// client form and the server action share this file, so the two cannot
// disagree about what is required.
//
// Sean's bar is "as little as a customer email address" — email is the ONLY
// required field. Everything else is asked for, optional, and merged into the
// document only when present (see ./merge.ts).

import { isEmailShape, normalizeEmail } from "@/lib/email/address";

export type RecipientInput = {
  email: string;
  fullName: string;
  companyName: string;
  legalName: string;
  address: string;
  phone: string;
};

export const RECIPIENT_FIELD_LABELS: Record<keyof RecipientInput, string> = {
  email: "Email address",
  fullName: "Contact full name",
  companyName: "Company name",
  legalName: "Legal entity name",
  address: "Address",
  phone: "Phone",
};

/** The fields beyond email, in the order the progressive form reveals them. */
export const OPTIONAL_RECIPIENT_FIELDS: (keyof RecipientInput)[] = [
  "fullName",
  "companyName",
  "legalName",
  "address",
  "phone",
];

export const EMPTY_RECIPIENT_INPUT: RecipientInput = {
  email: "",
  fullName: "",
  companyName: "",
  legalName: "",
  address: "",
  phone: "",
};

/** Field length caps. A contract merges these, so an absurd value is a
 *  document defect, not just a wide table cell. */
const MAX_LENGTH: Record<keyof RecipientInput, number> = {
  email: 320, // RFC 3696 practical maximum
  fullName: 200,
  companyName: 200,
  legalName: 200,
  address: 500,
  phone: 60,
};

/**
 * Anything recipient-shaped: a posted form, or a Recipient row whose
 * optional columns are `null`. Both are normalized the same way, so a
 * caller never has to coalesce nulls before calling.
 */
export type RecipientInputLike = Partial<Record<keyof RecipientInput, string | null | undefined>>;

/** Trim every field, canonicalise the email, and clamp to the caps above. */
export function normalizeRecipientInput(raw: RecipientInputLike): RecipientInput {
  const out = { ...EMPTY_RECIPIENT_INPUT };
  for (const field of Object.keys(EMPTY_RECIPIENT_INPUT) as (keyof RecipientInput)[]) {
    const value = typeof raw[field] === "string" ? raw[field] : "";
    const trimmed = field === "email" ? normalizeEmail(value) : value.trim();
    out[field] = trimmed.slice(0, MAX_LENGTH[field]);
  }
  return out;
}

export type RecipientValidation =
  | { ok: true; input: RecipientInput }
  | { ok: false; field: keyof RecipientInput; error: string };

/**
 * Validate a normalized input. Only the email can fail — that is the whole
 * point of the one-field bar. Returns the normalized input on success so a
 * caller never has to remember to normalize first.
 */
export function validateRecipientInput(raw: RecipientInputLike): RecipientValidation {
  const input = normalizeRecipientInput(raw);
  if (input.email === "") {
    return { ok: false, field: "email", error: "An email address is required to send an MSA." };
  }
  if (!isEmailShape(input.email)) {
    return { ok: false, field: "email", error: `"${input.email}" is not a valid email address.` };
  }
  return { ok: true, input };
}

/** Optional fields the operator actually filled in — for the "we captured N
 *  of 5 extra details" line on the send screens. */
export function filledOptionalFields(input: RecipientInput): (keyof RecipientInput)[] {
  return OPTIONAL_RECIPIENT_FIELDS.filter((f) => input[f] !== "");
}
