// Wizard flows against a real SQLite database (the shipped datastore):
// skip, complete, and re-run-with-changes — the three acceptance-criteria
// flows. Each node:test file runs in its own process, so pointing
// DATABASE_URL at a scratch file BEFORE importing the lib is safe.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const scratch = mkdtempSync(path.join(tmpdir(), "standard-msa-test-"));
process.env.DATABASE_URL = `file:${path.join(scratch, "test.db")}`;

// Apply the real migrations — the test proves the schema the app ships.
execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
});

// Imported lazily (CJS test output forbids top-level await) and AFTER the
// env/migrate setup above, so the Prisma client opens the scratch database.
const lib = () => import("../../src/lib/identity/identity");
const dbMod = () => import("../../src/lib/db");

after(async () => {
  const { prisma } = await dbMod();
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
});

const INPUT = {
  name: "Standard Computer",
  legalName: "Standard Computer LLC",
  address: "123 Main St, Cabot, AR 72023",
  ownerName: "Sean Kubin",
  email: "alerts@standardcomputer.com",
  website: "https://www.standardcomputer.com",
  venueState: "Lonoke County, AR",
  venueCountry: "USA",
};

test("fresh install needs onboarding", async () => {
  const { mspIdentity, needsOnboarding } = await lib();
  assert.equal(await mspIdentity(), null);
  assert.equal(needsOnboarding(null), true);
});

test("skip: records the skip, stops the redirect, saves no values", async () => {
  const { needsOnboarding, skipOnboarding } = await lib();
  const row = await skipOnboarding();
  assert.ok(row.onboardingSkippedAt);
  assert.equal(row.onboardingCompletedAt, null);
  assert.equal(row.name, "");
  assert.equal(needsOnboarding(row), false);
});

test("complete: persists values, composes venue, clears the skip", async () => {
  const { mspIdentity, saveIdentity, toInput } = await lib();
  const { prisma } = await dbMod();
  const { row, changes } = await saveIdentity(INPUT);
  assert.equal(row.legalName, "Standard Computer LLC");
  assert.equal(row.venue, "Lonoke County, AR, USA");
  assert.ok(row.onboardingCompletedAt);
  assert.equal(row.onboardingSkippedAt, null);
  // The skip created the row blank, so every field reports as a change.
  assert.equal(changes.length, 8);

  // Still exactly ONE row — the singleton survived skip-then-complete.
  assert.equal(await prisma.mspIdentity.count(), 1);

  // What the settings page re-reads matches what was saved.
  assert.deepEqual(toInput(await mspIdentity()), INPUT);
});

test("re-run with changes: updates in place and reports only the diff", async () => {
  const { saveIdentity } = await lib();
  const { prisma } = await dbMod();
  const { row, changes } = await saveIdentity({
    ...INPUT,
    venueState: "Pulaski County, AR",
    email: "ops@standardcomputer.com",
  });
  assert.equal(row.venue, "Pulaski County, AR, USA");
  assert.deepEqual(changes.map((c) => c.field).sort(), ["email", "venueState"]);
  const venueChange = changes.find((c) => c.field === "venueState");
  assert.equal(venueChange?.before, "Lonoke County, AR");
  assert.equal(venueChange?.after, "Pulaski County, AR");
  assert.equal(await prisma.mspIdentity.count(), 1);
});

test("re-run with no changes is a clean no-op diff", async () => {
  const { saveIdentity } = await lib();
  const { changes } = await saveIdentity({
    ...INPUT,
    venueState: "Pulaski County, AR",
    email: "ops@standardcomputer.com",
  });
  assert.deepEqual(changes, []);
});

test("skip after completion does not blank a completed row", async () => {
  const { needsOnboarding, skipOnboarding } = await lib();
  const row = await skipOnboarding();
  assert.ok(row.onboardingCompletedAt);
  assert.equal(row.legalName, "Standard Computer LLC");
  assert.equal(needsOnboarding(row), false);
});
