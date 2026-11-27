// Setup-guide copy for Settings → Email (SHA-4509, GH #20 item 2).
//
// The guardrail that matters is 1:1 coverage against the provider registry:
// a future fourth provider fails this suite until its operator copy exists —
// the same omission class GH #17 and GH #20 were both about. The rest holds
// the module to the two honesty contracts: the required key per provider is
// the one resolveEmailConfig() actually enforces, and nothing the module
// exposes ever carries an env var VALUE — names only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { providerSlugs } from "../../src/lib/email/registry";
import { resolveEmailConfig } from "../../src/lib/email/config";
import {
  envPinNote,
  envPinnedSettings,
  GETTING_STARTED_STEPS,
  GETTING_STARTED_TITLE,
  requiredSecretFor,
  secretPresenceRows,
  setupGuideFor,
  setupGuideSlugs,
  SMTP_FIELDS_IGNORED_NOTE,
  SMTP_FIELDSET_INTRO,
  SMTP_FIELDSET_LEGEND,
  WEBHOOK_SECRET_NOTE,
} from "../../src/lib/email/setupGuide";

test("every registry slug has a setup entry", () => {
  // THE rule: a provider without operator copy cannot ship.
  for (const slug of providerSlugs()) {
    const guide = setupGuideFor(slug);
    assert.ok(guide, `provider "${slug}" has no entry in setupGuide.ts — add its operator copy`);
    assert.ok(guide.steps.length >= 3, `"${slug}" setup has real steps`);
    assert.ok(guide.requiredSecret.length > 0, `"${slug}" names its required env var`);
  }
});

test("no orphan setup entries", () => {
  const registered = new Set(providerSlugs());
  assert.deepEqual(
    setupGuideSlugs().filter((slug) => !registered.has(slug)),
    [],
    "these setupGuide entries match no registered provider — delete them",
  );
});

test("the required env var per slug is the one resolveEmailConfig() enforces", () => {
  assert.equal(requiredSecretFor("smtp2go"), "SMTP2GO_API_KEY");
  assert.equal(requiredSecretFor("sendgrid"), "SENDGRID_API_KEY");
  assert.equal(requiredSecretFor("smtp"), "SMTP_PASSWORD");
  assert.equal(requiredSecretFor("not-a-provider"), undefined);

  // Executable cross-check against config.ts rather than against this
  // module's own copy. For the API providers, a missing key refuses at
  // resolve time with a reason naming the exact variable.
  for (const [slug, envVar] of [
    ["smtp2go", "SMTP2GO_API_KEY"],
    ["sendgrid", "SENDGRID_API_KEY"],
  ] as const) {
    const state = resolveEmailConfig({ EMAIL_PROVIDER: slug, EMAIL_FROM: "ops@msp.example" });
    assert.equal(state.configured, false, `${slug} without its key does not configure`);
    assert.ok(
      !state.configured && state.reason.includes(envVar),
      `${slug} refusal names ${envVar}`,
    );
  }

  // SMTP is the honest exception: resolveEmailConfig refuses on a missing
  // HOST, not a missing password — the password only matters at send time,
  // when a username is set and the server demands login. The copy says so.
  const noHost = resolveEmailConfig({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "ops@msp.example" });
  assert.equal(noHost.configured, false);
  assert.ok(!noHost.configured && noHost.reason.includes("SMTP_HOST"), "smtp refusal names the host");
  const hostNoPassword = resolveEmailConfig({
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM: "ops@msp.example",
    SMTP_HOST: "mail.msp.example",
  });
  assert.equal(hostNoPassword.configured, true, "smtp with a host but no password still resolves");
  const smtpGuide = setupGuideFor("smtp");
  assert.ok(smtpGuide?.blockingNote, "smtp carries the host-vs-password honesty note");
  assert.match(smtpGuide.blockingNote, /Host/i, "the note says the host is what blocks");
  assert.match(smtpGuide.blockingNote, /send time/i, "the note says the password fails at send time");
  assert.ok(smtpGuide.usesSmtpFields, "smtp uses the host/port/username fieldset");
  assert.ok(!setupGuideFor("smtp2go")?.usesSmtpFields, "smtp2go ignores the SMTP fieldset");
  assert.ok(!setupGuideFor("sendgrid")?.usesSmtpFields, "sendgrid ignores the SMTP fieldset");
});

test("the key-presence rows mark required / not-needed / optional per provider", () => {
  for (const slug of providerSlugs()) {
    const rows = secretPresenceRows(slug);
    const required = rows.filter((r) => r.requiredForCurrent);
    assert.equal(required.length, 1, `exactly one key is required for ${slug}`);
    assert.equal(required[0].envVar, requiredSecretFor(slug));
    assert.match(required[0].note, /^required for /);
    for (const row of rows.filter((r) => !r.requiredForCurrent && r.envVar !== "EMAIL_WEBHOOK_SECRET")) {
      assert.match(row.note, /^not needed for /, `${row.envVar} reads as safe to ignore under ${slug}`);
    }
  }
  // The webhook secret is optional for every provider and must say what it
  // actually gates — ingestion, not sending.
  for (const slug of [...providerSlugs(), undefined]) {
    const webhook = secretPresenceRows(slug).find((r) => r.envVar === "EMAIL_WEBHOOK_SECRET");
    assert.ok(webhook, "the webhook secret row is always present");
    assert.equal(webhook.requiredForCurrent, false);
    assert.equal(webhook.note, WEBHOOK_SECRET_NOTE);
  }
  assert.match(WEBHOOK_SECRET_NOTE, /not sending/);
  // No provider chosen yet: nothing is "required for" a choice not made.
  const unchosen = secretPresenceRows(undefined);
  assert.equal(unchosen.filter((r) => r.requiredForCurrent).length, 0);
  for (const row of unchosen.filter((r) => r.envVar !== "EMAIL_WEBHOOK_SECRET")) {
    assert.match(row.note, /^required when the provider is /);
  }
});

