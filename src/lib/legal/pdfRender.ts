// Layout blocks to PDF bytes (SHA-4501).
//
// Sean asked to click and download the PDF of a document. This is the only
// file that knows what a page looks like; ./pdfBlocks.ts decided what it
// says, and ./pdfDocument.ts decides which version it is and in what mode.
//
// Why pdf-lib (1.17.1, MIT, pinned exact): it is pure JavaScript with no
// native build and no install script, its dependencies are MIT/0BSD/Zlib, it
// adds no advisory to `npm audit` on this tree, and it supplies the one thing
// a hand-rolled writer cannot cheaply have — real font metrics, so
// `widthOfTextAtSize` wraps a clause where the glyphs actually end. Only the
// base-14 fonts are used, so no font file is embedded or shipped.
//
// Determinism matters and is why `generatedAt` is a parameter rather than a
// `new Date()` in here: two downloads of the same version differ only in the
// timestamp the caller passes, which is what makes the byte-level tests
// possible. `useObjectStreams: false` keeps the page content streams as plain
// objects, so a test can read the text back out of the bytes.
//
// Nothing here touches the database, next/headers or a Request, so the whole
// renderer is unit-testable.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { PdfBlock, PdfRun } from "./pdfBlocks";
import { toPdfText } from "./pdfText";

/** US Letter, in points. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
/** Leaves room for the footer rule and its line of text. */
const MARGIN_BOTTOM = 64;

const BODY_SIZE = 10.5;
const BODY_LEADING = 14.5;
const HEADING_SIZES: Readonly<Record<1 | 2 | 3, number>> = { 1: 15, 2: 12.5, 3: 11 };
const TITLE_SIZE = 19;
const META_SIZE = 9;
const FOOTER_SIZE = 8;
const CODE_SIZE = 9;

const INDENT = 18;
const MARKER_GAP = 6;
const QUOTE_INDENT = 14;

const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.8, 0.82, 0.85);
const DRAFT_INK = rgb(0.72, 0.33, 0.04);

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

/** What the cover block and the footers say about the version being read. */
export interface PdfDocumentMeta {
  readonly title: string;
  readonly version: number;
  /** ISO date (YYYY-MM-DD) a published version took effect, or null. */
  readonly effectiveDate: string | null;
  /** True for an unpublished draft: labelled on every page and in the name. */
  readonly draft: boolean;
  /** The MSP this install belongs to, for the cover line and PDF metadata. */
  readonly mspName: string | null;
  /** Where this copy came from, e.g. "https://msp.example.com/legal/msa". */
  readonly sourceUrl: string | null;
  /** Fixed by the caller so the same version renders the same bytes. */
  readonly generatedAt: Date;
}

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly italic: PDFFont;
  readonly boldItalic: PDFFont;
  readonly mono: PDFFont;
}

/** One measured, positioned piece of a line. */
interface Fragment {
  readonly text: string;
  readonly font: PDFFont;
  readonly size: number;
  readonly width: number;
}

type Line = readonly Fragment[];

