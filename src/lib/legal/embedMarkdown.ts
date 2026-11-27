import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";
import { escapeHtml } from "./html";

// A legal body's Markdown as an HTML STRING, for the embed frame and the
// public /legal pages (SHA-2957; ported from ShadowPSA STA-9323).
//
// remark parses — the tokenisation of a contract's numbered clauses is not
// reimplemented here — and this file walks the small, known AST and emits
// tags for an EXPLICIT ALLOW-LIST of node types.
//
// That inversion matters: the usual posture is "raw HTML is not rendered
// because no plugin is configured for it" — correct, but it is a property of
// a plugin NOT being present, and the next person to add one re-opens it.
// Here an `html` node has no branch: raw HTML in a body is dropped because
// there is no code path that could emit it. Same for images, and
// `javascript:` URLs are refused by `safeUrl` below rather than by a library
// default.
//
// This matters more here than anywhere else in the app: the output is
// injected into a page on the MSP's own website, so an escaping hole would
// be their XSS, carrying their brand.
//
// Classes are `sm-l-*`, matching the <style> block in ./embedDocument.ts.

const PROCESSOR = unified().use(remarkParse).use(remarkGfm);

/**
 * URLs that may become an `href`: http, https, mailto and tel, plus relative
 * paths and fragments. Everything else — `javascript:`, `data:`,
 * `vbscript:` — yields null and the link renders as plain text with its
 * label intact, which keeps the clause readable instead of deleting words
 * out of a contract.
 *
 * Checked on the SCHEME rather than by trying to parse, because a relative
 * path is legitimate here and is not a parseable URL on its own.
 *
 * Exported for ./pdfBlocks.ts, which prints a link's URL next to its label.
 * One implementation, deliberately: a second copy of this predicate is how
 * one renderer quietly ends up with the laxer rule (the posture ./html.ts
 * states for the escaper).
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === "") return null;
  // Leading control characters and whitespace are how `java\nscript:` gets
  // past a naive scheme test.
  const cleaned = s.replace(/[\u0000-\u0020]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return s; // relative path or #fragment
  return ["http", "https", "mailto", "tel"].includes(scheme[1].toLowerCase()) ? s : null;
}

function attr(name: string, value: string): string {
  return ` ${name}="${escapeHtml(value)}"`;
}

/** Inline nodes. Anything not listed renders as its text content, never as markup. */
function inline(nodes: PhrasingContent[] | undefined): string {
  if (!nodes) return "";
  return nodes.map(inlineOne).join("");
}

function inlineOne(n: PhrasingContent): string {
  switch (n.type) {
    case "text":
      return escapeHtml(n.value);
    case "strong":
      return `<strong class="sm-l-strong">${inline(n.children)}</strong>`;
    case "emphasis":
      return `<em class="sm-l-em">${inline(n.children)}</em>`;
    case "delete":
      return `<del>${inline(n.children)}</del>`;
    case "inlineCode":
      return `<code class="sm-l-code">${escapeHtml(n.value)}</code>`;
    case "break":
      return "<br>";
    case "link": {
      const href = safeUrl(n.url);
      const body = inline(n.children);
      // A refused URL keeps its LABEL. Dropping the text would remove words
      // from an agreement, which is never ours to do.
      if (!href) return body;
      // target=_blank throughout: the embed is a panel inside somebody
      // else's page. Navigating the FRAME away would leave a stub sitting in
      // their layout with no way back, since their chrome is still around it
      // and their back button does not drive our frame.
      return `<a class="sm-l-a"${attr("href", href)} target="_blank" rel="noreferrer noopener">${body}</a>`;
    }
    case "image":
      // NOT rendered: an <img src> out of imported text would fire a request
      // from the MSP's website to an arbitrary host, which is a tracking
      // pixel we put on somebody else's page.
      return `<span class="sm-l-img-omitted">[image omitted: ${escapeHtml(n.alt || "untitled")}]</span>`;
    // `html` is deliberately absent — see the header. Raw HTML in a body
    // cannot be emitted because nothing here emits it.
    default:
      // A node type remark grows later renders as its text, which is the
      // safe default: visible, inert, and never markup.
      return "children" in n && Array.isArray(n.children) ? inline(n.children as PhrasingContent[]) : "";
  }
}

function block(n: RootContent): string {
  switch (n.type) {
    case "heading": {
      // h1-h3 are styled; deeper headings fold onto h3 rather than emitting
      // an unstyled h4 — a legal document that nests four deep is using
      // headings as emphasis, and the embed is a reading surface.
      const level = Math.min(n.depth, 3);
      return `<h${level} class="sm-l-h${level}">${inline(n.children)}</h${level}>`;
    }
    case "paragraph":
      return `<p class="sm-l-p">${inline(n.children)}</p>`;
    case "list": {
      const tag = n.ordered ? "ol" : "ul";
      const cls = n.ordered ? "sm-l-ol" : "sm-l-ul";
      // `start` is preserved: a clause list beginning at 7 is a cross
      // reference in the surrounding prose, and renumbering it from 1 would
      // change what the document says.
      const start = n.ordered && typeof n.start === "number" && n.start !== 1 ? attr("start", String(n.start)) : "";
      const items = n.children
        .map((li) => `<li class="sm-l-li">${li.children.map(block).join("")}</li>`)
        .join("");
      return `<${tag} class="${cls}"${start}>${items}</${tag}>`;
    }
    case "blockquote":
      return `<blockquote class="sm-l-quote">${n.children.map(block).join("")}</blockquote>`;
    case "thematicBreak":
      return `<hr class="sm-l-hr">`;
    case "code":
      return `<pre class="sm-l-pre"><code class="sm-l-code">${escapeHtml(n.value)}</code></pre>`;
    case "table": {
      const [head, ...body] = n.children;
      const cell = (c: { children: PhrasingContent[] }, tag: "th" | "td") =>
        `<${tag} class="sm-l-${tag}">${inline(c.children)}</${tag}>`;
      const thead = head
        ? `<thead><tr>${head.children.map((c) => cell(c, "th")).join("")}</tr></thead>`
        : "";
      const tbody = body.length
        ? `<tbody>${body.map((r) => `<tr>${r.children.map((c) => cell(c, "td")).join("")}</tr>`).join("")}</tbody>`
        : "";
      return `<div class="sm-l-table-wrap"><table class="sm-l-table">${thead}${tbody}</table></div>`;
    }
    // `html` absent on purpose, as inline. Footnote nodes fall through to the
    // text default rather than rendering a half-wired reference.
    default:
      return "children" in n && Array.isArray(n.children)
        ? `<p class="sm-l-p">${inline(n.children as PhrasingContent[])}</p>`
        : "";
  }
}

/** A published body's Markdown → the embed's HTML. */
export function markdownToEmbedHtml(source: string): string {
  const tree = PROCESSOR.parse(source) as Root;
  return `<div class="sm-l-body">${tree.children.map(block).join("")}</div>`;
}
