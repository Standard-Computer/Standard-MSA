import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

// A rendered legal body as a PDF (GH #22 / SHA-4505). PURE given its inputs.
//
// This file takes markdown whose {{tokens}} are ALREADY substituted — the
// caller runs renderLegalBody first and chooses the mode there, so the
// public/filled isolation stays where it lives today (variables.ts), and a
// later send-PDF lane can reuse this renderer with "filled" output without
// touching it.
//
// The same allow-list posture as embedMarkdown.ts: remark parses, and this
// file walks the known AST emitting an explicit set of block shapes. An
// `html` node has no branch here either — raw HTML in a body cannot reach
// the PDF because no code path emits it.
//
// Fonts are the standard-14 Helvetica family: nothing is embedded, nothing
// ships in the repo, and every PDF viewer renders them. The cost is WinAnsi
// coverage only — a character outside it draws as a visible "?" rather than
// throwing, because a download that 500s on one exotic character is worse
// than one visibly degraded glyph (same "visible, never silent" rule as the
// [unset: …] blanks).

export type PdfRun = { text: string; bold: boolean; italic: boolean };

export type PdfBlock = {
  kind: "heading" | "text" | "rule";
  /** Heading level, clamped to 1–3 like the embed renderer. */
  level?: 1 | 2 | 3;
  /** Left indent in points (list nesting, blockquotes). */
  indent: number;
  /** List marker ("•", "7.") drawn in the gutter left of the text. */
  marker?: string;
  runs: PdfRun[];
};

const PROCESSOR = unified().use(remarkParse).use(remarkGfm);

const INDENT_STEP = 18;

/** Inline nodes → styled runs. Anything unknown contributes its text, never markup. */
function inlineRuns(nodes: PhrasingContent[] | undefined, bold: boolean, italic: boolean): PdfRun[] {
  if (!nodes) return [];
  const out: PdfRun[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out.push({ text: n.value, bold, italic });
        break;
      case "strong":
        out.push(...inlineRuns(n.children, true, italic));
        break;
      case "emphasis":
        out.push(...inlineRuns(n.children, bold, true));
        break;
      case "delete":
        out.push(...inlineRuns(n.children, bold, italic));
        break;
      case "inlineCode":
        out.push({ text: n.value, bold, italic });
        break;
      case "break":
        out.push({ text: "\n", bold, italic });
        break;
      case "link":
        // The LABEL is the agreement's text; the href is presentation. A
        // printed page cannot be clicked, and appending URLs would add words
        // to a contract, which is as much ours to do as deleting them.
        out.push(...inlineRuns(n.children, bold, italic));
        break;
      case "image":
        // Same decision as the embed: an image in imported text renders as a
        // visible omission, never as a fetch.
        out.push({ text: `[image omitted: ${n.alt || "untitled"}]`, bold, italic });
        break;
      // `html` is deliberately absent — raw HTML has no path into the PDF.
      default:
        if ("children" in n && Array.isArray(n.children)) {
          out.push(...inlineRuns(n.children as PhrasingContent[], bold, italic));
        }
        break;
    }
  }
  return out;
}

function textBlock(runs: PdfRun[], indent: number, marker?: string): PdfBlock {
  return { kind: "text", indent, marker, runs };
}

function blockNodes(n: RootContent, indent: number, out: PdfBlock[]): void {
  switch (n.type) {
    case "heading": {
      // Deeper headings fold onto 3, as in the embed: a legal document that
      // nests four deep is using headings as emphasis.
      const level = Math.min(n.depth, 3) as 1 | 2 | 3;
      out.push({ kind: "heading", level, indent, runs: inlineRuns(n.children, true, false) });
      break;
    }
    case "paragraph":
      out.push(textBlock(inlineRuns(n.children, false, false), indent));
      break;
    case "list": {
      // `start` is preserved: a clause list beginning at 7 is a cross
      // reference, and renumbering it would change what the document says.
      let number = n.ordered ? (typeof n.start === "number" ? n.start : 1) : 0;
      for (const li of n.children) {
        const marker = n.ordered ? `${number}.` : "•";
        if (n.ordered) number += 1;
        let first = true;
        for (const child of li.children) {
          if (first && child.type === "paragraph") {
            out.push(textBlock(inlineRuns(child.children, false, false), indent + INDENT_STEP, marker));
            first = false;
          } else {
            blockNodes(child, indent + INDENT_STEP, out);
            first = false;
          }
        }
        if (first) out.push(textBlock([], indent + INDENT_STEP, marker));
      }
      break;
    }
    case "blockquote":
      for (const child of n.children) blockNodes(child, indent + INDENT_STEP, out);
      break;
    case "thematicBreak":
      out.push({ kind: "rule", indent, runs: [] });
      break;
    case "code":
      // Verbatim lines, one block per line so the hard breaks survive.
      for (const line of n.value.split("\n")) {
        out.push(textBlock([{ text: line, bold: false, italic: false }], indent + INDENT_STEP));
      }
      break;
    case "table": {
      // A reading rendition, not a grid: each row becomes a "a | b | c"
      // line, header row bold — same information, print-safe layout.
      const [head, ...body] = n.children;
      const rowRuns = (row: (typeof n.children)[number], bold: boolean): PdfRun[] =>
        row.children.flatMap((cell, i) => {
          const runs = inlineRuns(cell.children, bold, false);
          return i === 0 ? runs : [{ text: " | ", bold, italic: false }, ...runs];
        });
      if (head) out.push(textBlock(rowRuns(head, true), indent));
      for (const row of body) out.push(textBlock(rowRuns(row, false), indent));
      break;
    }
    // `html` absent on purpose, as inline. Unknown block types render their
    // text content — visible, inert, never markup.
    default:
      if ("children" in n && Array.isArray(n.children)) {
        out.push(textBlock(inlineRuns(n.children as PhrasingContent[], false, false), indent));
      }
      break;
  }
}

