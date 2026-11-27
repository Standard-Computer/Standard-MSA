import { test } from "node:test";
import assert from "node:assert/strict";

import { blocksPlainText, markdownToPdfBlocks } from "../../src/lib/legal/pdfBlocks";
import { STARTER_TEMPLATES } from "../../src/lib/legal/templates";
import { hasRawTokens, parseVersionDefaults, renderLegalBody } from "../../src/lib/legal/variables";
import type { MspValues } from "../../src/lib/legal/variables";

// What a PDF page SAYS (SHA-4501). PURE — no PDF library, no fonts, no bytes.
//
// The layout half is tests/legal/pdfRender.test.ts. Everything here is about
// not losing or inventing words, which is the only thing that can make a
// downloaded agreement wrong rather than ugly.

const MSP: MspValues = {
  mspName: "Standard Computer",
  mspLegalName: "Standard Computer LLC",
  mspAddress: "17 Prairie Road, Lincoln, Nebraska",
  mspOwnerName: "Sean Kubin",
  mspEmail: "legal@standardcomputer.test",
  mspWebsite: "https://standardcomputer.test",
  venue: "Nebraska",
};

test("headings, paragraphs and clause numbering come through in order", () => {
  const blocks = markdownToPdfBlocks(
    "## Master Service Agreement\n\n### 1. Services\n\n1.1 The Provider will deliver.\n",
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "heading", "paragraph"],
  );
  assert.equal(blocksPlainText(blocks), "Master Service Agreement\n1. Services\n1.1 The Provider will deliver.");
});

test("bold and italic become runs, not lost emphasis and not literal asterisks", () => {
  const blocks = markdownToPdfBlocks("Between **Standard Computer LLC** and *the Client*.\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
  assert.deepEqual(
    runs.map((r) => [r.text, r.bold ?? false, r.italic ?? false]),
    [
      ["Between ", false, false],
      ["Standard Computer LLC", true, false],
      [" and ", false, false],
      ["the Client", false, true],
      [".", false, false],
    ],
  );
});

test("adjacent same-style text is merged into one run", () => {
  // Not cosmetic: a sentence split into fragments would be measured piecewise
  // and could wrap mid-word.
  const blocks = markdownToPdfBlocks("one two three four\n");
  const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, "one two three four");
});

test("a list keeps its markers, its `start` and its nesting", () => {
  const blocks = markdownToPdfBlocks(
    "7. Seventh clause\n8. Eighth clause\n\n- a bullet\n  - nested\n",
  );
  const items = blocks.filter((b) => b.kind === "listItem");
  assert.deepEqual(
    items.map((b) => (b.kind === "listItem" ? [b.marker, b.depth] : [])),
    // A list beginning at 7 is a cross-reference in the surrounding prose;
    // renumbering it from 1 would change what the document says.
    [
      ["7.", 0],
      ["8.", 0],
      ["•", 0],
      ["•", 1],
    ],
  );
});

test("a link keeps its label and gains its URL; a refused URL keeps the label alone", () => {
  const ok = blocksPlainText(markdownToPdfBlocks("See our [security policy](https://example.test/sec).\n"));
  assert.equal(ok, "See our security policy (https://example.test/sec).");

  // A PDF cannot be hovered, so an href that is dropped silently is a
  // cross-reference the reader cannot follow.
  const refused = blocksPlainText(markdownToPdfBlocks("See [the policy](javascript:alert(1)).\n"));
  assert.equal(refused, "See the policy.");
  assert.ok(!refused.includes("javascript"), "the refused scheme does not reach the page");

  // A URL that IS its own label is not printed twice — including the three
  // forms where the label and the href differ only by a scheme remark added.
  assert.equal(
    blocksPlainText(markdownToPdfBlocks("Write to <legal@example.test>.\n")),
    "Write to legal@example.test.",
  );
  assert.equal(
    blocksPlainText(markdownToPdfBlocks("See https://example.test/sec for details.\n")),
    "See https://example.test/sec for details.",
  );
  assert.equal(
    blocksPlainText(markdownToPdfBlocks("See www.example.test for details.\n")),
    "See www.example.test for details.",
  );
  // …but a label that says something else keeps the href, because that is
  // information a printed copy would otherwise lose.
  assert.equal(
    blocksPlainText(markdownToPdfBlocks("[Our policy](https://example.test/policy)\n")),
    "Our policy (https://example.test/policy)",
  );
});

test("raw HTML in a body cannot reach a page, and an image leaves a visible note", () => {
  const html = blocksPlainText(
    markdownToPdfBlocks('<script>alert(1)</script>\n\nClause <b>one</b> stands.\n'),
  );
  assert.ok(!html.includes("<script>"), "no raw HTML survives");
  assert.ok(!html.includes("alert(1)"), "nor its contents");
  assert.ok(html.includes("Clause"), "the real clause is still there");

  const image = blocksPlainText(markdownToPdfBlocks("![signature block](https://example.test/x.png)\n"));
  assert.equal(image, "[image omitted: signature block]");
});

