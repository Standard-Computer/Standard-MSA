// The PDF renderer (GH #22 / SHA-4505): the pure block flattening, the
// WinAnsi degradation rule, and the rendered bytes themselves.
//
// pdf-lib Flate-compresses content streams and hex-encodes drawn strings,
// so the byte-level assertions go through ./_pdfText's extractor: the
// generic client wording IS drawn, a raw {{token}} NEVER is, and a draft
// says so.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agreementPdfFilename,
  encodableText,
  pdfBlocks,
  renderAgreementPdf,
} from "../../src/lib/legal/pdf";
import { renderLegalBody, hasRawTokens, type MspValues } from "../../src/lib/legal/variables";
import { STARTER_TEMPLATES } from "../../src/lib/legal/templates";
import { pdfText } from "./_pdfText";

const MSP: MspValues = {
  mspName: "Standard Computer",
  mspLegalName: "Standard Computer LLC",
  mspAddress: "123 Main St, Lincoln, NE",
  mspOwnerName: "Sean",
  mspEmail: "ops@example.com",
  mspWebsite: "https://example.com",
  venue: "Nebraska",
};

const magic = (bytes: Uint8Array): string => Buffer.from(bytes.slice(0, 8)).toString("latin1");

// ── Block flattening ────────────────────────────────────────────────────────

test("headings clamp to 1-3, bold text becomes bold runs", () => {
  const blocks = pdfBlocks("# One\n\n#### Four\n\nplain **bold** *italic*");
  assert.equal(blocks[0].kind, "heading");
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].kind, "heading");
  assert.equal(blocks[1].level, 3, "h4+ folds onto 3, as in the embed");
  const para = blocks[2];
  assert.deepEqual(
    para.runs.map((r) => [r.text, r.bold, r.italic]),
    [
      ["plain ", false, false],
      ["bold", true, false],
      [" ", false, false],
      ["italic", false, true],
    ],
  );
});

test("ordered lists keep their numbers, start included; bullets get a dot", () => {
  const blocks = pdfBlocks("7. seventh\n8. eighth\n\n- a\n- b");
  assert.deepEqual(
    blocks.map((b) => b.marker),
    ["7.", "8.", "•", "•"],
    "a clause list starting at 7 is a cross reference, never renumbered",
  );
  assert.ok(blocks.every((b) => b.indent > 0), "list items are indented");
});

test("nested list content indents deeper than its parent", () => {
  const blocks = pdfBlocks("- outer\n  - inner");
  assert.equal(blocks.length, 2);
  assert.ok(blocks[1].indent > blocks[0].indent);
});

test("raw HTML has no path into the PDF; images render as a visible omission", () => {
  const blocks = pdfBlocks('<script>alert(1)</script>\n\nBefore ![logo](https://evil.test/x.png) after');
  const text = blocks.flatMap((b) => b.runs.map((r) => r.text)).join("");
  assert.ok(!text.includes("script"), "an html node contributes nothing");
  assert.ok(!text.includes("evil.test"), "an image URL is never fetched nor printed");
  assert.ok(text.includes("[image omitted: logo]"));
});

test("links keep their label and only their label", () => {
  const blocks = pdfBlocks("See [our site](https://example.com) here");
  const text = blocks.flatMap((b) => b.runs.map((r) => r.text)).join("");
  assert.equal(text, "See our site here");
});

// ── WinAnsi degradation ─────────────────────────────────────────────────────

test("unencodable characters degrade to visible '?', never a throw", () => {
  const winAnsi = new Set([..."abcdefgh ?-"].map((c) => c.codePointAt(0) as number));
  const canEncode = (ch: string) => winAnsi.has(ch.codePointAt(0) ?? -1);
  assert.equal(encodableText("ab → cd", canEncode), "ab ? cd", "arrow becomes ?");
  assert.equal(encodableText("a b", canEncode), "a b", "nbsp becomes a space");
  assert.equal(encodableText("a−b", canEncode), "a-b", "minus sign becomes a hyphen");
  assert.equal(encodableText("a\nb", canEncode), "a\nb", "newlines survive for the wrapper");
});

// ── Rendered bytes ──────────────────────────────────────────────────────────

test("a published agreement renders: %PDF magic, title, version, generic wording, no tokens", async () => {
  const rendered = renderLegalBody(
    "## Agreement\n\nProvided to {{client_name}}.\n\nBy {{msp_name}}.",
    "public",
    MSP,
  );
  assert.ok(!hasRawTokens(rendered));
  const bytes = await renderAgreementPdf(
    { title: "Test Agreement", version: 3, effectiveDate: "2026-11-01", draft: false },
    rendered,
  );
  assert.ok(magic(bytes).startsWith("%PDF-"), "magic bytes");
  const text = pdfText(bytes);
  assert.ok(text.includes("Test Agreement"), "title is drawn");
  assert.ok(text.includes("Version 3"), "version is drawn");
  assert.ok(text.includes("Effective 2026-11-01"), "effective date is drawn");
  assert.ok(text.includes("the Client."), "generic client wording is drawn");
  assert.ok(text.includes("Standard Computer"), "MSP identity is filled");
  assert.ok(!text.includes("{{"), "no raw token reaches the bytes");
  assert.ok(!text.includes("DRAFT"), "a published version is not marked draft");
});

test("a draft is clearly labelled as one", async () => {
  const bytes = await renderAgreementPdf(
    { title: "Test Agreement", version: 4, effectiveDate: null, draft: true },
    "Draft body.",
  );
  const text = pdfText(bytes);
  assert.ok(text.includes("DRAFT"), "the draft marker is drawn");
  assert.ok(text.includes("not published"));
});

test("every starter template survives the full public-mode PDF pipeline", async () => {
  for (const t of STARTER_TEMPLATES) {
    const rendered = renderLegalBody(t.bodyMarkdown, "public", MSP, t.variables);
    const bytes = await renderAgreementPdf(
      { title: t.title, version: 1, effectiveDate: "2026-11-01", draft: false },
      rendered,
    );
    assert.ok(magic(bytes).startsWith("%PDF-"), `${t.slug}: magic bytes`);
    const text = pdfText(bytes);
    assert.ok(!text.includes("{{"), `${t.slug}: no raw token in the bytes`);
    // A long agreement paginates, and every page carries its number.
    assert.ok(text.includes("Page 1 of"), `${t.slug}: page footer drawn`);
  }
});

test("filenames: slug-vN.pdf, drafts say so", () => {
  assert.equal(agreementPdfFilename("msa", 3, false), "msa-v3.pdf");
  assert.equal(agreementPdfFilename("website-terms", 1, true), "website-terms-v1-draft.pdf");
});
