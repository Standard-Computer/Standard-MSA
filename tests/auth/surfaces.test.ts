// The request-surface split (SHA-3047), asserted path by path.
//
// This is the file that would have caught finding 4 on PR #7: /sends/[id]
// and /sends/[id]/evidence are asserted to be operator surfaces, so the
// classification cannot drift back to public without a test going red.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPath,
  matchesPattern,
  requiresOperator,
  safeRedirectTarget,
  SURFACES,
} from "../../src/lib/auth/surfaces";

test("every operator surface named on SHA-3047 requires a session", () => {
  for (const path of [
    "/sends",
    "/sends/new",
    "/sends/notices",
    "/sends/1",
    "/sends/999999",
    "/sends/1/evidence",
  ]) {
    assert.equal(requiresOperator(path), true, `${path} must be operator-only`);
  }
});

test("the rest of the operator console requires a session too", () => {
  for (const path of [
    "/",
    "/onboarding",
    "/embed",
    "/settings/identity",
    "/settings/email",
    // Not written yet when this landed: a new screen under /settings is
    // operator-gated by the /settings/** entry rather than by remembering.
    "/settings/api",
    "/visits",
    "/visits/export",
  ]) {
    assert.equal(requiresOperator(path), true, `${path} must be operator-only`);
  }
});

test("the recipient's own agreement link stays auth-free", () => {
  // The whole point of the lane: fixing the operator screens must not touch
  // the one surface where the token IS the authorisation.
  for (const path of ["/msa/abc", "/msa/" + "x".repeat(43), "/msa/tok/anything"]) {
    assert.equal(classifyPath(path).kind, "public", `${path} must stay public`);
  }
});

test("the public legal site and the login screen stay auth-free", () => {
  for (const path of [
    "/legal",
    "/legal/msa",
    "/legal/msa/2",
    "/legal/embed.js",
    "/legal/embed/frame",
    "/login",
  ]) {
    assert.equal(classifyPath(path).kind, "public", `${path} must stay public`);
  }
});

test("machine surfaces carry their own credential, not a browser session", () => {
  for (const path of [
    "/api/cron/email",
    "/api/cron/liveness",
    "/api/email/webhooks/sendgrid",
    "/api/email/open/abc",
    "/api/email/click/abc/0",
    "/api/legal/visit",
    "/api/sends/view",
    "/api/v1/sends",
  ]) {
    assert.equal(classifyPath(path).kind, "machine", `${path} must be machine-authed`);
  }
});

test("an unknown path is operator, not public — deny by default", () => {
  for (const path of ["/whatever", "/sends/1/secret", "/admin", "/legalish", "/msax/tok"]) {
    assert.equal(requiresOperator(path), true, `${path} must deny by default`);
  }
});

test("the evidence download is refused as data, the screens as a redirect", () => {
  assert.equal(classifyPath("/sends/1/evidence").refusal, "status");
  assert.equal(classifyPath("/visits/export").refusal, "status");
  assert.equal(classifyPath("/sends/1").refusal, "redirect");
  assert.equal(classifyPath("/sends").refusal, "redirect");
});

test("query strings and trailing slashes classify as the bare path", () => {
  assert.equal(classifyPath("/sends?ok=1&msg=hi").pattern, "/sends");
  assert.equal(classifyPath("/sends/").pattern, "/sends");
  assert.equal(classifyPath("/legal/msa?v=2").kind, "public");
});

test("matching is segment-wise, so a prefix cannot smuggle a path through", () => {
  assert.equal(matchesPattern("/legal/**", "/legal/a"), true);
  assert.equal(matchesPattern("/legal/**", "/legal"), false);
  assert.equal(matchesPattern("/legal/**", "/legalish/a"), false);
  assert.equal(matchesPattern("/sends/[id]", "/sends/1"), true);
  assert.equal(matchesPattern("/sends/[id]", "/sends/1/evidence"), false);
  assert.equal(matchesPattern("/sends/[id]", "/sends"), false);
  assert.equal(matchesPattern("/", "/"), true);
  assert.equal(matchesPattern("/", "/sends"), false);
});

test("the specific evidence entry wins over the general /sends/[id] entry", () => {
  // Registry order is load-bearing; assert it rather than trusting it.
  const evidence = SURFACES.findIndex((s) => s.pattern === "/sends/[id]/evidence");
  const detail = SURFACES.findIndex((s) => s.pattern === "/sends/[id]");
  assert.ok(evidence !== -1 && detail !== -1);
  assert.ok(evidence < detail, "/sends/[id]/evidence must be listed before /sends/[id]");
});

test("every public and machine entry records why it needs no session", () => {
  for (const surface of SURFACES) {
    if (surface.kind === "operator") continue;
    assert.ok(
      surface.because && surface.because.length > 20,
      `${surface.pattern} opts out of the operator gate and must say why`,
    );
  }
});

test("safeRedirectTarget refuses anything but a same-origin operator screen", () => {
  assert.equal(safeRedirectTarget("/sends"), "/sends");
  assert.equal(safeRedirectTarget("/sends/12"), "/sends/12");
  assert.equal(safeRedirectTarget("/settings/email"), "/settings/email");
  // Open-redirect attempts.
  assert.equal(safeRedirectTarget("//evil.test/x"), "/");
  assert.equal(safeRedirectTarget("https://evil.test"), "/");
  assert.equal(safeRedirectTarget("http://evil.test"), "/");
  assert.equal(safeRedirectTarget("/\\evil.test"), "/");
  assert.equal(safeRedirectTarget("javascript:alert(1)"), "/");
  // Not a screen, or not ours.
  assert.equal(safeRedirectTarget("/sends/1/evidence"), "/");
  assert.equal(safeRedirectTarget("/msa/token"), "/");
  assert.equal(safeRedirectTarget("/api/v1/sends"), "/");
  // Not a string.
  assert.equal(safeRedirectTarget(undefined), "/");
  assert.equal(safeRedirectTarget(null), "/");
  assert.equal(safeRedirectTarget(42), "/");
});