/** A rendered body's markdown → the flat block list the layout draws. */
export function pdfBlocks(markdown: string): PdfBlock[] {
  const tree = PROCESSOR.parse(markdown) as Root;
  const out: PdfBlock[] = [];
  for (const node of tree.children) blockNodes(node, 0, out);
  return out;
}

export type AgreementPdfMeta = {
  title: string;
  version: number;
  /** YYYY-MM-DD, or null when unpublished. */
  effectiveDate: string | null;
  draft: boolean;
};

/** The download filename. Slugs are already locked to lowercase-kebab. */
export function agreementPdfFilename(slug: string, version: number, draft: boolean): string {
  return `${slug}-v${version}${draft ? "-draft" : ""}.pdf`;
}

// ── Layout ──────────────────────────────────────────────────────────────────

// US Letter, 1" margins. Sizes in points.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOTER_ROOM = 28;

const BODY_SIZE = 10.5;
const HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 17, 2: 14, 3: 12 };
const SPACE_BEFORE: Record<1 | 2 | 3, number> = { 1: 14, 2: 12, 3: 10 };
const LINE = 1.45;
const BLOCK_GAP = 6;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.45, 0.48, 0.53);
const DRAFT_COLOR = rgb(0.75, 0.3, 0.05);

/**
 * A few common characters just outside WinAnsi, mapped to their closest
 * encodable neighbour before the "?" fallback.
 */
const CHAR_FALLBACK: Record<string, string> = {
  "\u00a0": " ", // no-break space
  "\u2212": "-", // minus sign
  "\u2028": "\n", // line separator
  "\u2029": "\n", // paragraph separator
  "\t": " ",
};

/** Text → something `font` can encode; unencodable characters become "?". */
export function encodableText(text: string, canEncode: (ch: string) => boolean): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || canEncode(ch)) {
      out += ch;
      continue;
    }
    const mapped = CHAR_FALLBACK[ch];
    out += mapped !== undefined && (mapped === " " || canEncode(mapped)) ? mapped : "?";
  }
  return out;
}

type Word = { text: string; font: PDFFont; glue: boolean; hardBreak: boolean };
type Segment = { text: string; x: number; font: PDFFont };
type Line = { segments: Segment[] };

/** Runs → words carrying their font and whether they glue to the previous word. */
function wordsOf(runs: PdfRun[], fontFor: (r: PdfRun) => PDFFont, canEncode: (ch: string) => boolean): Word[] {
  const words: Word[] = [];
  let endedInSpace = true; // leading whitespace at block start is meaningless
  for (const run of runs) {
    const font = fontFor(run);
    const text = encodableText(run.text, canEncode);
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (part === "") continue;
      if (/\s/.test(part)) {
        if (part.includes("\n") && words.length > 0) words[words.length - 1].hardBreak = true;
        endedInSpace = true;
        continue;
      }
      words.push({ text: part, font, glue: !endedInSpace, hardBreak: false });
      endedInSpace = false;
    }
  }
  return words;
}

