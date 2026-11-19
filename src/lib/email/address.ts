// The one email-address shape check in the app.
//
// Extracted from ./verify.ts (SHA-2958) when the send lane needed the same
// check in a PURE module: verify.ts reaches Prisma through ./send, so a
// browser-reachable form validator could not import it. One regex, one
// meaning of "looks like an address" — a second copy is how one surface
// quietly accepts what another rejects.
//
// Deliberately a SHAPE check, not RFC 5322: the only honest proof that an
// address exists is that mail to it was delivered, which is what the
// lifecycle log records.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShape(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}

/**
 * Canonical storage form: trimmed and lowercased. Recipient identity is
 * keyed on this, so "Sean@Example.com" and "sean@example.com" are one
 * recipient and not two rows with divergent lifecycle logs.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
