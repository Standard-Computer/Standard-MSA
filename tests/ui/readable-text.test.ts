import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { AA_NORMAL, AAA_NORMAL, contrast, ratio } from "./_contrast";
import tailwindConfig, { READABLE_SLATE_TEXT } from "../../tailwind.config";
import { embedCss, embedDocumentHtml } from "../../src/lib/legal/embedDocument";
import {
  asEmbedTheme,
  embedIframeSnippet,
  embedScriptSnippet,
} from "../../src/lib/legal/embed";

// GH #19 / SHA-4498 — "Light mode by default. Make the text readable, no gray
// fonts." (Sean, 2026-11-27).
//
// These tests exist so the gray cannot come back by accident. Two of them are
// repo-wide SCANS rather than assertions about the files this lane edited:
// the failure mode worth defending against is not the current markup, it is
// the next page somebody writes with `text-slate-500` in it, which is what
// every Tailwind example reaches for.

const ROOT = process.cwd();

/** The operator surface. The root layout is `bg-white`, and for the embed's
 *  `--legal-bg:transparent` light palette white is the worst case a host
 *  page can present to dark text. */
const WHITE = "#ffffff";

// The paths walked here are this repo's own `src` tree, not input — the
// suppressions follow the openapi.test.ts precedent for test code reading
// its own source.
function walk(dir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SRC_FILES = walk(path.join(ROOT, "src"));

/** Read a file from this repo's own tree. */
function read(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(file, "utf8");
}

// ──────────────────────────────────────────────────────────────────────
// The measuring stick itself
// ──────────────────────────────────────────────────────────────────────

test("the contrast helper reproduces known WCAG ratios", () => {
  // Black on white is the spec's maximum; a colour against itself is 1:1.
  assert.equal(ratio("#000000", WHITE), 21);
  assert.equal(ratio(WHITE, WHITE), 1);
  assert.equal(ratio("#0f172a", "#0f172a"), 1);
  // Order must not matter.
  assert.equal(ratio("#0f172a", WHITE), ratio(WHITE, "#0f172a"));
  // Shorthand parses to the same colour as its expanded form.
  assert.equal(ratio("#fff", "#000"), ratio("#ffffff", "#000000"));
  // The two stock slate shades this lane exists to remove, measured. If
  // either of these numbers moves, the helper is wrong, not Tailwind.
  assert.equal(ratio("#94a3b8", WHITE), 2.56); // stock slate-400
  assert.equal(ratio("#64748b", WHITE), 4.76); // stock slate-500
  assert.throws(() => ratio("slate-500", WHITE), /not a hex colour/);
});

// ──────────────────────────────────────────────────────────────────────
// AC 2 + AC 3 — the operator text ramp
// ──────────────────────────────────────────────────────────────────────

test("every slate shade used for text clears AA on white, and the body tier is near-black", () => {
  // Shades 50-200 are the LIGHT text on this app's dark buttons
  // (`bg-slate-900 text-slate-100`); they are not measured against white.
  const onDarkSurfaces = new Set(["50", "100", "200"]);

  for (const [shade, hex] of Object.entries(READABLE_SLATE_TEXT)) {
    if (onDarkSurfaces.has(shade)) {
      assert.ok(
        contrast(hex, "#0f172a") >= AA_NORMAL,
        `text-slate-${shade} (${hex}) is meant for dark surfaces but measures ` +
          `${ratio(hex, "#0f172a")}:1 on #0f172a`,
      );
      continue;
    }
    assert.ok(
      contrast(hex, WHITE) >= AAA_NORMAL,
      `text-slate-${shade} (${hex}) measures ${ratio(hex, WHITE)}:1 on white — ` +
        `AC 3 wants a very dark gray, not a shade that scrapes past AA`,
    );
  }

  // AC 2: body copy, form labels and table cells are near-black. These are
  // the shades the pages actually use for prose.
  for (const shade of ["600", "700", "800", "900"] as const) {
    assert.equal(
      READABLE_SLATE_TEXT[shade],
      "#0f172a",
      `text-slate-${shade} carries body copy and must be #0f172a (AC 2)`,
    );
  }

  // AC 3: the softer tiers are allowed to exist, but only in the AAA band,
  // and they must stay ordered or the emphasis in the markup inverts.
  const faint = contrast(READABLE_SLATE_TEXT["300"], WHITE);
  const secondary = contrast(READABLE_SLATE_TEXT["500"], WHITE);
  const body = contrast(READABLE_SLATE_TEXT["900"], WHITE);
  assert.ok(faint >= AAA_NORMAL, `faint tier ${ratio(READABLE_SLATE_TEXT["300"], WHITE)}:1`);
  assert.ok(faint < secondary, "the 300/400 tier must stay lighter than 500");
  assert.ok(secondary < body, "the 500 tier must stay lighter than the body tier");

  // The scale must be COMPLETE. A partial object replaces Tailwind's `slate`
  // under `textColor` outright, and a missing shade fails silently — the
  // utility stops emitting a colour instead of erroring.
  for (const shade of [
    "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950",
  ]) {
    assert.ok(shade in READABLE_SLATE_TEXT, `textColor.slate dropped shade ${shade}`);
  }
});

test("the ramp is wired under textColor, never under colors", () => {
  // Scope matters as much as the values. Under `theme.extend.colors` the same
  // object would also repaint `disabled:bg-slate-400` on three submit buttons
  // (near-black reads as ENABLED) and `focus:border-slate-500`. Both still
  // want stock slate, so this must stay a text-only override.
  const extend = tailwindConfig.theme?.extend as
    | { textColor?: { slate?: Record<string, string> }; colors?: unknown }
    | undefined;

  assert.equal(
    extend?.textColor?.slate,
    READABLE_SLATE_TEXT,
    "the readable ramp must be wired into theme.extend.textColor.slate",
  );
  assert.equal(
    extend?.colors,
    undefined,
    "theme.extend.colors must stay empty — a slate override there would " +
      "repaint disabled:bg-slate-400 and focus:border-slate-500 too",
  );

  // The non-text utilities that depend on stock slate. If one of these
  // disappears the scoping argument above needs revisiting, not deleting.
  const markup = SRC_FILES.map((f) => read(f)).join("\n");
  assert.match(markup, /disabled:bg-slate-400/, "the disabled-button case this scoping protects");
  assert.match(markup, /focus:border-slate-500/, "the focus-ring case this scoping protects");
});

test("no source file uses a slate text shade the ramp does not define", () => {
  const seen = new Map<string, string[]>();
  for (const file of SRC_FILES) {
    const body = read(file);
    for (const m of body.matchAll(/\btext-slate-(\d+)\b/g)) {
      const shade = m[1];
      if (!seen.has(shade)) seen.set(shade, []);
      const where = seen.get(shade)!;
      const rel = path.relative(ROOT, file);
      if (!where.includes(rel)) where.push(rel);
    }
  }
  assert.ok(seen.size > 0, "scan found no text-slate-* classes at all — glob broken?");

  for (const [shade, files] of seen) {
    const hex = READABLE_SLATE_TEXT[shade];
    assert.ok(
      hex,
      `text-slate-${shade} is used in ${files.join(", ")} but the readable ramp ` +
        `in tailwind.config.ts does not define it — the utility would emit no colour`,
    );
    // 100 and below are the light-on-dark cases; everything else sits on the
    // white operator surface.
    if (Number(shade) <= 200) continue;
    assert.ok(
      contrast(hex, WHITE) >= AA_NORMAL,
      `text-slate-${shade} -> ${hex} is ${ratio(hex, WHITE)}:1 on white, used in ` +
        `${files.join(", ")}`,
    );
  }
});

// ──────────────────────────────────────────────────────────────────────
// AC 1 + AC 6 — light stays the default, no operator dark theme
// ──────────────────────────────────────────────────────────────────────

test("the operator app is pinned light: no dark variants, no prefers-color-scheme flip", () => {
  const layout = read(path.join(ROOT, "src/app/layout.tsx"));
  assert.match(layout, /bg-white/, "root layout must keep the white surface");
  assert.match(layout, /text-slate-900/, "root layout must keep near-black default text");
  assert.doesNotMatch(layout, /dark:/, "no dark: variant on the app shell");

  // AC 6: no operator dark theme in this issue. A `dark:` variant anywhere
  // in src is how one starts.
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (/\bdark:(bg|text|border|ring|divide|placeholder)-/.test(read(file))) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `AC 6 forbids an operator dark theme in this lane; dark: variants found in ${offenders.join(", ")}`,
  );

  // Native controls are not painted by Tailwind classes. Without this the
  // browser renders <input>/<select> from its DARK palette on a dark-mode
  // OS, inside our white card.
  const globals = read(path.join(ROOT, "src/app/globals.css"));
  assert.match(globals, /color-scheme:\s*light/, "globals.css must pin color-scheme: light");
});

