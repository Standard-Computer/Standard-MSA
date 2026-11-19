// Recipient merge variables and the filled/public render modes (SHA-2959).
//
// The load-bearing test in this file is the last one: public mode must be
// incapable of rendering a recipient value even when one is handed to it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mspValuesFrom } from "../../src/lib/legal/embedAssemble";
import { hasRawTokens, parseVersionDefaults, renderLegalBody } from "../../src/lib/legal/variables";
import { normalizeRecipientInput } from "../../src/lib/sends/fields";
import {
  acceptanceMergeVars,
  parseMergeVars,
  recipientMergeVars,
} from "../../src/lib/sends/merge";

const MSP = mspValuesFrom({
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "1 Main St, Lincoln NE",
  ownerName: "Sean",
  email: "sean@standardcomputer.com",
  website: "https://standardcomputer.com",
  venue: "Nebraska",
});

const BODY =
  "{{msp_name}} agrees with {{client_name}} of {{client_company}} " +
  "at {{client_address}}, contactable at {{client_email}}, " +
  "signed by {{signer_name}} on {{accepted_date}}.";

test("an email-only send produces no recipient values at all", () => {
  const vars = recipientMergeVars(normalizeRecipientInput({ email: "dana@mail.shadowpsa.com" }));
  assert.deepEqual(vars, { client_email: "dana@mail.shadowpsa.com" });
});

test("empty fields are omitted, so the generic wording still applies", () => {
  const vars = recipientMergeVars(
    normalizeRecipientInput({ email: "dana@mail.shadowpsa.com", companyName: "Reyes Dental" }),
  );
  assert.equal(vars.client_name, "Reyes Dental", "a known company names the Client");
  assert.equal("client_address" in vars, false, "an uncaptured field is absent, not empty");

  const filled = renderLegalBody(BODY, "filled", MSP, {}, vars);
  assert.match(filled, /Reyes Dental/);
  assert.match(filled, /the Client's address of record/, "absent field falls back to generic prose");
  assert.ok(!hasRawTokens(filled), "no raw token survives");
  assert.ok(!filled.includes("[unset:"), "a complete agreement shows no holes");
});

test("signer_name does not fall back to a company — a company cannot sign", () => {
  const vars = recipientMergeVars(
    normalizeRecipientInput({ email: "dana@mail.shadowpsa.com", companyName: "Reyes Dental" }),
  );
  assert.equal("signer_name" in vars, false);

  const withPerson = recipientMergeVars(
    normalizeRecipientInput({ email: "dana@mail.shadowpsa.com", fullName: "Dana Reyes" }),
  );
  assert.equal(withPerson.signer_name, "Dana Reyes");
});

test("legal name falls back through company to person, and vice versa", () => {
  const legalOnly = recipientMergeVars(
    normalizeRecipientInput({ email: "d@mail.shadowpsa.com", legalName: "Reyes Dental Group LLC" }),
  );
  assert.equal(legalOnly.client_name, "Reyes Dental Group LLC");
  assert.equal(legalOnly.client_company, "Reyes Dental Group LLC");

  const personOnly = recipientMergeVars(
    normalizeRecipientInput({ email: "d@mail.shadowpsa.com", fullName: "Dana Reyes" }),
  );
  assert.equal(personOnly.client_legal_name, "Dana Reyes");
  assert.equal("client_company" in personOnly, false, "a person is not a company");
});

test("date tokens appear only once accepted", () => {
  assert.deepEqual(acceptanceMergeVars(null), {});
  assert.deepEqual(acceptanceMergeVars(new Date("2026-11-19T10:30:00Z")), {
    accepted_date: "2026-11-19",
    effective_date: "2026-11-19",
  });

  const unaccepted = renderLegalBody(BODY, "filled", MSP, {}, { client_name: "Dana" });
  assert.match(unaccepted, /the date of acceptance/, "an unsigned agreement has no effective date");
});

test("a recipient value beats a version default for the same token", () => {
  const defaults = parseVersionDefaults('{"client_name":"TEMPLATE PLACEHOLDER"}');
  const filled = renderLegalBody(BODY, "filled", MSP, defaults, { client_name: "Dana Reyes" });
  assert.match(filled, /Dana Reyes/);
  assert.ok(!filled.includes("TEMPLATE PLACEHOLDER"), "we now know who this is");
});

test("parseMergeVars survives a corrupt frozen blob", () => {
  assert.deepEqual(parseMergeVars("not json"), {});
  assert.deepEqual(parseMergeVars("[1,2]"), {});
  assert.deepEqual(parseMergeVars('{"client_name":"Dana","n":5}'), { client_name: "Dana" });
  assert.deepEqual(parseMergeVars('{"CLIENT_NAME":"Dana"}'), { client_name: "Dana" });
});

test("PUBLIC mode cannot render a recipient value even when handed one", () => {
  const leak = {
    client_name: "Dana Reyes",
    client_email: "dana@mail.shadowpsa.com",
    client_address: "100 Main St, Springfield IL",
    signer_name: "Dana Reyes",
  };
  const published = renderLegalBody(BODY, "public", MSP, {}, leak);

  for (const value of Object.values(leak)) {
    assert.ok(
      !published.includes(value),
      `public surface leaked a recipient value: ${value}`,
    );
  }
  // It still reads as a complete agreement, in generic prose.
  assert.match(published, /the Client/);
  assert.ok(!hasRawTokens(published));

  // And the same call in filled mode DOES render them — proving the guard is
  // the mode, not a quirk of this body or these values.
  const filled = renderLegalBody(BODY, "filled", MSP, {}, leak);
  for (const value of Object.values(leak)) {
    assert.ok(filled.includes(value), `filled mode must render ${value}`);
  }
});
