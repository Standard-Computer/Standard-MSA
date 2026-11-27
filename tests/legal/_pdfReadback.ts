// Read the text back out of PDF bytes, for the tests only.
//
// Not a general PDF parser, and not a claim to be one. It knows exactly what
// src/lib/legal/pdfRender.ts produces: pdf-lib Flate-compresses each page's
// content stream and draws text with the base-14 fonts as a hex string
// followed by `Tj`. So: find the streams, inflate them, pull the operands of
// the text-showing operators, and decode them as WinAnsi.
//
// It exists so the assertions are about the real artefact. A test that read
// the block list instead would pass with the whole renderer deleted.

import zlib from "node:zlib";

/** WinAnsi's 0x80-0x9F block, which is where it differs from Latin-1. */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeWinAnsi(bytes: Buffer): string {
  let out = "";
  for (const byte of bytes) {
    out += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

/** PDF string-literal escapes, for the `(…) Tj` form. */
function unescapePdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") {
        octal += raw[i + 1];
        i += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    const named: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\n": "" };
    out += named[next] ?? next;
  }
  return out;
}

/** Every stream in the file, inflated where it is Flate-compressed. */
function contentStreams(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = buf.indexOf("stream", cursor);
    if (open === -1) break;
    const close = buf.indexOf("endstream", open);
    if (close === -1) break;
    let start = open + "stream".length;
    while (buf[start] === 0x0d || buf[start] === 0x0a) start += 1;
    const raw = buf.subarray(start, close);
    try {
      out.push(zlib.inflateSync(raw).toString("latin1"));
    } catch {
      // Not compressed (or not a stream we can read): take it as it is. A
      // font program lands here and simply contributes no text operators.
      out.push(raw.toString("latin1"));
    }
    cursor = close + "endstream".length;
  }
  return out;
}

/**
 * Every string the PDF draws, in content-stream order, one per show operator.
 *
 * Both operand forms are read — `<hex> Tj`, which is what pdf-lib emits, and
 * `(literal) Tj` — so a future pdf-lib that changes its mind about encoding
 * does not quietly make every assertion here vacuous.
 */
export function pdfDrawnStrings(bytes: Uint8Array): string[] {
  const out: string[] = [];
  // Operands then the operator: `<...> Tj` or `(...) Tj`. The character
  // classes are negated single characters, so the pattern is linear and
  // cannot backtrack.
  const SHOW = /(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\))\s*(Tj|TJ)/g;
  for (const stream of contentStreams(bytes)) {
    for (const match of stream.matchAll(SHOW)) {
      const [, hex, literal] = match;
      if (hex !== undefined) {
        const clean = hex.replace(/\s+/g, "");
        if (clean.length === 0) continue;
        out.push(decodeWinAnsi(Buffer.from(clean, "hex")));
        continue;
      }
      if (literal !== undefined) out.push(unescapePdfLiteral(literal));
    }
  }
  return out;
}

/** The drawn strings as one searchable string, words separated by spaces. */
export function pdfText(bytes: Uint8Array): string {
  return pdfDrawnStrings(bytes).join(" ");
}

/** How many pages the file declares. */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  // `/Type /Page` but not `/Type /Pages`, which is the tree node.
  return (text.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}
