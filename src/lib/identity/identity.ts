// MspIdentity persistence (SHA-2956). The ONLY writer of the singleton row,
// and — per docs/ARCHITECTURE.md's cross-lane contracts — the only source
// other lanes read brand/venue values from.

import type { MspIdentity, PrismaClient } from "@prisma/client";

import { prisma } from "../db";
import { composeVenue, normalizeIdentityInput, type MspIdentityInput } from "./fields";
import { identityChanges, type IdentityChange } from "./diff";

/** The singleton row, or null before first save/skip. Callers get the whole
 *  row; `toInput` below is the bridge back into wizard/diff shape. */
export async function mspIdentity(db: PrismaClient = prisma): Promise<MspIdentity | null> {
  return db.mspIdentity.findFirst({ orderBy: { id: "asc" } });
}

/** First visit goes to /onboarding until the wizard was completed OR
 *  deliberately skipped. Pure, so the redirect logic is testable. */
export function needsOnboarding(row: MspIdentity | null): boolean {
  return !row || (!row.onboardingCompletedAt && !row.onboardingSkippedAt);
}

/** Saved row → wizard input shape (nullable columns become ""). */
export function toInput(row: MspIdentity | null): MspIdentityInput {
  return {
    name: row?.name ?? "",
    legalName: row?.legalName ?? "",
    address: row?.address ?? "",
    ownerName: row?.ownerName ?? "",
    email: row?.email ?? "",
    phone: row?.phone ?? "",
    website: row?.website ?? "",
    venueState: row?.venueState ?? "",
    venueCountry: row?.venueCountry ?? "",
  };
}

/**
 * Save a confirmed wizard submission: update the singleton (never a second
 * row), compose the venue line, stamp completion, clear any earlier skip.
 *
 * Returns the changes relative to what was stored before, so the caller can
 * echo "what changed" after a re-run. Published documents are untouched by
 * design: they merge identity values at render/send time (SHA-2957/2959),
 * so updating the row re-points future renders and orphans nothing.
 */
export async function saveIdentity(
  input: MspIdentityInput,
  db: PrismaClient = prisma,
): Promise<{ row: MspIdentity; changes: IdentityChange[] }> {
  const next = normalizeIdentityInput(input);
  const existing = await mspIdentity(db);
  const changes = identityChanges(toInput(existing), next);

  const data = {
    name: next.name,
    legalName: next.legalName,
    address: next.address || null,
    ownerName: next.ownerName || null,
    email: next.email,
    // Optional column, like `address`: "" is stored as NULL so an empty
    // phone is absent rather than an empty string the intro would have to
    // special-case.
    phone: next.phone || null,
    website: next.website,
    venueState: next.venueState,
    venueCountry: next.venueCountry,
    venue: composeVenue(next.venueState, next.venueCountry),
    onboardingCompletedAt: new Date(),
    onboardingSkippedAt: null,
  };

  const row = existing
    ? await db.mspIdentity.update({ where: { id: existing.id }, data })
    : await db.mspIdentity.create({ data });

  return { row, changes };
}

/**
 * Record a deliberate skip so the first-visit redirect stops looping. Keeps
 * whatever values already exist (skipping a RE-run must not blank a
 * completed row — completion wins, so a skip after completion is a no-op).
 */
export async function skipOnboarding(db: PrismaClient = prisma): Promise<MspIdentity> {
  const existing = await mspIdentity(db);
  if (existing) {
    if (existing.onboardingCompletedAt) return existing;
    return db.mspIdentity.update({
      where: { id: existing.id },
      data: { onboardingSkippedAt: new Date() },
    });
  }
  return db.mspIdentity.create({
    data: { name: "", onboardingSkippedAt: new Date() },
  });
}
