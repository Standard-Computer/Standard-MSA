import { inflateSync } from "node:zlib";

// Test-only PDF text extraction (GH #22 / SHA-4505).
//
// pdf-lib Flate-compresses content streams and writes every drawn string as
// a hex literal (`<48656C6C6F> Tj`), so "does the PDF say X" cannot be asked
// of the raw bytes. This inflates every stream and decodes every hex string
// in the inflated operators to latin1 — which matches WinAnsi for the ASCII
// the assertions use. It is deliberately NOT a PDF parser: good enough to
// assert presence/absence of drawn text, nothing more.

const STREAM_RE = /stream\r?\n/g;
const HEX_STRING_RE = /<([0-9A-Fa-f\s]+)>/g;

function decodedHexStrings(operators: string): string {
  let out = "";
  for (const m of operators.matchAll(HEX_STRING_RE)) {
    const hex = m[1].replace(/\s+/g, "");
    let s = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    out += `${s}\n`;
  }
  return out;
}

/**
 * Every drawn string in the PDF, decoded.
 *
 * Deliberately EXCLUDES the raw compressed bytes: flate output is dense
 * binary, so any two-character needle ("{{") will eventually occur in it by
 * coincidence, and an absence assertion against the raw bytes would flake.
 * Only inflated stream text and decoded hex strings are searched.
 */
export function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  let out = decodedHexStrings(raw);
  let m: RegExpExecArray | null;
  STREAM_RE.lastIndex = 0;
  while ((m = STREAM_RE.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) continue;
    try {
      const inflated = inflateSync(buf.subarray(start, end)).toString("latin1");
      out += `\n${inflated}\n${decodedHexStrings(inflated)}`;
    } catch {
      // Not a Flate stream: its hex strings are already decoded from `raw`
      // above, which is all a text assertion needs.
    }
  }
  return out;
}
