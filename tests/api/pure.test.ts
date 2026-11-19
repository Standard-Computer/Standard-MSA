// SHA-2960: pure pieces of the API surface — rate limiter, webhook signing
// and backoff, URL vetting, key shapes and scopes, idempotency hashing,
// error envelopes. No database, no network.

import "../email/setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { z } from "zod";

import { ApiError, validationError } from "../../src/lib/api/errors";
import { idempotencyKeyFrom, requestHash } from "../../src/lib/api/idempotency";
import { isApiKeyShape, keyScopes } from "../../src/lib/api/keys";
import { API_SCOPES } from "../../src/lib/api/scopes";
import { rateLimitHeaders, takeToken } from "../../src/lib/api/ratelimit";
import {
  nextAttemptDelayMs,
  signWebhookBody,
  webhookUrlProblem,
  WEBHOOK_BACKOFF_MINUTES,
  WEBHOOK_MAX_ATTEMPTS,
} from "../../src/lib/api/webhooks";

// ── Rate limiter ────────────────────────────────────────────────────────────

test("token bucket allows a full burst, then denies with a Retry-After", () => {
  const config = { perMinute: 3 };
  let state: { tokens: number; updatedAtMs: number } | undefined;
  const now = 1_000_000;

  for (let i = 0; i < 3; i++) {
    const { bucket, decision } = takeToken(state, config, now);
    state = bucket;
    assert.equal(decision.allowed, true, `request ${i + 1} should pass`);
  }
  const denied = takeToken(state, config, now);
  assert.equal(denied.decision.allowed, false);
  assert.equal(denied.decision.remaining, 0);
  assert.ok(denied.decision.retryAfterSeconds >= 1);

  const headers = rateLimitHeaders(denied.decision);
  assert.equal(headers["X-RateLimit-Limit"], "3");
  assert.ok(headers["Retry-After"]);
});

test("token bucket refills continuously and caps at capacity", () => {
  const config = { perMinute: 60 }; // 1 token/second
  const start = 0;
  let { bucket } = takeToken(undefined, config, start); // 59 left
  for (let i = 0; i < 59; i++) bucket = takeToken(bucket, config, start).bucket;
  assert.equal(takeToken(bucket, config, start).decision.allowed, false);
  // 2 seconds later there are ~2 tokens, not more.
  const later = takeToken(bucket, config, start + 2000);
  assert.equal(later.decision.allowed, true);
  // A long idle period never overfills past capacity.
  const idle = takeToken(later.bucket, config, start + 10_000_000);
  assert.equal(idle.decision.remaining, config.perMinute - 1);
});

// ── Webhook signing and schedule ────────────────────────────────────────────

test("webhook signature is HMAC-SHA256 over '<unix>.<body>'", () => {
  const sig = signWebhookBody("whsec_test", '{"a":1}', 1700000000);
  const expected = createHmac("sha256", "whsec_test").update('1700000000.{"a":1}').digest("hex");
  assert.equal(sig, `t=1700000000,v1=${expected}`);
  // Any ingredient changing changes the MAC.
  assert.notEqual(signWebhookBody("whsec_other", '{"a":1}', 1700000000), sig);
  assert.notEqual(signWebhookBody("whsec_test", '{"a":2}', 1700000000), sig);
  assert.notEqual(signWebhookBody("whsec_test", '{"a":1}', 1700000001), sig);
});

test("backoff schedule walks the table then exhausts", () => {
  assert.equal(nextAttemptDelayMs(1), WEBHOOK_BACKOFF_MINUTES[0] * 60_000);
  assert.equal(
    nextAttemptDelayMs(WEBHOOK_BACKOFF_MINUTES.length),
    WEBHOOK_BACKOFF_MINUTES[WEBHOOK_BACKOFF_MINUTES.length - 1] * 60_000,
  );
  assert.equal(nextAttemptDelayMs(WEBHOOK_MAX_ATTEMPTS), null);
});

test("webhook URL vetting refuses non-http and private literals", () => {
  assert.equal(webhookUrlProblem("https://psa.example.com/hooks/msa"), null);
  assert.equal(webhookUrlProblem("http://psa.example.com/hooks"), null); // hostnames vet at delivery
  assert.ok(webhookUrlProblem("not a url"));
  assert.ok(webhookUrlProblem("ftp://example.com/x"));
  assert.ok(webhookUrlProblem("http://127.0.0.1/hook"));
  assert.ok(webhookUrlProblem("http://10.1.2.3/hook"));
  assert.ok(webhookUrlProblem("http://169.254.169.254/latest/meta-data"));
  assert.ok(webhookUrlProblem("http://[::1]/hook"));
  assert.ok(webhookUrlProblem("http://[::ffff:169.254.169.254]/hook"));
});

// ── Keys ────────────────────────────────────────────────────────────────────

test("API key shape gate", () => {
  assert.equal(isApiKeyShape(`smsa_${"a".repeat(43)}`), true);
  assert.equal(isApiKeyShape("smsa_short"), false);
  assert.equal(isApiKeyShape(`SMSA_${"a".repeat(43)}`), false);
  assert.equal(isApiKeyShape(`smsa_${"a".repeat(43)}!`), false);
  assert.equal(isApiKeyShape(42), false);
});

test("empty scope list grants everything; a subset restricts; corruption narrows to nothing", () => {
  assert.deepEqual(keyScopes({ scopesJson: "[]" }), [...API_SCOPES]);
  assert.deepEqual(keyScopes({ scopesJson: '["sends:write","bogus"]' }), ["sends:write"]);
  // A corrupt row must fail CLOSED: unparseable or non-array scope data
  // narrows the key to no scopes rather than widening it to all of them.
  assert.deepEqual(keyScopes({ scopesJson: "not json" }), []);
  assert.deepEqual(keyScopes({ scopesJson: '"contacts:read"' }), []);
  assert.deepEqual(keyScopes({ scopesJson: '["bogus"]' }), []);
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test("request hashing distinguishes bodies; header extraction bounds length", () => {
  assert.equal(requestHash({ a: 1 }), requestHash({ a: 1 }));
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: 2 }));
  assert.equal(requestHash(undefined), requestHash(null)); // "no body" is one state

  assert.equal(idempotencyKeyFrom(new Headers()), null);
  assert.equal(idempotencyKeyFrom(new Headers({ "Idempotency-Key": "  abc  " })), "abc");
  assert.equal(idempotencyKeyFrom(new Headers({ "Idempotency-Key": "x".repeat(200) })), "x".repeat(200));
  // Oversized is a typed rejection, never a silent downgrade to "no key":
  // the caller sent a key, so they believe they are replay-protected.
  assert.throws(
    () => idempotencyKeyFrom(new Headers({ "Idempotency-Key": "x".repeat(201) })),
    (err: unknown) => err instanceof ApiError && err.code === "validation_failed",
  );
});

// ── Errors ──────────────────────────────────────────────────────────────────

test("error envelope carries a stable code and optional details", () => {
  const err = new ApiError("not_found", "No such send.");
  assert.equal(err.status, 404);
  assert.deepEqual(err.body(), { error: { code: "not_found", message: "No such send." } });

  const parse = z.object({ email: z.email() }).safeParse({ email: "nope" });
  assert.ok(!parse.success);
  const invalid = validationError(parse.error);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body().error.details?.[0]?.path, "email");
});
