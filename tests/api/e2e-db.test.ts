// SHA-2960 acceptance criteria, end to end against a real database and the
// REAL route handlers: create contact → create send (email alone) → poll
// status → simulate open/accept → read the lifecycle log. Plus the auth,
// scope, idempotency, rate-limit, webhook and publish behaviour around it.
//
// Route handlers are plain functions over fetch Request/Response, so the
// scripted run drives exactly the code a PSA would hit — no HTTP server
// needed, which is what lets this run in CI on a bare node.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha2960-api-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.mail.shadowpsa.com";
// No EMAIL_PROVIDER on purpose: delivery must degrade to data (`delivery.ok
// false`), never block the create or dial anything from CI.
delete process.env.EMAIL_PROVIDER;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// Dynamic imports so every module initialises after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let keys: typeof import("../../src/lib/api/keys");
let ratelimit: typeof import("../../src/lib/api/ratelimit");
let webhooks: typeof import("../../src/lib/api/webhooks");
let evidence: typeof import("../../src/lib/sends/evidence");
let contactsRoute: typeof import("../../src/app/api/v1/contacts/route");
let contactRoute: typeof import("../../src/app/api/v1/contacts/[id]/route");
let sendsRoute: typeof import("../../src/app/api/v1/sends/route");
let sendRoute: typeof import("../../src/app/api/v1/sends/[id]/route");
let eventsRoute: typeof import("../../src/app/api/v1/sends/[id]/events/route");
let documentsRoute: typeof import("../../src/app/api/v1/documents/route");
let versionsRoute: typeof import("../../src/app/api/v1/documents/[slug]/versions/route");
let publishRoute: typeof import("../../src/app/api/v1/documents/[slug]/versions/[version]/publish/route");
let statsRoute: typeof import("../../src/app/api/v1/stats/legal-visits/route");
let webhooksRoute: typeof import("../../src/app/api/v1/webhooks/route");
let webhookRoute: typeof import("../../src/app/api/v1/webhooks/[id]/route");
let deliveriesRoute: typeof import("../../src/app/api/v1/webhooks/[id]/deliveries/route");
let openapiRoute: typeof import("../../src/app/api/v1/openapi.json/route");

let apiKey = ""; // full-access key, minted in before()

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

async function json(res: Response): Promise<any> {
  return res.json();
}

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  keys = await import("../../src/lib/api/keys");
  ratelimit = await import("../../src/lib/api/ratelimit");
  webhooks = await import("../../src/lib/api/webhooks");
  evidence = await import("../../src/lib/sends/evidence");
  contactsRoute = await import("../../src/app/api/v1/contacts/route");
  contactRoute = await import("../../src/app/api/v1/contacts/[id]/route");
  sendsRoute = await import("../../src/app/api/v1/sends/route");
  sendRoute = await import("../../src/app/api/v1/sends/[id]/route");
  eventsRoute = await import("../../src/app/api/v1/sends/[id]/events/route");
  documentsRoute = await import("../../src/app/api/v1/documents/route");
  versionsRoute = await import("../../src/app/api/v1/documents/[slug]/versions/route");
  publishRoute = await import(
    "../../src/app/api/v1/documents/[slug]/versions/[version]/publish/route"
  );
  statsRoute = await import("../../src/app/api/v1/stats/legal-visits/route");
  webhooksRoute = await import("../../src/app/api/v1/webhooks/route");
  webhookRoute = await import("../../src/app/api/v1/webhooks/[id]/route");
  deliveriesRoute = await import("../../src/app/api/v1/webhooks/[id]/deliveries/route");
  openapiRoute = await import("../../src/app/api/v1/openapi.json/route");

  await prisma.mspIdentity.create({
    data: { name: "Standard Computer", legalName: "Standard Computer LLC", venue: "Nebraska" },
  });
  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Service Agreement", kind: "msa" },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: "## Agreement\n\nBetween {{msp_name}} and {{client_name}}.",
      publishedAt: new Date(),
    },
  });
  await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 2,
      bodyMarkdown: "## Agreement (v2)\n\nBetween {{msp_name}} and {{client_name}}.",
      changelog: "Clarified venue.",
    },
  });

  apiKey = (await keys.createApiKey("e2e test", [])).plaintext;
});

