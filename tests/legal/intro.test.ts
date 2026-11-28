// The public /legal intro (SHA-4708, GH #33 §1–§3; AC1–AC4, AC6, AC7).
//
// Pure units — no database, no Next request — because src/lib/legal/intro.ts
// is pure precisely so the page, the embed and these tests can all reach the
// same resolver. The two properties worth the most here are the ones a human
// reviewer cannot eyeball:
//
//   · NOTHING TOKEN-SHAPED SURVIVES. Not a raw {{token}}, not a labelled
//     [unset: …] blank. Asserted over every paragraph of every case below
//     via expectClean(), not only in the one test named after it, so a new
//     case cannot quietly introduce a leak.
//   · /legal AND THE EMBED AGREE. Asserted by resolving through both call
//     paths and comparing, which is the only way to notice the two surfaces
//     drifting apart.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LEGAL_INTRO,
  introPhoneValue,
  resolveFooterLines,
  resolveIntroParagraphs,
} from "../../src/lib/legal/intro";
import { assembleEmbedData, mspValuesFrom } from "../../src/lib/legal/embedAssemble";
import { embedDocumentHtml } from "../../src/lib/legal/embedDocument";
import { renderLegalBody, type MspValues } from "../../src/lib/legal/variables";
import type { ResolvedLegalSettings } from "../../src/lib/legal/settings";
import type { PublishedDocument } from "../../src/lib/legal/documents";

const FULL = mspValuesFrom({
  name: "Reyes IT",
  legalName: "Reyes IT LLC",
  address: "1 Main St, Lincoln NE",
  ownerName: "Ana Reyes",
  email: "ops@reyes.example",
  phone: "555-0100",
  website: "https://reyes.example",
  venue: "Nebraska",
});

/** No phone, but an email — the §3 fallback. */
const NO_PHONE = mspValuesFrom({
  name: "Reyes IT",
  legalName: null,
  address: null,
  ownerName: null,
  email: "ops@reyes.example",
  phone: null,
  website: null,
  venue: null,
});

/** Neither phone nor email — the clause must disappear entirely. */
const NO_CONTACT = mspValuesFrom({
  name: "Reyes IT",
  legalName: null,
  address: null,
  ownerName: null,
  email: null,
  phone: null,
  website: null,
  venue: null,
});

/** Skipped onboarding: name "" and nothing else. */
const SKIPPED = mspValuesFrom({
  name: "",
  legalName: null,
  address: null,
  ownerName: null,
  email: null,
  phone: null,
  website: null,
  venue: null,
});

/** The invariant every case shares (AC7). */
function expectClean(paragraphs: string[], label: string) {
  for (const p of paragraphs) {
    assert.ok(!/\{\{/.test(p), `${label}: raw token survived in ${JSON.stringify(p)}`);
    assert.ok(!/\}\}/.test(p), `${label}: stray braces in ${JSON.stringify(p)}`);
    assert.ok(!p.includes("[unset:"), `${label}: labelled blank leaked in ${JSON.stringify(p)}`);
    assert.ok(p.trim() === p, `${label}: untrimmed paragraph ${JSON.stringify(p)}`);
    assert.ok(p !== "", `${label}: empty paragraph survived`);
  }
}

// ── AC2: the shipped default names nobody ──────────────────────────────────

test("AC2: the default intro hard-codes no company name and no phone number", () => {
  assert.ok(!DEFAULT_LEGAL_INTRO.includes("Standard Computer"));
  assert.ok(!DEFAULT_LEGAL_INTRO.includes("501-224-0050"));
  assert.ok(!/\d{3}-\d{3}-\d{4}/.test(DEFAULT_LEGAL_INTRO), "no phone-shaped literal at all");
  // It carries the tokens instead — that is what makes it right for every
  // template install rather than for Sean's.
  assert.ok(DEFAULT_LEGAL_INTRO.includes("{{msp_name}}"));
  assert.ok(DEFAULT_LEGAL_INTRO.includes("{{msp_phone}}"));
  // Sean's four paragraphs, verbatim: one line each.
  assert.equal(DEFAULT_LEGAL_INTRO.split("\n").filter((l) => l.trim() !== "").length, 4);
});

