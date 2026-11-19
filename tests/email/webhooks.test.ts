import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { isWebhookAuthorized } from "../../src/lib/email/webhooks";
import { smtp2goProvider } from "../../src/lib/email/providers/smtp2go";
import { sendgridProvider } from "../../src/lib/email/providers/sendgrid";
import { OUTBOUND_ID_HEADER, type ResolvedEmailConfig } from "../../src/lib/email/types";

function config(secrets: ResolvedEmailConfig["secrets"]): ResolvedEmailConfig {
  return {
    provider: "any",
    fromAddress: "msa@example.com",
    secrets,
    smtp: { port: 587, secure: false },
    baseUrl: "https://msa.example.com",
  };
}

test("webhook authorization requires a configured mechanism", () => {
  // Nothing configured: reject even with a guessed key.
  assert.equal(isWebhookAuthorized("smtp2go", "guess", config({})), false);
  // Shared secret set: exact match only.
  const c = config({ webhookSecret: "hooksecret123" });
  assert.equal(isWebhookAuthorized("smtp2go", "hooksecret123", c), true);
  assert.equal(isWebhookAuthorized("smtp2go", "hooksecret12", c), false);
  assert.equal(isWebhookAuthorized("smtp2go", null, c), false);
  // SendGrid may pass without shared secret only when signature key is set.
  assert.equal(isWebhookAuthorized("sendgrid", null, config({ sendgridWebhookPublicKey: "x" })), true);
  assert.equal(isWebhookAuthorized("smtp2go", null, config({ sendgridWebhookPublicKey: "x" })), false);
});

test("smtp2go webhook events map to normalised types with header correlation", () => {
  const body = JSON.stringify([
    { event: "delivered", email_id: "1a2b", headers: { [OUTBOUND_ID_HEADER]: "ob-1" } },
    { event: "bounce", email_id: "1a2b" },
    { event: "spam", email_id: "1a2b" },
    { event: "irrelevant-noise" },
  ]);
  const events = smtp2goProvider.parseWebhook!(body, {}, config({}));
  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.type),
    ["delivered", "bounced", "complained"],
  );
  assert.equal(events[0].outboundId, "ob-1");
  assert.equal(events[1].providerMessageId, "1a2b");
});

test("smtp2go webhook rejects non-JSON", () => {
  assert.equal(smtp2goProvider.parseWebhook!("<xml/>", {}, config({})), null);
});

test("sendgrid webhook maps events and reads custom_args outbound_id", () => {
  const body = JSON.stringify([
    { event: "bounce", outbound_id: "ob-9", sg_message_id: "sg-1.filter", timestamp: 1700000000, reason: "mailbox full" },
    { event: "spamreport", outbound_id: "ob-9" },
    { event: "open", outbound_id: "ob-9" },
    { event: "processed", outbound_id: "ob-9" }, // unmapped — dropped
  ]);
  const events = sendgridProvider.parseWebhook!(body, {}, config({}));
  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.type),
    ["bounced", "complained", "opened"],
  );
  assert.equal(events[0].outboundId, "ob-9");
  assert.equal(events[0].providerMessageId, "sg-1");
});

test("sendgrid signed webhook verifies ECDSA and rejects tampering", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const body = JSON.stringify([{ event: "delivered", outbound_id: "ob-7" }]);
  const timestamp = "1700000000";
  const signer = createSign("sha256");
  signer.update(timestamp + body);
  const signature = signer.sign(privateKey).toString("base64");

  const c = config({ sendgridWebhookPublicKey: publicKeyB64 });
  const headers = {
    "x-twilio-email-event-webhook-signature": signature,
    "x-twilio-email-event-webhook-timestamp": timestamp,
  };
  const ok = sendgridProvider.parseWebhook!(body, headers, c);
  assert.ok(ok && ok[0].type === "delivered");

  // Tampered body must fail verification.
  const tampered = sendgridProvider.parseWebhook!(body.replace("ob-7", "ob-8"), headers, c);
  assert.equal(tampered, null);
  // Missing signature headers must fail when a key is configured.
  assert.equal(sendgridProvider.parseWebhook!(body, {}, c), null);
});
