import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEmailConfig } from "../../src/lib/email/config";

test("unconfigured when no provider anywhere", () => {
  const state = resolveEmailConfig({});
  assert.equal(state.configured, false);
  if (!state.configured) assert.match(state.reason, /EMAIL_PROVIDER/);
});

test("unknown provider fails loudly and names the valid ones", () => {
  const state = resolveEmailConfig({ EMAIL_PROVIDER: "pigeon", EMAIL_FROM: "a@b.co" });
  assert.equal(state.configured, false);
  if (!state.configured) assert.match(state.reason, /smtp2go, sendgrid, smtp/);
});

test("provider without its key is unconfigured, reason names the env var not the value", () => {
  for (const [provider, envVar] of [
    ["smtp2go", "SMTP2GO_API_KEY"],
    ["sendgrid", "SENDGRID_API_KEY"],
  ] as const) {
    const state = resolveEmailConfig({ EMAIL_PROVIDER: provider, EMAIL_FROM: "a@b.co" });
    assert.equal(state.configured, false);
    if (!state.configured) assert.ok(state.reason.includes(envVar), `reason names ${envVar}`);
  }
});

test("selects smtp2go from env", () => {
  const state = resolveEmailConfig({
    EMAIL_PROVIDER: "smtp2go",
    EMAIL_FROM: "msa@example.com",
    SMTP2GO_API_KEY: "api-TESTTESTTESTTESTTESTTEST00",
  });
  assert.equal(state.configured, true);
  if (state.configured) {
    assert.equal(state.config.provider, "smtp2go");
    assert.equal(state.config.fromAddress, "msa@example.com");
  }
});

test("env wins over DB settings; DB fills gaps", () => {
  const state = resolveEmailConfig(
    { EMAIL_PROVIDER: "smtp", SMTP_HOST: "mail.env.example" },
    { provider: "sendgrid", fromAddress: "db@example.com", smtpHost: "mail.db.example", smtpPort: 2525 },
  );
  assert.equal(state.configured, true);
  if (state.configured) {
    assert.equal(state.config.provider, "smtp"); // env beat the DB row
    assert.equal(state.config.fromAddress, "db@example.com"); // DB filled the gap
    assert.equal(state.config.smtp.host, "mail.env.example");
    assert.equal(state.config.smtp.port, 2525);
  }
});

test("smtp without a host is unconfigured", () => {
  const state = resolveEmailConfig({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "a@b.co" });
  assert.equal(state.configured, false);
  if (!state.configured) assert.match(state.reason, /SMTP_HOST/);
});

test("no secret value ever appears in an unconfigured reason", () => {
  const key = "SG.leakyleakyleakyleak.leakyleakyleakyleak";
  // Misconfigured on purpose: key present but provider missing its from-address.
  const state = resolveEmailConfig({ EMAIL_PROVIDER: "sendgrid", SENDGRID_API_KEY: key });
  assert.equal(state.configured, false);
  if (!state.configured) assert.ok(!state.reason.includes(key));
});
