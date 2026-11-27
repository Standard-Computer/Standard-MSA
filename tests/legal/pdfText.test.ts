import { test } from "node:test";
import assert from "node:assert/strict";

import { hasUndrawable, isDrawable, toPdfText } from "../../src/lib/legal/pdfText";

// The sanitiser (SHA-4501). PURE, no PDF involved.
//
// What this is really asserting: the PDF routes cannot 500 on a body the
// HTML surface renders. pdf-lib's WinAnsi encoder throws on the first
// character it cannot encode, so every string is filtered here first — and
// the test that matters most is the LAST one, which asserts the postcondition
// over text nobody thought to list.

test("the characters real contract text is made of survive untouched", () => {
  const kept = [
    "Plain ASCII, digits 0-9 and punctuation: ()[]{}.,;:!?'\"-/@#$%&*+=<>|~^_`",
    // What Word and Google Docs emit, which is the realistic input.
    "Curly quotes “quoted” and ‘single’, an apostrophe’s, en–dash, em—dash",
    "Bullets • ellipsis … dagger † per mille ‰ trade mark ™",
    // Latin-1: an MSP with an accented legal name, and the currency signs.
    "Élan Sàrl, Muñoz & Co, £100, €100, ¥100, © 2026, ®, °C, ½",
  ];
  for (const text of kept) {
    assert.equal(toPdfText(text), text, text);
    assert.equal(hasUndrawable(text), false, text);
  }
});

test("a zero-width character becomes nothing, not a question mark", () => {
  // The copy-paste case: invisible in the source, invisible in the output.
  assert.equal(toPdfText("term​ination"), "termination");
  assert.equal(toPdfText("﻿## Heading"), "## Heading");
  assert.equal(toPdfText("a‌‍⁠b"), "ab");
});

test("a line break or tab inside a run becomes a space", () => {
  // A literal newline in a drawn string would be a byte in the content
  // stream, not a line break: layout is ./pdfRender.ts's job.
  assert.equal(toPdfText("one\ntwo"), "one two");
  assert.equal(toPdfText("one\r\ntwo"), "one  two");
  assert.equal(toPdfText("one\ttwo"), "one two");
  assert.equal(toPdfText("one two three"), "one two three");
});

test("a substituted character reads as what it meant", () => {
  assert.equal(toPdfText("response ≤ 4 hours"), "response <= 4 hours");
  assert.equal(toPdfText("uptime ≥ 99%"), "uptime >= 99%");
  assert.equal(toPdfText("tier 1 → tier 2"), "tier 1 -> tier 2");
  assert.equal(toPdfText("5‑6pm"), "5-6pm");
  assert.equal(toPdfText("✓ included"), "[x] included");
  assert.equal(toPdfText("30′"), "30'");
});

test("an unlisted character folds to its base letter when it can", () => {
  // NFKD, so the table does not have to enumerate Latin Extended-A.
  assert.equal(toPdfText("Gdańsk"), "Gdansk"); // n with acute: folded
  assert.equal(toPdfText("the ﬁrst"), "the first"); // fi ligature: expanded
  // All three paths in one word: "Ł" has no decomposition (it is in the
  // substitute table, since NFKD would leave it and rule 4 would reach "?"),
  // "ó" is Latin-1 and is kept as itself, and "ź" folds.
  assert.equal(toPdfText("Łódź"), "Lódz");
  assert.equal(toPdfText("Ħ Đ ŋ"), "H D n");
});

test("a character with no reading at all becomes a VISIBLE question mark", () => {
  // Deliberately not deleted: a missing word in a contract is the failure
  // nobody notices. Asserted as "?" rather than "" on purpose.
  assert.equal(toPdfText("中文"), "??");
  assert.equal(toPdfText("name: Αβ"), "name: ??");
  // An emoji is one code point, so it is one "?" and not two surrogate halves.
  assert.equal(toPdfText("ok \u{1F44D}"), "ok ?");
  assert.equal(toPdfText("\u{1F44D}").length, 1);
});

test("control characters never reach a content stream", () => {
  // Written with String.fromCharCode, not as literals: a NUL and an ESC
  // pasted into a source file make it unreviewable (git calls the file
  // binary) and invisible to the reader of this test.
  const NUL = String.fromCharCode(0x00);
  const ESC = String.fromCharCode(0x1b);
  // 0x80-0x9F is WinAnsi's named-glyph block, so only the 27 named ones pass;
  // 0x81 is one of the five unassigned slots.
  const UNASSIGNED = String.fromCharCode(0x81);
  assert.equal(isDrawable(NUL), false);
  assert.equal(isDrawable(ESC), false);
  assert.equal(isDrawable(UNASSIGNED), false);
  assert.equal(isDrawable("\u2014"), true, "the em dash in that block IS named");
  assert.equal(toPdfText(`a${NUL}b${ESC}c`), "a?b?c");
  assert.equal(toPdfText(`x${UNASSIGNED}y`), "x?y");
});

test("the output of toPdfText is always drawable, and stable under a second pass", () => {
  // The postcondition, over inputs nobody listed: whatever goes in, what
  // comes out is drawable — which is the property that stops the route
  // throwing. Checked by sweeping every BMP code point at a stride that is
  // coprime with the common block sizes, plus the astral plane start.
  let checked = 0;
  for (let cp = 0; cp <= 0xffff; cp += 7) {
    // Lone surrogates are not characters and cannot appear in a well-formed
    // string; String.fromCodePoint would produce one, so they are skipped.
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const out = toPdfText(ch);
    for (const o of out) {
      assert.equal(isDrawable(o), true, `U+${cp.toString(16)} yielded an undrawable ${o}`);
    }
    assert.equal(toPdfText(out), out, `U+${cp.toString(16)} is not idempotent`);
    checked += 1;
  }
  for (const cp of [0x1f44d, 0x1f600, 0x10000, 0x10ffff]) {
    const out = toPdfText(String.fromCodePoint(cp));
    for (const o of out) assert.equal(isDrawable(o), true);
    checked += 1;
  }
  // Non-vacuity: an empty sweep would pass while proving nothing.
  assert.ok(checked > 9000, `expected a real sweep, checked ${checked}`);
});
