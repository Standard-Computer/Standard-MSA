// The gate's resolution table (SHA-4455).
//
// Five rows, five tests. The two that matter most are the fail-closed ones:
// a present-but-rejected OPERATOR_PASSWORD and an unreadable database must
// NOT resolve to `setup`, because `setup` means "anyone may claim this
// instance" and both of those are instances somebody already owns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveOperatorAuth, MIN_PASSWORD_LENGTH } from "../../src/lib/auth/config";
import { hashPassword, type CredentialRead } from "../../src/lib/auth/credential";
import { gateAcceptsSignIn, gateSessionSecret, resolveGate, verifyOperatorPassword } from "../../src/lib/auth/gate";

const PASSWORD = "a-long-enough-operator-password";
const STORED_PASSWORD = "a-different-long-password";
const FAST = 1_000;

const NO_CREDENTIAL: CredentialRead = { ok: true, credential: null };
const UNREADABLE: CredentialRead = { ok: false, reason: "database unreachable" };

const env = (value?: string) =>
  resolveOperatorAuth(value === undefined ? {} : { OPERATOR_PASSWORD: value });

test("OPERATOR_PASSWORD set and long enough -> env, and env wins over a stored credential", async () => {
  const stored = await hashPassword(STORED_PASSWORD, FAST);
  const gate = resolveGate(env(PASSWORD), { ok: true, credential: stored });
  assert.equal(gate.kind, "env");
  assert.equal(gateSessionSecret(gate), PASSWORD);
  assert.equal(await verifyOperatorPassword(gate, PASSWORD), true);
  // The stored password does NOT open an env-configured instance: one gate is
  // live at a time, which is what makes the env var a recovery route.
  assert.equal(await verifyOperatorPassword(gate, STORED_PASSWORD), false);
});

test("OPERATOR_PASSWORD present but too short -> closed, NOT setup", () => {
  const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
  for (const read of [NO_CREDENTIAL, UNREADABLE]) {
    const gate = resolveGate(env(short), read);
    assert.equal(gate.kind, "closed", "a misconfigured instance must not reopen first boot");
    assert.equal(gateAcceptsSignIn(gate), false);
    assert.ok(
      gate.kind === "closed" && gate.reason.includes("OPERATOR_PASSWORD"),
      "the refusal names the variable to fix",
    );
    assert.ok(
      gate.kind === "closed" && !gate.reason.includes(short),
      "the refusal never quotes the value",
    );
  }
});

test("no OPERATOR_PASSWORD, a stored credential exists -> stored", async () => {
  const stored = await hashPassword(STORED_PASSWORD, FAST);
  const gate = resolveGate(env(), { ok: true, credential: stored });
  assert.equal(gate.kind, "stored");
  assert.equal(await verifyOperatorPassword(gate, STORED_PASSWORD), true);
  assert.equal(await verifyOperatorPassword(gate, PASSWORD), false);
  assert.equal(await verifyOperatorPassword(gate, ""), false);
  // The signing secret is derived from the record, never the plaintext.
  const secret = gateSessionSecret(gate);
  assert.ok(secret !== null && !secret.includes(STORED_PASSWORD));
});

test("no OPERATOR_PASSWORD, no stored credential -> setup", async () => {
  const gate = resolveGate(env(), NO_CREDENTIAL);
  assert.equal(gate.kind, "setup");
  assert.equal(gateSessionSecret(gate), null);
  assert.equal(gateAcceptsSignIn(gate), false);
  // Nothing authenticates against an unclaimed instance, including the empty
  // string — a session could not be minted under a null secret anyway.
  assert.equal(await verifyOperatorPassword(gate, PASSWORD), false);
  assert.equal(await verifyOperatorPassword(gate, ""), false);
});

test("no OPERATOR_PASSWORD and an unreadable database -> closed, NOT setup", async () => {
  const gate = resolveGate(env(), UNREADABLE);
  assert.equal(gate.kind, "closed", "an unreadable database is not an unclaimed instance");
  assert.equal(gateAcceptsSignIn(gate), false);
  assert.equal(await verifyOperatorPassword(gate, PASSWORD), false);
});

test("an all-whitespace OPERATOR_PASSWORD counts as absent, so first boot stays open", () => {
  // resolveOperatorAuth() treats "   " as unset (it trims for the emptiness
  // check only). That is the "variable exists in the platform UI but was
  // never filled in" case — the instance is unconfigured, not misconfigured.
  assert.equal(resolveGate(env("   "), NO_CREDENTIAL).kind, "setup");
});
