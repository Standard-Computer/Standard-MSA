// SHA-3086 acceptance, end to end against a real database and the REAL
// route handlers: create a document → open a draft (invisible publicly) →
// publish → it is what /legal and /sends read. Plus the scope gate, the
// one-open-draft conflict, slug validation, duplicate-slug conflict,
// idempotent replay, and published-version immutability via the lib.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha3086-authoring-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.mail.shadowpsa.com";
delete process.env.EMAIL_PROVIDER;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// Dynamic imports so every module initialises after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let keys: typeof import("../../src/lib/api/keys");
let authoring: typeof import("../../src/lib/legal/authoring");
let documents: typeof import("../../src/lib/legal/documents");
let documentsRoute: typeof import("../../src/app/api/v1/documents/route");
let versionsRoute: typeof import("../../src/app/api/v1/documents/[slug]/versions/route");
let publishRoute: typeof import("../../src/app/api/v1/documents/[slug]/versions/[version]/publish/route");

let apiKey = ""; // full-access key
let readOnlyKey = ""; // documents:read only — must be refused by the writes

const BASE = "https://msa.mail.shadowpsa.com/api/v1";

function request(
  method: string,
  path: string,
  options: { body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...options.headers };
  const key = options.key === undefined ? apiKey : options.key;
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  keys = await import("../../src/lib/api/keys");
  authoring = await import("../../src/lib/legal/authoring");
  documents = await import("../../src/lib/legal/documents");
  documentsRoute = await import("../../src/app/api/v1/documents/route");
  versionsRoute = await import("../../src/app/api/v1/documents/[slug]/versions/route");
  publishRoute = await import(
    "../../src/app/api/v1/documents/[slug]/versions/[version]/publish/route"
  );

  await prisma.mspIdentity.create({
    data: { name: "Standard Computer", legalName: "Standard Computer LLC", venue: "Nebraska" },
  });
  apiKey = (await keys.createApiKey("authoring e2e", [])).plaintext;
  readOnlyKey = (await keys.createApiKey("read only", ["documents:read"])).plaintext;
  // A live subscription, so publish events materialise as delivery rows.
  await prisma.webhook.create({
    data: { url: "https://psa.example.com/hooks", secret: "whsec_test", eventsJson: "[]" },
  });
});

test("documents:write is enforced: a documents:read key cannot create", async () => {
  const res = await documentsRoute.POST(
    request("POST", "/documents", { body: { slug: "msa", title: "MSA" }, key: readOnlyKey }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "forbidden");

  const res2 = await versionsRoute.POST(
    request("POST", "/documents/msa/versions", { body: { bodyMarkdown: "x" }, key: readOnlyKey }),
    params({ slug: "msa" }),
  );
  assert.equal(res2.status, 403);
});

test("create document → draft → publish: the full authoring arc over the API", async () => {
  // Create.
  const created = await documentsRoute.POST(
    request("POST", "/documents", { body: { slug: "msa", title: "Master Service Agreement" } }),
  );
  assert.equal(created.status, 201);
  const doc = await created.json();
  assert.equal(doc.slug, "msa");
  assert.equal(doc.kind, "msa"); // defaulted
  assert.equal(doc.currentVersion, null);

  // A document with no versions publishes nothing.
  assert.equal(await documents.publishedDocument("msa"), null);

  // Draft v1.
  const drafted = await versionsRoute.POST(
    request("POST", "/documents/msa/versions", {
      body: {
        bodyMarkdown: "## Agreement\n\nBetween {{msp_name}} and {{client_legal_name}}. Terms: {{payment_terms_days}} days.",
        variables: { payment_terms_days: "30" },
        changelog: "First draft",
      },
    }),
    params({ slug: "msa" }),
  );
  assert.equal(drafted.status, 201);
  const draft = await drafted.json();
  assert.equal(draft.version.version, 1);
  assert.equal(draft.version.published, false);
  assert.equal(draft.document.currentVersion, null);

  // Still invisible publicly: a draft has no public existence.
  assert.equal(await documents.publishedDocument("msa"), null);

  // A second open draft is refused — one draft per document.
  const second = await versionsRoute.POST(
    request("POST", "/documents/msa/versions", { body: { bodyMarkdown: "competing draft" } }),
    params({ slug: "msa" }),
  );
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "conflict");

  // Publish through the existing publish endpoint.
  const published = await publishRoute.POST(
    request("POST", "/documents/msa/versions/1/publish", { body: {} }),
    params({ slug: "msa", version: "1" }),
  );
  assert.equal(published.status, 200);
  const pub = await published.json();
  assert.equal(pub.alreadyPublished, false);
  assert.equal(pub.document.currentVersion, 1);
  assert.equal(pub.notices, null); // publishing emailed nobody

  // NOW it is what /legal, the embed and /sends/new read.
  const live = await documents.publishedDocument("msa");
  assert.ok(live);
  assert.equal(live!.current.version, 1);

  // The publish emitted exactly one webhook event.
  const events = await prisma.webhookDelivery.findMany({ where: { eventType: "document.published" } });
  assert.equal(events.length, 1);
});

