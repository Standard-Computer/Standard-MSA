import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeVenue,
  isValidEmail,
  isValidWebsiteUrl,
  normalizeIdentityInput,
  validateIdentityInput,
  venueValueProblems,
  EMPTY_IDENTITY_INPUT,
  IDENTITY_FIELD_LABELS,
  type MspIdentityInput,
} from "../../src/lib/identity/fields";

const VALID: MspIdentityInput = {
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "123 Main St, Cabot, AR 72023",
  ownerName: "Sean Kubin",
  email: "alerts@standardcomputer.com",
  phone: "555-0100",
  website: "https://www.standardcomputer.com",
  venueState: "Lonoke County, AR",
  venueCountry: "USA",
};

test("a fully valid input has no errors", () => {
  assert.deepEqual(validateIdentityInput(VALID), {});
});

test("required fields: name, legal name, email, website, both venue parts", () => {
  const errors = validateIdentityInput(EMPTY_IDENTITY_INPUT);
  assert.deepEqual(
    Object.keys(errors).sort(),
    ["email", "legalName", "name", "venueCountry", "venueState", "website"].sort(),
  );
});

test("address and owner are optional — the preview shows their blank instead", () => {
  const errors = validateIdentityInput({ ...VALID, address: "", ownerName: "" });
  assert.deepEqual(errors, {});
});

test("email must parse", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("two@at@signs.com"), false);
  assert.equal(isValidEmail("no-tld@host"), false);
  const errors = validateIdentityInput({ ...VALID, email: "nope" });
  assert.ok(errors.email);
});

test("website must be an absolute http(s) URL", () => {
  assert.equal(isValidWebsiteUrl("https://example.com"), true);
  assert.equal(isValidWebsiteUrl("http://localhost:3000"), true);
  assert.equal(isValidWebsiteUrl("example.com"), false); // no scheme
  assert.equal(isValidWebsiteUrl("ftp://example.com"), false);
  assert.equal(isValidWebsiteUrl("http://noDotHost"), false);
  const errors = validateIdentityInput({ ...VALID, website: "example.com" });
  assert.ok(errors.website);
});

test("venue values with braces are surfaced, never silently templated", () => {
  assert.ok(venueValueProblems("Lonoke {County}").length > 0);
  assert.ok(venueValueProblems("{{venue}}").length > 0);
  assert.deepEqual(venueValueProblems("Lonoke County, AR"), []);
  const errors = validateIdentityInput({ ...VALID, venueState: "{venue}" });
  assert.match(errors.venueState ?? "", /brace/);
});

test("venue values must be one clean line", () => {
  assert.ok(venueValueProblems("two\nlines").length > 0);
  assert.ok(venueValueProblems("ctrlchar").length > 0);
});

test("composeVenue joins the parts and tolerates a missing one", () => {
  assert.equal(composeVenue("Lonoke County, AR", "USA"), "Lonoke County, AR, USA");
  assert.equal(composeVenue("  Ontario  ", " Canada "), "Ontario, Canada");
  assert.equal(composeVenue("", "USA"), "USA");
  assert.equal(composeVenue("", ""), "");
});

test("normalize trims every field", () => {
  const n = normalizeIdentityInput({ ...VALID, name: "  Padded  ", email: " a@b.co " });
  assert.equal(n.name, "Padded");
  assert.equal(n.email, "a@b.co");
});

// ── {{msp_phone}} (SHA-4708 / GH #33 §4, AC5) ──────────────────────────────

test("phone is OPTIONAL — a blank one never blocks a save", () => {
  // Same posture as address: an install that skipped onboarding, and every
  // row that predates SHA-4708, must stay saveable.
  assert.deepEqual(validateIdentityInput({ ...VALID, phone: "" }), {});
  assert.ok(!("phone" in validateIdentityInput(EMPTY_IDENTITY_INPUT)));
});

test("phone is a field the shared label map knows, so every surface shows it", () => {
  // /settings/identity and the re-run diff both enumerate this map; a field
  // missing from it is a field that silently does not appear.
  assert.equal(IDENTITY_FIELD_LABELS.phone, "Phone");
  assert.ok("phone" in EMPTY_IDENTITY_INPUT);
  assert.equal(EMPTY_IDENTITY_INPUT.phone, "");
});

test("phone is trimmed at the boundary like every other field", () => {
  assert.equal(normalizeIdentityInput({ ...VALID, phone: "  555-0100  " }).phone, "555-0100");
});

test("no format validation on phone: real numbers are not all one shape", () => {
  for (const phone of ["+44 20 7946 0958", "(555) 010-0100 x2", "555.0100", "call the on-call line"]) {
    assert.deepEqual(validateIdentityInput({ ...VALID, phone }), {}, `${phone} must be accepted`);
  }
});
