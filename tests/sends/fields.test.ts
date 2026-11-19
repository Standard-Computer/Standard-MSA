// Recipient field normalisation and the one-required-field bar (SHA-2959).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_RECIPIENT_INPUT,
  OPTIONAL_RECIPIENT_FIELDS,
  filledOptionalFields,
  normalizeRecipientInput,
  validateRecipientInput,
} from "../../src/lib/sends/fields";

test("an email address alone is enough to send — Sean's bar", () => {
  const result = validateRecipientInput({ email: "dana@mail.shadowpsa.com" });
  assert.ok(result.ok, "one field must be sufficient");
  assert.equal(result.input.email, "dana@mail.shadowpsa.com");
  assert.deepEqual(filledOptionalFields(result.input), [], "no optional field is required");
});

test("email is required and shape-checked; nothing else can fail", () => {
  const missing = validateRecipientInput({ fullName: "Dana Reyes", phone: "+1 555 010 0100" });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.field, "email");

  const malformed = validateRecipientInput({ email: "dana@localhost" });
  assert.equal(malformed.ok, false, "no dot in the domain is refused");

  // Every optional field explicitly blank, email fine: still valid.
  const sparse = validateRecipientInput({ ...EMPTY_RECIPIENT_INPUT, email: "a@b.co" });
  assert.equal(sparse.ok, true);
});

test("emails are canonicalised so one person is one recipient, not two rows", () => {
  const input = normalizeRecipientInput({ email: "  Dana@Mail.ShadowPSA.com  " });
  assert.equal(input.email, "dana@mail.shadowpsa.com");
});

test("every field is trimmed, and nulls from a DB row normalise to empty strings", () => {
  const input = normalizeRecipientInput({
    email: "dana@mail.shadowpsa.com",
    fullName: "  Dana Reyes  ",
    companyName: null,
    legalName: undefined,
    address: "\t100 Main St\n",
    phone: "  ",
  });
  assert.equal(input.fullName, "Dana Reyes");
  assert.equal(input.companyName, "", "null column must not become the string 'null'");
  assert.equal(input.legalName, "");
  assert.equal(input.address, "100 Main St");
  assert.equal(input.phone, "", "whitespace-only is empty, not a captured value");
});

test("absurd values are clamped — a contract merges these", () => {
  const input = normalizeRecipientInput({
    email: "dana@mail.shadowpsa.com",
    fullName: "N".repeat(5000),
    address: "A".repeat(5000),
  });
  assert.equal(input.fullName.length, 200);
  assert.equal(input.address.length, 500);
});

test("filledOptionalFields reports exactly what the operator captured", () => {
  const input = normalizeRecipientInput({
    email: "dana@mail.shadowpsa.com",
    companyName: "Reyes Dental",
    phone: "+1 555 010 0100",
  });
  assert.deepEqual(filledOptionalFields(input), ["companyName", "phone"]);
  assert.ok(
    filledOptionalFields(input).every((f) => OPTIONAL_RECIPIENT_FIELDS.includes(f)),
    "never reports a field the form does not offer",
  );
});