test("struck text is bracketed rather than deleted", () => {
  // No strike-through in a base-14 font and no hover in a PDF: the words stay
  // and the document says they were struck.
  assert.equal(
    blocksPlainText(markdownToPdfBlocks("Fees are ~~due on receipt~~ due in 30 days.\n")),
    "Fees are [struck: due on receipt] due in 30 days.",
  );
});

test("a table becomes header-marked rows, cell by cell", () => {
  const blocks = markdownToPdfBlocks(
    "| Priority | Response |\n| --- | --- |\n| P1 | 1 hour |\n| P2 | 4 hours |\n",
  );
  const rows = blocks.filter((b) => b.kind === "tableRow");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => (r.kind === "tableRow" ? r.header : null)),
    [true, false, false],
  );
  assert.equal(blocksPlainText(blocks), "Priority | Response\nP1 | 1 hour\nP2 | 4 hours");
});

test("code, quotes and rules survive as themselves", () => {
  const blocks = markdownToPdfBlocks("> Quoted clause.\n\n    indented code\n\n---\n");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["quote", "code", "rule"],
  );
});

test("undrawable characters are already handled by the time a block exists", () => {
  // The sanitiser runs at block construction, so ./pdfRender.ts never
  // measures a string the font cannot encode.
  const text = blocksPlainText(markdownToPdfBlocks("Response ≤ 4 hours for 中文 clients.\n"));
  assert.equal(text, "Response <= 4 hours for ?? clients.");
});

// ── The templates, rendered the way every PDF surface renders them ──────────

test("every starter template renders in public mode with generic wording and no raw tokens", () => {
  for (const template of STARTER_TEMPLATES) {
    const rendered = renderLegalBody(
      template.bodyMarkdown,
      "public",
      MSP,
      parseVersionDefaults(JSON.stringify(template.variables)),
    );
    const text = blocksPlainText(markdownToPdfBlocks(rendered));

    assert.equal(hasRawTokens(text), false, `${template.slug}: a raw {{token}} reached the page`);
    assert.ok(!text.includes("[unset:"), `${template.slug}: an unresolved variable reached the page`);
    assert.ok(text.includes("Standard Computer"), `${template.slug}: the MSP identity filled`);
    // No sample client name anywhere: the generic prose is the only client
    // wording a no-known-client surface may show.
    assert.ok(!/Acme|Reyes|Example Dental/i.test(text), `${template.slug}: a sample client name`);
  }
});

test("the website-terms template is the no-known-client one: continued use, no signature block", () => {
  const template = STARTER_TEMPLATES.find((t) => t.slug === "website-terms");
  assert.ok(template, "the website terms template ships");
  assert.equal(template.kind, "website-terms");

  const rendered = renderLegalBody(
    template.bodyMarkdown,
    "public",
    MSP,
    parseVersionDefaults(JSON.stringify(template.variables)),
  );
  const text = blocksPlainText(markdownToPdfBlocks(rendered));

  // The ask, in Sean's words: "the website where it is continued usage =
  // acceptance".
  assert.match(text, /continued use of the site/i);
  assert.match(text, /is your acceptance/i);
  assert.match(text, /There is nothing to sign/i);

  // The MSA and the BAA both end in a signature block. This one must not:
  // there is no signer, so "the Client's authorized signatory" would describe
  // a signature nobody gives.
  assert.ok(
    !/authorized signatory/i.test(text),
    "no signer wording in a document accepted by use",
  );
  assert.ok(!/Accepted for the/i.test(text), "no countersignature block");

  // It must not claim to govern the services the MSA governs.
  assert.match(text, /not an offer of services/i);
  assert.match(text, /Master Service Agreement/i);

  // The notice period is a variable DEFAULT, never a hard-coded term.
  assert.equal(template.variables.terms_change_notice_days, "14");
  assert.match(text, /at least 14 days before it takes effect/i);
  assert.ok(
    template.bodyMarkdown.includes("{{terms_change_notice_days}}"),
    "the body reads the variable rather than the number",
  );
  // No price, rate or amount is hard-coded (the company standing bar).
  assert.ok(!/\$\s?\d/.test(template.bodyMarkdown), "no dollar amount in the body");
});

test("the signed templates still carry their signature block (the control)", () => {
  // Paired with the assertion above: if `blocksPlainText` stopped reporting
  // the end of a body, the "no signature block" test would pass vacuously.
  for (const slug of ["msa", "hipaa-baa"]) {
    const template = STARTER_TEMPLATES.find((t) => t.slug === slug);
    assert.ok(template, slug);
    const text = blocksPlainText(
      markdownToPdfBlocks(
        renderLegalBody(
          template.bodyMarkdown,
          "public",
          MSP,
          parseVersionDefaults(JSON.stringify(template.variables)),
        ),
      ),
    );
    assert.match(text, /authorized signatory/i, `${slug} is a signed agreement`);
  }
});
