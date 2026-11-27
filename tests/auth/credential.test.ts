// The stored-credential primitives (SHA-4455).
//
// Pure: no database, no env. The persistence half is tests/auth/setup-db.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_PASSWORD_LENGTH } from "../../src/lib/auth/config";
import {
  PBKDF2_ALGORITHM,
  PBKDF2_ITERATIONS,
  checkProposedPassword,
  hashPassword,
  sessionSecretFor,
  verifyPassword,
} from "../../src/lib/auth/credential";

const PASSWORD = "a-long-enough-operator-password";
/** Cheap derivation for the round-trip tests; the cost itself is asserted separately. */
const FAST = 1_000;

test("a hashed password verifies, and a different one does not", async () => {
  const stored = await hashPassword(PASSWORD, FAST);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${PASSWORD}x`, stored), false);
  assert.equal(await verifyPassword(PASSWORD.slice(0, -1), stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("the plaintext is nowhere in the stored record", async () => {
  const stored = await hashPassword(PASSWORD, FAST);
  const serialised = JSON.stringify(stored) + sessionSecretFor(stored);
  assert.equal(serialised.includes(PASSWORD), false);
  // Nor any substantial run of it: a hash that embedded the password would
  // show up as a shared prefix long before the whole string matched.
  assert.equal(serialised.includes(PASSWORD.slice(0, 12)), false);
});

test("the same password hashes differently every time", async () => {
  // Per-row salt, so two instances that chose the same password share no
  // stored bytes and neither record is precomputable.
  const a = await hashPassword(PASSWORD, FAST);
  const b = await hashPassword(PASSWORD, FAST);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(sessionSecretFor(a), sessionSecretFor(b));
  // ...and each still verifies its own.
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test("the default cost is the OWASP floor, and it is what hashPassword uses", async () => {
  // Guards against a stray edit lowering the cost silently: the number is the
  // whole protection a stolen database row has.
  assert.ok(PBKDF2_ITERATIONS >= 600_000, `iterations=${PBKDF2_ITERATIONS}`);
  const stored = await hashPassword(PASSWORD);
  assert.equal(stored.iterations, PBKDF2_ITERATIONS);
  assert.equal(stored.algorithm, PBKDF2_ALGORITHM);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
});

test("a tampered or unreadable record verifies nothing", async () => {
  const stored = await hashPassword(PASSWORD, FAST);
  const cases = [
    { ...stored, algorithm: "md5" },
    { ...stored, algorithm: "" },
    { ...stored, iterations: 0 },
    { ...stored, iterations: -1 },
    { ...stored, iterations: 1.5 },
    { ...stored, salt: "not base64url!!" },
    { ...stored, hash: "not base64url!!" },
    // A right-length-looking but wrong hash, and a truncated one.
    { ...stored, hash: stored.hash.slice(0, 8) },
    { ...stored, salt: "AAAAAAAAAAAAAAAAAAAAAA" },
  ];
  for (const record of cases) {
    assert.equal(
      await verifyPassword(PASSWORD, record),
      false,
      `expected refusal for ${JSON.stringify({ ...record, hash: "…" })}`,
    );
  }
});

test("the iteration count is part of the record, not an assumption", async () => {
  // A row written under one cost must still verify after the constant moves.
  const stored = await hashPassword(PASSWORD, FAST);
  assert.equal(stored.iterations, FAST);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  // Re-reading it with a different count is a different derivation entirely.
  assert.equal(await verifyPassword(PASSWORD, { ...stored, iterations: FAST + 1 }), false);
});

test("checkProposedPassword enforces the same policy as the env var", () => {
  const long = "x".repeat(MIN_PASSWORD_LENGTH);
  assert.equal(checkProposedPassword(long, long), null);
  assert.equal(checkProposedPassword(long, `${long}y`), "mismatch");
  assert.equal(checkProposedPassword(long, undefined), "mismatch");
  assert.equal(checkProposedPassword("x".repeat(MIN_PASSWORD_LENGTH - 1), "x".repeat(MIN_PASSWORD_LENGTH - 1)), "too-short");
  assert.equal(checkProposedPassword("", ""), "missing");
  assert.equal(checkProposedPassword(undefined, undefined), "missing");
  assert.equal(checkProposedPassword(null, null), "missing");
  assert.equal(checkProposedPassword(12345678901234, "12345678901234"), "missing");
});

test("a password is stored verbatim — leading and trailing space included", async () => {
  // Same decision as resolveOperatorAuth(): trimming would store a value the
  // operator never typed, and they would be locked out by their own password.
  const padded = `  ${PASSWORD}  `;
  assert.equal(checkProposedPassword(padded, padded), null);
  const stored = await hashPassword(padded, FAST);
  assert.equal(await verifyPassword(padded, stored), true);
  assert.equal(await verifyPassword(PASSWORD, stored), false);
});
