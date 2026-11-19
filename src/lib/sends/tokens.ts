// Per-send URL tokens (SHA-2959).
//
// The token IS the authorisation to read and accept one agreement: there is
// no recipient login, which is deliberate — asking a prospect to create an
// account before they can read the MSA is how an MSA does not get signed.
// So the token has to be unguessable rather than merely unique: 32 bytes of
// CSPRNG, base64url, 256 bits. A sequential id or a timestamp-derived value
// would let anyone walk other recipients' contracts.

import { randomBytes } from "node:crypto";

export const SEND_TOKEN_BYTES = 32;

export function newSendToken(): string {
  return randomBytes(SEND_TOKEN_BYTES).toString("base64url");
}

/**
 * Shape gate for a token off the wire, so /msa/<garbage> is refused without
 * a database round trip. Never a substitute for the lookup — it proves only
 * that the value could be one of ours.
 */
export function isSendTokenShape(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(raw);
}

/** The recipient-facing URL for one send. */
export function sendUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/msa/${token}`;
}
