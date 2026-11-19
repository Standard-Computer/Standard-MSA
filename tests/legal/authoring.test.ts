// SHA-3086: the pure authoring rules, and the starter templates held to the
// same bar as any body an operator writes — they must render cleanly
// through the real public-mode pipeline with NO raw {{token}} surviving,
// and must never smuggle in a hard-coded price.

import "../email/setup";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENT_SLUG_RE,
  documentKindLabel,
  isValidDocumentSlug,
  nextVersionNumber,
  openDraft,
  serializeVersionDefaults,
} from "../../src/lib/legal/authoringRules";
import { STARTER_TEMPLATES, starterTemplate, TEMPLATE_DISCLAIMER } from "../../src/lib/legal/templates";
import {
  hasRawTokens,
  parseVersionDefaults,
  renderLegalBody,
  type MspValues,
} from "../../src/lib/legal/variables";
import { markdownToEmbedHtml } from "../../src/lib/legal/embedMarkdown";

// ── Slug rules ──────────────────────────────────────────────────────────────

test("slugs: lowercase kebab only, 1-80 chars, no edge hyphens", () => {
  for (const good of ["msa", "hipaa-baa", "a", "a1", "terms-2026", "x".repeat(80)]) {
    assert.ok(isValidDocumentSlug(good), `${good} should be valid`);
  }
  for (const bad of ["", "MSA", "msa ", " msa", "-msa", "msa-", "msa_baa", "a/b", "a.b", "x".repeat(81), 42, null]) {
    assert.ok(!isValidDocumentSlug(bad), `${String(bad)} should be invalid`);
  }
});

test("the API schema admits nothing the rules reject, except the edge-hyphen case the handler re-checks", async () => {
  // schemas.ts cannot import authoringRules (PURE layering keeps zod out of
  // the legal module), so the character-class pattern is written twice; this
  // pins them together. The edge-hyphen rule lives in isValidDocumentSlug,
  // which every create path calls.
  const { DocumentCreateSchema } = await import("../../src/lib/api/schemas");
  assert.ok(DocumentCreateSchema.safeParse({ slug: "hipaa-baa", title: "t" }).success);
  assert.ok(!DocumentCreateSchema.safeParse({ slug: "HIPAA", title: "t" }).success);
  assert.ok(!DocumentCreateSchema.safeParse({ slug: "a b", title: "t" }).success);
  assert.ok(!DocumentCreateSchema.safeParse({ slug: "x".repeat(81), title: "t" }).success);
  assert.ok(DOCUMENT_SLUG_RE.test("hipaa-baa") && !DOCUMENT_SLUG_RE.test("a b"));
});

// ── Draft and version arithmetic ────────────────────────────────────────────

test("openDraft finds the unpublished version; nextVersionNumber counts past drafts", () => {
  const published = { version: 1, publishedAt: new Date() };
  const draft = { version: 2, publishedAt: null };
  assert.equal(openDraft([published]), null);
  assert.equal(openDraft([draft, published]), draft);
  assert.equal(nextVersionNumber([]), 1);
  assert.equal(nextVersionNumber([published]), 2);
  // Drafts count too: a draft v2 means the next version is 3, so numbers
  // never collide even across discard-and-recreate.
  assert.equal(nextVersionNumber([draft, published]), 3);
});

test("serializeVersionDefaults round-trips through parseVersionDefaults, lowercased", () => {
  const stored = serializeVersionDefaults({ Payment_Terms_Days: "30", n: "x" });
  assert.deepEqual(parseVersionDefaults(stored), { payment_terms_days: "30", n: "x" });
});

test("kind labels: known kinds get prose, unknown kinds pass through", () => {
  assert.equal(documentKindLabel("msa"), "Master Service Agreement");
  assert.equal(documentKindLabel("hipaa-baa"), "HIPAA Business Associate Agreement");
  assert.equal(documentKindLabel("nda"), "nda");
});

// ── Starter templates ───────────────────────────────────────────────────────

const FULL_IDENTITY: MspValues = {
  mspName: "Standard Computer",
  mspLegalName: "Standard Computer LLC",
  mspAddress: "123 Main St, Lincoln, NE",
  mspOwnerName: "Sean",
  mspEmail: "ops@example.com",
  mspWebsite: "https://example.com",
  venue: "Nebraska",
};

const BLANK_IDENTITY: MspValues = {
  mspName: "Acme MSP",
  mspLegalName: null,
  mspAddress: null,
  mspOwnerName: null,
  mspEmail: null,
  mspWebsite: null,
  venue: null,
};

test("both SHA-2970 documents ship: an MSA and a HIPAA BAA", () => {
  assert.deepEqual(
    STARTER_TEMPLATES.map((t) => t.kind).sort(),
    ["hipaa-baa", "msa"],
  );
  assert.equal(starterTemplate("msa")?.title, "Master Service Agreement");
  assert.equal(starterTemplate("hipaa-baa")?.title, "HIPAA Business Associate Agreement");
  assert.equal(starterTemplate("nope"), null);
  assert.match(TEMPLATE_DISCLAIMER, /not legal advice/);
});

test("every template renders through the public pipeline with no raw tokens and no unset blanks", () => {
  for (const t of STARTER_TEMPLATES) {
    assert.ok(DOCUMENT_SLUG_RE.test(t.slug), `${t.slug} must be a valid slug`);
    const rendered = renderLegalBody(t.bodyMarkdown, "public", FULL_IDENTITY, t.variables);
    assert.ok(!hasRawTokens(rendered), `${t.slug}: raw {{token}} survived rendering`);
    // With a full identity and the template's own defaults, nothing may
    // render as a labelled blank — every token the template uses must be
    // MSP-sourced, client-generic, or defaulted by the template itself.
    const blankAt = rendered.indexOf("[unset:");
    assert.ok(
      blankAt === -1,
      `${t.slug}: template uses a token with no source near "…${rendered.slice(Math.max(0, blankAt - 40), blankAt + 30)}…"`,
    );
    // And it must actually be renderable markdown that produces headings.
    const html = markdownToEmbedHtml(rendered);
    assert.ok(html.includes("<h2"), `${t.slug}: expected section headings in rendered HTML`);
  }
});

test("templates degrade to visible-but-inert blanks, never silently, on an empty identity", () => {
  for (const t of STARTER_TEMPLATES) {
    const rendered = renderLegalBody(t.bodyMarkdown, "public", BLANK_IDENTITY, t.variables);
    assert.ok(!hasRawTokens(rendered), `${t.slug}: raw {{token}} survived rendering`);
    // msp_address / venue / msp_email have no fallback: they must show as
    // labelled blanks the preview flags, not vanish into prose.
    assert.ok(rendered.includes("[unset:"), `${t.slug}: expected labelled blanks with a blank identity`);
  }
});

test("no hard-coded dollar amounts or percentages in template prose", () => {
  for (const t of STARTER_TEMPLATES) {
    assert.ok(!/[$€£]\s?\d/.test(t.bodyMarkdown), `${t.slug}: currency amount in template`);
    assert.ok(!/\d\s?%/.test(t.bodyMarkdown), `${t.slug}: percentage in template`);
    // Numeric terms live in editable defaults, not prose: every default the
    // template declares is actually referenced by its body.
    for (const key of Object.keys(t.variables)) {
      assert.ok(t.bodyMarkdown.includes(`{{${key}}}`), `${t.slug}: unused default ${key}`);
    }
  }
});
