import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPingSeconds,
  clampTotalSeconds,
  clientIpFrom,
  geoFromHeaders,
  hashIp,
  isValidVisitId,
  purgeCutoff,
  visitIpColumns,
  visitIpSalt,
  visitorColumns,
} from "../../src/lib/visits/visits";
import { VISIT_MAX_PING_SECONDS, VISIT_MAX_TOTAL_SECONDS } from "../../src/lib/visits/constants";
import { csvCell, parseVisitFilters } from "../../src/lib/visits/query";

const headersOf = (map: Record<string, string>) => (name: string) => map[name] ?? null;

test("clientIpFrom takes the first x-forwarded-for hop", () => {
  assert.equal(
    clientIpFrom(headersOf({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    "203.0.113.9",
  );
  assert.equal(clientIpFrom(headersOf({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
  assert.equal(clientIpFrom(headersOf({})), null);
});

test("geoFromHeaders reads proxy geo headers, drops unknowns", () => {
  assert.deepEqual(geoFromHeaders(headersOf({ "cf-ipcountry": "us" })), {
    country: "US",
    region: null,
  });
  assert.deepEqual(
    geoFromHeaders(
      headersOf({ "x-vercel-ip-country": "DE", "x-vercel-ip-country-region": "BE" }),
    ),
    { country: "DE", region: "BE" },
  );
  // Cloudflare's "unknown" marker must not read as a country.
  assert.deepEqual(geoFromHeaders(headersOf({ "cf-ipcountry": "XX" })), {
    country: null,
    region: null,
  });
  assert.deepEqual(geoFromHeaders(headersOf({})), { country: null, region: null });
});

test("read-timer pings are clamped per call and in total", () => {
  assert.equal(clampPingSeconds(10), 10);
  assert.equal(clampPingSeconds(10.9), 10);
  assert.equal(clampPingSeconds(99999), VISIT_MAX_PING_SECONDS);
  assert.equal(clampPingSeconds(-5), 0);
  assert.equal(clampPingSeconds("lie"), 0);
  assert.equal(clampTotalSeconds(VISIT_MAX_TOTAL_SECONDS - 10, 120), VISIT_MAX_TOTAL_SECONDS);
  assert.equal(clampTotalSeconds(100, 20), 120);
});

test("visitId is shape-checked", () => {
  assert.equal(isValidVisitId("abcd1234efgh5678".repeat(1)), true);
  assert.equal(isValidVisitId("short"), false);
  assert.equal(isValidVisitId("has spaces here!"), false);
  assert.equal(isValidVisitId(42), false);
});

// ── What a visit row keeps of the visitor (SHA-4497) ─────────────────────
//
// Sean's ruling in mail 4895: the default stays raw IP + timestamp, and the
// operator's "store a salted hash instead" toggle stays. These tests are the
// pin on that default — the ternary they cover used to be copy-pasted into
// both visit writers, where a change to either would have moved the default
// for half the visits with nothing failing.

test("default (toggle off) stores the raw IP and no hash", () => {
  assert.deepEqual(visitIpColumns("203.0.113.9", false, "salt"), {
    ip: "203.0.113.9",
    ipHash: null,
  });
});

test("toggle on stores ONLY the salted hash — never the address too", () => {
  const cols = visitIpColumns("203.0.113.9", true, "salt");
  assert.equal(cols.ip, null);
  assert.equal(cols.ipHash, hashIp("203.0.113.9", "salt"));
  // The columns are exclusive on both branches: a row never carries the
  // visitor's address twice, under either setting.
  assert.ok(!(cols.ip !== null && cols.ipHash !== null));
});

test("no resolvable IP leaves both columns null, hashed or not", () => {
  assert.deepEqual(visitIpColumns(null, false, "salt"), { ip: null, ipHash: null });
  // Not sha256(salt + "") — an absent address must not become a stable
  // pseudonym that every proxy-less visitor shares.
  assert.deepEqual(visitIpColumns(null, true, "salt"), { ip: null, ipHash: null });
});

test("the salt falls back rather than silently storing raw IPs", () => {
  const before = process.env.VISIT_IP_HASH_SALT;
  try {
    delete process.env.VISIT_IP_HASH_SALT;
    assert.equal(visitIpSalt(), "standard-msa");
    process.env.VISIT_IP_HASH_SALT = "operator-chosen";
    assert.equal(visitIpSalt(), "operator-chosen");
  } finally {
    if (before === undefined) delete process.env.VISIT_IP_HASH_SALT;
    else process.env.VISIT_IP_HASH_SALT = before;
  }
});

test("visitorColumns derives UA, IP-or-hash and geo from headers alone", () => {
  const get = headersOf({
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    "user-agent": "Mozilla/5.0 (test)",
    "cf-ipcountry": "us",
  });
  assert.deepEqual(visitorColumns(get, false, "salt"), {
    userAgent: "Mozilla/5.0 (test)",
    ip: "203.0.113.9",
    ipHash: null,
    country: "US",
    region: null,
  });
  const hashed = visitorColumns(get, true, "salt");
  assert.equal(hashed.ip, null);
  assert.equal(hashed.ipHash, hashIp("203.0.113.9", "salt"));
  // Geo survives hashing: it comes from the proxy's header, not the address.
  assert.equal(hashed.country, "US");
  // A hostile UA cannot grow the row without bound.
  assert.equal(
    visitorColumns(headersOf({ "user-agent": "x".repeat(900) }), false, "salt").userAgent?.length,
    400,
  );
});

test("hashIp is salted and stable", () => {
  const a = hashIp("203.0.113.9", "salt1");
  assert.equal(a, hashIp("203.0.113.9", "salt1"));
  assert.notEqual(a, hashIp("203.0.113.9", "salt2"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("purgeCutoff is N days back, floor 1", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  assert.equal(
    purgeCutoff(30, now).toISOString(),
    new Date("2026-10-20T12:00:00Z").toISOString(),
  );
  assert.equal(
    purgeCutoff(0, now).toISOString(),
    new Date("2026-11-18T12:00:00Z").toISOString(),
  );
});

test("visit filters parse dates as whole UTC days", () => {
  const f = parseVisitFilters({ slug: "msa", from: "2026-11-01", to: "2026-11-19" });
  assert.equal(f.slug, "msa");
  assert.equal(f.from?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(f.to?.toISOString(), "2026-11-19T23:59:59.999Z");
  const bad = parseVisitFilters({ from: "junk" });
  assert.equal(bad.from, null);
});

test("csvCell escapes quotes/commas and defangs formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(evil)"), "'=HYPERLINK(evil)");
  assert.equal(csvCell(null), "");
});
