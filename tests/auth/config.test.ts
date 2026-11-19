// Operator auth configuration (SHA-3047). The important assertion here is
// the fail-closed one: an absent OPERATOR_PASSWORD must never resolve to
// "configured", because that is indistinguishable from no gate at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PASSWORD_LENGTH,
  resolveOperatorAuth,
  secureCookies,
} from "../../src/lib/auth/config";

test("a missing, empty or whitespace password is unconfigured, and says what to set", () => {
  for (const env of [{}, { OPERATOR_PASSWORD: "" }, { OPERATOR_PASSWORD: "   " }]) {
    const state = resolveOperatorAuth(env);
    assert.equal(state.configured, false);
    assert.ok(state.configured === false && state.reason.includes("OPERATOR_PASSWORD"));
  }
});

test("a short password is unconfigured rather than accepted", () => {
  const state = resolveOperatorAuth({ OPERATOR_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH - 1) });
  assert.equal(state.configured, false);
  assert.ok(state.configured === false && state.reason.includes(String(MIN_PASSWORD_LENGTH)));
});

test("a long enough password configures the gate, verbatim", () => {
  // Untrimmed: the comparison is byte-for-byte, so trimming here would
  // accept a value the operator never typed.
  const raw = `  ${"x".repeat(MIN_PASSWORD_LENGTH)}  `;
  const state = resolveOperatorAuth({ OPERATOR_PASSWORD: raw });
  assert.equal(state.configured, true);
  assert.equal(state.configured === true && state.password, raw);
});

test("the unconfigured reason never echoes the value", () => {
  const secret = "hunter2";
  const state = resolveOperatorAuth({ OPERATOR_PASSWORD: secret });
  assert.equal(state.configured, false);
  assert.ok(state.configured === false && !state.reason.includes(secret));
});

test("Secure cookies follow the instance's own base URL, not NODE_ENV", () => {
  assert.equal(secureCookies({ APP_BASE_URL: "https://msa.example.com" }), true);
  assert.equal(secureCookies({ APP_BASE_URL: "HTTPS://msa.example.com" }), true);
  assert.equal(secureCookies({ APP_BASE_URL: "http://localhost:3000" }), false);
  assert.equal(secureCookies({}), false);
  // A plain-http self-host must not get a Secure cookie it can never send.
  assert.equal(secureCookies({ APP_BASE_URL: "http://10.0.0.5:3000", NODE_ENV: "production" }), false);
});
