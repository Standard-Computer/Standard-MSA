import { test } from "node:test";
import assert from "node:assert/strict";

import { renderContractHeader, CUSTOMER_GENERIC } from "../../src/lib/identity/headerPreview";

const FULL = {
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "123 Main St, Cabot, AR 72023",
  ownerName: "Sean Kubin",
  venueState: "Lonoke County, AR",
  venueCountry: "USA",
};

test("filled values render into the header verbatim", () => {
  const h = renderContractHeader(FULL);
  assert.match(h.partiesBlock, /Standard Computer LLC, d\/b\/a Standard Computer/);
  assert.match(h.partiesBlock, /of 123 Main St, Cabot, AR 72023 \("Provider"\)/);
  assert.match(h.venueLine, /the courts of Lonoke County, AR, USA\./);
  assert.match(h.signatureLine, /Signed for the Provider by Sean Kubin/);
  assert.deepEqual(h.missing, []);
});

test("customer side renders the ported generic prose, never a value", () => {
  const h = renderContractHeader(FULL);
  assert.ok(h.partiesBlock.includes(CUSTOMER_GENERIC.legalName));
  assert.ok(h.partiesBlock.includes(CUSTOMER_GENERIC.address));
  assert.ok(h.signatureLine.includes(CUSTOMER_GENERIC.signerName));
});

test("effective date resolves per-send: preview reads 'Date of acceptance'", () => {
  const h = renderContractHeader(FULL);
  assert.equal(h.effectiveDateLine, "Effective date: Date of acceptance.");
});

test("missing values render labeled blanks and are listed, not hidden", () => {
  const h = renderContractHeader({ ...FULL, legalName: "", address: "", ownerName: "", venueState: "", venueCountry: "" });
  assert.match(h.partiesBlock, /\[MSP legal name\]/);
  assert.match(h.partiesBlock, /\[MSP address\]/);
  assert.match(h.venueLine, /\[Venue\]/);
  assert.match(h.signatureLine, /\[Owner \/ CEO\]/);
  assert.deepEqual(h.missing.sort(), ["MSP address", "MSP legal name", "Owner / CEO", "Venue"].sort());
});

test("d/b/a vanishes when it adds nothing (ported client_dba posture)", () => {
  const same = renderContractHeader({ ...FULL, name: "Standard Computer LLC" });
  assert.doesNotMatch(same.partiesBlock, /d\/b\/a/);
  const blank = renderContractHeader({ ...FULL, name: "" });
  assert.doesNotMatch(blank.partiesBlock, /d\/b\/a/);
});

test("a partial venue still renders what exists", () => {
  const h = renderContractHeader({ ...FULL, venueCountry: "" });
  assert.match(h.venueLine, /the courts of Lonoke County, AR\./);
  assert.deepEqual(h.missing, []);
});
