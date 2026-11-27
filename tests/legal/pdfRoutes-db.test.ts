// The real PDF route handlers against a real database (GH #22 / SHA-4505).
//
// AC 6's required test, plus the isolation rules around it: a published
// fixture yields an application/pdf attachment whose bytes carry the
// generic client wording and no raw {{token}}; a draft is invisible on the
// public routes but downloadable — labelled — by an operator; and an
// unauthenticated caller gets a bare 401 from the operator route, never a
// document.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pdfText } from "./_pdfText";

const dbDir = mkdtempSync(join(tmpdir(), "sha4505-pdf-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.com";
const PASSWORD = "a-long-enough-operator-password";
process.env.OPERATOR_PASSWORD = PASSWORD;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

const BASE = "https://msa.example.com";

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let currentPdfRoute: typeof import("../../src/app/legal/[slug]/pdf/route");
let versionPdfRoute: typeof import("../../src/app/legal/[slug]/[version]/pdf/route");
let operatorPdfRoute: typeof import("../../src/app/documents/[slug]/versions/[version]/pdf/route");

let cookie = "";

const bodyBytes = async (res: Response): Promise<Uint8Array> =>
  new Uint8Array(await res.arrayBuffer());
const magic = (bytes: Uint8Array): string => Buffer.from(bytes.slice(0, 8)).toString("latin1");

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  const session = await import("../../src/lib/auth/session");
  currentPdfRoute = await import("../../src/app/legal/[slug]/pdf/route");
  versionPdfRoute = await import("../../src/app/legal/[slug]/[version]/pdf/route");
  operatorPdfRoute = await import("../../src/app/documents/[slug]/versions/[version]/pdf/route");

  await prisma.mspIdentity.create({
    data: { name: "Standard Computer", legalName: "Standard Computer LLC", venue: "Nebraska" },
  });
  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Services Agreement", kind: "msa" },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      // Short lines on purpose: unwrapped, each survives verbatim in the
      // content stream, so the byte-level assertions below are exact.
      bodyMarkdown: "## Parties\n\nProvided to {{client_name}}.\n\nBy {{msp_name}}.",
      variablesJson: "{}",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 2,
      bodyMarkdown: "## Parties\n\nDraft wording v2 for {{client_name}}.",
      variablesJson: "{}",
      publishedAt: null,
    },
  });

  cookie = `${session.OPERATOR_COOKIE}=${await session.mintSession(PASSWORD)}`;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

const getCurrent = (slug: string): Promise<Response> =>
  currentPdfRoute.GET(new Request(`${BASE}/legal/${slug}/pdf`), {
    params: Promise.resolve({ slug }),
  });

const getVersion = (slug: string, version: string): Promise<Response> =>
  versionPdfRoute.GET(new Request(`${BASE}/legal/${slug}/${version}/pdf`), {
    params: Promise.resolve({ slug, version }),
  });

const getOperator = (slug: string, version: string, withCookie?: string): Promise<Response> =>
  operatorPdfRoute.GET(
    new Request(
      `${BASE}/documents/${slug}/versions/${version}/pdf`,
      withCookie ? { headers: { cookie: withCookie } } : undefined,
    ),
    { params: Promise.resolve({ slug, version }) },
  );

test("GET /legal/[slug]/pdf: application/pdf attachment with generic wording, no tokens", async () => {
  const res = await getCurrent("msa");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="msa-v1.pdf"');
  const bytes = await bodyBytes(res);
  assert.ok(magic(bytes).startsWith("%PDF-"), "the body is a PDF");
  const text = pdfText(bytes);
  assert.ok(text.includes("Provided to the Client."), "client token rendered generically");
  assert.ok(text.includes("By Standard Computer."), "MSP identity filled");
  assert.ok(!text.includes("{{"), "no raw token");
  assert.ok(!text.includes("DRAFT"), "published version carries no draft marker");
});

test("GET /legal/[slug]/[version]/pdf serves a published version and only a published one", async () => {
  const ok = await getVersion("msa", "1");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-disposition"), 'attachment; filename="msa-v1.pdf"');

  // The draft v2 must be invisible on every public surface — same rule as
  // the /legal pages themselves.
  assert.equal((await getVersion("msa", "2")).status, 404);
  assert.equal((await getVersion("msa", "0")).status, 404);
  assert.equal((await getVersion("msa", "x")).status, 404);
  assert.equal((await getVersion("nope", "1")).status, 404);
});

test("GET /legal/[slug]/pdf 404s for a document with nothing published", async () => {
  const bare = await prisma.legalDocument.create({
    data: { slug: "draft-only", title: "Draft Only", kind: "msa" },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: bare.id,
      version: 1,
      bodyMarkdown: "Unpublished.",
      variablesJson: "{}",
      publishedAt: null,
    },
  });
  assert.equal((await getCurrent("draft-only")).status, 404);
});

test("the operator PDF route refuses an unauthenticated caller with a bare 401", async () => {
  const res = await getOperator("msa", "2");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-disposition"), null, "nothing to save");
  const body = await res.text();
  assert.ok(!body.includes("%PDF-"), "no document bytes in a refusal");
  assert.ok(!body.includes("Draft wording"), "no draft text in a refusal");
});

test("an operator downloads a draft, clearly labelled as one", async () => {
  const res = await getOperator("msa", "2", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="msa-v2-draft.pdf"');
  const text = pdfText(await bodyBytes(res));
  assert.ok(text.includes("DRAFT"), "the draft marker is drawn");
  assert.ok(text.includes("Draft wording v2 for the Client."), "public-mode wording even for the operator");
  assert.ok(!text.includes("{{"), "no raw token");
});

test("an operator downloads the published version too, and unknown versions 404", async () => {
  const res = await getOperator("msa", "1", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="msa-v1.pdf"');
  assert.equal((await getOperator("msa", "9", cookie)).status, 404);
  assert.equal((await getOperator("nope", "1", cookie)).status, 404);
});
