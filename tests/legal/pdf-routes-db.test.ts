// The real PDF route handlers, against a real database (SHA-4501).
//
// Criterion A6 asks for exactly this: a published fixture document yields an
// `application/pdf` response whose `Content-Disposition` is an attachment,
// and whose public-mode output carries the generic client wording rather
// than raw tokens.
//
// Plus the three isolation rules the criteria set, each asserted against the
// handler rather than against the library it calls:
//
//   · the operator download is gated, and refuses as a 401 (a download, not
//     a screen) — `tests/auth/coverage.test.ts` holds the classification,
//     this holds the behaviour;
//   · a DRAFT is downloadable by the operator and invisible to both public
//     routes;
//   · a recipient's real details, present in the database, never reach a
//     public PDF — asserted with a send whose values WOULD be visible if any
//     of these surfaces rendered in `filled` mode.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pdfText } from "./_pdfReadback";

const dbDir = mkdtempSync(join(tmpdir(), "sha4501-pdf-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.test";
const PASSWORD = "a-long-enough-operator-password";
process.env.OPERATOR_PASSWORD = PASSWORD;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

const BASE = "https://msa.example.test";

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let legalCurrentPdf: typeof import("../../src/app/legal/[slug]/pdf/route");
let legalVersionPdf: typeof import("../../src/app/legal/[slug]/[version]/pdf/route");
let documentPdf: typeof import("../../src/app/documents/[slug]/versions/[version]/pdf/route");
let cookie = "";

// A body that uses one token of each kind, so a mode mistake is visible in
// the output rather than theoretical.
const BODY = `## Master Service Agreement

Between **{{msp_legal_name}}** of {{msp_address}} and **{{client_legal_name}}** of {{client_address}}, effective {{effective_date}}.

### 1. Services

1.1 The Provider delivers managed IT services to {{client_name}}.

### 2. Acceptance

Accepted for the Client by {{signer_name}} on {{accepted_date}}. Questions go to {{msp_email}}.`;

const RECIPIENT = {
  email: "dana@mail.example.test",
  fullName: "Dana Reyes",
  companyName: "Reyes Dental",
  legalName: "Reyes Dental LLC",
  address: "17 Prairie Road, Lincoln, Nebraska",
  phone: "+1-402-555-0117",
};

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  const session = await import("../../src/lib/auth/session");
  const sends = await import("../../src/lib/sends/sends");
  legalCurrentPdf = await import("../../src/app/legal/[slug]/pdf/route");
  legalVersionPdf = await import("../../src/app/legal/[slug]/[version]/pdf/route");
  documentPdf = await import("../../src/app/documents/[slug]/versions/[version]/pdf/route");

  await prisma.mspIdentity.create({
    data: {
      name: "Standard Computer",
      legalName: "Standard Computer LLC",
      address: "9 Platte Street, Lincoln, Nebraska",
      email: "legal@standardcomputer.test",
      venue: "Nebraska",
    },
  });

  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Service Agreement", kind: "msa" },
  });
  // v1 published, v2 published (the current one), v3 an open draft.
  for (const version of [1, 2]) {
    await prisma.legalDocumentVersion.create({
      data: {
        documentId: doc.id,
        version,
        bodyMarkdown: `${BODY}\n\nThis is version ${version}.`,
        variablesJson: "{}",
        publishedAt: new Date(`2026-1${version}-01T00:00:00Z`),
      },
    });
  }
  const draft = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 3,
      bodyMarkdown: `${BODY}\n\nUNPUBLISHED DRAFT TEXT.`,
      variablesJson: "{}",
      publishedAt: null,
    },
  });
  assert.equal(draft.publishedAt, null, "fixture: v3 is an open draft");

  // A real send of v2, so the recipient's details genuinely exist in this
  // database. Every "not in the PDF" assertion below would be vacuous
  // without it.
  const current = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { documentId: doc.id, version: 2 },
  });
  await sends.createSend(current.id, RECIPIENT);

  cookie = `${session.OPERATOR_COOKIE}=${await session.mintSession(PASSWORD)}`;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

