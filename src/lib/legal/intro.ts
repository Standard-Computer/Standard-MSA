import { renderLegalBody, type MspValues } from "./variables";

// The public /legal intro (SHA-4708, GH #33 §1–§3).
//
// PURE — no Prisma, no server-only, following ./variables.ts — because
// /legal (a React server component), the embed assembler and the tests all
// resolve the same intro and must not be able to disagree about it. ONE
// resolver, called from both surfaces, is the structural half of AC7's "the
// index and the embed receive identical paragraphs": they cannot drift,
// because there is only one function that knows how.
//
// THE ORDER IN resolveIntroParagraphs IS THE SECURITY PROPERTY.
// Substitute first, then escape — and the escaping is deliberately NOT done
// here, because the two surfaces escape differently and both are correct:
// /legal renders `<p>{paragraph}</p>`, where JSX escapes a plain-text child,
// and the embed calls the canonical escapeHtml() in ./embedDocument.ts.
// This module therefore returns PLAIN TEXT, never markup, and that is what
// makes it safe to hand to either one. Rendering to HTML here and
// substituting afterwards would drop an operator's "<" into markup that was
// already escaped — the same two operations in the wrong order are an
// injection point, which is why ./embedAssemble.ts spells the same warning
// over the document bodies.

/**
 * Sean's copy (GH #33), verbatim, with his company name and phone number
 * replaced by the tokens that resolve them from MspIdentity at render time.
 *
 * NO LITERAL COMPANY NAME OR PHONE NUMBER BELONGS IN HERE (AC2). This
 * constant ships to every template install, so a hard-coded "Standard
 * Computer" would introduce Sean's MSP to someone else's customers. The
 * tokens are what make the same default correct for every deploy, and
 * tests/legal/intro.test.ts greps this constant to keep it that way.
 *
 * Kept in code rather than seeded into the database so a fresh deploy has it
 * before anyone opens the editor, and so clearing the editor restores it.
 */
export const DEFAULT_LEGAL_INTRO = `Using {{msp_name}} services means you accept these agreements. They govern every client relationship with {{msp_name}}, with or without a signature.
A client accepts the current version of each applicable agreement, in full, by doing any of the following: requesting service, receiving service, accepting a quote, or paying an invoice. Continuing to use our services after we publish an updated version is acceptance of that version.
Each agreement below shows the version in force today, its effective date, and a unique version ID. Every earlier version stays on the agreement's history page.
If you don't accept these terms, stop using our services and contact us at {{msp_phone}}.`;

/** Free-text intro/footer settings → trimmed, non-empty lines. */
export function textLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The value {{msp_phone}} takes ON THE PUBLIC INTRO: the phone, else the
 * notification email, else nothing.
 *
 * THE EMAIL FALLBACK LIVES HERE, NOT IN mspTokenValue(). GH #33 §3 asks for
 * it on "the public intro", and putting it in the token resolver would
 * silently change what {{msp_phone}} means inside a signed agreement body —
 * a contract that says "reach us on 555-0100" would start printing an email
 * address, and {{msp_phone}} would behave unlike every other optional MSP
 * token. So the resolver below hands renderLegalBody an MspValues whose
 * mspPhone is already the intro's answer, and ./variables.ts keeps
 * {{msp_phone}} plain: the field, or a labelled blank, exactly like
 * {{msp_address}}.
 */
export function introPhoneValue(msp: MspValues): string | null {
  return msp.mspPhone?.trim() || msp.mspEmail?.trim() || null;
}

/**
 * Drop the contact clause's " at {{msp_phone}}" when there is nothing to put
 * there, so the sentence ends at "contact us." rather than at "contact us at
 * ." or at a labelled blank (GH #33 §3).
 *
 * Done BEFORE substitution, on the template, which is why it can match the
 * token at all — afterwards there is no token left to find, only the hole it
 * left behind, and "us at ." is not reliably repairable from text alone.
 */
function elidePhoneClause(line: string): string {
  return line.replace(/\s+at\s+\{\{\s*msp_phone\s*\}\}/gi, "");
}

/**
 * The final sweep: nothing token-shaped reaches a visitor (AC7).
 *
 * `renderLegalBody` is built for AGREEMENT BODIES, where an unresolved token
 * must stay visible as `[unset: key]` — silently deleting words from a
 * contract is never ours to do. That invariant is correct there, is pinned
 * by tests/legal/embedDocument.test.ts, and is NOT changed by this file. But
 * the intro is site furniture, not terms: an operator who writes
 * "call {{msp_phone}}" on an install with no phone should get "call", not
 * "call [unset: msp_phone]" on their public legal page.
 *
 * The brace clause catches what the renderer cannot: TOKEN_RE only matches
 * `{{[a-z0-9_]+}}`, so a near-miss an operator actually types — `{{msp
 * name}}`, `{{ msp-phone }}` — survives rendering as raw template syntax,
 * and a value that itself contains braces is not rescanned. Either one reads
 * as a broken website. AC7 says neither appears in the intro, so neither
 * does.
 */
function stripTokenResidue(line: string): string {
  return line.replace(/\[unset:\s*[^\]]*\]/gi, "").replace(/\{\{[^{}]*\}\}/g, "");
}

/** Close up the gaps a removed clause leaves behind. */
function tidy(line: string): string {
  return line
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/(\()[ \t]+/g, "$1")
    .trim();
}

/**
 * The substitution pipeline, shared by the intro and the footer.
 *
 * Takes already-split lines and NO default: the caller decides whether an
 * empty setting means "use shipped copy" (the intro) or "show nothing"
 * (the footer). Keeping the fallback out of here is deliberate — a single
 * function that both resolved and defaulted would put the whole
 * four-paragraph intro into an empty footer.
 */
export function resolveTemplateLines(lines: string[], msp: MspValues): string[] {
  const phone = introPhoneValue(msp);
  // renderLegalBody sees the intro's phone answer, so the elision check and
  // the substitution can never disagree about whether there is a phone.
  const effective: MspValues = { ...msp, mspPhone: phone };

  return lines
    .map((line) => (phone === null ? elidePhoneClause(line) : line))
    .map((line) => renderLegalBody(line, "public", effective))
    .map(stripTokenResidue)
    .map(tidy)
    .filter((line) => line !== "");
}

/**
 * The resolved public intro, as plain-text paragraphs.
 *
 * Both /legal and the embed call THIS — see the file header. The default is
 * applied at render time, never written to the database, so:
 *   · current production (introText IS NULL) shows Sean's copy with no
 *     backfill,
 *   · clearing the editor restores the default rather than blanking the
 *     page (the /embed action already coerces "" → null), and
 *   · a non-empty saved value is never overwritten by a later deploy.
 */
export function resolveIntroParagraphs(introText: string | null, msp: MspValues): string[] {
  const saved = textLines(introText);
  const lines = saved.length > 0 ? saved : textLines(DEFAULT_LEGAL_INTRO);
  return resolveTemplateLines(lines, msp);
}

/**
 * The operator's footer lines, resolved the same way — but with NO default:
 * an install that has written no footer shows no footer.
 */
export function resolveFooterLines(footerText: string | null, msp: MspValues): string[] {
  return resolveTemplateLines(textLines(footerText), msp);
}
