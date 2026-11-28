import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownToPdfBlocks } from "../../src/lib/legal/pdfBlocks";
import { pdfFilename, renderPdf, type PdfDocumentMeta } from "../../src/lib/legal/pdfRender";
import { STARTER_TEMPLATES } from "../../src/lib/legal/templates";
import { parseVersionDefaults, renderLegalBody } from "../../src/lib/legal/variables";
import type { MspValues } from "../../src/lib/legal/variables";
import { pdfDrawnStrings, pdfPageCount, pdfText } from "./_pdfReadback";

// The bytes (SHA-4501). Asserted by reading the text back OUT of them — see
// ./_pdfReadback.ts — because a test against the block list would pass with
// the renderer deleted.

const GENERATED_AT = new Date("2026-11-27T12:00:00Z");

const MSP: MspValues = {
  mspName: "Standard Computer",
  mspLegalName: "Standard Computer LLC",
  mspAddress: "17 Prairie Road, Lincoln, Nebraska",
  mspOwnerName: "Sean Kubin",
  mspEmail: "legal@standardcomputer.test",
  mspPhone: "555-0100",
  mspWebsite: "https://standardcomputer.test",
  venue: "Nebraska",
};

const meta = (over: Partial<PdfDocumentMeta> = {}): PdfDocumentMeta => ({
  title: "Master Service Agreement",
  version: 2,
  effectiveDate: "2026-11-01",
  draft: false,
  mspName: "Standard Computer",
  sourceUrl: "https://msa.example.test/legal/msa/2",
  generatedAt: GENERATED_AT,
  ...over,
});

const publicBody = (slug: string): string => {
  const template = STARTER_TEMPLATES.find((t) => t.slug === slug);
  assert.ok(template, slug);
  return renderLegalBody(
    template.bodyMarkdown,
    "public",
    MSP,
    parseVersionDefaults(JSON.stringify(template.variables)),
  );
};

test("the output is a PDF file, structurally", async () => {
  const bytes = await renderPdf(markdownToPdfBlocks("## Terms\n\nOne clause.\n"), meta());
  const head = Buffer.from(bytes.slice(0, 8)).toString("latin1");
  assert.match(head, /^%PDF-1\.\d/, "a PDF header");
  const tail = Buffer.from(bytes.slice(-16)).toString("latin1");
  assert.match(tail, /%%EOF\s*$/, "a PDF trailer");
  assert.ok(bytes.byteLength > 1000, `not a stub: ${bytes.byteLength} bytes`);
});

test("the cover carries the title, the version and the effective date", async () => {
  const text = pdfText(await renderPdf(markdownToPdfBlocks("One clause.\n"), meta()));
  assert.match(text, /Master Service Agreement/);
  assert.match(text, /Version 2/);
  assert.match(text, /effective 2026-11-01/);
  assert.match(text, /Standard Computer/);
  assert.match(text, /msa\.example\.test\/legal\/msa\/2/);
});

test("a DRAFT says so on the cover, in the footer and in its filename", async () => {
  const bytes = await renderPdf(
    markdownToPdfBlocks("Unpublished text.\n"),
    meta({ draft: true, effectiveDate: null, version: 3 }),
  );
  const strings = pdfDrawnStrings(bytes);
  const draftMarks = strings.filter((s) => s.includes("DRAFT"));
  // Once on the cover and once per page footer: a draft that reads as an
  // agreement in force is the one way this download could mislead somebody.
  assert.ok(draftMarks.length >= 2, `expected a cover and a footer mark, got ${draftMarks.length}`);
  assert.match(pdfText(bytes), /DRAFT - NOT PUBLISHED/);
  assert.equal(pdfFilename("msa", 3, true), "msa-v3-draft.pdf");
  // A draft cites no source URL even when the caller passes one — the
  // /legal path it would name does not serve the draft. `meta()` supplies a
  // sourceUrl by default, so this is asserting the renderer's refusal and
  // not the absence of an argument.
  assert.ok(meta({ draft: true }).sourceUrl !== null, "the fixture really does pass a URL");
  assert.ok(!pdfText(bytes).includes("/legal/"), "a draft advertises no public URL");
  // The published control: the same cover DOES cite it.
  assert.ok(pdfText(await renderPdf(markdownToPdfBlocks("x\n"), meta())).includes("/legal/msa/2"));
});

test("the rendered agreement text really is in the bytes, in order", async () => {
  const bytes = await renderPdf(markdownToPdfBlocks(publicBody("msa")), meta());
  const text = pdfText(bytes);
  for (const phrase of [
    "Master Service Agreement",
    "Standard Computer LLC",
    "Services",
    "Term and Termination",
    "Limitation of Liability",
    "Acceptance",
  ]) {
    assert.ok(text.includes(phrase), `the PDF says "${phrase}"`);
  }
  const first = text.indexOf("Services");
  const last = text.indexOf("Limitation of Liability");
  assert.ok(first < last && first !== -1, "clauses are drawn in document order");
});