test("AC2: a resolved default never prints a name or number that is not the install's", () => {
  const html = JSON.stringify(resolveIntroParagraphs(null, FULL));
  assert.ok(!html.includes("Standard Computer"));
  assert.ok(!html.includes("501-224-0050"));
  assert.ok(html.includes("Reyes IT"), "it shows THIS install's name");
  assert.ok(html.includes("555-0100"), "and THIS install's number");
});

// ── AC1 / AC6: the render-time fallback ────────────────────────────────────

test("AC6: null, empty and whitespace-only introText all fall back to the default", () => {
  const expected = resolveIntroParagraphs(DEFAULT_LEGAL_INTRO, FULL);
  for (const raw of [null, "", "   ", "\n\n", " \r\n \n "]) {
    const got = resolveIntroParagraphs(raw, FULL);
    assert.deepEqual(got, expected, `introText ${JSON.stringify(raw)} should use the default`);
    assert.equal(got.length, 4);
    expectClean(got, `fallback ${JSON.stringify(raw)}`);
  }
});

test("AC3/AC6: a custom intro wins, and is never mixed with the default", () => {
  const custom = "Our own words about {{msp_name}}.\nA second paragraph.";
  const got = resolveIntroParagraphs(custom, FULL);
  assert.deepEqual(got, ["Our own words about Reyes IT.", "A second paragraph."]);
  // None of Sean's copy leaks in alongside it.
  assert.ok(!got.join(" ").includes("Using Reyes IT services"));
  expectClean(got, "custom");
});

test("one paragraph per line; blank lines ignored, consistent with textLines()", () => {
  const got = resolveIntroParagraphs("  first  \n\n\n  second  \n", FULL);
  assert.deepEqual(got, ["first", "second"]);
});

// ── AC1 / §3: substitution ─────────────────────────────────────────────────

test("AC1: msp_name and msp_phone are substituted from current identity", () => {
  const got = resolveIntroParagraphs(null, FULL);
  assert.match(got[0], /^Using Reyes IT services means you accept these agreements\./);
  assert.ok(got[0].includes("every client relationship with Reyes IT"), "both occurrences");
  assert.equal(got[3], "If you don't accept these terms, stop using our services and contact us at 555-0100.");
  expectClean(got, "FULL");
});

test("§3: an empty phone falls back to msp_email", () => {
  assert.equal(introPhoneValue(NO_PHONE), "ops@reyes.example");
  const got = resolveIntroParagraphs(null, NO_PHONE);
  assert.equal(got[3], "If you don't accept these terms, stop using our services and contact us at ops@reyes.example.");
  expectClean(got, "NO_PHONE");
});

test("§3: with neither phone nor email the sentence ends at 'contact us.'", () => {
  assert.equal(introPhoneValue(NO_CONTACT), null);
  const got = resolveIntroParagraphs(null, NO_CONTACT);
  assert.equal(got[3], "If you don't accept these terms, stop using our services and contact us.");
  // The specific failures this guards: a dangling preposition, a double
  // space where the clause was, and a space before the full stop.
  assert.ok(!/\bat\s*\.?$/.test(got[3]), "no trailing 'at'");
  assert.ok(!got[3].includes("  "), "no double space");
  assert.ok(!/ \./.test(got[3]), "no space before the period");
  expectClean(got, "NO_CONTACT");
});

test("§3: an empty msp_name reads as 'the Service Provider', never a blank", () => {
  const got = resolveIntroParagraphs(null, SKIPPED);
  assert.ok(got[0].startsWith("Using the Service Provider services"));
  expectClean(got, "SKIPPED");
});

