import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUsableHost,
  originFromHeaders,
  requestOrigin,
} from "../../src/lib/http/requestOrigin";

// The public origin of a request (SHA-4501 follow-up). PURE except for the
// last block, which builds a real Request.
//
// The bug this pins: on the Railway production deploy, the PDF cover line
// citing where to find the live text read `https://0.0.0.0:8080/legal/msa/1`,
// because the route handler used `new URL(req.url).origin` and that is the
// address the container BOUND to, not the one the reader typed. Every test
// below is a case the live site produced or could produce; the wildcard-bind
// ones are the defect itself.

function headersFrom(map: Record<string, string>): (name: string) => string | null {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower.get(name.toLowerCase()) ?? null;
}

test("the forwarded host and proto win — the proxy knows the public name", () => {
  const get = headersFrom({
    "x-forwarded-host": "legal.acme-builders.com",
    "x-forwarded-proto": "https",
    host: "0.0.0.0:8080",
  });
  assert.equal(
    originFromHeaders(get, { fallbackOrigin: "https://0.0.0.0:8080" }),
    "https://legal.acme-builders.com",
  );
});

test("a comma-separated forwarded chain uses the first hop, which is the client's", () => {
  const get = headersFrom({
    "x-forwarded-host": "legal.acme.com, internal-lb, 10.0.0.4:8080",
    "x-forwarded-proto": "https, http",
  });
  assert.equal(originFromHeaders(get), "https://legal.acme.com");
});

test("no forwarded headers: the Host header is the next best truth", () => {
  const get = headersFrom({ host: "msa.example.org:8443" });
  assert.equal(
    originFromHeaders(get, { fallbackOrigin: "https://msa.example.org:8443" }),
    "https://msa.example.org:8443",
  );
});

test("THE PRODUCTION BUG: a wildcard bind address is never cited", () => {
  // Exactly what the Railway deploy sent. Before the fix this produced
  // https://0.0.0.0:8080/legal/msa/1 on the cover of a downloaded agreement.
  for (const host of ["0.0.0.0:8080", "0.0.0.0", "::", "[::]:3000", "0:0:0:0:0:0:0:0"]) {
    assert.equal(isUsableHost(host), false, host);
    const origin = originFromHeaders(headersFrom({ host, "x-forwarded-host": host }), {
      fallbackOrigin: "https://0.0.0.0:8080",
      configuredBaseUrl: "https://standard-msa-production.up.railway.app",
    });
    assert.equal(origin, "https://standard-msa-production.up.railway.app", host);
  }
});

test("a wildcard bind with no APP_BASE_URL cites nothing rather than a dead link", () => {
  // pdfDocument.ts turns a null origin into no cover URL at all, which is the
  // documented preference: citing a URL that 404s is worse than citing none.
  const origin = originFromHeaders(headersFrom({ host: "0.0.0.0:8080" }), {
    fallbackOrigin: "http://0.0.0.0:8080",
    configuredBaseUrl: null,
  });
  assert.equal(origin, null);
});

test("a malformed or injected host is dropped, not substituted", () => {
  // These are visitor-controllable when nothing sits in front of the app, and
  // the result is printed into a PDF of a legal agreement.
  const bad = [
    "evil.com/path",
    "evil.com?q=1",
    "host with spaces",
    "evil.com\r\nx-injected: 1",
    "http://evil.com",
    "-leading-dash.com",
    "exfil@evil.com",
    "",
    "   ",
  ];
  for (const host of bad) {
    assert.equal(isUsableHost(host), false, JSON.stringify(host));
    assert.equal(
      originFromHeaders(headersFrom({ "x-forwarded-host": host }), {
        fallbackOrigin: "https://real.example.com",
      }),
      "https://real.example.com",
      JSON.stringify(host),
    );
  }
});

test("a port outside the real range, or an unbracketed IPv6, is not a host", () => {
  for (const host of ["example.com:0", "example.com:99999", "example.com:", "example.com:80:80", "::1", "a.b:x"]) {
    assert.equal(isUsableHost(host), false, host);
  }
});

test("real hostnames, IPs and bracketed IPv6 are usable", () => {
  for (const host of [
    "example.com",
    "sub.domain.example.co.uk",
    "localhost",
    "localhost:3000",
    "192.168.1.10:8080",
    "[::1]",
    "[2001:db8::1]:8443",
  ]) {
    assert.equal(isUsableHost(host), true, host);
  }
});

test("the protocol follows the server when the proxy does not say", () => {
  // A self-hosted install behind no TLS terminator is supported, so http is
  // the floor rather than an error.
  assert.equal(
    originFromHeaders(headersFrom({ "x-forwarded-host": "msa.internal" }), {
      fallbackOrigin: "https://msa.internal",
    }),
    "https://msa.internal",
  );
  assert.equal(
    originFromHeaders(headersFrom({ "x-forwarded-host": "msa.internal" }), {
      fallbackOrigin: "http://msa.internal",
    }),
    "http://msa.internal",
  );
  assert.equal(originFromHeaders(headersFrom({ "x-forwarded-host": "msa.internal" })), "http://msa.internal");
});

test("a junk x-forwarded-proto does not become the scheme", () => {
  const get = headersFrom({
    "x-forwarded-host": "msa.example.com",
    "x-forwarded-proto": "javascript",
  });
  assert.equal(originFromHeaders(get, { fallbackOrigin: "https://msa.example.com" }), "https://msa.example.com");
});

test("APP_BASE_URL is normalised: trailing slash and path dropped, non-http rejected", () => {
  const none = headersFrom({});
  assert.equal(originFromHeaders(none, { configuredBaseUrl: "https://msa.example.com/" }), "https://msa.example.com");
  assert.equal(
    originFromHeaders(none, { configuredBaseUrl: "https://msa.example.com/legal/msa" }),
    "https://msa.example.com",
  );
  assert.equal(originFromHeaders(none, { configuredBaseUrl: "ftp://msa.example.com" }), null);
  assert.equal(originFromHeaders(none, { configuredBaseUrl: "not a url" }), null);
  assert.equal(originFromHeaders(none, { configuredBaseUrl: "https://0.0.0.0:8080" }), null);
});

test("nothing at all is null, not a guess", () => {
  assert.equal(originFromHeaders(headersFrom({})), null);
});

test("requestOrigin() on a real Request prefers the proxy over the bound URL", () => {
  const req = new Request("https://0.0.0.0:8080/legal/msa/pdf", {
    headers: { "x-forwarded-host": "legal.acme.com", "x-forwarded-proto": "https" },
  });
  assert.equal(requestOrigin(req), "https://legal.acme.com");
});

test("requestOrigin() on a direct, unproxied request keeps the URL's own origin", () => {
  const req = new Request("http://localhost:3000/legal/msa/pdf", {
    headers: { host: "localhost:3000" },
  });
  assert.equal(requestOrigin(req), "http://localhost:3000");
});