test("the embed still defaults to light and keeps its theme knobs", () => {
  // The default on every entry point, including garbage input.
  assert.equal(asEmbedTheme(undefined), "light");
  assert.equal(asEmbedTheme(null), "light");
  assert.equal(asEmbedTheme(""), "light");
  assert.equal(asEmbedTheme("DARK"), "light");
  // AC 1/AC 4: the knobs must survive this lane.
  assert.equal(asEmbedTheme("dark"), "dark");
  assert.equal(asEmbedTheme("auto"), "auto");

  const script = embedScriptSnippet({ baseUrl: "https://msa.example.com" });
  assert.doesNotMatch(script, /data-theme/, "light is the default and emits no attribute");
  assert.match(
    embedScriptSnippet({ baseUrl: "https://msa.example.com", theme: "dark" }),
    /data-theme="dark"/,
  );
  const frame = embedIframeSnippet({ baseUrl: "https://msa.example.com" });
  assert.doesNotMatch(frame, /\?theme=/, "light is the default and adds no query");
  assert.match(
    embedIframeSnippet({ baseUrl: "https://msa.example.com", theme: "auto" }),
    /frame\?theme=auto/,
  );

  const doc = (theme: "light" | "dark" | "auto") =>
    embedDocumentHtml({
      docs: [],
      introParagraphs: [],
      footerLines: [],
      accentColor: "#1d4ed8",
      theme,
      indexHref: "https://x/legal",
      recordVisits: false,
    });
  assert.match(doc("light"), /<html lang="en-US" data-sm-embed-theme="light">/);
  assert.match(doc("auto"), /<html lang="en-US">/);
  assert.match(doc("dark"), /<html lang="en-US" data-sm-embed-theme="dark">/);
});