test("AC7: an operator's standalone {{msp_phone}} leaves no residue when unset", () => {
  // "at {{msp_phone}}" is elided; a bare token is not, so this is the case
  // the final sweep exists for.
  assert.deepEqual(resolveIntroParagraphs("Call {{msp_phone}} today.", NO_CONTACT), ["Call today."]);
  assert.deepEqual(resolveIntroParagraphs("Phone: {{msp_phone}}", NO_CONTACT), ["Phone:"]);
  // A paragraph that resolves to nothing at all is dropped, not blank.
  assert.deepEqual(resolveIntroParagraphs("{{msp_phone}}", NO_CONTACT), []);
});

test("AC7: an unknown or malformed token leaves no residue either", () => {
  for (const line of [
    "Ask about {{made_up_token}}.",
    "Ask about {{msp name}}.",
    "Ask about {{ msp-phone }}.",
    "Ask about {{}}.",
  ]) {
    const got = resolveIntroParagraphs(line, FULL);
    expectClean(got, line);
    assert.deepEqual(got, ["Ask about."], `for ${line}`);
  }
});

test("the document-body contract is UNCHANGED: bodies still show [unset: …]", () => {
  // The intro's sweep must not have been implemented by weakening the
  // renderer. Deleting words from an agreement is never ours to do.
  assert.equal(
    renderLegalBody("Ask about {{made_up_token}}.", "public", FULL),
    "Ask about [unset: made_up_token].",
  );
  // And {{msp_phone}} in a BODY is the phone field or a labelled blank —
  // never the email, which is the intro-only fallback.
  assert.equal(renderLegalBody("Call {{msp_phone}}.", "public", FULL), "Call 555-0100.");
  assert.equal(renderLegalBody("Call {{msp_phone}}.", "public", NO_PHONE), "Call [unset: msp_phone].");
});

// ── AC4: escaping ──────────────────────────────────────────────────────────

test("AC4: the resolver returns PLAIN TEXT — it does not escape, and must not", () => {
  // Escaping here would double-escape on /legal, where JSX escapes a text
  // child. The contract is "plain text out, each surface escapes once".
  assert.deepEqual(resolveIntroParagraphs("Tom & Jerry <b>hi</b>", FULL), ["Tom & Jerry <b>hi</b>"]);
});

test("AC4: a saved <script> is escaped in the embed's HTML, not executed", () => {
  const nasty = '<script>alert("xss")</script> and <img src=x onerror=1>';
  const html = embedHtmlWithIntro(nasty, FULL);
  assert.ok(!html.includes("<script>alert"), "no live script tag from the intro");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
});

test("AC4: an identity value containing '<' is escaped after substitution", () => {
  const sharp = mspValuesFrom({
    name: 'Reyes <script>alert(1)</script> IT',
    legalName: null,
    address: null,
    ownerName: null,
    email: null,
    phone: "<b>555</b>",
    website: null,
    venue: null,
  });
  // Substituted into plain text first...
  const paragraphs = resolveIntroParagraphs(null, sharp);
  assert.ok(paragraphs[0].includes("<script>"), "the value is merged as text");
  // ...then escaped exactly once by the surface.
  const html = embedHtmlWithIntro(null, sharp);
  assert.ok(!html.includes("<script>alert(1)</script>"), "never live markup");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;555&lt;/b&gt;"));
});

// ── AC7: /legal and the embed cannot disagree ──────────────────────────────

const SETTINGS = (introText: string | null, footerText: string | null = null): ResolvedLegalSettings => ({
  embedEnabled: true,
  embedOrigins: [],
  introText,
  footerText,
  accentColor: "#1d4ed8",
  visitRetentionDays: 365,
  hashVisitorIps: false,
  monitorEnabled: false,
  monitorUrl: null,
});

const PUBLISHED: PublishedDocument[] = [];

function embedHtmlWithIntro(introText: string | null, msp: MspValues): string {
  const data = assembleEmbedData("https://msa.example.com", PUBLISHED, SETTINGS(introText), msp);
  return embedDocumentHtml({
    docs: data.docs,
    introParagraphs: data.introParagraphs,
    footerLines: data.footerLines,
    accentColor: data.accentColor,
    theme: "auto",
    indexHref: data.indexHref,
    recordVisits: false,
  });
}