/** Greedy left-aligned wrap of styled words into lines of at most `width`. */
function wrapWords(words: Word[], width: number, size: number): Line[] {
  const lines: Line[] = [];
  let current: Segment[] = [];
  let x = 0;
  let pendingBreak = false;

  const flush = (): void => {
    if (current.length > 0) lines.push({ segments: current });
    current = [];
    x = 0;
  };

  // Consecutive same-font words merge into ONE segment (one draw call, one
  // string in the content stream) — smaller output, and the drawn text stays
  // phrase-shaped for anything that extracts it.
  const append = (word: Word, atX: number): void => {
    const last = current[current.length - 1];
    if (last !== undefined && last.font === word.font) {
      last.text += (word.glue ? "" : " ") + word.text;
    } else {
      current.push({ text: word.text, x: atX, font: word.font });
    }
  };

  for (const word of words) {
    if (pendingBreak) {
      flush();
      pendingBreak = false;
    }
    const wordW = word.font.widthOfTextAtSize(word.text, size);
    const spaceW = word.glue && current.length > 0 ? 0 : word.font.widthOfTextAtSize(" ", size);
    const startX = current.length === 0 ? 0 : x + (word.glue ? 0 : spaceW);
    if (current.length > 0 && startX + wordW > width) {
      flush();
      current.push({ text: word.text, x: 0, font: word.font });
      x = wordW;
    } else {
      if (current.length === 0) {
        current.push({ text: word.text, x: startX, font: word.font });
      } else {
        append(word, startX);
      }
      x = startX + wordW;
    }
    if (word.hardBreak) pendingBreak = true;
  }
  flush();
  return lines;
}

/**
 * Meta + an already-rendered body → the PDF bytes.
 *
 * `renderedMarkdown` must have gone through renderLegalBody first; this
 * function never sees tokens or recipient values, only prose.
 */
export async function renderAgreementPdf(meta: AgreementPdfMeta, renderedMarkdown: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${meta.title} — v${meta.version}`);
  doc.setProducer("Standard MSA");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);

  // One character set covers the whole family — the standard-14 Helvetica
  // faces share WinAnsi.
  const charset = new Set(regular.getCharacterSet());
  const canEncode = (ch: string): boolean => charset.has(ch.codePointAt(0) ?? -1);
  const fontFor = (r: PdfRun): PDFFont =>
    r.bold && r.italic ? boldItalic : r.bold ? bold : r.italic ? italic : regular;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensureRoom = (needed: number): void => {
    if (y - needed < MARGIN + FOOTER_ROOM) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const drawLines = (lines: Line[], leftX: number, size: number, color = INK): void => {
    const lineH = size * LINE;
    for (const line of lines) {
      ensureRoom(lineH);
      y -= lineH;
      for (const seg of line.segments) {
        page.drawText(seg.text, { x: leftX + seg.x, y, size, font: seg.font, color });
      }
    }
  };

  // ── Header: title, version, effective date — AC 3's required fields ──────
  const titleRuns: PdfRun[] = [{ text: meta.title, bold: true, italic: false }];
  drawLines(wrapWords(wordsOf(titleRuns, fontFor, canEncode), CONTENT_W, 20), MARGIN, 20);
  y -= 4;
  const metaText = meta.draft
    ? `Version ${meta.version} · DRAFT — not published`
    : `Version ${meta.version}${meta.effectiveDate ? ` · Effective ${meta.effectiveDate}` : ""}`;
  const metaLine = encodableText(metaText, canEncode);
  ensureRoom(BODY_SIZE * LINE);
  y -= BODY_SIZE * LINE;
  page.drawText(metaLine, {
    x: MARGIN,
    y,
    size: BODY_SIZE,
    font: meta.draft ? bold : regular,
    color: meta.draft ? DRAFT_COLOR : MUTED,
  });
  y -= 10;

  // ── Body ──────────────────────────────────────────────────────────────────
  for (const block of pdfBlocks(renderedMarkdown)) {
    const leftX = MARGIN + block.indent;
    const width = CONTENT_W - block.indent;

    if (block.kind === "rule") {
      ensureRoom(14);
      y -= 10;
      page.drawLine({
        start: { x: leftX, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.6,
        color: MUTED,
      });
      y -= 4;
      continue;
    }

    const size = block.kind === "heading" ? HEADING_SIZE[block.level ?? 3] : BODY_SIZE;
    const lines = wrapWords(wordsOf(block.runs, fontFor, canEncode), width, size);
    if (lines.length === 0 && !block.marker) continue;

    if (block.kind === "heading") {
      // Keep a heading with at least one body line below it.
      ensureRoom(SPACE_BEFORE[block.level ?? 3] + size * LINE + BODY_SIZE * LINE);
      y -= SPACE_BEFORE[block.level ?? 3];
    }
    if (block.marker) {
      // The marker sits in the gutter the indent step opened, on the first
      // line's baseline — drawn before the line moves y.
      const markerText = encodableText(block.marker, canEncode);
      ensureRoom(size * LINE);
      page.drawText(markerText, {
        x: leftX - INDENT_STEP,
        y: y - size * LINE,
        size,
        font: regular,
        color: INK,
      });
    }
    drawLines(lines, leftX, size);
    // A marker with no text (an empty list item) still occupies its line.
    if (lines.length === 0 && block.marker) y -= size * LINE;
    y -= BLOCK_GAP;
  }

  // ── Footer: page numbers, second pass once the count is known ────────────
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = regular.widthOfTextAtSize(label, 9);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: MARGIN / 2, size: 9, font: regular, color: MUTED });
  });

  return doc.save();
}
