// VISIT_IP_HASH_SALT never leaves the server (SHA-4497, GH #18 item 4).
//
// The salt is the one secret this feature has, and its whole value is that
// nobody outside the install can run the dictionary attack that turns 2^32
// candidate IPv4 addresses back into the hash in a visit row. An unsalted —
// or publicly-salted — hash of an IP is not a pseudonym, it is the address
// with extra steps.
//
// gitleaks (.github/workflows/ci.yml) catches the salt being COMMITTED. This
// file catches the other direction, which no scanner sees: the salt reaching
// a surface a stranger can read. Everything asserted here is a surface the
// public can fetch — the pasted snippet, the loader script, the frame
// document — plus the operator screens, where a shoulder-surfed value is
// just as spent.
//
// The sentinel is set BEFORE the modules load — they are imported inside
// before(), after the assignment — so a module that captured the salt at
// load time would capture THIS value and be caught by the assertions below.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "sha4497-sentinel-salt-must-never-render";
process.env.VISIT_IP_HASH_SALT = SENTINEL;

let embed: typeof import("../../src/lib/legal/embed");
let loader: typeof import("../../src/lib/legal/embedLoader");
let doc: typeof import("../../src/lib/legal/embedDocument");
let assemble: typeof import("../../src/lib/legal/embedAssemble");
let visits: typeof import("../../src/lib/visits/visits");

before(async () => {
  embed = await import("../../src/lib/legal/embed");
  loader = await import("../../src/lib/legal/embedLoader");
  doc = await import("../../src/lib/legal/embedDocument");
  assemble = await import("../../src/lib/legal/embedAssemble");
  visits = await import("../../src/lib/visits/visits");
});

const BASE = "https://msa.example.com";
const IP = "203.0.113.77";

const SETTINGS = {
  embedEnabled: true,
  embedOrigins: [],
  introText: "Our agreements.",
  footerText: "Questions? legal@reyesdental.example",
  accentColor: "#1d4ed8",
  visitRetentionDays: 365,
  hashVisitorIps: true,
  monitorEnabled: false,
  monitorUrl: null,
};

function publicFrameHtml(): string {
  const published = [
    {
      doc: { id: 1, slug: "msa", title: "Master Services Agreement", kind: "msa" },
      current: {
        id: 1,
        documentId: 1,
        version: 1,
        bodyMarkdown: "## 1. Parties\n\nBetween {{msp_name}} and {{client_name}}.",
        variablesJson: "{}",
        publishedAt: new Date("2026-11-01T00:00:00Z"),
      },
      history: [],
    },
  ];
  const data = assemble.assembleEmbedData(
    BASE,
    // The pure assembler's row shape; only the fields it reads are supplied.
    published as unknown as Parameters<typeof assemble.assembleEmbedData>[1],
    SETTINGS as unknown as Parameters<typeof assemble.assembleEmbedData>[2],
    assemble.mspValuesFrom({ name: "Reyes IT", legalName: "Reyes IT LLC", venue: "Nebraska" } as never),
  );
  return doc.embedDocumentHtml({
    docs: data.docs,
    introParagraphs: data.introParagraphs,
    footerLines: data.footerLines,
    accentColor: data.accentColor,
    theme: "light",
    indexHref: data.indexHref,
    recordVisits: true,
  });
}

test("the sentinel really is the live salt — the assertions below are not vacuous", () => {
  assert.equal(visits.visitIpSalt(), SENTINEL);
  assert.equal(visits.visitIpColumns(IP, true, visits.visitIpSalt()).ipHash, visits.hashIp(IP, SENTINEL));
});

test("no public embed surface carries the salt", () => {
  const surfaces: Array<[string, string]> = [
    ["script snippet", embed.embedScriptSnippet({ baseUrl: BASE })],
    ["iframe snippet", embed.embedIframeSnippet({ baseUrl: BASE })],
    ["loader js", loader.EMBED_LOADER_JS],
    ["frame document", publicFrameHtml()],
    ["embed-off document", doc.embedDocumentOffHtml()],
  ];
  for (const [name, body] of surfaces) {
    assert.ok(!body.includes(SENTINEL), `${name} must not contain the salt`);
    // Nor the env var's NAME: a surface that names it is a surface that is
    // one interpolation away from carrying it.
    assert.ok(!body.includes("VISIT_IP_HASH_SALT"), `${name} must not name the salt variable`);
  }
});

test("a hashed visit row carries neither the salt nor the address", () => {
  const cols = visits.visitorColumns(
    (n) => ({ "x-forwarded-for": IP, "user-agent": "UA" })[n] ?? null,
    true,
    visits.visitIpSalt(),
  );
  const row = JSON.stringify(cols);
  assert.ok(!row.includes(SENTINEL), "the stored row is not the salt's hiding place");
  assert.ok(!row.includes(IP), "hashing on means the address is not in the row");
  assert.match(cols.ipHash ?? "", /^[0-9a-f]{64}$/);
});

test("only the two visit writers can reach the salt, and only visits.ts reads it", () => {
  // Every extra reader is an extra chance for one to be interpolated into
  // output, and an extra copy of the fallback to drift.
  //
  // The sweep matches the SYMBOL as well as the env-var name. Grepping the
  // literal `VISIT_IP_HASH_SALT` alone measures the wrong thing: visitIpSalt()
  // is a second, grep-invisible route to the same value, so a new file could
  // resolve the salt — `<div data-salt={visitIpSalt()} />` on the public
  // /legal index being the cheapest example — and this assertion would still
  // have seen exactly one hit. Whole-of-src/ exact match is what makes the
  // claim "it cannot reach a public surface" rather than "it does not reach
  // these six surfaces today": any fourth file, public or operator-gated,
  // fails here by appearing in the list.
  const hits: string[] = [];
  const walk = (dir: string) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|css)$/.test(entry)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (/VISIT_IP_HASH_SALT|visitIpSalt/.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk(join(process.cwd(), "src"));
  // readdirSync is not sorted, so both sides are — otherwise a multi-hit
  // expectation passes or fails on directory order.
  assert.deepEqual(
    hits.map((p) => p.slice(process.cwd().length + 1)).sort(),
    [
      "src/app/api/legal/visit/route.ts",
      "src/lib/visits/record.ts",
      "src/lib/visits/visits.ts",
    ].sort(),
    "visits.ts reads the salt; only the two visit-row writers may even resolve it",
  );
});

test("the operator screens render settings, never the salt", () => {
  // The /embed page offers the hash TOGGLE, which is a boolean. Neither it
  // nor the visitor log may put the salt on a screen (or in a form field, a
  // data attribute, or a comment that ships in the bundle).
  for (const rel of ["src/app/embed/page.tsx", "src/app/visits/page.tsx", "src/app/visits/export/route.ts"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.ok(!src.includes("VISIT_IP_HASH_SALT"), `${rel} must not touch the salt`);
    assert.ok(!src.includes("visitIpSalt"), `${rel} must not even resolve the salt`);
  }
});

test("the env documentation names the variable without a real value", () => {
  // The operator has to be TOLD the var exists — that is how it gets set —
  // so the docs naming it is correct. What must never appear beside it is a
  // value that looks usable.
  const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("VISIT_IP_HASH_SALT"));
  assert.ok(line, ".env.example must document the salt variable");
  const value = line!.split("=").slice(1).join("=").trim();
  assert.ok(
    value === "" || /^(""|''|<.*>|change-me.*|replace.*)$/i.test(value),
    `.env.example must ship an empty or obviously-placeholder salt, got ${JSON.stringify(value)}`,
  );
});