test("AC7: /legal and the embed receive IDENTICAL resolved paragraphs", () => {
  for (const [label, msp] of [
    ["full", FULL],
    ["no phone", NO_PHONE],
    ["no contact", NO_CONTACT],
    ["skipped", SKIPPED],
  ] as const) {
    for (const intro of [null, "", DEFAULT_LEGAL_INTRO, "Custom {{msp_name}} line.\nAnd {{msp_phone}}."]) {
      // What the page renders (it calls the resolver directly) …
      const onPage = resolveIntroParagraphs(intro, msp);
      // … and what the embed assembler puts in the frame.
      const inEmbed = assembleEmbedData("https://x.example", PUBLISHED, SETTINGS(intro), msp).introParagraphs;
      assert.deepEqual(inEmbed, onPage, `${label} / ${JSON.stringify(intro)} must match`);
      expectClean(onPage, `${label} page`);
      expectClean(inEmbed, `${label} embed`);
    }
  }
});

test("AC1: an install with no saved intro still gets four paragraphs on BOTH surfaces", () => {
  assert.equal(resolveIntroParagraphs(null, FULL).length, 4);
  assert.equal(
    assembleEmbedData("https://x.example", PUBLISHED, SETTINGS(null), FULL).introParagraphs.length,
    4,
  );
});

// ── §3 last paragraph: the footer takes the same path ──────────────────────

test("§3: footer lines get the same substitution — and NO default", () => {
  // The bug this pins: resolving the footer through the intro's resolver
  // would publish Sean's whole four-paragraph intro as a footer.
  assert.deepEqual(resolveFooterLines(null, FULL), []);
  assert.deepEqual(resolveFooterLines("", FULL), []);
  assert.deepEqual(resolveFooterLines("Questions? {{msp_phone}}", FULL), ["Questions? 555-0100"]);
  expectClean(resolveFooterLines("Questions? {{msp_phone}}", NO_CONTACT), "footer no contact");
});

test("§3: an EMPTY footer stays empty — the intro default must never leak into it", () => {
  // Caught by mutation: resolving the footer through the intro's resolver
  // (which defaults) publishes Sean's whole four-paragraph intro as the
  // footer of every install that has not written one.
  const data = assembleEmbedData("https://x.example", PUBLISHED, SETTINGS(null, null), FULL);
  assert.deepEqual(data.footerLines, ["Reyes IT", "1 Main St, Lincoln NE"]);
  for (const line of data.footerLines) {
    assert.ok(!line.includes("means you accept"), "no intro copy in the footer");
    assert.ok(!line.includes("version ID"), "no intro copy in the footer");
  }
  // Nothing at all to show, and no identity either: still empty.
  assert.deepEqual(
    assembleEmbedData("https://x.example", PUBLISHED, SETTINGS(null, null), SKIPPED).footerLines,
    [],
  );
});

test("§3: buildFooterLines keeps the name/address lines as values, then resolves the rest", () => {
  const data = assembleEmbedData(
    "https://x.example",
    PUBLISHED,
    SETTINGS(null, "Reach us on {{msp_phone}}.\n{{made_up}}"),
    FULL,
  );
  assert.deepEqual(data.footerLines, [
    "Reyes IT",
    "1 Main St, Lincoln NE",
    "Reach us on 555-0100.",
  ]);
  // The empty-resolving custom line was dropped rather than published blank.
  assert.ok(!data.footerLines.includes(""));
});

test("§3: a footer line containing markup is escaped in the frame", () => {
  const data = assembleEmbedData("https://x.example", PUBLISHED, SETTINGS(null, "<i>hi</i>"), FULL);
  const html = embedDocumentHtml({
    docs: data.docs,
    introParagraphs: data.introParagraphs,
    footerLines: data.footerLines,
    accentColor: data.accentColor,
    theme: "auto",
    indexHref: data.indexHref,
    recordVisits: false,
  });
  assert.ok(html.includes("&lt;i&gt;hi&lt;/i&gt;"));
  assert.ok(!html.includes("<i>hi</i>"));
});
