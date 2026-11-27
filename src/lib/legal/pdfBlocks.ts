// A legal body's Markdown as PDF layout blocks (SHA-4501). PURE.
//
// The sibling of ./embedMarkdown.ts, which turns the same AST into HTML for
// the embed and the public /legal pages. Both walk remark's output; neither
// re-tokenises a contract's numbered clauses, and neither has a branch for
// the node types it refuses to render.
//
// Split out from the drawing code on purpose: everything that decides WHAT a
// page says is here and is testable with no PDF library, no fonts and no
// bytes. ./pdfRender.ts decides only where the text sits.
//
// Three renderer-specific decisions, all of them about not losing words:
//
//   1. A link keeps its label, and gains its URL in parentheses when the two
//      differ. A PDF is read on paper and the href is otherwise lost, which
//      matters for an agreement that points at a policy by URL. The URL is
//      vetted by the same safeUrl() the HTML renderer uses, so a
//      `javascript:` href is dropped there as here.
//   2. An image is not drawn — the same refusal as the embed, for the same
//      reason (an agreement body is text; a remote fetch is not ours to
//      make) — and leaves the visible "[image omitted: alt]" the HTML
//      surface leaves.
//   3. Unknown node types fall through to their text content. Visible and
//      inert, never dropped.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

import { safeUrl } from "./embedMarkdown";
import { toPdfText } from "./pdfText";

const PROCESSOR = unified().use(remarkParse).use(remarkGfm);

/** A styled span of text. Styles map to the base-14 font variants. */
export interface PdfRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Inline code and code blocks: drawn in Courier. */
  readonly mono?: boolean;
}

export type PdfBlock =
  /** Levels 1-3, matching the embed's h1-h3 fold. */
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly runs: readonly PdfRun[] }
  | { readonly kind: "paragraph"; readonly runs: readonly PdfRun[] }
  /** One list item's first paragraph; `depth` is its nesting level from 0. */
  | {
      readonly kind: "listItem";
      readonly depth: number;
      readonly marker: string;
      readonly runs: readonly PdfRun[];
    }
  | { readonly kind: "quote"; readonly runs: readonly PdfRun[] }
  | { readonly kind: "code"; readonly lines: readonly string[] }
  | { readonly kind: "rule" }
  | {
      readonly kind: "tableRow";
      readonly header: boolean;
      readonly cells: readonly (readonly PdfRun[])[];
    };

type Style = { bold: boolean; italic: boolean; mono: boolean };

const PLAIN: Style = { bold: false, italic: false, mono: false };

function push(runs: PdfRun[], text: string, style: Style): void {
  if (text === "") return;
  const drawable = toPdfText(text);
  if (drawable === "") return;
  const last = runs[runs.length - 1];
  // Merged with the previous run when the style matches, so a sentence split
  // across mdast text nodes measures as one string rather than as fragments
  // that could wrap mid-word.
  if (
    last !== undefined &&
    (last.bold ?? false) === style.bold &&
    (last.italic ?? false) === style.italic &&
    (last.mono ?? false) === style.mono
  ) {
    runs[runs.length - 1] = { ...last, text: last.text + drawable };
    return;
  }
  runs.push({
    text: drawable,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.mono ? { mono: true } : {}),
  });
}

const joinedText = (runs: readonly PdfRun[]): string => runs.map((r) => r.text).join("");

const joinedLength = (runs: readonly PdfRun[]): number =>
  runs.reduce((total, r) => total + r.text.length, 0);

function inlineInto(nodes: readonly PhrasingContent[] | undefined, style: Style, runs: PdfRun[]): void {
  if (!nodes) return;
  for (const n of nodes) inlineOne(n, style, runs);
}

function inlineOne(n: PhrasingContent, style: Style, runs: PdfRun[]): void {
  switch (n.type) {
    case "text":
      push(runs, n.value, style);
      return;
    case "strong":
      inlineInto(n.children, { ...style, bold: true }, runs);
      return;
    case "emphasis":
      inlineInto(n.children, { ...style, italic: true }, runs);
      return;
    case "delete":
      // No strike-through in a base-14 font, and a PDF cannot be hovered to
      // see what was struck: the words stay, bracketed, so the reader can
      // tell the document says they were removed.
      push(runs, "[struck: ", style);
      inlineInto(n.children, style, runs);
      push(runs, "]", style);
      return;
    case "inlineCode":
      push(runs, n.value, { ...style, mono: true });
      return;
    case "break":
      // A hard break inside a paragraph becomes a space: the block is one
      // wrapped paragraph here, and an empty line would read as a new clause.
      push(runs, " ", style);
      return;
    case "link": {
      const href = safeUrl(n.url);
      // Measured in CHARACTERS, not in runs: `push` merges a same-styled run
      // into its predecessor, so the link's label frequently lands inside
      // the run that holds the words before it ("Write to " + the address)
      // and a run-index slice would come back empty.
      const before = joinedLength(runs);
      inlineInto(n.children, style, runs);
      const label = joinedText(runs).slice(before);
      // A refused URL keeps its label and nothing else — the same answer the
      // HTML renderer gives. A URL that IS the label is not repeated.
      if (href !== null && urlKey(toPdfText(href)) !== urlKey(label)) {
        push(runs, ` (${href})`, style);
      }
      return;
    }
    case "image":
      push(runs, `[image omitted: ${n.alt || "untitled"}]`, style);
      return;
    // `html` is deliberately absent, as in ./embedMarkdown.ts: raw HTML in a
    // body cannot reach a page because no branch emits it.
    default:
      if ("children" in n && Array.isArray(n.children)) {
        inlineInto(n.children as PhrasingContent[], style, runs);
      }
      return;
  }
}