test("env-override detection names exactly the vars that pin, values never", () => {
  assert.deepEqual(envPinnedSettings({}), [], "an empty env pins nothing");

  const SENTINEL = "SENTINEL-VALUE-do-not-leak";
  const pinned = envPinnedSettings({
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM: `from-${SENTINEL}@msp.example`,
    SMTP_HOST: `host-${SENTINEL}`,
    SMTP_PORT: "2525",
    SMTP_USERNAME: `user-${SENTINEL}`,
    SMTP_SECURE: "true",
  });
  assert.deepEqual(
    pinned.map((p) => p.envVar).sort(),
    ["EMAIL_FROM", "EMAIL_PROVIDER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USERNAME"],
  );
  // Names and labels only — never a value.
  assert.ok(!JSON.stringify(pinned).includes(SENTINEL), "pin data carries no env values");
  for (const pin of pinned) {
    assert.ok(pin.label.length > 0, `${pin.envVar} has an operator-facing label`);
    assert.ok(!envPinNote(pin.envVar).includes(SENTINEL));
    assert.ok(envPinNote(pin.envVar).includes(pin.envVar), "the note names the pinning var");
    assert.match(envPinNote(pin.envVar), /override/i, "the note says env wins over the saved value");
  }

  // The predicates mirror resolveEmailConfig()'s resolution EXACTLY — each
  // edge below is asserted against config.ts itself, not against our copy.

  // An unparsable SMTP_PORT does NOT win over the DB row…
  const badPort = { EMAIL_PROVIDER: "smtp", EMAIL_FROM: "a@b.c", SMTP_HOST: "h", SMTP_PORT: "not-a-port" };
  const badPortState = resolveEmailConfig(badPort, { smtpPort: 2525 });
  assert.ok(badPortState.configured && badPortState.config.smtp.port === 2525);
  assert.deepEqual(envPinnedSettings(badPort).map((p) => p.envVar).includes("SMTP_PORT"), false);

  // …while SMTP_SECURE="" DOES win (any set value beats the row, even empty).
  const emptySecure = { EMAIL_PROVIDER: "smtp", EMAIL_FROM: "a@b.c", SMTP_HOST: "h", SMTP_SECURE: "" };
  const emptySecureState = resolveEmailConfig(emptySecure, { smtpSecure: true });
  assert.ok(emptySecureState.configured && emptySecureState.config.smtp.secure === false);
  assert.ok(envPinnedSettings(emptySecure).map((p) => p.envVar).includes("SMTP_SECURE"));

  // Whitespace-only EMAIL_FROM does not win, so it is not reported as a pin.
  const blankFrom = { EMAIL_FROM: "   " };
  const blankFromState = resolveEmailConfig({ ...blankFrom, EMAIL_PROVIDER: "smtp", SMTP_HOST: "h" }, { fromAddress: "row@b.c" });
  assert.ok(blankFromState.configured && blankFromState.config.fromAddress === "row@b.c");
  assert.deepEqual(envPinnedSettings(blankFrom), []);
});

test("no module string is value-shaped, and the module never reads the env", () => {
  const exposed: string[] = [
    SMTP_FIELDSET_LEGEND,
    SMTP_FIELDSET_INTRO,
    SMTP_FIELDS_IGNORED_NOTE,
    GETTING_STARTED_TITLE,
    WEBHOOK_SECRET_NOTE,
    ...GETTING_STARTED_STEPS,
    envPinNote("SMTP_HOST"),
  ];
  for (const slug of providerSlugs()) {
    const guide = setupGuideFor(slug);
    assert.ok(guide);
    exposed.push(...guide.steps, guide.requiredSecret, guide.blockingNote ?? "");
    for (const row of secretPresenceRows(slug)) exposed.push(row.envVar, row.note);
  }
  // Provider key shapes, same patterns redact.ts hunts for.
  const valueShaped = [/SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, /api-[A-Za-z0-9]{24,}/, /[A-Za-z0-9+/]{40,}={0,2}/];
  for (const text of exposed) {
    for (const pattern of valueShaped) {
      assert.doesNotMatch(text, pattern, `copy looks value-shaped: ${text}`);
    }
  }

  // Structural: deciding copy must never require a secret's value. The
  // module takes env as a parameter for the NON-secret pins and otherwise
  // has no access at all.
  const source = readFileSync(
    path.join(process.cwd(), "src", "lib", "email", "setupGuide.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /process\.env/, "setupGuide.ts never touches process.env");
});

test("the page renders from the module rather than its own copy", () => {
  // Same stance as the home-page/MODULE_CARDS test: the copy and the page
  // are only one fact if the page reads the module.
  const source = readFileSync(
    path.join(process.cwd(), "src", "app", "settings", "email", "page.tsx"),
    "utf8",
  );
  assert.match(source, /@\/lib\/email\/setupGuide/, "page.tsx imports the setup guide");
  assert.match(source, /secretPresenceRows/, "the key-presence list is data-driven");
  assert.match(source, /envPinnedSettings/, "the env-pin honesty renders");
  assert.doesNotMatch(source, /SMTP only/, "the easy-to-miss legend is gone");
});
