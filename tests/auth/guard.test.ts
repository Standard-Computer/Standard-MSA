// Per-surface refusal (SHA-3047), through the real gate with real Requests.
//
// Every operator path is asserted to be refused with a status and an empty
// or fixed body, and the same gate is asserted to let the public and machine
// surfaces through untouched. node's test runner gives this file its own
// process, so the env set here never leaks into another test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { guardOperatorRequest, LOGIN_PATH } from "../../src/lib/auth/guard";
import { mintSession, OPERATOR_COOKIE } from "../../src/lib/auth/session";

const PASSWORD = "a-long-enough-operator-password";
const BASE = "https://msa.example.com";

// Set after the imports deliberately: the gate reads process.env on every
// call (src/lib/auth/config.ts), never at module load, which is what lets a
// self-hoster change the password with a restart instead of a rebuild.
process.env.OPERATOR_PASSWORD = PASSWORD;
process.env.APP_BASE_URL = BASE;

/** Every operator screen, by concrete path. */
const SCREENS = [
  "/",
  "/onboarding",
  "/embed",
  "/settings/identity",
  "/settings/email",
  "/sends",
  "/sends/new",
  "/sends/notices",
  "/sends/1",
  "/sends/4242",
  "/visits",
] as const;

/** Every operator surface that answers with data rather than a screen. */
const DOWNLOADS = ["/sends/1/evidence", "/visits/export"] as const;

const PUBLIC = [
  "/login",
  "/msa/sometoken",
  "/legal",
  "/legal/msa",
  "/legal/msa/2",
  "/legal/embed.js",
  "/legal/embed/frame",
] as const;

const MACHINE = [
  "/api/cron/email",
  "/api/cron/liveness",
  "/api/email/webhooks/sendgrid",
  "/api/email/open/abc",
  "/api/email/click/abc/0",
  "/api/legal/visit",
  "/api/sends/view",
  "/api/v1/sends",
] as const;

const get = (path: string, cookie?: string): Request =>
  new Request(`${BASE}${path}`, cookie ? { headers: { cookie } } : undefined);

