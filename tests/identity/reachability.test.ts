import { test } from "node:test";
import assert from "node:assert/strict";

import { isPrivateAddress, probeWebsite } from "../../src/lib/identity/reachability";

const publicLookup = async () => ["93.184.216.34"];

function fakeFetch(responses: (() => Promise<Response>)[]): typeof fetch {
  let i = 0;
  return (() => responses[Math.min(i++, responses.length - 1)]()) as typeof fetch;
}

test("a 200 answer from a public host is reachable", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([async () => new Response("ok", { status: 200 })]),
    5000,
    publicLookup,
  );
  assert.deepEqual(result, { ok: true, status: 200 });
});

test("an HTTP error is reported as data, not thrown", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([async () => new Response("gone", { status: 404 })]),
    5000,
    publicLookup,
  );
  assert.deepEqual(result, { ok: false, reason: "responded with HTTP 404" });
});

test("a connection failure is reported as data, not thrown", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([
      async () => {
        throw new TypeError("fetch failed");
      },
    ]),
    5000,
    publicLookup,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not be reached/);
});

test("a timeout names the budget", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([
      async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    ]),
    5000,
    publicLookup,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /did not respond within 5s/);
});

// ── SSRF guard ──────────────────────────────────────────────────────────────

test("private, loopback, link-local and mapped addresses are private", () => {
  for (const addr of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:192.168.1.1",
  ]) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
  for (const addr of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should be public`);
  }
});

test("a hostname resolving to a private address is refused before any fetch", async () => {
  let fetched = false;
  const result = await probeWebsite(
    "https://internal.example.com",
    (() => {
      fetched = true;
      return Promise.resolve(new Response("nope"));
    }) as unknown as typeof fetch,
    5000,
    async () => ["10.0.0.5"],
  );
  assert.equal(fetched, false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /private or internal address/);
});

test("an IP-literal URL in a private range is refused", async () => {
  const result = await probeWebsite(
    "http://169.254.169.254/latest/meta-data/",
    fakeFetch([async () => new Response("metadata", { status: 200 })]),
    5000,
    publicLookup,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /private or internal address/);
});

test("redirects are followed with the guard applied per hop", async () => {
  // Public host redirects to the metadata endpoint — the laundering case.
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    ]),
    5000,
    publicLookup,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /private or internal address/);
});

test("a legitimate redirect chain still succeeds", async () => {
  const result = await probeWebsite(
    "http://example.com",
    fakeFetch([
      async () =>
        new Response(null, { status: 301, headers: { location: "https://www.example.com/" } }),
      async () => new Response("ok", { status: 200 }),
    ]),
    5000,
    publicLookup,
  );
  assert.deepEqual(result, { ok: true, status: 200 });
});

test("endless redirects are cut off", async () => {
  const result = await probeWebsite(
    "https://example.com",
    fakeFetch([
      async () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
    ]),
    5000,
    publicLookup,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /redirected more than/);
});