test("public mode reaches the page as generic wording, never a token or a client name", async () => {
  // Criterion A3/A6: the no-known-client surfaces render in `public` mode, so
  // the client/signer tokens must arrive as the generic prose.
  const bytes = await renderPdf(markdownToPdfBlocks(publicBody("msa")), meta());
  const text = pdfText(bytes);
  assert.ok(text.includes("the Client"), "the generic client wording is on the page");
  assert.ok(
    text.includes("the Client's authorized signatory") || text.includes("authorized signatory"),
    "and the generic signer wording",
  );
  assert.ok(!text.includes("{{"), "no raw {{token}} survived");
  assert.ok(!text.includes("[unset:"), "no unresolved variable survived");
  // The MSP side DID fill, so the assertion above is not passing because the
  // page is empty.
  assert.ok(text.includes("Standard Computer LLC"), "the MSP identity filled");
});

test("the website terms render as a continued-use document with no signature block", async () => {
  const text = pdfText(await renderPdf(markdownToPdfBlocks(publicBody("website-terms")), meta({
    title: "Website Terms of Use",
    version: 1,
  })));
  assert.match(text, /Website Terms of Use/);
  assert.match(text, /continued use of the site/i);
  assert.ok(!text.includes("authorized signatory"), "nobody signs website terms");
  assert.ok(!text.includes("{{"), "no raw token");
});

test("a long body paginates, and every page is numbered with the real total", async () => {
  const long = Array.from({ length: 120 }, (_, i) => `${i + 1}.1 A clause of ordinary length that wraps across the measured width of the page.`).join("\n\n");
  const bytes = await renderPdf(markdownToPdfBlocks(long), meta());
  const pages = pdfPageCount(bytes);
  assert.ok(pages >= 3, `expected several pages, got ${pages}`);
  const text = pdfText(bytes);
  // "of N" is written after every page exists, so N is the real total rather
  // than a guess made while laying out page 1.
  for (let i = 1; i <= pages; i++) {
    assert.ok(text.includes(`Page ${i} of ${pages}`), `page ${i} is numbered`);
  }
  assert.ok(!text.includes(`Page ${pages + 1} of`), "no page beyond the total");
});

test("a word too long for a line is broken rather than run off the page", async () => {
  const word = "A".repeat(400);
  const bytes = await renderPdf(markdownToPdfBlocks(`${word}\n`), meta());
  const drawn = pdfDrawnStrings(bytes).filter((s) => s.startsWith("AAA"));
  assert.ok(drawn.length > 1, "the word was split across lines");
  assert.equal(drawn.join("").length, 400, "every character survived the break");
});

test("a table and a code block render without throwing", async () => {
  // Layout shapes with their own branches; the assertion is that the bytes
  // exist and the words are in them.
  const bytes = await renderPdf(
    markdownToPdfBlocks(
      "| Priority | Response |\n| --- | --- |\n| P1 | 1 hour |\n\n```\nverbatim text\n```\n\n> Quoted.\n\n---\n",
    ),
    meta(),
  );
  const text = pdfText(bytes);
  for (const phrase of ["Priority", "Response", "P1", "1 hour", "verbatim text", "Quoted."]) {
    assert.ok(text.includes(phrase), `the PDF says "${phrase}"`);
  }
});

test("a body full of characters WinAnsi cannot encode renders instead of throwing", async () => {
  // The regression this guards: pdf-lib throws on the first unencodable
  // character, so without src/lib/legal/pdfText.ts an operator pasting a
  // name in Chinese would 500 the download of their own agreement.
  const bytes = await renderPdf(
    markdownToPdfBlocks("## 中文标题\n\nResponse ≤ 4 hours. Client: 株式会社. Emoji \u{1F44D}.\n"),
    meta(),
  );
  const text = pdfText(bytes);
  assert.match(text, /Response <= 4 hours/);
  assert.ok(text.includes("?"), "the unrepresentable characters are visibly marked, not dropped");
  assert.ok(bytes.byteLength > 1000);
});

test("the same version renders the same bytes twice", async () => {
  // What makes the assertions above stable, and what `generatedAt` exists
  // for: nothing in the renderer reads the clock.
  const body = markdownToPdfBlocks(publicBody("msa"));
  const a = await renderPdf(body, meta());
  const b = await renderPdf(body, meta());
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  // …and a different timestamp is the only thing that changes.
  const c = await renderPdf(body, meta({ generatedAt: new Date("2027-01-01T00:00:00Z") }));
  assert.notDeepEqual(Buffer.from(a), Buffer.from(c));
  assert.equal(pdfText(a), pdfText(c), "the words do not depend on when it was made");
});

test("the filename is built from the slug and the version, and is header-safe", () => {
  assert.equal(pdfFilename("msa", 1, false), "msa-v1.pdf");
  assert.equal(pdfFilename("hipaa-baa", 12, false), "hipaa-baa-v12.pdf");
  assert.equal(pdfFilename("website-terms", 2, true), "website-terms-v2-draft.pdf");
  // A slug that never passes DOCUMENT_SLUG_RE still cannot inject a header:
  // the quote, the newline and the path are gone.
  assert.equal(pdfFilename('a"b\nc/../d', 1, false), "a-b-c-d-v1.pdf");
  assert.equal(pdfFilename("", 1, false), "document-v1.pdf");
  for (const name of [pdfFilename('x"\r\ny', 1, false), pdfFilename("../../etc/passwd", 9, true)]) {
    assert.ok(!/["\r\n\\/]/.test(name), `no header-breaking character in ${name}`);
  }
});
