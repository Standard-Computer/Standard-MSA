// SHA-2960: the delivery-time SSRF guard in defaultWebhookTransport.
//
// webhookUrlProblem (create-time) only refuses LITERAL private IPs, by
// design — a hostname can re-resolve between create and delivery, so the
// guard that actually protects is the resolve-then-refuse step inside the
// transport. That line must be defended against its own deletion: every
// assertion here checks the EXACT refusal message, because a deleted guard
// would still "fail" these URLs with a connection error, just after
// having made the request.
//
// No test here performs network I/O: refusal happens before any socket
// opens, and `localhost` resolves locally via the hosts file.

import "../email/setup";

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultWebhookTransport } from "../../src/lib/api/webhooks";

const PRIVATE = "resolves to a private or internal address";

async function post(url: string) {
  return defaultWebhookTransport(url, "{}", { "content-type": "application/json" }, 1000);
}

test("delivery refuses private and internal literals before any socket opens", async () => {
  for (const url of [
    "http://127.0.0.1/hook",
    "http://127.0.0.1:8080/hook",
    "https://10.0.0.5/hook",
    "https://192.168.1.1/hook",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/hook",
    "http://100.64.0.1/hook", // CGNAT
    "http://[::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://[fd00::1]/hook",
  ]) {
    const result = await post(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.statusCode, null, url);
    assert.equal(result.error, PRIVATE, url);
  }
});

test("delivery refuses obfuscated loopback forms", async () => {
  // WHATWG URL normalizes these to dotted-quad loopback before our guard
  // ever sees them; assert the normalization + guard pair holds.
  for (const url of ["http://2130706433/hook", "http://0x7f000001/hook", "http://017700000001/hook"]) {
    const result = await post(url);
    assert.equal(result.error, PRIVATE, url);
  }
});

test("delivery refuses hostnames that RESOLVE private, not just literals", async () => {
  // localhost resolves via the hosts file — no network — and is exactly the
  // case the create-time vet lets through for delivery-time handling.
  const result = await post("https://localhost/hook");
  assert.equal(result.ok, false);
  assert.equal(result.error, PRIVATE);
});

test("delivery refuses non-http(s) and unparseable URLs", async () => {
  assert.equal((await post("ftp://example.com/x")).error, "not an http(s) URL");
  assert.equal((await post("not a url")).error, "invalid URL");
});
