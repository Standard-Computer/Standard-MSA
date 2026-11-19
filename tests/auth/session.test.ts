// Operator session cookie (SHA-3047): minting, verification, and every way
// a forged or stale cookie must fail.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  equalSecrets,
  mintSession,
  OPERATOR_COOKIE,
  readCookie,
  SESSION_TTL_SECONDS,
  verifySession,
} from "../../src/lib/auth/session";

const PASSWORD = "correct-horse-battery-staple";
const NOW = 1_763_500_000_000;

test("a freshly minted session verifies", async () => {
  const cookie = await mintSession(PASSWORD, NOW);
  assert.equal(await verifySession(cookie, PASSWORD, NOW), true);
});

test("the password never appears in the cookie", async () => {
  const cookie = await mintSession(PASSWORD, NOW);
  assert.ok(!cookie.includes(PASSWORD));
  // Shape: v1.<expiry>.<signature>
  assert.match(cookie, /^v1\.[0-9]{10,}\.[A-Za-z0-9_-]+$/);
});

test("a session minted under a different password is refused", async () => {
  // This is how changing OPERATOR_PASSWORD revokes outstanding sessions.
  const cookie = await mintSession(PASSWORD, NOW);
  assert.equal(await verifySession(cookie, PASSWORD + "!", NOW), false);
  assert.equal(await verifySession(cookie, PASSWORD.slice(0, -1), NOW), false);
});

test("an empty password refuses rather than throwing", async () => {
  // Web Crypto throws DataError on a zero-length HMAC key, and this runs on
  // the refusal path for every operator request: a throw here would be a 500
  // where a 401 belongs. resolveOperatorAuth() will not produce an empty
  // password, so this is the belt to that braces.
  const cookie = await mintSession(PASSWORD, NOW);
  assert.equal(await verifySession(cookie, "", NOW), false);
  await assert.rejects(() => mintSession("", NOW), TypeError);
});

test("a tampered expiry is refused", async () => {
  const cookie = await mintSession(PASSWORD, NOW);
  const [, expiry, signature] = cookie.split(".");
  const extended = `v1.${Number(expiry) + 86_400}.${signature}`;
  assert.equal(await verifySession(extended, PASSWORD, NOW), false);
});

test("a tampered signature is refused", async () => {
  const cookie = await mintSession(PASSWORD, NOW);
  const [version, expiry, signature] = cookie.split(".");
  const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  assert.equal(await verifySession(`${version}.${expiry}.${flipped}`, PASSWORD, NOW), false);
});

test("an expired session is refused, one second before expiry is not", async () => {
  const cookie = await mintSession(PASSWORD, NOW);
  const expiresAtMs = NOW + SESSION_TTL_SECONDS * 1000;
  assert.equal(await verifySession(cookie, PASSWORD, expiresAtMs - 1000), true);
  assert.equal(await verifySession(cookie, PASSWORD, expiresAtMs), false);
  assert.equal(await verifySession(cookie, PASSWORD, expiresAtMs + 60_000), false);
});

test("garbage never throws and never verifies", async () => {
  for (const value of [
    "",
    ".",
    "..",
    "v1",
    "v1.123",
    "v1.123.456.789",
    "v2.9999999999.AAAA",
    "v1.notanumber.AAAA",
    "v1.1e999.AAAA",
    "v1.0x10.AAAA",
    "v1.9999999999.not+base64url!",
    "v1.99999999999999999999999999.AAAA",
    null,
    undefined,
  ] as (string | null | undefined)[]) {
    assert.equal(
      await verifySession(value, PASSWORD, NOW),
      false,
      `${String(value)} must not verify`,
    );
  }
});

test("a signature of the right shape but the wrong content is refused", async () => {
  // 32 base64url bytes of zeroes: well-formed, wrong HMAC.
  const fake = "A".repeat(43);
  assert.equal(await verifySession(`v1.${Math.floor(NOW / 1000) + 600}.${fake}`, PASSWORD, NOW), false);
});

test("equalSecrets is true only for identical strings", async () => {
  assert.equal(await equalSecrets("abc", "abc"), true);
  assert.equal(await equalSecrets("", ""), true);
  assert.equal(await equalSecrets("abc", "abd"), false);
  assert.equal(await equalSecrets("abc", "ab"), false);
  assert.equal(await equalSecrets("abc", "abcd"), false);
  assert.equal(await equalSecrets("abc", ""), false);
  // Unicode compared by bytes, not by collation.
  assert.equal(await equalSecrets("é", "é"), true);
  assert.equal(await equalSecrets("é", "e"), false);
});

test("readCookie picks the named value out of a real header", () => {
  const header = `theme=dark; ${OPERATOR_COOKIE}=v1.123.sig; other=x`;
  assert.equal(readCookie(header, OPERATOR_COOKIE), "v1.123.sig");
  assert.equal(readCookie(`${OPERATOR_COOKIE}=only`, OPERATOR_COOKIE), "only");
  assert.equal(readCookie("theme=dark", OPERATOR_COOKIE), null);
  assert.equal(readCookie("", OPERATOR_COOKIE), null);
  assert.equal(readCookie(null, OPERATOR_COOKIE), null);
  assert.equal(readCookie(undefined, OPERATOR_COOKIE), null);
  // A cookie whose NAME merely ends with ours must not be read as ours.
  assert.equal(readCookie(`not_${OPERATOR_COOKIE}=x`, OPERATOR_COOKIE), null);
  assert.equal(readCookie(`${OPERATOR_COOKIE}_other=x`, OPERATOR_COOKIE), null);
});