test("every operator screen refuses an unauthenticated request", async () => {
  for (const path of SCREENS) {
    const refusal = await guardOperatorRequest(get(path));
    assert.ok(refusal, `${path} must be refused`);
    assert.equal(refusal.status, 303, `${path} must redirect a browser`);
    assert.ok(
      refusal.headers.get("location")?.startsWith(`${LOGIN_PATH}?next=`),
      `${path} must send the visitor to the login screen`,
    );
    assert.equal(await refusal.text(), "", `${path} must ship no payload`);
    assert.match(refusal.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("every operator download refuses an unauthenticated request with 401", async () => {
  for (const path of DOWNLOADS) {
    const refusal = await guardOperatorRequest(get(path));
    assert.ok(refusal, `${path} must be refused`);
    assert.equal(refusal.status, 401, `${path} must answer 401`);
    assert.equal(await refusal.text(), "Operator sign-in required.\n");
    assert.match(refusal.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("the refusal is identical for a real id and a fabricated one", async () => {
  // Otherwise the gate is itself the enumeration oracle it exists to close.
  const one = await guardOperatorRequest(get("/sends/1"));
  const other = await guardOperatorRequest(get("/sends/999999999"));
  assert.ok(one && other);
  assert.equal(one.status, other.status);
  assert.equal(await one.text(), await other.text());

  const evidenceOne = await guardOperatorRequest(get("/sends/1/evidence"));
  const evidenceOther = await guardOperatorRequest(get("/sends/999999999/evidence"));
  assert.ok(evidenceOne && evidenceOther);
  assert.equal(evidenceOne.status, evidenceOther.status);
  assert.equal(await evidenceOne.text(), await evidenceOther.text());
});

test("a valid session is let through to every operator surface", async () => {
  const cookie = `${OPERATOR_COOKIE}=${await mintSession(PASSWORD)}`;
  for (const path of [...SCREENS, ...DOWNLOADS]) {
    assert.equal(
      await guardOperatorRequest(get(path, cookie)),
      null,
      `${path} must be served to a signed-in operator`,
    );
  }
});

test("a forged or stale session is refused on every operator surface", async () => {
  const forged = [
    `${OPERATOR_COOKIE}=v1.9999999999.${"A".repeat(43)}`,
    `${OPERATOR_COOKIE}=${await mintSession("some-other-password-entirely")}`,
    `${OPERATOR_COOKIE}=${await mintSession(PASSWORD, Date.now() - 48 * 60 * 60 * 1000)}`,
    `${OPERATOR_COOKIE}=`,
    "theme=dark",
  ];
  for (const cookie of forged) {
    for (const path of [...SCREENS, ...DOWNLOADS]) {
      const refusal = await guardOperatorRequest(get(path, cookie));
      assert.ok(refusal, `${path} must refuse cookie ${cookie.slice(0, 40)}`);
      assert.ok(refusal.status === 303 || refusal.status === 401);
    }
  }
});

test("public and machine surfaces are untouched, with or without a session", async () => {
  const cookie = `${OPERATOR_COOKIE}=${await mintSession(PASSWORD)}`;
  for (const path of [...PUBLIC, ...MACHINE]) {
    assert.equal(await guardOperatorRequest(get(path)), null, `${path} must stay open`);
    assert.equal(await guardOperatorRequest(get(path, cookie)), null, `${path} must stay open`);
  }
});

test("an unknown path is refused rather than served — deny by default", async () => {
  for (const path of ["/admin", "/sends/1/raw", "/legalish", "/reports"]) {
    const refusal = await guardOperatorRequest(get(path));
    assert.ok(refusal, `${path} must be refused`);
    assert.equal(refusal.status, 303);
  }
});

test("the login redirect target is encoded, not interpolated", async () => {
  const refusal = await guardOperatorRequest(get("/sends/1%2F..%2Fevil"));
  assert.ok(refusal);
  const location = refusal.headers.get("location") ?? "";
  assert.ok(location.startsWith(`${LOGIN_PATH}?next=`));
  // One query parameter, no smuggled separators.
  assert.equal(location.split("?")[1].split("&").length, 1);
});

test("with no password and no readable database the gate closes", async () => {
  // Since SHA-4455 an unset OPERATOR_PASSWORD is no longer the end of the
  // question — the gate also asks the database whether this instance was
  // claimed through the first-boot screen. This process has no DATABASE_URL,
  // so that read FAILS, and the fail-closed rule applies: an unreadable
  // database is not an unclaimed instance, and must not open /setup on an
  // instance somebody already owns (src/lib/auth/gate.ts).
  delete process.env.OPERATOR_PASSWORD;
  try {
    for (const path of [...SCREENS, ...DOWNLOADS]) {
      const refusal = await guardOperatorRequest(get(path));
      assert.ok(refusal, `${path} must be refused`);
      assert.equal(refusal.status, 503, `${path} must fail closed, not open`);
      const body = await refusal.text();
      assert.ok(body.includes("DATABASE_URL"), "the refusal names what to fix");
      assert.equal(
        body.includes("/setup"),
        false,
        "a closed gate must not advertise first boot",
      );
    }
    // And a session minted earlier does not survive the password going away.
    const cookie = `${OPERATOR_COOKIE}=${await mintSession(PASSWORD)}`;
    const refusal = await guardOperatorRequest(get("/sends", cookie));
    assert.ok(refusal);
    assert.equal(refusal.status, 503);
    // The public surfaces still work — an unconfigured gate must not take
    // the recipients' own agreement links down with it.
    for (const path of PUBLIC) {
      assert.equal(await guardOperatorRequest(get(path)), null, `${path} must stay open`);
    }
  } finally {
    process.env.OPERATOR_PASSWORD = PASSWORD;
  }
});

test("a too-short OPERATOR_PASSWORD closes the gate and names the variable", async () => {
  // The misconfiguration case, and the one that must NOT reach first boot:
  // somebody configured this instance and got it wrong, so reopening /setup
  // would hand their instance to the next passer-by.
  // A value with no substring in common with the refusal text, so the
  // "never quotes the value" assertion cannot pass or fail by accident.
  const TOO_SHORT = "zqx9v";
  process.env.OPERATOR_PASSWORD = TOO_SHORT;
  try {
    for (const path of [...SCREENS, ...DOWNLOADS]) {
      const refusal = await guardOperatorRequest(get(path));
      assert.ok(refusal, `${path} must be refused`);
      assert.equal(refusal.status, 503, `${path} must fail closed, not open`);
      const body = await refusal.text();
      assert.ok(body.includes("OPERATOR_PASSWORD"), "the refusal names what to set");
      assert.equal(body.includes(TOO_SHORT), false, "and never quotes the value");
    }
    for (const path of PUBLIC) {
      assert.equal(await guardOperatorRequest(get(path)), null, `${path} must stay open`);
    }
  } finally {
    process.env.OPERATOR_PASSWORD = PASSWORD;
  }
});
