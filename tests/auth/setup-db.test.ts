// First boot against a real database (SHA-4455).
//
// The claim that needs a real database rather than a stub is "it can only
// happen once": that property is a primary-key constraint, so a fake would be
// asserting my own mock. This applies the real migrations to a temporary
// SQLite file and drives the real functions.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha4455-setup-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.com";
// Unset deliberately: this file is about the instance that has no env
// password, which is the only instance first boot applies to.
delete process.env.OPERATOR_PASSWORD;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

const FIRST = "the-first-operator-password";
const SECOND = "a-second-operator-password";

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let credential: typeof import("../../src/lib/auth/credential");
let gate: typeof import("../../src/lib/auth/gate");
let guard: typeof import("../../src/lib/auth/guard");
let session: typeof import("../../src/lib/auth/session");
let prisma: typeof import("../../src/lib/db").prisma;

before(async () => {
  credential = await import("../../src/lib/auth/credential");
  gate = await import("../../src/lib/auth/gate");
  guard = await import("../../src/lib/auth/guard");
  session = await import("../../src/lib/auth/session");
  prisma = (await import("../../src/lib/db")).prisma;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

test("an unclaimed instance reads as setup, and nothing is stored yet", async () => {
  const read = await credential.readStoredCredential();
  assert.deepEqual(read, { ok: true, credential: null });
  assert.equal((await gate.operatorGate()).kind, "setup");
});

test("the first claim succeeds and the instance becomes signable-in", async () => {
  const outcome = await credential.claimOperatorPassword(FIRST);
  assert.equal(outcome.claimed, true);

  const live = await gate.operatorGate();
  assert.equal(live.kind, "stored");
  assert.equal(await gate.verifyOperatorPassword(live, FIRST), true);
  assert.equal(await gate.verifyOperatorPassword(live, SECOND), false);

  // A session minted under this gate verifies under it, which is the whole
  // point of the stored record: the operator can actually get in.
  const secret = gate.gateSessionSecret(live);
  assert.ok(secret !== null);
  assert.equal(await session.verifySession(await session.mintSession(secret), secret), true);
});

test("the plaintext never reaches the database", async () => {
  const row = await prisma.operatorCredential.findUnique({
    where: { id: credential.CREDENTIAL_ROW_ID },
  });
  assert.ok(row !== null);
  assert.equal(JSON.stringify(row).includes(FIRST), false);
  assert.equal(row.algorithm, credential.PBKDF2_ALGORITHM);
  assert.equal(row.iterations, credential.PBKDF2_ITERATIONS);
});

test("a second claim is refused, and does not change the password", async () => {
  // The race this closes: two replicas, or two people with the URL, both
  // posting the setup form. The second INSERT violates the primary key.
  const outcome = await credential.claimOperatorPassword(SECOND);
  assert.deepEqual(outcome, { claimed: false, reason: "already-set" });

  const rows = await prisma.operatorCredential.count();
  assert.equal(rows, 1, "at most one credential row, ever");

  const live = await gate.operatorGate();
  assert.equal(await gate.verifyOperatorPassword(live, FIRST), true, "the first password still works");
  assert.equal(await gate.verifyOperatorPassword(live, SECOND), false, "the second never took effect");
});

test("concurrent claims on an empty table: exactly one wins", async () => {
  await prisma.operatorCredential.deleteMany();
  assert.equal((await gate.operatorGate()).kind, "setup");

  const attempts = ["aaa-password-one", "bbb-password-two", "ccc-password-three"];
  const outcomes = await Promise.all(attempts.map((p) => credential.claimOperatorPassword(p)));
  const winners = outcomes.filter((o) => o.claimed);
  assert.equal(winners.length, 1, `exactly one claim wins, got ${winners.length}`);
  assert.equal(await prisma.operatorCredential.count(), 1);

  // And the winner is the one whose password now works.
  const live = await gate.operatorGate();
  const working = [];
  for (const p of attempts) {
    if (await gate.verifyOperatorPassword(live, p)) working.push(p);
  }
  assert.equal(working.length, 1, "exactly one of the three passwords opens the instance");
});

test("setup closes once claimed — and reopens only if the credential is gone", async () => {
  assert.equal((await gate.operatorGate()).kind, "stored");
  await prisma.operatorCredential.deleteMany();
  // Stated so the recovery path is deliberate and visible: an operator who
  // loses the password recovers by setting OPERATOR_PASSWORD, or — on an
  // instance they control the database of — by deleting this row.
  assert.equal((await gate.operatorGate()).kind, "setup");
});

test("on an unclaimed instance the guard sends browsers to /setup and serves no data", async () => {
  await prisma.operatorCredential.deleteMany();
  const req = (path: string) => new Request(`https://msa.example.com${path}`);

  // Screens: a 303 to first boot, so a one-click deploy's root URL leads
  // somewhere useful instead of to a 503 about an environment variable.
  for (const path of ["/", "/onboarding", "/sends", "/sends/1", "/settings/email"]) {
    const refusal = await guard.guardOperatorRequest(req(path));
    assert.ok(refusal, `${path} must be refused`);
    assert.equal(refusal.status, 303, path);
    assert.equal(refusal.headers.get("location"), gate.SETUP_PATH, path);
    assert.equal(await refusal.text(), "", "a redirect carries no operator data");
  }

  // Downloads and data surfaces: 503, never a redirect to an HTML form.
  for (const path of ["/sends/1/evidence", "/visits/export"]) {
    const refusal = await guard.guardOperatorRequest(req(path));
    assert.ok(refusal, `${path} must be refused`);
    assert.equal(refusal.status, 503, path);
  }

  // The public and machine surfaces are untouched: an unclaimed operator
  // console must not take the recipients' own agreement links down with it.
  for (const path of ["/login", "/setup", "/msa/sometoken", "/legal", "/api/v1/sends"]) {
    assert.equal(await guard.guardOperatorRequest(req(path)), null, `${path} must stay open`);
  }

  // And once claimed, the same screen asks for a sign-in instead.
  await credential.claimOperatorPassword(FIRST);
  const afterClaim = await guard.guardOperatorRequest(req("/sends"));
  assert.ok(afterClaim);
  assert.equal(afterClaim.status, 303);
  assert.match(afterClaim.headers.get("location") ?? "", /^\/login\?next=/);
});

test("OPERATOR_PASSWORD wins over a stored credential, and restores it when removed", async () => {
  await credential.claimOperatorPassword(FIRST);
  const envPassword = "an-env-operator-password";
  process.env.OPERATOR_PASSWORD = envPassword;
  try {
    const live = await gate.operatorGate();
    assert.equal(live.kind, "env");
    assert.equal(await gate.verifyOperatorPassword(live, envPassword), true);
    assert.equal(await gate.verifyOperatorPassword(live, FIRST), false);
  } finally {
    delete process.env.OPERATOR_PASSWORD;
  }
  const back = await gate.operatorGate();
  assert.equal(back.kind, "stored");
  assert.equal(await gate.verifyOperatorPassword(back, FIRST), true);
});
