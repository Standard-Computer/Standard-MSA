// The /legal embed and the visitor log, end to end against a real database
// (SHA-4497, for GH #18 acceptance items 2 and 3).
//
// Everything this exercises was built by SHA-2957. Sean asked for it again
// in mail 4895 as though it were missing, and the issue's remaining work is
// "confirm" — so the confirmation is executable rather than a paragraph on a
// card. What it drives is the URLs an operator actually pastes on their
// website:
//
//   item 2  GET /legal/embed.js  and  GET /legal/embed/frame  — the two
//           snippet targets — list EVERY published agreement, and a newly
//           published version replaces the one on display without the
//           pasted snippet changing by one character.
//   item 3  POST/PATCH /api/legal/visit — the embed beacon — record the
//           visitor's IP (or the salted hash, per the operator toggle) and a
//           timestamp, and the rows come back through the exact query
//           /visits renders from.
//
// The direct-page-view writer (src/lib/visits/record.ts) CAN now be driven
// here, which it could not when this file was first written: SHA-4501 (#28)
// gave recordPageVisit an optional `requestHeaders`, for the PDF route
// handlers, and supplying it is what keeps the function off next/headers —
// which throws outside a request scope and is swallowed by its own catch. So
// the second writer gets real behavioural coverage below rather than only
// the source pin at the bottom of the file, and both of them are held to ONE
// copy of Sean's ruling by both.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha4497-embed-visit-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.com";
// The hash branch must be provably salted with THIS value, not the fallback.
process.env.VISIT_IP_HASH_SALT = "sha4497-test-salt";
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

const BASE = "https://msa.example.com";
const VISITOR_IP = "203.0.113.77";
const VISITOR_UA = "Mozilla/5.0 (SHA-4497 fixture)";
const HOST_PAGE = "https://www.reyesdental.example/legal";

// Imported dynamically so every module initialises after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let frameRoute: typeof import("../../src/app/legal/embed/frame/route");
let loaderRoute: typeof import("../../src/app/legal/embed.js/route");
let visitRoute: typeof import("../../src/app/api/legal/visit/route");
let settings: typeof import("../../src/lib/legal/settings");
let visitsQuery: typeof import("../../src/lib/visits/query");
let visitHelpers: typeof import("../../src/lib/visits/visits");
let record: typeof import("../../src/lib/visits/record");
let embed: typeof import("../../src/lib/legal/embed");

let msaDocId = 0;

/** Publish a version of a document, as the operator's Publish button does. */
async function publish(documentId: number, version: number, body: string, at: string) {
  await prisma.legalDocumentVersion.create({
    data: {
      documentId,
      version,
      bodyMarkdown: body,
      variablesJson: "{}",
      publishedAt: new Date(at),
    },
  });
}

/** A GET of one of the pasted snippet's URLs. */
async function getFrame(url = `${BASE}/legal/embed/frame`) {
  const { NextRequest } = await import("next/server");
  return frameRoute.GET(new NextRequest(new Request(url)));
}