// ──────────────────────────────────────────────────────────────────────
// AC 4 — the embed palette and the agreement body
// ──────────────────────────────────────────────────────────────────────

const CSS = embedCss("#1d4ed8");

/** The declarations inside one `{...}` block, by selector prefix. */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector + "{");
  assert.notEqual(at, -1, `selector ${selector} missing from the embed stylesheet`);
  const open = at + selector.length + 1;
  const close = css.indexOf("}", open);
  assert.notEqual(close, -1, `unterminated block for ${selector}`);
  return css.slice(open, close);
}

function vars(declarations: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of declarations.matchAll(/(--[a-z-]+)\s*:\s*([^;]+)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

test("the embed's light palette is AAA on a white host and pairs with its own surface", () => {
  const light = vars(block(CSS, ":root"));
  const dark = vars(block(CSS, '@media (prefers-color-scheme: dark){:root'));

  // Each palette carries its OWN surface. The file's comment explains why:
  // a `--legal-bg` on :root alone lets a pinned-light embed on a dark OS
  // paint #0f172a text on the dark palette's #0f172a surface.
  assert.equal(light.get("--legal-bg"), "transparent");
  assert.equal(dark.get("--legal-bg"), "#0f172a");

  // Same key set in both, or the pair drifts apart over a couple of tweaks.
  const lightKeys = [...light.keys()].filter((k) => k !== "--legal-accent").sort();
  assert.deepEqual(lightKeys, [...dark.keys()].sort(), "the two palettes must declare the same tokens");

  // AC 3/AC 4: every light token that paints text clears AA against white,
  // and the two muted tiers are held to AAA — they are what AC 3 rejected at
  // 4.76:1 (`--legal-faint` was #64748b).
  for (const token of ["--legal-fg", "--legal-link"]) {
    const hex = light.get(token)!;
    assert.ok(
      contrast(hex, WHITE) >= AA_NORMAL,
      `${token} ${hex} is ${ratio(hex, WHITE)}:1 on a white host`,
    );
  }
  for (const token of ["--legal-muted", "--legal-faint"]) {
    const hex = light.get(token)!;
    assert.ok(
      contrast(hex, WHITE) >= AAA_NORMAL,
      `${token} ${hex} is only ${ratio(hex, WHITE)}:1 on a white host — AC 3 wants ` +
        `a very dark gray for small meta, not a shade that scrapes past AA`,
    );
  }
  // Ordering: fg darkest, then muted, then faint. If this inverts the
  // stylesheet's emphasis reads backwards.
  assert.ok(contrast(light.get("--legal-fg")!, WHITE) > contrast(light.get("--legal-muted")!, WHITE));
  assert.ok(contrast(light.get("--legal-muted")!, WHITE) > contrast(light.get("--legal-faint")!, WHITE));

  // The pinned selectors must carry the FULL palettes, not a subset.
  const pinnedLight = vars(block(CSS, 'html[data-sm-embed-theme="light"]'));
  const pinnedDark = vars(block(CSS, 'html[data-sm-embed-theme="dark"]'));
  assert.deepEqual([...pinnedLight.entries()].sort(), lightKeys.map((k) => [k, light.get(k)!]).sort());
  assert.deepEqual([...pinnedDark.entries()].sort(), [...dark.entries()].sort());
});

test("the embed's dark palette stays readable on its own dark surface", () => {
  const dark = vars(block(CSS, '@media (prefers-color-scheme: dark){:root'));
  const surface = dark.get("--legal-bg")!;
  for (const token of ["--legal-fg", "--legal-muted", "--legal-faint", "--legal-link"]) {
    const hex = dark.get(token)!;
    assert.ok(
      contrast(hex, surface) >= AA_NORMAL,
      `${token} ${hex} is ${ratio(hex, surface)}:1 on ${surface}`,
    );
  }
});

test("agreement body copy uses --legal-fg, never a muted tier", () => {
  // AC 4 by name. These four selectors carry the clauses a customer agrees
  // to; `.sm-l-intro` is the operator's prose above them.
  for (const selector of [".sm-l-p", ".sm-l-ol", ".sm-l-ul", ".sm-l-quote", ".sm-l-intro"]) {
    const declarations = block(CSS, selector);
    assert.match(
      declarations,
      /color:var\(--legal-fg\)/,
      `${selector} must paint body copy with --legal-fg`,
    );
    assert.doesNotMatch(
      declarations,
      /--legal-muted|--legal-faint/,
      `${selector} is body copy and must not use a muted tier (AC 4)`,
    );
  }
  // Table cells inherit from .sm-l-body, which is --legal-fg. Pin that, since
  // AC 2 names table cells explicitly.
  assert.match(block(CSS, ".sm-l-body"), /color:var\(--legal-fg\)/);
  assert.doesNotMatch(block(CSS, ".sm-l-th,.sm-l-td"), /--legal-muted|--legal-faint/);
});