const asBytes = async (res: Response): Promise<Uint8Array> =>
  new Uint8Array(await res.arrayBuffer());

const getCurrent = (slug: string): Promise<Response> =>
  legalCurrentPdf.GET(new Request(`${BASE}/legal/${slug}/pdf`), {
    params: Promise.resolve({ slug }),
  });

const getVersion = (slug: string, version: string): Promise<Response> =>
  legalVersionPdf.GET(new Request(`${BASE}/legal/${slug}/${version}/pdf`), {
    params: Promise.resolve({ slug, version }),
  });

const getOperator = (slug: string, version: string, withCookie?: string): Promise<Response> =>
  documentPdf.GET(
    new Request(
      `${BASE}/documents/${slug}/versions/${version}/pdf`,
      withCookie ? { headers: { cookie: withCookie } } : undefined,
    ),
    { params: Promise.resolve({ slug, version }) },
  );

test("the fixture really does hold a recipient's details (else the rest proves nothing)", async () => {
  const recipient = await prisma.recipient.findFirstOrThrow();
  assert.equal(recipient.legalName, RECIPIENT.legalName);
  assert.equal(recipient.address, RECIPIENT.address);
});

test("GET /legal/[slug]/pdf downloads the current published version as a PDF", async () => {
  const res = await getCurrent("msa");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="msa-v2\.pdf"$/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  const bytes = await asBytes(res);
  assert.match(Buffer.from(bytes.slice(0, 5)).toString("latin1"), /^%PDF-/);
  const text = pdfText(bytes);
  assert.ok(text.includes("This is version 2"), "the CURRENT version, not an older one");
  assert.ok(!text.includes("This is version 1"), "and not the history");
});

test("the public PDF carries the generic client wording and no raw token", async () => {
  const text = pdfText(await asBytes(await getCurrent("msa")));
  // The MSP side filled from MspIdentity…
  assert.ok(text.includes("Standard Computer LLC"), "the MSP legal name");
  assert.ok(text.includes("9 Platte Street"), "the MSP address");
  // …and every client/signer token rendered its generic prose.
  assert.ok(text.includes("the Client"), '"the Client" for a client name');
  assert.ok(text.includes("the Client's address of record"), "and for the address");
  assert.ok(text.includes("authorized signatory"), "and for the signer");
  assert.ok(text.includes("the date of acceptance"), "and for the date");
  // Never a token, never a blank.
  assert.ok(!text.includes("{{"), "no raw {{token}}");
  assert.ok(!text.includes("[unset:"), "no unresolved variable");
});

test("no recipient value reaches a public PDF, on either public route", async () => {
  // `renderLegalBody` discards recipientValues unless the mode is `filled`,
  // and src/lib/legal/pdfDocument.ts takes no mode argument at all — so
  // there is no call path that could put these on a public page. Asserted
  // against the real send created above.
  for (const res of [await getCurrent("msa"), await getVersion("msa", "2")]) {
    const text = pdfText(await asBytes(res));
    for (const leak of [
      RECIPIENT.legalName,
      RECIPIENT.companyName,
      RECIPIENT.address,
      RECIPIENT.email,
      RECIPIENT.fullName,
      RECIPIENT.phone,
    ]) {
      assert.ok(!text.includes(leak), `"${leak}" must not appear in a public PDF`);
    }
  }
});

