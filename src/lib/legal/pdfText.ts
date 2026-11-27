// Text that a PDF standard font can actually draw (SHA-4501). PURE.
//
// The PDF stack here uses the base-14 Helvetica/Courier fonts, which carry a
// WinAnsi (Latin-1 plus 27 named slots) encoding and NOTHING else. pdf-lib
// throws on the first character outside it, so an operator who pastes a
// curly quote from Word is fine and one who pastes a Greek letter, a CJK
// name or an arrow would otherwise get a 500 on a download of their own
// agreement — from text the HTML surface renders without complaint.
//
// So every string goes through here before it is measured or drawn. Four
// rules, in order:
//
//   1. Encodable characters pass through untouched. Curly quotes, the euro
//      sign, en/em dashes, bullets and all of Latin-1 are drawable as-is.
//   2. The invisible formatting characters a copy-paste drags along (a
//      zero-width space, a BOM) map to nothing, since they render as
//      nothing, and the line/paragraph separators map to a space.
//   3. A known substitute is used where one reads correctly: an arrow
//      becomes "->", a non-breaking hyphen becomes "-".
//   4. Anything else is NFKD-folded ("á" to "a", an fi ligature to "fi")
//      when the fold is itself drawable, and otherwise becomes "?".
//
// Rule 4's fallback is deliberately VISIBLE. Silently dropping a character
// out of an agreement is never ours to do — the same reason the markdown
// renderer keeps the label of a link whose URL it refuses. A "?" in a
// downloaded PDF is a defect an operator reports; a missing word in a
// contract is one nobody notices.
//
// The characters with no glyph are listed by CODE POINT rather than as
// literals: a zero-width space sitting in a source file is unreviewable, and
// a reviewer cannot tell a missing entry from a present one.

/** The 27 Unicode characters WinAnsi puts in the 0x80-0x9F range. */
const WIN_ANSI_SPECIALS: readonly string[] = [
  "€", // euro
  "‚", // single low-9 quote
  "ƒ", // florin
  "„", // double low-9 quote
  "…", // ellipsis
  "†", // dagger
  "‡", // double dagger
  "ˆ", // circumflex
  "‰", // per mille
  "Š", // S caron
  "‹", // single left angle quote
  "Œ", // OE ligature
  "Ž", // Z caron
  "‘", // left single quote
  "’", // right single quote
  "“", // left double quote
  "”", // right double quote
  "•", // bullet
  "–", // en dash
  "—", // em dash
  "˜", // small tilde
  "™", // trade mark
  "š", // s caron
  "›", // single right angle quote
  "œ", // oe ligature
  "ž", // z caron
  "Ÿ", // Y diaeresis
];

const SPECIALS = new Set<string>(WIN_ANSI_SPECIALS);

/**
 * Can a base-14 standard font draw this single character?
 *
 * Printable ASCII, the Latin-1 supplement, and the specials above. The C0/C1
 * control ranges are excluded on purpose: they are not glyphs, and a stray
 * one in pasted text should not travel into a page's content stream.
 */
export function isDrawable(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return SPECIALS.has(ch);
}

const fromCodePoints = (points: readonly number[]): Set<string> =>
  new Set(points.map((cp) => String.fromCodePoint(cp)));

/** Zero-width characters: they render as nothing, so they become nothing. */
const DROPPED = fromCodePoints([
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x2060, // word joiner
  0xfeff, // BOM / zero-width no-break space
]);

/**
 * Characters that become a single space.
 *
 * A literal newline, carriage return or tab inside a drawn string would be a
 * byte in the content stream rather than a line break — lines are laid out
 * by ./pdfRender.ts long before the font sees them — and the Unicode
 * line/paragraph separators are the same mistake in a less obvious form.
 */
const SPACED = fromCodePoints([
  0x09, // tab
  0x0a, // line feed
  0x0d, // carriage return
  0x2028, // line separator
  0x2029, // paragraph separator
]);

/**
 * Characters worth a reading substitute rather than a fold or a "?".
 *
 * Only shapes that appear in real contract text: the dash and quote variants
 * Word and Google Docs emit, and the arrows and comparison operators an SLA
 * table uses.
 */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  "‐": "-", // hyphen
  "‑": "-", // non-breaking hyphen
  "‒": "-", // figure dash
  "―": "-", // horizontal bar
  "−": "-", // minus sign
  "′": "'", // prime
  "″": '"', // double prime
  "‵": "'", // reversed prime
  "←": "<-",
  "→": "->",
  "↔": "<->",
  "⇒": "=>",
  "≠": "!=",
  "≤": "<=",
  "≥": ">=",
  "≈": "~",
  "✓": "[x]", // check mark
  "✗": "[ ]", // ballot x
  "★": "*",
  "☆": "*",
  // Latin letters whose stroke is part of the glyph rather than a combining
  // mark, so NFKD leaves them alone and rule 4 would reach "?". A Polish or
  // Croatian company name in an MSP's own identity is the realistic case.
  Ł: "L",
  ł: "l",
  Đ: "D",
  đ: "d",
  Ħ: "H",
  ħ: "h",
  Ŧ: "T",
  ŧ: "t",
  Ŋ: "N",
  ŋ: "n",
  ẞ: "SS",
};

const COMBINING = /[̀-ͯ]/g;

function substitute(ch: string): string {
  if (DROPPED.has(ch)) return "";
  if (SPACED.has(ch)) return " ";
  const explicit = SUBSTITUTES[ch];
  if (explicit !== undefined) return explicit;
  // NFKD splits a precomposed letter into base + combining marks, so dropping
  // the marks leaves the base letter. Accepted only when every character of
  // the result is itself drawable, so a fold that merely swaps one
  // unencodable character for another is refused.
  const folded = ch.normalize("NFKD").replace(COMBINING, "");
  if (folded !== "" && folded !== ch && [...folded].every(isDrawable)) return folded;
  return "?";
}

/**
 * A string as the PDF fonts here can draw it.
 *
 * Idempotent: the output contains only drawable characters, so running it
 * twice changes nothing.
 */
export function toPdfText(value: string): string {
  let out = "";
  // Iterated by code POINT, so an astral character (an emoji, say) is handled
  // as one character and yields one "?" rather than two surrogate halves.
  for (const ch of value) {
    out += isDrawable(ch) ? ch : substitute(ch);
  }
  return out;
}

/** Did `toPdfText` have to substitute anything in this string? */
export function hasUndrawable(value: string): boolean {
  for (const ch of value) {
    if (!isDrawable(ch)) return true;
  }
  return false;
}