function fontFor(run: PdfRun, fonts: Fonts): PDFFont {
  if (run.mono) return fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

const widthOf = (font: PDFFont, text: string, size: number): number =>
  text === "" ? 0 : font.widthOfTextAtSize(text, size);

/**
 * Split a word that cannot fit a whole line at all.
 *
 * A 200-character URL with no spaces would otherwise either overflow the
 * margin or loop forever. Broken by character, which is honest: nothing is
 * removed, and the break is visible.
 */
function hardBreak(text: string, font: PDFFont, size: number, limit: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of text) {
    const next = current + ch;
    if (current !== "" && widthOf(font, next, size) > limit) {
      parts.push(current);
      current = ch;
      continue;
    }
    current = next;
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * Runs to wrapped lines, greedily, measuring with the real font metrics.
 *
 * Styles are preserved across a wrap: a clause that starts bold and
 * continues in roman produces fragments of each on the same line.
 */
function wrap(
  runs: readonly PdfRun[],
  fonts: Fonts,
  size: number,
  limit: number,
  defaultFont?: PDFFont,
): Line[] {
  const lines: Fragment[][] = [];
  let line: Fragment[] = [];
  let used = 0;

  const flush = (): void => {
    if (line.length > 0) lines.push(line);
    line = [];
    used = 0;
  };

  for (const run of runs) {
    const font = defaultFont ?? fontFor(run, fonts);
    // Split on runs of whitespace, keeping the separators so a space between
    // two differently styled runs is not lost.
    const words = run.text.split(/(\s+)/).filter((w) => w !== "");
    for (const word of words) {
      const isSpace = /^\s+$/.test(word);
      if (isSpace) {
        // Leading whitespace on a fresh line is dropped: it is the wrap point.
        if (line.length === 0) continue;
        const spaceWidth = widthOf(font, " ", size);
        if (used + spaceWidth > limit) {
          flush();
          continue;
        }
        line.push({ text: " ", font, size, width: spaceWidth });
        used += spaceWidth;
        continue;
      }
      let width = widthOf(font, word, size);
      if (width > limit) {
        // Does not fit even alone: break it, laying out each piece in turn.
        flush();
        for (const piece of hardBreak(word, font, size, limit)) {
          const pieceWidth = widthOf(font, piece, size);
          lines.push([{ text: piece, font, size, width: pieceWidth }]);
        }
        continue;
      }
      if (used + width > limit) {
        flush();
        // A line never begins with the space that preceded its first word.
        width = widthOf(font, word, size);
      }
      line.push({ text: word, font, size, width });
      used += width;
    }
  }
  flush();
  // A paragraph of nothing but whitespace still occupies a line, so the
  // spacing around it matches what the author wrote.
  return lines.length > 0 ? lines : [[]];
}

/** The drawing cursor: which page, and how far down it. */
class Cursor {
  private page: PDFPage;
  private y: number;
  readonly pages: PDFPage[] = [];

  constructor(private readonly pdf: PDFDocument) {
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  private addPage(): PDFPage {
    const page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    return page;
  }

  /** Make sure `height` points are available, starting a page if not. */
  ensure(height: number): void {
    if (this.y - height >= MARGIN_BOTTOM) return;
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  gap(height: number): void {
    // Never opens a page just to hold trailing whitespace.
    if (this.y - height < MARGIN_BOTTOM) return;
    this.y -= height;
  }

  /** Draw wrapped lines at `x`, advancing by `leading` per line. */
  drawLines(lines: readonly Line[], x: number, leading: number, color = INK): void {
    for (const line of lines) {
      this.ensure(leading);
      let cx = x;
      for (const fragment of line) {
        if (fragment.text.trim() !== "") {
          this.page.drawText(fragment.text, {
            x: cx,
            y: this.y - fragment.size,
            size: fragment.size,
            font: fragment.font,
            color,
          });
        }
        cx += fragment.width;
      }
      this.y -= leading;
    }
  }

  /** One line of already-measured text, e.g. a list marker. */
  drawInline(text: string, x: number, size: number, font: PDFFont, color = INK): void {
    this.page.drawText(text, { x, y: this.y - size, size, font, color });
  }

  horizontalRule(x: number, width: number, color = RULE): void {
    this.ensure(8);
    this.page.drawRectangle({ x, y: this.y - 4, width, height: 0.75, color });
    this.y -= 8;
  }

  /** A left bar, for a block quote. */
  verticalBar(x: number, top: number, bottom: number, color = RULE): void {
    const height = top - bottom;
    if (height <= 0) return;
    this.page.drawRectangle({ x, y: bottom, width: 1.5, height, color });
  }

  get top(): number {
    return this.y;
  }

  /**
   * Put the cursor back to a y on the CURRENT page.
   *
   * Only the table row uses this, and only after `ensure()` has guaranteed
   * the whole row fits — so no cell can have started a page, and every cell
   * in the row really does begin at the same height.
   */
  resetTo(y: number): void {
    this.y = y;
  }
}

/** The measured height of wrapped lines at a leading. */
const linesHeight = (lines: readonly Line[], leading: number): number => lines.length * leading;

function drawCover(cursor: Cursor, meta: PdfDocumentMeta, fonts: Fonts): void {
  const title = wrap(
    [{ text: toPdfText(meta.title), bold: true }],
    fonts,
    TITLE_SIZE,
    CONTENT_WIDTH,
  );
  cursor.drawLines(title, MARGIN_X, TITLE_SIZE + 6);

  const parts = [`Version ${meta.version}`];
  // The draft notice comes FIRST in the line and is repeated in every page
  // footer and in the filename: a draft that reads as an agreement in force
  // is the one way this download could mislead somebody.
  if (meta.draft) parts.unshift("DRAFT - NOT PUBLISHED");
  if (meta.effectiveDate !== null) parts.push(`effective ${meta.effectiveDate}`);
  if (meta.mspName !== null && meta.mspName !== "") parts.push(toPdfText(meta.mspName));
  cursor.drawLines(
    wrap([{ text: parts.join("  -  ") }], fonts, META_SIZE, CONTENT_WIDTH),
    MARGIN_X,
    META_SIZE + 4,
    meta.draft ? DRAFT_INK : MUTED,
  );

  // A draft cites nothing, whatever the caller passed: the /legal path a
  // draft's URL would name does not serve the draft, and a printed page
  // telling a reader to "see the live version here" at a 404 is worse than
  // telling them nothing. ./pdfDocument.ts already passes null for a draft;
  // this is the same rule in the only place that could draw it.
  if (!meta.draft && meta.sourceUrl !== null && meta.sourceUrl !== "") {
    cursor.drawLines(
      wrap([{ text: toPdfText(meta.sourceUrl) }], fonts, META_SIZE, CONTENT_WIDTH),
      MARGIN_X,
      META_SIZE + 4,
      MUTED,
    );
  }

  cursor.horizontalRule(MARGIN_X, CONTENT_WIDTH);
  cursor.gap(6);
}

function drawBlock(cursor: Cursor, block: PdfBlock, fonts: Fonts): void {
  switch (block.kind) {
    case "heading": {
      const size = HEADING_SIZES[block.level];
      const lines = wrap(block.runs, fonts, size, CONTENT_WIDTH, fonts.bold);
      // Kept with at least one line of what follows, so a heading is never
      // the last thing on a page.
      cursor.gap(block.level === 1 ? 10 : 8);
      cursor.ensure(linesHeight(lines, size + 5) + BODY_LEADING);
      cursor.drawLines(lines, MARGIN_X, size + 5);
      cursor.gap(3);
      return;
    }
    case "paragraph": {
      const lines = wrap(block.runs, fonts, BODY_SIZE, CONTENT_WIDTH);
      cursor.drawLines(lines, MARGIN_X, BODY_LEADING);
      cursor.gap(5);
      return;
    }
    case "listItem": {
      const indent = MARGIN_X + INDENT * block.depth;
      const marker = toPdfText(block.marker);
      const markerWidth = widthOf(fonts.regular, marker, BODY_SIZE) + MARKER_GAP;
      const textX = indent + markerWidth;
      const lines = wrap(block.runs, fonts, BODY_SIZE, PAGE_WIDTH - MARGIN_X - textX);
      cursor.ensure(BODY_LEADING);
      // The marker sits on the item's FIRST line, which is only known to be
      // on this page after ensure() above.
      cursor.drawInline(marker, indent, BODY_SIZE, fonts.regular, MUTED);
      cursor.drawLines(lines, textX, BODY_LEADING);
      cursor.gap(2);
      return;
    }
    case "quote": {
      const x = MARGIN_X + QUOTE_INDENT;
      const lines = wrap(block.runs, fonts, BODY_SIZE, CONTENT_WIDTH - QUOTE_INDENT);
      cursor.ensure(BODY_LEADING);
      const top = cursor.top;
      cursor.drawLines(lines, x, BODY_LEADING);
      // Only barred when the quote stayed on one page; a bar drawn from a
      // remembered `top` after a page break would run off the new page.
      if (cursor.top < top) cursor.verticalBar(MARGIN_X + 4, top, Math.max(cursor.top, MARGIN_BOTTOM));
      cursor.gap(5);
      return;
    }
    case "code": {
      for (const raw of block.lines) {
        const lines = wrap([{ text: raw, mono: true }], fonts, CODE_SIZE, CONTENT_WIDTH - 8, fonts.mono);
        cursor.drawLines(lines, MARGIN_X + 8, CODE_SIZE + 3.5);
      }
      cursor.gap(5);
      return;
    }
    case "rule":
      cursor.gap(4);
      cursor.horizontalRule(MARGIN_X, CONTENT_WIDTH);
      cursor.gap(4);
      return;
    case "tableRow": {
      // Equal columns, each cell wrapped: a contract's tables are small, and
      // guessing column weights from content is how a table ends up less
      // readable than the even split.
      const count = Math.max(block.cells.length, 1);
      const gutter = 8;
      const columnWidth = (CONTENT_WIDTH - gutter * (count - 1)) / count;
      const font = block.header ? fonts.bold : undefined;
      const wrapped = block.cells.map((cell) =>
        wrap(cell, fonts, BODY_SIZE, columnWidth, font),
      );
      const rows = Math.max(...wrapped.map((w) => w.length), 1);
      const rowHeight = rows * BODY_LEADING + 4;
      if (rowHeight > PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) {
        // Taller than a whole page: no arrangement of columns keeps this row
        // on one page, so the cells are stacked down the page instead. Every
        // word survives, which is the property that matters.
        for (const cellLines of wrapped) {
          cursor.drawLines(cellLines, MARGIN_X, BODY_LEADING);
          cursor.gap(3);
        }
        return;
      }
      cursor.ensure(rowHeight);
      const top = cursor.top;
      let lowest = top;
      wrapped.forEach((cellLines, index) => {
        const x = MARGIN_X + index * (columnWidth + gutter);
        // Each cell starts from the row's top; `drawLines` moves the shared
        // cursor, so it is reset between cells and taken to the lowest point
        // any cell reached once the row is done.
        cursor.resetTo(top);
        cursor.drawLines(cellLines, x, BODY_LEADING);
        lowest = Math.min(lowest, cursor.top);
      });
      cursor.resetTo(lowest);
      if (block.header) cursor.horizontalRule(MARGIN_X, CONTENT_WIDTH);
      else cursor.gap(2);
      return;
    }
  }
}

function drawFooters(pages: readonly PDFPage[], meta: PdfDocumentMeta, fonts: Fonts): void {
  const label = [
    toPdfText(meta.title),
    `v${meta.version}`,
    ...(meta.draft ? ["DRAFT - NOT PUBLISHED"] : []),
  ].join("  -  ");
  pages.forEach((page, index) => {
    const number = `Page ${index + 1} of ${pages.length}`;
    page.drawRectangle({
      x: MARGIN_X,
      y: MARGIN_BOTTOM - 14,
      width: CONTENT_WIDTH,
      height: 0.5,
      color: RULE,
    });
    // Truncated by MEASURE, not by character count: a long title must not
    // run into the page number.
    const numberWidth = widthOf(fonts.regular, number, FOOTER_SIZE);
    const room = CONTENT_WIDTH - numberWidth - 12;
    let text = label;
    while (text !== "" && widthOf(fonts.regular, text, FOOTER_SIZE) > room) {
      text = text.slice(0, -1);
    }
    page.drawText(text, {
      x: MARGIN_X,
      y: MARGIN_BOTTOM - 26,
      size: FOOTER_SIZE,
      font: fonts.regular,
      color: meta.draft ? DRAFT_INK : MUTED,
    });
    page.drawText(number, {
      x: PAGE_WIDTH - MARGIN_X - numberWidth,
      y: MARGIN_BOTTOM - 26,
      size: FOOTER_SIZE,
      font: fonts.regular,
      color: MUTED,
    });
  });
}

/**
 * Blocks plus a cover and footers, as PDF bytes.
 *
 * The caller has already resolved variables (in `public` mode for every
 * surface that has no known client) and parsed the Markdown, so nothing
 * here can decide what the document says.
 */
export async function renderPdf(
  blocks: readonly PdfBlock[],
  meta: PdfDocumentMeta,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };

  pdf.setTitle(toPdfText(`${meta.title} v${meta.version}${meta.draft ? " (draft)" : ""}`));
  if (meta.mspName !== null && meta.mspName !== "") pdf.setAuthor(toPdfText(meta.mspName));
  pdf.setProducer("Standard-MSA");
  pdf.setCreator("Standard-MSA");
  pdf.setCreationDate(meta.generatedAt);
  pdf.setModificationDate(meta.generatedAt);

  const cursor = new Cursor(pdf);
  drawCover(cursor, meta, fonts);
  for (const block of blocks) drawBlock(cursor, block, fonts);
  drawFooters(cursor.pages, meta, fonts);

  // Plain objects rather than object streams: a compressed cross-reference
  // stream would make the text unreadable to the byte-level tests, and the
  // size difference on a text-only agreement is a few hundred bytes.
  return pdf.save({ useObjectStreams: false });
}

/**
 * The download filename.
 *
 * Built from the slug — already lowercase-kebab by `DOCUMENT_SLUG_RE` — plus
 * the version, so an operator who downloads four versions gets four files
 * rather than four copies of one name. Anything the slug rule would not
 * allow is replaced rather than trusted, because this string ends up in a
 * `Content-Disposition` header.
 */
export function pdfFilename(slug: string, version: number, draft: boolean): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = safe === "" ? "document" : safe;
  return `${stem}-v${version}${draft ? "-draft" : ""}.pdf`;
}