test("GET /legal/[slug]/[version]/pdf serves one historical version, by number", async () => {
  const res = await getVersion("msa", "1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /filename="msa-v1\.pdf"/);
  const text = pdfText(await asBytes(res));
  assert.ok(text.includes("This is version 1"), "v1 is still readable after v2 shipped");
  assert.ok(!text.includes("This is version 2"));
});

test("the public routes refuse a draft, an unknown slug and a nonsense version", async () => {
  // The draft exists and is downloadable by the operator (next test), so
  // this 404 is a refusal rather than an absence.
  assert.equal((await getVersion("msa", "3")).status, 404);
  assert.equal((await getVersion("msa", "99")).status, 404);
  assert.equal((await getVersion("msa", "0")).status, 404);
  assert.equal((await getVersion("msa", "-1")).status, 404);
  assert.equal((await getVersion("msa", "2abc")).status, 404);
  assert.equal((await getVersion("msa", "")).status, 404);
  assert.equal((await getCurrent("no-such-document")).status, 404);
  assert.equal((await getVersion("no-such-document", "1")).status, 404);
});

test("a document with nothing published has no public PDF at all", async () => {
  const draftOnly = await prisma.legalDocument.create({
    data: { slug: "unpublished-only", title: "Unpublished Only", kind: "website-terms" },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: draftOnly.id,
      version: 1,
      bodyMarkdown: "## Secret draft\n\nNot published.",
      variablesJson: "{}",
      publishedAt: null,
    },
  });
  assert.equal((await getCurrent("unpublished-only")).status, 404);
  assert.equal((await getVersion("unpublished-only", "1")).status, 404);
  // …and the operator can still download it.
  const res = await getOperator("unpublished-only", "1", cookie);
  assert.equal(res.status, 200);
  assert.ok(pdfText(await asBytes(res)).includes("Secret draft"));
});

test("GET /documents/[slug]/versions/[version]/pdf refuses an unauthenticated caller with 401", async () => {
  const res = await getOperator("msa", "3");
  assert.equal(res.status, 401);
  // A download refuses with a status, not a 303 to a form it cannot use.
  assert.equal(res.headers.get("content-disposition"), null);
  assert.equal(res.headers.get("location"), null);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const body = await res.text();
  assert.ok(!body.includes("%PDF"), "no bytes of the document leak with the refusal");
  assert.ok(!body.includes("DRAFT"), "nor anything about it");
});

test("the refusal is identical for a document that does not exist", async () => {
  // An unauthenticated caller must not be able to enumerate slugs by
  // comparing refusals, which is why the guard runs before the lookup.
  const real = await getOperator("msa", "1");
  const fake = await getOperator("no-such-document", "1");
  assert.equal(real.status, fake.status);
  assert.equal(await real.text(), await fake.text());
});

test("an authenticated operator downloads any version, draft included and labelled", async () => {
  const res = await getOperator("msa", "3", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /^attachment; filename="msa-v3-draft\.pdf"$/,
  );
  const text = pdfText(await asBytes(res));
  assert.ok(text.includes("UNPUBLISHED DRAFT TEXT"), "the draft text is there");
  assert.ok(text.includes("DRAFT - NOT PUBLISHED"), "and it is labelled as a draft");
  // Still public-mode wording: this is the "see what the website will say"
  // download, so no recipient value and no raw token even for the operator.
  assert.ok(text.includes("the Client"));
  assert.ok(!text.includes("{{"));
  assert.ok(!text.includes(RECIPIENT.legalName));
});

test("the operator download of a PUBLISHED version is not labelled a draft", async () => {
  const res = await getOperator("msa", "2", cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /filename="msa-v2\.pdf"/);
  const text = pdfText(await asBytes(res));
  assert.ok(!text.includes("DRAFT"), "a published version is never marked DRAFT");
  assert.ok(text.includes("effective 2026-12-01"), "it carries its effective date");
});

test("the operator route 404s a version that does not exist, once authenticated", async () => {
  assert.equal((await getOperator("msa", "99", cookie)).status, 404);
  assert.equal((await getOperator("no-such-document", "1", cookie)).status, 404);
  assert.equal((await getOperator("msa", "abc", cookie)).status, 404);
});

