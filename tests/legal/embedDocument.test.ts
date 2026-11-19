import { test } from "node:test";
import assert from "node:assert/strict";
import { embedDocumentHtml, embedDocumentOffHtml, renderEmbedBody } from "../../src/lib/legal/embedDocument";
import { assembleEmbedData, buildFooterLines, mspValuesFrom, textLines } from "../../src/lib/legal/embedAssemble";
import { hasRawTokens, parseVersionDefaults, renderLegalBody } from "../../src/lib/legal/variables";
import { VISIT_API_PATH } from "../../src/lib/visits/constants";
import type { ResolvedLegalSettings } from "../../src/lib/legal/settings";

const MSP = mspValuesFrom({
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "1 Main St, Lincoln NE",
  ownerName: "Sean",
  email: "sean@standardcomputer.com",
  website: "https://standardcomputer.com",
  venue: "Nebraska",
});

test("a skipped-onboarding row (name '') renders like no row at all, never [unset: msp_name]", () => {
  const skipped = mspValuesFrom({
    name: "",
    legalName: null,
    address: null,
    ownerName: null,
    email: null,
    website: null,
    venue: null,
  });
  assert.equal(skipped.mspName, "the Service Provider");
  assert.equal(mspValuesFrom(null).mspName, "the Service Provider");
  const rendered = renderLegalBody("{{msp_name}} provides services.", "public", skipped);
  assert.equal(rendered, "the Service Provider provides services.");
  assert.ok(!rendered.includes("[unset:"));
});

const SETTINGS: ResolvedLegalSettings = {
  embedEnabled: true,
  embedOrigins: [],
  introText: "These are our standard agreements.",
  footerText: "Questions? Call us.",
  accentColor: "#1d4ed8",
  visitRetentionDays: 365,
  hashVisitorIps: false,
  monitorEnabled: false,
  monitorUrl: null,
};

function makeDoc(id: number, slug: string, title: string, versions: Array<{ v: number; body: string }>) {
  const now = new Date("2026-11-01T00:00:00Z");
  const vs = versions.map(({ v, body }) => ({
    id: id * 100 + v,
    documentId: id,
    version: v,
    bodyMarkdown: body,
    variablesJson: "{}",
    changelog: null,
    publishedAt: now,
    createdAt: now,
  }));
  const sorted = [...vs].sort((a, b) => b.version - a.version);
  return {
    doc: { id, slug, title, kind: "msa", createdAt: now, updatedAt: now },
    current: sorted[0],
    history: sorted.slice(1),
  };
}

test("public mode: MSP values merge, client tokens go generic, no raw tokens survive", () => {
  const body =
    "This MSA is between {{msp_legal_name}} ({{msp_name}}) and {{client_name}}, venue {{venue}}. Unknown: {{made_up_token}}.";
  const rendered = renderLegalBody(body, "public", MSP, parseVersionDefaults('{"made_up_token":"a default"}'));
  assert.match(rendered, /Standard Computer LLC/);
  assert.match(rendered, /the Client/);
  assert.match(rendered, /Nebraska/);
  assert.match(rendered, /a default/);
  assert.equal(hasRawTokens(rendered), false);
  // And with no default either: labelled blank, still no raw token.
  const rendered2 = renderLegalBody("{{totally_unknown}}", "public", MSP);
  assert.equal(hasRawTokens(rendered2), false);
  assert.match(rendered2, /\[unset: totally_unknown\]/);
});

test("assembleEmbedData renders EVERY published document — MSA and BAA together (v1 scope)", () => {
  const data = assembleEmbedData(
    "https://msa.example.com/",
    [
      makeDoc(1, "msa", "Master Service Agreement", [
        { v: 1, body: "# MSA v1" },
        { v: 2, body: "# MSA v2 for {{client_name}}" },
      ]),
      makeDoc(2, "hipaa-baa", "HIPAA Business Associate Agreement", [{ v: 1, body: "# BAA" }]),
    ],
    SETTINGS,
    MSP,
  );
  assert.equal(data.docs.length, 2);
  assert.deepEqual(
    data.docs.map((d) => d.slug),
    ["msa", "hipaa-baa"],
  );
  const msa = data.docs[0];
  assert.equal(msa.current?.version, 2);
  assert.equal(msa.history.length, 1);
  assert.equal(msa.history[0].href, "https://msa.example.com/legal/msa/1");
  assert.match(msa.body, /the Client/);
  assert.equal(data.indexHref, "https://msa.example.com/legal");
});

test("the frame document: escaped shell, beacon present, docs listed", () => {
  const data = assembleEmbedData(
    "https://msa.example.com",
    [makeDoc(1, "msa", 'MSA <"&> edition', [{ v: 1, body: "# Hello\n\nBody." }])],
    SETTINGS,
    MSP,
  );
  const html = embedDocumentHtml({
    docs: data.docs,
    introParagraphs: data.introParagraphs,
    footerLines: data.footerLines,
    accentColor: data.accentColor,
    theme: "auto",
    indexHref: data.indexHref,
    recordVisits: true,
  });
  assert.match(html, /MSA &lt;&quot;&amp;&gt; edition/, "title escaped");
  assert.doesNotMatch(html, /MSA <"&> edition/);
  assert.ok(html.includes(VISIT_API_PATH), "visit beacon wired");
  assert.match(html, /"docs":\["msa"\]|\["msa"\]/, "beacon carries rendered slugs");
  assert.match(html, /sm-l-root/, "liveness marker present");
  assert.match(html, /<html lang="en-US">/, "auto emits no theme attribute on <html>");
  const pinned = embedDocumentHtml({
    docs: data.docs,
    introParagraphs: [],
    footerLines: [],
    accentColor: "#1d4ed8",
    theme: "dark",
    indexHref: data.indexHref,
  });
  assert.match(pinned, /<html lang="en-US" data-sm-embed-theme="dark">/);
});

test("preview mode emits no beacon", () => {
  const html = embedDocumentHtml({
    docs: [],
    introParagraphs: [],
    footerLines: [],
    accentColor: "#1d4ed8",
    theme: "light",
    indexHref: "https://x/legal",
    recordVisits: false,
  });
  assert.ok(!html.includes(VISIT_API_PATH));
  assert.match(html, /No agreements have been published yet/);
});

test("the off document is an empty 0-height 200 body, not an error", () => {
  const html = embedDocumentOffHtml();
  assert.match(html, /height:0/);
  assert.doesNotMatch(html, /error|Error/);
});

test("renderEmbedBody output is never double-escaped by the shell", () => {
  const data = assembleEmbedData(
    "https://x",
    [makeDoc(1, "msa", "MSA", [{ v: 1, body: "**bold** stays bold" }])],
    SETTINGS,
    MSP,
  );
  const html = embedDocumentHtml({
    docs: data.docs,
    introParagraphs: [],
    footerLines: [],
    accentColor: "#1d4ed8",
    theme: "light",
    indexHref: "https://x/legal",
  });
  assert.match(html, /<strong class="sm-l-strong">bold<\/strong>/);
  assert.doesNotMatch(html, /&lt;strong/);
});

test("footer/intro helpers split lines and include MSP identity", () => {
  assert.deepEqual(textLines(" a \n\n b "), ["a", "b"]);
  assert.deepEqual(buildFooterLines(MSP, "Line 1\nLine 2"), [
    "Standard Computer",
    "1 Main St, Lincoln NE",
    "Line 1",
    "Line 2",
  ]);
  const body = renderEmbedBody("plain");
  assert.match(body, /sm-l-body/);
});