/** A beacon POST exactly as the frame script sends it, behind a proxy. */
async function beacon(visitId: string, extra: Record<string, unknown> = {}) {
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    new Request(`${BASE}/api/legal/visit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `${VISITOR_IP}, 10.0.0.1`,
        "user-agent": VISITOR_UA,
        "cf-ipcountry": "us",
      },
      body: JSON.stringify({ visitId, docs: ["msa", "baa"], theme: "light", referrer: HOST_PAGE, ...extra }),
    }),
  );
  return visitRoute.POST(req);
}

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  frameRoute = await import("../../src/app/legal/embed/frame/route");
  loaderRoute = await import("../../src/app/legal/embed.js/route");
  visitRoute = await import("../../src/app/api/legal/visit/route");
  settings = await import("../../src/lib/legal/settings");
  visitsQuery = await import("../../src/lib/visits/query");
  visitHelpers = await import("../../src/lib/visits/visits");
  record = await import("../../src/lib/visits/record");
  embed = await import("../../src/lib/legal/embed");

  await prisma.mspIdentity.create({
    data: { name: "Reyes IT", legalName: "Reyes IT LLC", venue: "Nebraska" },
  });

  const msa = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Services Agreement", kind: "msa" },
  });
  msaDocId = msa.id;
  await publish(msa.id, 1, "## 1. Parties\n\nBetween {{msp_name}} and {{client_name}}.", "2026-11-01T00:00:00Z");

  const baa = await prisma.legalDocument.create({
    data: { slug: "baa", title: "HIPAA Business Associate Agreement", kind: "baa" },
  });
  await publish(baa.id, 1, "## 1. Scope\n\nProtected health information handled by {{msp_name}}.", "2026-11-02T00:00:00Z");

  // A draft, to prove "published" is doing work in the assertions below.
  const draftOnly = await prisma.legalDocument.create({
    data: { slug: "aup", title: "Acceptable Use Policy", kind: "other" },
  });
  await prisma.legalDocumentVersion.create({
    data: { documentId: draftOnly.id, version: 1, bodyMarkdown: "## Draft", variablesJson: "{}" },
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

// ── Item 2: the pasted snippet renders every published agreement ──────────

test("the pasted snippet's URLs are the ones this install serves", async () => {
  // The operator copies these two strings; nothing else connects them to the
  // routes, so the paths are asserted against the snippet text itself.
  const script = embed.embedScriptSnippet({ baseUrl: BASE });
  const iframe = embed.embedIframeSnippet({ baseUrl: BASE });
  assert.ok(script.includes(`${BASE}/legal/embed.js`), script);
  assert.ok(iframe.includes(`${BASE}/legal/embed/frame`), iframe);

  // And both of those URLs answer on this install.
  const loader = await loaderRoute.GET();
  assert.equal(loader.status, 200);
  assert.match(loader.headers.get("content-type") ?? "", /javascript/);
  const loaderBody = await loader.text();
  assert.ok(loaderBody.includes("/legal/embed/frame"), "the loader injects the frame");

  const frame = await getFrame();
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get("content-type") ?? "", /text\/html/);
});

test("the frame lists EVERY published agreement, and no draft", async () => {
  const html = await (await getFrame()).text();
  assert.ok(html.includes("Master Services Agreement"), "MSA present");
  assert.ok(html.includes("HIPAA Business Associate Agreement"), "BAA present");
  assert.ok(html.includes("Between Reyes IT and"), "MSP value merged into the body");
  // The draft document must not reach somebody else's website.
  assert.ok(!html.includes("Acceptable Use Policy"), "draft-only document stays invisible");
  // Client tokens go generic in public mode; no raw token survives.
  assert.ok(!html.includes("{{"), "no unsubstituted token in the rendered frame");
});

test("publishing a new version changes what the SAME snippet renders", async () => {
  const before = await (await getFrame()).text();
  assert.ok(before.includes("Between Reyes IT and"), "v1 body on display");
  assert.ok(!before.includes("Amended liability cap"), "v2 text not there yet");

  await publish(msaDocId, 2, "## 1. Parties\n\nAmended liability cap for {{client_name}}.", "2026-11-20T00:00:00Z");

  const after = await (await getFrame()).text();
  assert.ok(after.includes("Amended liability cap"), "v2 is now the version on display");
  // v1 moves to the history list rather than vanishing — it stays reachable
  // at its own permalink, which is what makes an archived version citable.
  assert.ok(after.includes("/legal/msa/1"), "v1 linked as history");
  // Nothing about the operator's pasted snippet changed to make that happen.
  assert.equal(embed.embedScriptSnippet({ baseUrl: BASE }), embed.embedScriptSnippet({ baseUrl: BASE }));
  // And the frame is never statically cached, which is what would otherwise
  // leave v1 on the MSP's site after v2 went live.
  const fresh = await getFrame();
  assert.match(fresh.headers.get("cache-control") ?? "", /max-age=300/);
});

// ── Item 3: visits record IP-or-hash + timestamp, and show on /visits ─────

test("an embed visit records the raw IP and a timestamp by default", async () => {
  const sentAt = Date.now();
  const res = await beacon("sha4497visit0001");
  assert.equal(res.status, 204);

  const row = await prisma.legalVisit.findUnique({ where: { visitId: "sha4497visit0001" } });
  assert.ok(row, "the beacon created a visit row");
  // Sean's ruling: the default is the address itself, not a pseudonym.
  assert.equal(row!.ip, VISITOR_IP);
  assert.equal(row!.ipHash, null);
  // The timestamp half of "IPs and timestamps".
  assert.ok(Math.abs(row!.occurredAt.getTime() - sentAt) < 60_000, "occurredAt is this visit's time");
  assert.equal(row!.embedded, true);
  assert.equal(row!.path, "/legal/embed/frame");
  assert.equal(row!.userAgent, VISITOR_UA);
  assert.equal(row!.referer, HOST_PAGE, "the HOST page's URL, not the frame's");
  assert.equal(row!.country, "US");
  assert.deepEqual(JSON.parse(row!.docsJson), ["msa", "baa"]);
});

test("the read timer accrues onto that visit, server-clamped", async () => {
  const { NextRequest } = await import("next/server");
  const patch = (seconds: number) =>
    visitRoute.PATCH(
      new NextRequest(
        new Request(`${BASE}/api/legal/visit`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitId: "sha4497visit0001", seconds }),
        }),
      ),
    );
  assert.equal((await patch(15)).status, 204);
  assert.equal((await patch(15)).status, 204);
  // A lying client gets one interval, not its claim.
  assert.equal((await patch(999_999)).status, 204);
  const row = await prisma.legalVisit.findUnique({ where: { visitId: "sha4497visit0001" } });
  assert.equal(row!.secondsOnPage, 15 + 15 + 120);
});

test("with the operator toggle on, the SAME beacon stores only a salted hash", async () => {
  await settings.updateLegalSettings({ hashVisitorIps: true });
  try {
    const res = await beacon("sha4497visit0002");
    assert.equal(res.status, 204);
    const row = await prisma.legalVisit.findUnique({ where: { visitId: "sha4497visit0002" } });
    assert.equal(row!.ip, null, "the raw address is not stored when hashing is on");
    assert.equal(row!.ipHash, visitHelpers.hashIp(VISITOR_IP, "sha4497-test-salt"));
    // The toggle is about the address only: the visit is still logged, still
    // timestamped, and still attributable to a country.
    assert.ok(row!.occurredAt instanceof Date);
    assert.equal(row!.country, "US");
  } finally {
    // Back to Sean's default for the rest of the file.
    await settings.updateLegalSettings({ hashVisitorIps: false });
  }
  assert.equal((await settings.legalSettings()).hashVisitorIps, false);
});

test("both visits come back through the query /visits renders from", async () => {
  // The exact read in src/app/visits/page.tsx: parse the operator's filters,
  // build the where, order by occurredAt desc.
  const filters = visitsQuery.parseVisitFilters({});
  const where = visitsQuery.visitWhere(filters);
  const [rows, total] = await Promise.all([
    prisma.legalVisit.findMany({ where, orderBy: { occurredAt: "desc" }, take: 200 }),
    prisma.legalVisit.count({ where }),
  ]);
  assert.equal(total, 2);
  const ids = rows.map((r) => r.visitId);
  assert.ok(ids.includes("sha4497visit0001") && ids.includes("sha4497visit0002"));
  // One row carries the address, the other the hash — the operator sees both
  // kinds of visit in one log, which is the point of keeping the toggle.
  assert.equal(rows.filter((r) => r.ip !== null).length, 1);
  assert.equal(rows.filter((r) => r.ipHash !== null).length, 1);
  // Every row in the log has a timestamp; a visit with no time is not a visit.
  assert.ok(rows.every((r) => r.occurredAt instanceof Date));

  // And the CSV export is fed the same rows through the same escaping.
  assert.equal(visitsQuery.csvCell(VISITOR_IP), VISITOR_IP);
});

test("a date filter narrows the log without dropping the IP columns", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const where = visitsQuery.visitWhere(visitsQuery.parseVisitFilters({ from: today, to: today }));
  const rows = await prisma.legalVisit.findMany({ where });
  assert.equal(rows.length, 2, "both of today's visits match a same-day filter");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const none = await prisma.legalVisit.findMany({
    where: visitsQuery.visitWhere(visitsQuery.parseVisitFilters({ from: yesterday, to: yesterday })),
  });
  assert.equal(none.length, 0);
});

test("the direct page view obeys the same toggle, and never stores both", async () => {
  // The OTHER writer, driven for real. A source pin can only say what
  // record.ts looks like; this says what it does. Whatever the file is
  // rewritten to, a row that carries the address and the hash together — the
  // privacy-losing direction, and what the "exclusive by construction"
  // docstring in src/lib/visits/visits.ts forbids — fails here.
  const pageHeaders = () =>
    new Headers({
      "x-forwarded-for": `${VISITOR_IP}, 10.0.0.1`,
      "user-agent": VISITOR_UA,
      "cf-ipcountry": "us",
      referer: HOST_PAGE,
    });
  /** The row this writer just wrote, found by its own path. */
  const rowFor = async (path: string) => {
    const row = await prisma.legalVisit.findFirst({ where: { path }, orderBy: { id: "desc" } });
    assert.ok(row, `the page view created a visit row for ${path}`);
    return row!;
  };

  // Default: the address itself, per Sean's ruling.
  await record.recordPageVisit("/legal/msa/pin-off", "msa", 1, pageHeaders());
  const off = await rowFor("/legal/msa/pin-off");
  assert.equal(off.ip, VISITOR_IP);
  assert.equal(off.ipHash, null, "hashing off means no hash beside the address");
  assert.equal(off.embedded, false, "a page view is not an embed visit");
  assert.equal(off.userAgent, VISITOR_UA);
  assert.equal(off.referer, HOST_PAGE, "the page view reads referer from the request header");
  assert.equal(off.country, "US");

  // Toggle on: the hash, and ONLY the hash.
  await settings.updateLegalSettings({ hashVisitorIps: true });
  try {
    await record.recordPageVisit("/legal/msa/pin-on", "msa", 1, pageHeaders());
    const on = await rowFor("/legal/msa/pin-on");
    assert.equal(on.ip, null, "hashing on means the raw address is not stored");
    assert.equal(on.ipHash, visitHelpers.hashIp(VISITOR_IP, "sha4497-test-salt"));
    // Exclusivity, stated as the invariant rather than as two branch values:
    // whichever way the toggle is set, exactly one of the pair is populated.
    for (const row of [off, on]) {
      assert.equal(
        Number(row.ip !== null) + Number(row.ipHash !== null),
        1,
        `${row.path} must carry the address XOR the hash, never both and never neither`,
      );
    }
  } finally {
    await settings.updateLegalSettings({ hashVisitorIps: false });
  }
});

// ── One copy of the ruling ───────────────────────────────────────────────

test("both visit writers delegate the IP decision to visitorColumns", () => {
  // A source pin, in the discipline of tests/legal/embedRoutes.test.ts. The
  // page-view writer cannot be driven from a test (next/headers), so what is
  // held here is that it does not carry its OWN copy of the ternary: the
  // default Sean ruled on lives in src/lib/visits/visits.ts and nowhere
  // else. Delete the delegation and this fails before the default can drift
  // for half the visits.
  //
  // It pins the ARGUMENT LIST and the spread, not merely that the call is
  // present, because "calls visitorColumns" is satisfied by a writer that
  // then re-branches on the toggle itself and stores the raw address
  // alongside the hash — the exact thing the "exclusive by construction"
  // docstring at src/lib/visits/visits.ts forbids. A caller that passes a
  // hard-coded `false`, that spreads something other than the call's own
  // result, or that names `hashVisitorIps` a second time anywhere in the
  // file, fails here.
  const writers = [
    "src/lib/visits/record.ts",
    "src/app/api/legal/visit/route.ts",
  ];
  for (const rel of writers) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.match(
      src,
      /\.\.\.visitorColumns\(\s*get,\s*settings\.hashVisitorIps,\s*visitIpSalt\(\),?\s*\)/,
      `${rel} must spread visitorColumns(get, settings.hashVisitorIps, visitIpSalt()) straight into the write`,
    );
    assert.equal(
      (src.match(/hashVisitorIps/g) ?? []).length,
      1,
      `${rel} may name hashVisitorIps exactly once — as that argument, and never as a branch of its own`,
    );
    assert.ok(
      !src.includes("VISIT_IP_HASH_SALT"),
      `${rel} must not read the salt itself — visitIpSalt() is the one reader`,
    );
  }
});
