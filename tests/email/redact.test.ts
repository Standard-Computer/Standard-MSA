import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSecret, redactSecrets, REDACTED } from "../../src/lib/email/redact";

test("redacts secret values taken from the environment", () => {
  process.env.SENDGRID_API_KEY = "SG.testenvkeyabcdef1234.testenvsecretpart5678";
  try {
    const message = `401 Unauthorized for key ${process.env.SENDGRID_API_KEY}`;
    const safe = redactSecrets(message);
    assert.ok(!safe.includes("testenvsecretpart5678"), "key value must be gone");
    assert.ok(safe.includes(REDACTED));
  } finally {
    delete process.env.SENDGRID_API_KEY;
  }
});

test("redacts extra caller-supplied secrets, longest first", () => {
  const long = "secretvalue-and-more";
  const short = "secretvalue";
  const safe = redactSecrets(`a=${long} b=${short}`, [short, long]);
  assert.equal(safe, `a=${REDACTED} b=${REDACTED}`);
});

test("redacts provider-shaped keys even when not in env", () => {
  const sg = redactSecrets("provider said: SG.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb invalid");
  assert.ok(!sg.includes("SG.aaaaaaaaaaaaaaaaaaaa"), "SendGrid-shaped key must be gone");
  const s2g = redactSecrets("provider said: api-ABCDEFGHIJKLMNOPQRSTUVWX12 invalid");
  assert.ok(!s2g.includes("api-ABCDEFGHIJKLMNOPQRSTUVWX12"), "SMTP2GO-shaped key must be gone");
});

test("short or unset env values are never used as redaction patterns", () => {
  process.env.SMTP_PASSWORD = "abc"; // too short — redacting 'abc' would shred text
  try {
    assert.equal(redactSecrets("abcdef is fine"), "abcdef is fine");
  } finally {
    delete process.env.SMTP_PASSWORD;
  }
});

test("describeSecret reports presence and length, never the value", () => {
  assert.equal(describeSecret(undefined), "not set");
  assert.equal(describeSecret(""), "not set");
  const described = describeSecret("hunter2hunter2");
  assert.ok(!described.includes("hunter2"));
  assert.equal(described, "set (14 chars)");
});