test("slug and body validation are 422; duplicate slug is 409", async () => {
  const badSlug = await documentsRoute.POST(
    request("POST", "/documents", { body: { slug: "Bad Slug!", title: "x" } }),
  );
  assert.equal(badSlug.status, 422);

  // Passes the schema's character class but breaks the edge-hyphen rule —
  // the handler's isValidDocumentSlug check catches it.
  const edgeHyphen = await documentsRoute.POST(
    request("POST", "/documents", { body: { slug: "-bad-", title: "x" } }),
  );
  assert.equal(edgeHyphen.status, 422);

  const dupe = await documentsRoute.POST(
    request("POST", "/documents", { body: { slug: "msa", title: "Another MSA" } }),
  );
  assert.equal(dupe.status, 409);
  assert.equal((await dupe.json()).error.code, "conflict");

  const noBody = await versionsRoute.POST(
    request("POST", "/documents/msa/versions", { body: { bodyMarkdown: "" } }),
    params({ slug: "msa" }),
  );
  assert.equal(noBody.status, 422);

  const noDoc = await versionsRoute.POST(
    request("POST", "/documents/nope/versions", { body: { bodyMarkdown: "x" } }),
    params({ slug: "nope" }),
  );
  assert.equal(noDoc.status, 404);
});

test("version numbers continue past the published head, and defaults carry", async () => {
  const drafted = await versionsRoute.POST(
    request("POST", "/documents/msa/versions", {
      body: { bodyMarkdown: "## Agreement v2\n\nUpdated terms.", changelog: "Updated terms" },
    }),
    params({ slug: "msa" }),
  );
  assert.equal(drafted.status, 201);
  const draft = await drafted.json();
  assert.equal(draft.version.version, 2);
  // currentVersion still reports the published head, not the new draft.
  assert.equal(draft.document.currentVersion, 1);
});

test("Idempotency-Key replays the first creation instead of conflicting", async () => {
  const body = { slug: "hipaa-baa", title: "HIPAA BAA", kind: "hipaa-baa" };
  const first = await documentsRoute.POST(
    request("POST", "/documents", { body, headers: { "Idempotency-Key": "baa-create-1" } }),
  );
  assert.equal(first.status, 201);
  const replay = await documentsRoute.POST(
    request("POST", "/documents", { body, headers: { "Idempotency-Key": "baa-create-1" } }),
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.equal((await prisma.legalDocument.count({ where: { slug: "hipaa-baa" } })), 1);
});

test("published versions are immutable; drafts are editable (lib level, what the UI uses)", async () => {
  const publishedRow = await prisma.legalDocumentVersion.findFirst({
    where: { document: { slug: "msa" }, version: 1 },
  });
  const refused = await authoring.updateDraft(publishedRow!.id, { bodyMarkdown: "rewrite history" });
  assert.equal(refused.ok, false);
  assert.equal((refused as { reason: string }).reason, "conflict");

  const draftRow = await prisma.legalDocumentVersion.findFirst({
    where: { document: { slug: "msa" }, version: 2 },
  });
  const saved = await authoring.updateDraft(draftRow!.id, {
    bodyMarkdown: "## Agreement v2\n\nBetter terms.",
    variables: { payment_terms_days: "45" },
    changelog: "Better terms",
  });
  assert.equal(saved.ok, true);

  // Republish of v1 is a reported no-op, and adds no second webhook event.
  const again = await publishRoute.POST(
    request("POST", "/documents/msa/versions/1/publish", { body: {} }),
    params({ slug: "msa", version: "1" }),
  );
  assert.equal((await again.json()).alreadyPublished, true);
  const events = await prisma.webhookDelivery.findMany({ where: { eventType: "document.published" } });
  assert.equal(events.length, 1);
});
