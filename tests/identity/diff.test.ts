import { test } from "node:test";
import assert from "node:assert/strict";

import { identityChanges } from "../../src/lib/identity/diff";
import { EMPTY_IDENTITY_INPUT } from "../../src/lib/identity/fields";

const BASE = {
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "123 Main St",
  ownerName: "Sean Kubin",
  email: "alerts@standardcomputer.com",
  phone: "555-0100",
  website: "https://www.standardcomputer.com",
  venueState: "Lonoke County, AR",
  venueCountry: "USA",
};

test("identical inputs produce no changes", () => {
  assert.deepEqual(identityChanges(BASE, { ...BASE }), []);
});

test("whitespace-only differences are not changes", () => {
  assert.deepEqual(identityChanges(BASE, { ...BASE, name: "  Standard Computer  " }), []);
});

test("each changed field is reported with label, before and after", () => {
  const changes = identityChanges(BASE, { ...BASE, venueState: "Pulaski County, AR", email: "ops@standardcomputer.com" });
  assert.equal(changes.length, 2);
  const venue = changes.find((c) => c.field === "venueState");
  assert.deepEqual(venue, {
    field: "venueState",
    label: "Venue state/province",
    before: "Lonoke County, AR",
    after: "Pulaski County, AR",
  });
});

test("first run: every filled field reads as blank -> value", () => {
  const changes = identityChanges(EMPTY_IDENTITY_INPUT, BASE);
  assert.equal(changes.length, 9);
  assert.ok(changes.every((c) => c.before === "" && c.after !== ""));
});