test("a download of a public PDF is recorded in the visitor log", async () => {
  // The visit log is what tells an operator which version was read when
  // (SHA-2957); it must not go quiet because a reader saved the file rather
  // than scrolling the page.
  const before = await prisma.legalVisit.count();
  await getCurrent("msa");
  await getVersion("msa", "1");
  const rows = await prisma.legalVisit.findMany({ orderBy: { id: "desc" }, take: 2 });
  assert.equal(await prisma.legalVisit.count(), before + 2);
  const paths = rows.map((r) => r.path).sort();
  assert.deepEqual(paths, ["/legal/msa/1/pdf", "/legal/msa/pdf"]);
  assert.deepEqual(
    rows.map((r) => r.version).sort(),
    [1, 2],
  );
});

test("the operator download is NOT recorded as a public visit", async () => {
  // The operator reading their own draft is not a website visitor; counting
  // it would corrupt the number an operator reports.
  const before = await prisma.legalVisit.count();
  await getOperator("msa", "3", cookie);
  assert.equal(await prisma.legalVisit.count(), before);
});

test("REGRESSION: the cover cites the host the reader used, not the container's bind address", async () => {
  // Shipped bug, found on the Railway production deploy and not in CI: the
  // cover line reading "where to find the live text" said
  // https://0.0.0.0:8080/legal/msa/1, because the handler took
  // `new URL(req.url).origin` and that is what the Node server BOUND to.
  // Every test above fetches the handler on the same hostname it declares,
  // which is exactly why none of them could see it.
  const res = await legalCurrentPdf.GET(
    new Request("http://0.0.0.0:8080/legal/msa/pdf", {
      headers: { "x-forwarded-host": "legal.acme.test", "x-forwarded-proto": "https" },
    }),
    { params: Promise.resolve({ slug: "msa" }) },
  );
  assert.equal(res.status, 200);
  const text = pdfText(await asBytes(res));
  assert.ok(text.includes("https://legal.acme.test/legal/msa/2"), `cover URL missing: ${text.slice(0, 200)}`);
  assert.ok(!text.includes("0.0.0.0"), "a bind address is never a hostname a reader can reach");
});

test("REGRESSION: with no proxy header, a wildcard bind falls back to APP_BASE_URL", async () => {
  // The same deploy, minus the forwarded headers: the operator's declared
  // public base is the last thing that still beats citing 0.0.0.0.
  const res = await legalVersionPdf.GET(new Request("http://0.0.0.0:8080/legal/msa/1/pdf"), {
    params: Promise.resolve({ slug: "msa", version: "1" }),
  });
  assert.equal(res.status, 200);
  const text = pdfText(await asBytes(res));
  assert.ok(text.includes(`${BASE}/legal/msa/1`), "APP_BASE_URL is the fallback");
  assert.ok(!text.includes("0.0.0.0"));
});

test("REGRESSION: the operator PDF route derives its origin the same way", async () => {
  const res = await documentPdf.GET(
    new Request("http://0.0.0.0:8080/documents/msa/versions/2/pdf", {
      headers: { cookie, "x-forwarded-host": "ops.acme.test", "x-forwarded-proto": "https" },
    }),
    { params: Promise.resolve({ slug: "msa", version: "2" }) },
  );
  assert.equal(res.status, 200);
  const text = pdfText(await asBytes(res));
  assert.ok(text.includes("https://ops.acme.test/legal/msa/2"), "the operator's own host");
  assert.ok(!text.includes("0.0.0.0"));
});

test("REGRESSION: an injected Host header never reaches the cover of a saved agreement", async () => {
  // Nothing guarantees a proxy is in front of a self-hosted install, so
  // `x-forwarded-host` is visitor-controllable in that deployment — and this
  // output is printed into a PDF of a legal agreement that gets forwarded on.
  const res = await legalCurrentPdf.GET(
    new Request(`${BASE}/legal/msa/pdf`, {
      headers: { "x-forwarded-host": "evil.test/phish" },
    }),
    { params: Promise.resolve({ slug: "msa" }) },
  );
  assert.equal(res.status, 200);
  const text = pdfText(await asBytes(res));
  assert.ok(!text.includes("evil.test"), "a malformed host is dropped, not printed");
  assert.ok(text.includes(`${BASE}/legal/msa/2`), "and the sound origin is used instead");
});
