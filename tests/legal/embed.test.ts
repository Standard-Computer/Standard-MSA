import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_CONTAINER_ID,
  asEmbedTheme,
  embedIframeSnippet,
  embedScriptSnippet,
  frameAncestorsValue,
  isAllowedEmbedOrigin,
  normalizeEmbedOrigin,
  parseEmbedOrigins,
} from "../../src/lib/legal/embed";
import { EMBED_LOADER_JS } from "../../src/lib/legal/embedLoader";

test("normalizeEmbedOrigin accepts bare hostnames as https origins", () => {
  assert.equal(normalizeEmbedOrigin("www.example.com"), "https://www.example.com");
  assert.equal(normalizeEmbedOrigin("https://example.com/path/"), "https://example.com");
  assert.equal(normalizeEmbedOrigin("http://example.com:8080"), "http://example.com:8080");
  assert.equal(normalizeEmbedOrigin("localhost"), "https://localhost");
  assert.equal(normalizeEmbedOrigin("127.0.0.1"), "https://127.0.0.1");
});

test("normalizeEmbedOrigin refuses junk that would poison frame-ancestors", () => {
  assert.equal(normalizeEmbedOrigin("javascript://example.com"), null);
  assert.equal(normalizeEmbedOrigin("https://!!!"), null);
  assert.equal(normalizeEmbedOrigin("intranet"), null); // single label, no dot
  assert.equal(normalizeEmbedOrigin("-bad-.example.com"), null);
  assert.equal(normalizeEmbedOrigin(""), null);
});

test("parseEmbedOrigins splits lines and commas, dedupes, collapses *", () => {
  assert.deepEqual(parseEmbedOrigins("example.com\nwww.example.com, example.com"), [
    "https://example.com",
    "https://www.example.com",
  ]);
  assert.deepEqual(parseEmbedOrigins("example.com\n*"), []);
  assert.deepEqual(parseEmbedOrigins("   "), []);
});

test("frameAncestorsValue: empty = any; never X-Frame-Options semantics", () => {
  assert.equal(frameAncestorsValue([]), "frame-ancestors *");
  assert.equal(
    frameAncestorsValue(["https://a.com", "https://b.com"]),
    "frame-ancestors https://a.com https://b.com",
  );
});

test("isAllowedEmbedOrigin: empty list allows everyone, named list only itself", () => {
  assert.equal(isAllowedEmbedOrigin("https://any.com", []), true);
  assert.equal(isAllowedEmbedOrigin("https://a.com", ["https://a.com"]), true);
  assert.equal(isAllowedEmbedOrigin("https://evil.com", ["https://a.com"]), false);
  assert.equal(isAllowedEmbedOrigin(null, ["https://a.com"]), false);
});

test("asEmbedTheme falls back to light", () => {
  assert.equal(asEmbedTheme("dark"), "dark");
  assert.equal(asEmbedTheme("auto"), "auto");
  assert.equal(asEmbedTheme("neon"), "light");
  assert.equal(asEmbedTheme(null), "light");
});

test("script snippet carries the container and loader URL, no brand data", () => {
  const s = embedScriptSnippet({ baseUrl: "https://msa.example.com/" });
  assert.ok(s.includes(`<div id="${EMBED_CONTAINER_ID}"></div>`));
  assert.match(s, /src="https:\/\/msa\.example\.com\/legal\/embed\.js"/);
  assert.doesNotMatch(s, /data-theme/); // light is the default and emits nothing
  const dark = embedScriptSnippet({ baseUrl: "https://msa.example.com", theme: "dark" });
  assert.match(dark, /data-theme="dark"/);
});

test("iframe snippet is the same frame URL pasted by hand", () => {
  const s = embedIframeSnippet({ baseUrl: "https://msa.example.com" });
  assert.match(s, /src="https:\/\/msa\.example\.com\/legal\/embed\/frame"/);
  const dark = embedIframeSnippet({ baseUrl: "https://msa.example.com", theme: "dark" });
  assert.match(dark, /frame\?theme=dark/);
});

test("loader is ES5-ish, cookie-free, and clamps heights", () => {
  assert.doesNotMatch(EMBED_LOADER_JS, /=>/, "loader must stay ES5 (no arrow functions)");
  assert.doesNotMatch(EMBED_LOADER_JS, /\blet\b|\bconst\b/, "loader must stay ES5 (var only)");
  assert.doesNotMatch(EMBED_LOADER_JS, /document\.cookie|localStorage|sessionStorage/);
  assert.match(EMBED_LOADER_JS, /50000/, "height clamp present");
  assert.match(EMBED_LOADER_JS, /sm-legal/, "renamed namespace");
  assert.doesNotMatch(EMBED_LOADER_JS, /ob-legal|orangeboard|shadowpsa/i, "no upstream branding");
});
