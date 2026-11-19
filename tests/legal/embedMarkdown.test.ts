import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToEmbedHtml } from "../../src/lib/legal/embedMarkdown";

test("renders headings, lists, emphasis with sm-l-* classes", () => {
  const html = markdownToEmbedHtml("# Title\n\nSome **strong** text.\n\n1. one\n2. two\n");
  assert.match(html, /<h1 class="sm-l-h1">Title<\/h1>/);
  assert.match(html, /<strong class="sm-l-strong">strong<\/strong>/);
  assert.match(html, /<ol class="sm-l-ol">/);
});

test("escapes text content", () => {
  const html = markdownToEmbedHtml("a < b & c > d \"quoted\"");
  assert.doesNotMatch(html, /a < b/);
  assert.match(html, /a &lt; b &amp; c &gt; d/);
});

test("raw HTML in a body is dropped, not rendered", () => {
  const html = markdownToEmbedHtml('before\n\n<script>alert(1)</script>\n\n<img src="https://evil.example/pixel.png">\n\nafter');
  // Substring asserts, not tag-shaped regexes: "<script" catches every
  // variant a regex like /<script>/ would miss, and this is an assertion on
  // renderer OUTPUT, not an HTML filter (CodeQL js/bad-tag-filter).
  assert.ok(!html.includes("<script"), "no script tag may be emitted");
  assert.ok(!html.includes("<img"), "no img tag may be emitted");
  assert.match(html, /before/);
  assert.match(html, /after/);
});

test("javascript: and data: links render as plain text with label intact", () => {
  const html = markdownToEmbedHtml("[click me](javascript:alert(1)) and [fine](https://example.com)");
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /click me/);
  assert.match(html, /<a class="sm-l-a" href="https:\/\/example\.com"/);
});

test("scheme smuggling via control characters never yields an executable scheme", () => {
  // remark percent-encodes the control character, so the surviving href is
  // an inert relative path ("java%01script:...") - what matters is that no
  // javascript:/data: SCHEME can come out the other side, encoded or not.
  const html = markdownToEmbedHtml("[x](java\u0001script:alert(1))");
  assert.doesNotMatch(html, /href="(javascript|data|vbscript):/i);
  assert.match(html, /x/);
});

test("images are omitted with a visible marker (no third-party request)", () => {
  const html = markdownToEmbedHtml("![diagram](https://evil.example/track.png)");
  assert.ok(!html.includes("<img"), "no img tag may be emitted");
  assert.match(html, /image omitted: diagram/);
});

test("ordered list start is preserved", () => {
  const html = markdownToEmbedHtml("7. seventh\n8. eighth\n");
  assert.match(html, /<ol class="sm-l-ol" start="7">/);
});

test("gfm tables render with the wrap", () => {
  const html = markdownToEmbedHtml("| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.match(html, /<div class="sm-l-table-wrap"><table class="sm-l-table">/);
  assert.match(html, /<th class="sm-l-th">a<\/th>/);
  assert.match(html, /<td class="sm-l-td">1<\/td>/);
});
