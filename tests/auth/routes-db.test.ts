// The real route handlers, against a real database (SHA-3047).
//
// This is the test the card asks for in criterion 2: a live send whose
// accept token and whose recipient's email, address and phone really are in
// the evidence blob, fetched off its sequential integer id, asserting that
// an unauthenticated caller gets none of it.
//
// It proves the assertion is not vacuous by fetching the SAME url WITH a
// session and asserting the token IS there. A "token absent" test against a
// route that returns nothing at all would pass for the wrong reason.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha3047-auth-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.com";
const PASSWORD = "a-long-enough-operator-password";
process.env.OPERATOR_PASSWORD = PASSWORD;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

const BASE = "https://msa.example.com";

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let evidenceRoute: typeof import("../../src/app/sends/[id]/evidence/route");
let session: typeof import("../../src/lib/auth/session");

const RECIPIENT = {
  email: "dana@mail.shadowpsa.com",
  fullName: "Dana Reyes",
  companyName: "Reyes Dental",
  legalName: "Reyes Dental LLC",
  address: "17 Prairie Road, Lincoln, Nebraska",
  phone: "+1-402-555-0117",
};
const ACCEPTOR_IP = "198.51.100.42";
const ACCEPTOR_UA = "Mozilla/5.0 (SHA-3047 fixture)";

let sendId = 0;
let token = "";
let cookie = "";

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  session = await import("../../src/lib/auth/session");
  const sends = await import("../../src/lib/sends/sends");
  const evidence = await import("../../src/lib/sends/evidence");
  evidenceRoute = await import("../../src/app/sends/[id]/evidence/route");

  await prisma.mspIdentity.create({
    data: { name: "Standard Computer", legalName: "Standard Computer LLC", venue: "Nebraska" },
  });
  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Services Agreement", kind: "msa" },
  });
  const version = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: "## 1. Parties\n\nBetween {{msp_name}} and {{client_name}}.",
      variablesJson: "{}",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });

  const created = await sends.createSend(version.id, RECIPIENT);
  sendId = created.send.id;
  token = created.send.token;

  const accepted = await evidence.acceptSend(token, {
    acceptorName: "Dana Reyes",
    ip: ACCEPTOR_IP,
    userAgent: ACCEPTOR_UA,
  });
  assert.equal(accepted.ok, true, "fixture: the send was accepted");

  cookie = `${session.OPERATOR_COOKIE}=${await session.mintSession(PASSWORD)}`;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

const evidenceUrl = (id: number | string) => `${BASE}/sends/${id}/evidence`;

const fetchEvidence = (id: number | string, withCookie?: string): Promise<Response> =>
  evidenceRoute.GET(
    new Request(evidenceUrl(id), withCookie ? { headers: { cookie: withCookie } } : undefined),
    { params: Promise.resolve({ id: String(id) }) },
  );

test("the fixture really does carry the token and the PII (else the rest proves nothing)", async () => {
  const res = await fetchEvidence(sendId, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes(token), "the evidence blob contains the accept token");
  assert.ok(body.includes(RECIPIENT.email), "…and the recipient's email");
  assert.ok(body.includes(RECIPIENT.address), "…and their address");
  assert.ok(body.includes(RECIPIENT.phone), "…and their phone");
  assert.ok(body.includes(ACCEPTOR_IP), "…and the acceptor's IP");
  assert.ok(body.includes(ACCEPTOR_UA), "…and their user agent");
});

test("GET /sends/[id]/evidence refuses an unauthenticated caller with 401", async () => {
  const res = await fetchEvidence(sendId);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  // Not a file download, either: no Content-Disposition to save.
  assert.equal(res.headers.get("content-disposition"), null);
});

test("the accept token never appears in an unauthenticated response", async () => {
  const res = await fetchEvidence(sendId);
  const body = await res.text();
  assert.ok(!body.includes(token), "no token in the body");
  // Nor anywhere in the headers — including a Location, which is why the
  // whole response is searched rather than just the body.
  const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  assert.ok(!headers.includes(token), "no token in any header");
  assert.equal(res.headers.get("location"), null);
});

test("no recipient PII appears in an unauthenticated response", async () => {
  const res = await fetchEvidence(sendId);
  const whole = (await res.text()) + [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const secret of [
    RECIPIENT.email,
    RECIPIENT.fullName,
    RECIPIENT.companyName,
    RECIPIENT.legalName,
    RECIPIENT.address,
    RECIPIENT.phone,
    ACCEPTOR_IP,
    ACCEPTOR_UA,
  ]) {
    assert.ok(!whole.includes(secret), `${secret} must not be served to a stranger`);
  }
});

test("walking the integer ids tells a stranger nothing", async () => {
  // A real id, a never-used id and a non-numeric one must be indistinguishable
  // to an unauthenticated caller: same status, same body, same headers.
  const responses = await Promise.all(
    [sendId, 999_999, "abc"].map(async (id) => {
      const res = await fetchEvidence(id);
      return { status: res.status, body: await res.text() };
    }),
  );
  for (const res of responses) {
    assert.equal(res.status, 401);
    assert.equal(res.body, responses[0].body);
  }
});

test("a forged session is refused, a valid one is served", async () => {
  const forged = `${session.OPERATOR_COOKIE}=${await session.mintSession("a-different-password")}`;
  const refused = await fetchEvidence(sendId, forged);
  assert.equal(refused.status, 401);
  assert.ok(!(await refused.text()).includes(token));

  const served = await fetchEvidence(sendId, cookie);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-disposition") ?? "", /attachment/);
});

test("an expired session is refused even though it was once valid", async () => {
  const stale = `${session.OPERATOR_COOKIE}=${await session.mintSession(
    PASSWORD,
    Date.now() - (session.SESSION_TTL_SECONDS + 60) * 1000,
  )}`;
  const res = await fetchEvidence(sendId, stale);
  assert.equal(res.status, 401);
  assert.ok(!(await res.text()).includes(token));
});

test("with OPERATOR_PASSWORD unset the route fails closed, not open", async () => {
  delete process.env.OPERATOR_PASSWORD;
  try {
    const res = await fetchEvidence(sendId);
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.ok(body.includes("OPERATOR_PASSWORD"));
    assert.ok(!body.includes(token));
    // And the session that was valid a moment ago no longer opens it.
    const withCookie = await fetchEvidence(sendId, cookie);
    assert.equal(withCookie.status, 503);
    assert.ok(!(await withCookie.text()).includes(token));
  } finally {
    process.env.OPERATOR_PASSWORD = PASSWORD;
  }
});

test("a send token in a provider error is masked out of the delivery log", async () => {
  // EmailOutbound.lastError is rendered on /sends/[id]; an SMTP rejection
  // that quotes the message body back at us must not park the token there.
  const { redactSecrets } = await import("../../src/lib/email/redact");
  const quoted = `550 rejected: <a href="${BASE}/msa/${token}">Review</a>`;
  const safe = redactSecrets(quoted);
  assert.ok(!safe.includes(token), "the token is gone");
  assert.ok(safe.includes("/msa/[redacted]"), "but the shape is still readable");
  assert.ok(safe.includes("550 rejected"), "and so is the provider's reason");
});