// ── Auth gates ──────────────────────────────────────────────────────────────

test("no key, garbage key, and revoked key are all 401", async () => {
  assert.equal((await contactsRoute.GET(request("GET", "/contacts", { key: null }))).status, 401);
  assert.equal(
    (await contactsRoute.GET(request("GET", "/contacts", { key: "smsa_garbage" }))).status,
    401,
  );
  const revokable = await keys.createApiKey("revoked", []);
  await keys.revokeApiKey(revokable.record.id);
  const res = await contactsRoute.GET(request("GET", "/contacts", { key: revokable.plaintext }));
  assert.equal(res.status, 401);
  assert.equal((await json(res)).error.code, "unauthorized");
});

test("a scoped key is refused outside its scopes with a stable code", async () => {
  const readOnly = await keys.createApiKey("read only", ["contacts:read"]);
  const ok = await contactsRoute.GET(request("GET", "/contacts", { key: readOnly.plaintext }));
  assert.equal(ok.status, 200);
  const denied = await contactsRoute.POST(
    request("POST", "/contacts", { key: readOnly.plaintext, body: { email: "x@mail.shadowpsa.com" } }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await json(denied)).error.code, "forbidden");
});

// ── The scripted run the card names ─────────────────────────────────────────

test("create contact → create send → poll status → open/accept → read the log", async () => {
  // A webhook subscription first, so the lifecycle fans out as it happens.
  const hookRes = await webhooksRoute.POST(
    request("POST", "/webhooks", {
      body: { url: "https://psa.example.com/hooks/msa", events: ["send.created", "send.accepted"] },
    }),
  );
  assert.equal(hookRes.status, 201);
  const hook = await json(hookRes);
  assert.ok(hook.secret.startsWith("whsec_"), "signing secret returned once at creation");

  // 1. Create the contact.
  const contactRes = await contactsRoute.POST(
    request("POST", "/contacts", {
      body: { email: "dana@mail.shadowpsa.com", name: "Dana Reyes", company: "Reyes Dental" },
    }),
  );
  assert.equal(contactRes.status, 201);
  const contact = await json(contactRes);
  assert.equal(contact.email, "dana@mail.shadowpsa.com");

  const fetched = await contactRoute.GET(
    request("GET", `/contacts/${contact.id}`),
    params({ id: String(contact.id) }),
  );
  assert.equal(fetched.status, 200);

  // 2. Create the send — the tolerant core call: email alone must succeed.
  const sendRes = await sendsRoute.POST(
    request("POST", "/sends", { body: { email: "dana@mail.shadowpsa.com" } }),
  );
  assert.equal(sendRes.status, 201);
  const send = await json(sendRes);
  assert.match(send.documentUrl, /^https:\/\/msa\.mail\.shadowpsa\.com\/msa\/[A-Za-z0-9_-]{22,64}$/);
  assert.equal(send.document.slug, "msa");
  assert.equal(send.contact.id, contact.id, "email matched the existing contact");
  // Email is unconfigured in this run: the failure is data, the send stands.
  assert.equal(send.delivery.attempted, true);
  assert.equal(send.delivery.ok, false);
  assert.ok(send.delivery.error);

  // 3. Poll status.
  const polled = await sendRoute.GET(
    request("GET", `/sends/${send.id}`),
    params({ id: String(send.id) }),
  );
  assert.equal(polled.status, 200);
  assert.equal((await json(polled)).status, "created");

  // 4. Simulate the recipient: open, then accept through the real
  // acceptance path (evidence record and all).
  const { appendSendEvent } = await import("../../src/lib/sends/sends");
  await appendSendEvent(send.id, { type: "opened", ip: "198.51.100.7" });
  const token = send.documentUrl.split("/msa/")[1];
  const accepted = await evidence.acceptSend(token, {
    acceptorName: "Dana Reyes",
    ip: "198.51.100.7",
    userAgent: "e2e",
  });
  assert.ok(accepted.ok);

  const afterAccept = await json(
    await sendRoute.GET(request("GET", `/sends/${send.id}`), params({ id: String(send.id) })),
  );
  assert.equal(afterAccept.status, "accepted");
  assert.equal(afterAccept.acceptance.acceptorName, "Dana Reyes");

  // 5. Read the full lifecycle log.
  const logRes = await eventsRoute.GET(
    request("GET", `/sends/${send.id}/events`),
    params({ id: String(send.id) }),
  );
  assert.equal(logRes.status, 200);
  const log = await json(logRes);
  const types = log.events.map((e: { type: string }) => e.type);
  assert.deepEqual(types.slice().sort(), ["accepted", "created", "opened"].sort());

  // 6. The lifecycle queued the subscribed webhook events; deliver them with
  // an injected transport and verify the signature with the one-time secret.
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const sweep = await webhooks.deliverPendingWebhooks(async (url, body, headers) => {
    posts.push({ url, body, headers });
    return { ok: true, statusCode: 200, error: null };
  });
  assert.equal(sweep.delivered, 2, "send.created and send.accepted (send.opened unsubscribed)");
  for (const post of posts) {
    assert.equal(post.url, "https://psa.example.com/hooks/msa");
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(post.headers["x-standardmsa-signature"]);
    assert.ok(m, "delivery is signed");
    const expected = createHmac("sha256", hook.secret).update(`${m![1]}.${post.body}`).digest("hex");
    assert.equal(m![2], expected, "signature verifies with the returned secret");
    const payload = JSON.parse(post.body);
    assert.equal(payload.send.id, send.id);
    assert.equal(payload.send.documentUrl, send.documentUrl);
  }

  const deliveries = await json(
    await deliveriesRoute.GET(
      request("GET", `/webhooks/${hook.id}/deliveries`),
      params({ id: String(hook.id) }),
    ),
  );
  assert.equal(
    deliveries.deliveries.filter((d: { status: string }) => d.status === "delivered").length,
    2,
  );
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test("same Idempotency-Key replays the first response; different body is 409", async () => {
  const body = { email: "retry@mail.shadowpsa.com", deliver: false };
  const headers = { "Idempotency-Key": "e2e-retry-1" };
  const first = await sendsRoute.POST(request("POST", "/sends", { body, headers }));
  assert.equal(first.status, 201);
  const firstBody = await json(first);

  const second = await sendsRoute.POST(request("POST", "/sends", { body, headers }));
  assert.equal(second.status, 201);
  assert.equal(second.headers.get("Idempotency-Replayed"), "true");
  assert.equal((await json(second)).id, firstBody.id, "no second send was created");

  const conflicting = await sendsRoute.POST(
    request("POST", "/sends", { body: { ...body, name: "Changed" }, headers }),
  );
  assert.equal(conflicting.status, 409);
  assert.equal((await json(conflicting)).error.code, "idempotency_key_reused");

  assert.equal(await prisma.send.count({ where: { recipient: { email: "retry@mail.shadowpsa.com" } } }), 1);
});

test("only 2xx responses are stored for replay; an error never pins the key", async () => {
  const { withIdempotency } = await import("../../src/lib/api/idempotency");
  const keyRow = (await keys.createApiKey("idempotency unit", [])).record;
  const run = (result: { status: number; body: unknown }) =>
    withIdempotency(keyRow.id, "TEST /unit", "pin-1", { a: 1 }, async () => result);

  // A 422 outcome must NOT be stored: the caller who fixes their request
  // and retries the same key gets a fresh execution, not a pinned error.
  const first = await run({ status: 422, body: { error: "bad" } });
  assert.equal(first.status, 422);
  assert.equal(await prisma.apiIdempotencyKey.count({ where: { apiKeyId: keyRow.id } }), 0);

  const second = await run({ status: 201, body: { ok: true } });
  assert.equal(second.status, 201);
  assert.equal(second.replayed, false);

  // The 2xx IS stored: the same key now replays the 201 instead of executing.
  const third = await run({ status: 500, body: { never: "runs as fresh" } });
  assert.equal(third.status, 201);
  assert.equal(third.replayed, true);
});

test("an oversized Idempotency-Key is a typed 422, not a silent no-key create", async () => {
  const res = await sendsRoute.POST(
    request("POST", "/sends", {
      body: { email: "oversized-key@mail.shadowpsa.com", deliver: false },
      headers: { "Idempotency-Key": "k".repeat(201) },
    }),
  );
  assert.equal(res.status, 422);
  assert.equal((await json(res)).error.code, "validation_failed");
  assert.equal(
    await prisma.send.count({ where: { recipient: { email: "oversized-key@mail.shadowpsa.com" } } }),
    0,
    "the create must not run without the replay protection the caller asked for",
  );
});

// ── deliver:false and validation ────────────────────────────────────────────

test("deliver:false skips email entirely; a bad payload is a typed 422", async () => {
  const res = await sendsRoute.POST(
    request("POST", "/sends", { body: { email: "quiet@mail.shadowpsa.com", deliver: false } }),
  );
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.deepEqual(body.delivery, { attempted: false, ok: false, error: null });

  const invalid = await sendsRoute.POST(request("POST", "/sends", { body: { email: "nope" } }));
  assert.equal(invalid.status, 422);
  assert.equal((await json(invalid)).error.code, "validation_failed");

  const empty = await sendsRoute.POST(request("POST", "/sends", { body: {} }));
  assert.equal(empty.status, 422);
});

// ── Documents and publish ───────────────────────────────────────────────────

test("documents list, versions, publish idempotence", async () => {
  const docs = await json(await documentsRoute.GET(request("GET", "/documents")));
  assert.equal(docs.documents[0].slug, "msa");
  assert.equal(docs.documents[0].currentVersion, 1);

  const versions = await json(
    await versionsRoute.GET(request("GET", "/documents/msa/versions"), params({ slug: "msa" })),
  );
  assert.equal(versions.versions.length, 2);
  assert.equal(versions.versions[0].published, false, "v2 is still a draft");

  const publish = await publishRoute.POST(
    request("POST", "/documents/msa/versions/2/publish", { body: {} }),
    params({ slug: "msa", version: "2" }),
  );
  assert.equal(publish.status, 200);
  const published = await json(publish);
  assert.equal(published.alreadyPublished, false);
  assert.equal(published.document.currentVersion, 2);
  assert.equal(published.notices, null, "notices only on explicit request");

  const again = await json(
    await publishRoute.POST(
      request("POST", "/documents/msa/versions/2/publish", { body: {} }),
      params({ slug: "msa", version: "2" }),
    ),
  );
  assert.equal(again.alreadyPublished, true);

  const missing = await publishRoute.POST(
    request("POST", "/documents/msa/versions/9/publish", { body: {} }),
    params({ slug: "msa", version: "9" }),
  );
  assert.equal(missing.status, 404);
});

// ── Stats ───────────────────────────────────────────────────────────────────

test("visit stats aggregate and group", async () => {
  await prisma.legalVisit.createMany({
    data: [
      { path: "/legal/msa", slug: "msa", secondsOnPage: 30, country: "US", region: "NE", embedded: true },
      { path: "/legal/msa", slug: "msa", secondsOnPage: 12, country: "US", region: "NE" },
      { path: "/legal", secondsOnPage: 0 },
    ],
  });
  const stats = await json(
    await statsRoute.GET(request("GET", "/stats/legal-visits?groupBy=region")),
  );
  assert.equal(stats.total, 3);
  assert.equal(stats.totalSeconds, 42);
  assert.equal(stats.embedded, 1);
  const us = stats.groups.find((g: { key: string }) => g.key === "US / NE");
  assert.equal(us.visits, 2);

  const bySlug = await json(
    await statsRoute.GET(request("GET", "/stats/legal-visits?slug=msa")),
  );
  assert.equal(bySlug.total, 2);
});

// ── Webhook management ──────────────────────────────────────────────────────

test("webhook URL vetting at create; revoke voids its queue", async () => {
  const bad = await webhooksRoute.POST(
    request("POST", "/webhooks", { body: { url: "http://127.0.0.1/hook" } }),
  );
  assert.equal(bad.status, 422);

  const created = await json(
    await webhooksRoute.POST(
      request("POST", "/webhooks", { body: { url: "https://other.example.com/hook" } }),
    ),
  );
  // Queue something for it, then revoke before delivery.
  await webhooks.enqueueWebhookEvent("document.published", { document: { slug: "msa" } });
  const revoked = await webhookRoute.DELETE(
    request("DELETE", `/webhooks/${created.id}`),
    params({ id: String(created.id) }),
  );
  assert.equal(revoked.status, 200);
  assert.equal((await json(revoked)).active, false);

  // Other subscriptions' queues still deliver; the revoked hook is never
  // dialled and its rows are voided, not left pending forever.
  const dialled: string[] = [];
  await webhooks.deliverPendingWebhooks(async (url) => {
    dialled.push(url);
    return { ok: true, statusCode: 200, error: null };
  });
  // Exact equality on whole URLs (CodeQL js/incomplete-url-substring-
  // sanitization misreads Array.includes here as substring matching).
  const revokedDials = dialled.filter((u) => u === "https://other.example.com/hook");
  assert.equal(revokedDials.length, 0, "revoked hook was dialled");
  const voided = await prisma.webhookDelivery.findMany({ where: { webhookId: created.id } });
  assert.ok(voided.length >= 1);
  assert.ok(voided.every((d) => d.status === "exhausted" && d.lastError === "webhook revoked"));
});

// ── Rate limiting ───────────────────────────────────────────────────────────

test("per-key rate limit answers 429 with Retry-After", async () => {
  process.env.API_RATE_LIMIT_PER_MINUTE = "3";
  ratelimit.resetRateLimiter();
  try {
    const limited = await keys.createApiKey("limited", ["contacts:read"]);
    for (let i = 0; i < 3; i++) {
      const res = await contactsRoute.GET(request("GET", "/contacts", { key: limited.plaintext }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("X-RateLimit-Limit"), "3");
    }
    const denied = await contactsRoute.GET(request("GET", "/contacts", { key: limited.plaintext }));
    assert.equal(denied.status, 429);
    assert.equal((await json(denied)).error.code, "rate_limited");
    assert.ok(Number(denied.headers.get("Retry-After")) >= 1);
  } finally {
    delete process.env.API_RATE_LIMIT_PER_MINUTE;
    ratelimit.resetRateLimiter();
  }
});

// ── Request logging and the spec route ──────────────────────────────────────

test("every authenticated request lands in the per-key log", async () => {
  const logged = await keys.createApiKey("logged", ["contacts:read"]);
  await contactsRoute.GET(request("GET", "/contacts", { key: logged.plaintext }));
  const rows = await prisma.apiRequestLog.findMany({ where: { apiKey: { name: "logged" } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, "GET");
  assert.equal(rows[0].path, "/api/v1/contacts");
  assert.equal(rows[0].status, 200);
  const keyRow = await prisma.apiKey.findUniqueOrThrow({ where: { id: logged.record.id } });
  assert.ok(keyRow.lastUsedAt, "lastUsedAt stamped");
});

test("openapi.json serves the spec for this instance, unauthenticated", async () => {
  const res = await openapiRoute.GET(new Request(`${BASE}/openapi.json`));
  assert.equal(res.status, 200);
  const spec = await json(res);
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://msa.mail.shadowpsa.com/api/v1");
  assert.ok(spec.paths["/sends"].post, "the core call is documented");
});