/**
 * A URL as it compares against a link's own label.
 *
 * `<legal@example.test>` autolinks to `mailto:legal@example.test` with the
 * bare address as its label, and a GFM `www.` autolink gains an `http://`.
 * Printing the href next to a label that already IS the href is noise, so
 * the scheme and a trailing slash come off both sides before they are
 * compared. Lowercased because a host is case-insensitive; the printed URL
 * is always the original.
 */
function urlKey(value: string): string {
  return value
    .trim()
    .replace(/^(?:mailto:|tel:|https?:\/\/)/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function runsOf(nodes: readonly PhrasingContent[] | undefined): PdfRun[] {
  const runs: PdfRun[] = [];
  inlineInto(nodes, PLAIN, runs);
  return runs;
}

/** `1.`, `2.` … for an ordered list honouring `start`; a bullet otherwise. */
function listMarker(ordered: boolean, start: number, index: number): string {
  return ordered ? `${start + index}.` : "•";
}

function blockInto(n: RootContent, depth: number, out: PdfBlock[]): void {
  switch (n.type) {
    case "heading":
      out.push({
        kind: "heading",
        level: Math.min(n.depth, 3) as 1 | 2 | 3,
        runs: runsOf(n.children),
      });
      return;
    case "paragraph":
      out.push({ kind: "paragraph", runs: runsOf(n.children) });
      return;
    case "list": {
      // `start` is honoured for the same reason the HTML renderer honours it:
      // a clause list beginning at 7 is a cross-reference in the surrounding
      // prose, and renumbering it from 1 changes what the document says.
      const start = n.ordered && typeof n.start === "number" ? n.start : 1;
      n.children.forEach((item, index) => {
        const marker = listMarker(n.ordered === true, start, index);
        item.children.forEach((child, childIndex) => {
          if (child.type === "paragraph" && childIndex === 0) {
            out.push({ kind: "listItem", depth, marker, runs: runsOf(child.children) });
            return;
          }
          // Continuation paragraphs and nested lists indent one level and
          // carry no marker of their own.
          blockInto(child, depth + 1, out);
        });
      });
      return;
    }
    case "blockquote":
      for (const child of n.children) {
        if (child.type === "paragraph") {
          out.push({ kind: "quote", runs: runsOf(child.children) });
          continue;
        }
        blockInto(child, depth, out);
      }
      return;
    case "thematicBreak":
      out.push({ kind: "rule" });
      return;
    case "code":
      out.push({ kind: "code", lines: n.value.split("\n").map((l) => toPdfText(l)) });
      return;
    case "table": {
      const [head, ...body] = n.children;
      if (head) {
        out.push({
          kind: "tableRow",
          header: true,
          cells: head.children.map((c) => runsOf(c.children)),
        });
      }
      for (const row of body) {
        out.push({
          kind: "tableRow",
          header: false,
          cells: row.children.map((c) => runsOf(c.children)),
        });
      }
      return;
    }
    default:
      if ("children" in n && Array.isArray(n.children)) {
        const runs = runsOf(n.children as PhrasingContent[]);
        if (runs.length > 0) out.push({ kind: "paragraph", runs });
      }
      return;
  }
}

/**
 * A rendered legal body (Markdown, tokens already resolved) as layout blocks.
 *
 * The input is what `renderLegalBody` returned, NOT a raw stored body: this
 * module never sees a `{{token}}`, which is why no mode argument reaches it
 * and why no call site here can leak a recipient value.
 */
export function markdownToPdfBlocks(source: string): PdfBlock[] {
  const tree = PROCESSOR.parse(source) as Root;
  const out: PdfBlock[] = [];
  for (const node of tree.children) blockInto(node, 0, out);
  return out;
}

/** Every character the blocks would draw, for assertions and previews. */
export function blocksPlainText(blocks: readonly PdfBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
      case "paragraph":
      case "quote":
        lines.push(b.runs.map((r) => r.text).join(""));
        break;
      case "listItem":
        lines.push(`${b.marker} ${b.runs.map((r) => r.text).join("")}`);
        break;
      case "code":
        lines.push(...b.lines);
        break;
      case "rule":
        break;
      case "tableRow":
        lines.push(b.cells.map((c) => c.map((r) => r.text).join("")).join(" | "));
        break;
    }
  }
  return lines.join("\n");
}
