import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmailOutbound } from "@prisma/client";
import { buildPayload, retryDelayMs, MAX_ATTEMPTS } from "../../src/lib/email/queue";
import { clickUrl, openPixelUrl } from "../../src/lib/email/tracking";
import { OUTBOUND_ID_HEADER, type ResolvedEmailConfig } from "../../src/lib/email/types";

test("retry backoff doubles from one minute and caps at six hours", () => {
  assert.equal(retryDelayMs(0), 60_000);
  assert.equal(retryDelayMs(1), 120_000);
  assert.equal(retryDelayMs(2), 240_000);
  assert.equal(retryDelayMs(3), 480_000);
  assert.equal(retryDelayMs(10), 6 * 60 * 60 * 1000);
});

test("MAX_ATTEMPTS bounds the retry loop", () => {
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 10);
});

const config: ResolvedEmailConfig = {
  provider: "smtp",
  fromAddress: "msa@example.com",
  secrets: {},
  smtp: { host: "localhost", port: 2525, secure: false },
  baseUrl: "https://msa.example.com",
};

function outboundRow(overrides: Partial<EmailOutbound>): EmailOutbound {
  return {
    id: "ob-123",
    toAddress: "rcpt@example.com",
    subject: "Subject",
    bodyText: "text",
    bodyHtml: null,
    kind: "test",
    refJson: "{}",
    provider: null,
    status: "queued",
    attempts: 0,
    nextAttemptAt: new Date(0),
    lastError: null,
    providerMessageId: null,
    linksJson: "[]",
    openedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("payload stamps the per-send correlation header", () => {
  const payload = buildPayload(outboundRow({}), config);
  assert.equal(payload.headers[OUTBOUND_ID_HEADER], "ob-123");
  assert.equal(payload.from, "msa@example.com");
  assert.equal(payload.html, undefined);
});

test("html gets click-wrapped links and an open pixel", () => {
  const target = "https://msa.example.com/a/tok123";
  const payload = buildPayload(
    outboundRow({
      bodyHtml: `<p><a href="${target}">Review</a></p>`,
      linksJson: JSON.stringify([target]),
    }),
    config,
  );
  assert.ok(payload.html);
  // Exact-URL comparisons (not substring checks): every href must be the
  // wrapped click URL and the only img must be the open pixel.
  const hrefs = [...payload.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [clickUrl(config.baseUrl, "ob-123", 0)]);
  const imgSrcs = [...payload.html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imgSrcs, [openPixelUrl(config.baseUrl, "ob-123")]);
});

test("corrupt stored link list falls back to sending without wrapping", () => {
  const payload = buildPayload(
    outboundRow({ bodyHtml: "<p>hello</p>", linksJson: "not-json" }),
    config,
  );
  assert.ok(payload.html?.includes("<p>hello</p>"));
  // Exact-URL comparison (not a substring check, per CodeQL): the only img
  // is the open pixel for this outbound.
  const imgSrcs = [...(payload.html ?? "").matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imgSrcs, [openPixelUrl(config.baseUrl, "ob-123")]);
});
