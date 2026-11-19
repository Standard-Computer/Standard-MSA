import { test } from "node:test";
import assert from "node:assert/strict";

import { probeWebsite } from "../../src/lib/identity/reachability";

function fakeFetch(response: () => Promise<Response>): typeof fetch {
  return (() => response()) as typeof fetch;
}

test("a 200 answer is reachable", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch(async () => new Response("ok", { status: 200 })),
  );
  assert.deepEqual(result, { ok: true, status: 200 });
});

test("an HTTP error is reported as data, not thrown", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch(async () => new Response("gone", { status: 404 })),
  );
  assert.deepEqual(result, { ok: false, reason: "responded with HTTP 404" });
});

test("a connection failure is reported as data, not thrown", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not be reached/);
});

test("a timeout names the budget", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch(async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }),
    5000,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /did not respond within 5s/);
});
