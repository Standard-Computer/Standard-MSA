import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMBED_PUBLIC_ROUTES,
  NON_EMBED_HEADER_SOURCE,
  isPublicEmbedRoute,
} from "../../src/lib/legal/embedRoutes";

// The gate that keeps next.config.ts and embedRoutes.ts pinned to each
// other. Ported discipline from ShadowPSA STA-9551, where the app-wide
// headers entry silently replaced the frame's Content-Security-Policy for
// eleven months because nothing asserted the exemption.

test("next.config.ts carries the EXACT derived header source", () => {
  const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  // The literal in the config must be character-identical to the derived
  // value (with its backslash doubled for the TS string literal).
  const expectedLiteral = JSON.stringify(NON_EMBED_HEADER_SOURCE);
  assert.ok(
    config.includes(expectedLiteral),
    `next.config.ts must contain the literal ${expectedLiteral} — regenerate it from NON_EMBED_HEADER_SOURCE`,
  );
});

test("the derived regex excludes exactly the embed routes, prefix-safe", () => {
  // Compile the parenthesised pattern the same way path-to-regexp treats the
  // one param: anchor it over the path minus its leading slash.
  const m = /^\/:path\((.*)\)$/.exec(NON_EMBED_HEADER_SOURCE);
  assert.ok(m, "source has the expected /:path(...) shape");
  // The pattern under test IS the derived constant; compiling it is the test.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(`^${m![1]}$`);
  const applies = (p: string) => re.test(p.slice(1));

  // Headers must still apply everywhere else.
  assert.equal(applies("/"), true);
  assert.equal(applies("/legal"), true);
  assert.equal(applies("/legal/msa"), true);
  assert.equal(applies("/legal/msa/2"), true);
  assert.equal(applies("/visits"), true);
  // Exact exemptions only.
  assert.equal(applies("/legal/embed/frame"), false);
  assert.equal(applies("/legal/embed.js"), false);
  // Prefix-safety: nested paths are NOT exempt.
  assert.equal(applies("/legal/embed/frame/x"), true);
  assert.equal(applies("/legal/embed.js.map"), true);
  assert.equal(applies("/legal/embed"), true);
});

test("isPublicEmbedRoute is exact-match, never prefix", () => {
  for (const r of EMBED_PUBLIC_ROUTES) assert.equal(isPublicEmbedRoute(r), true);
  assert.equal(isPublicEmbedRoute("/legal/embed/frame/x"), false);
  assert.equal(isPublicEmbedRoute("/legal"), false);
});
