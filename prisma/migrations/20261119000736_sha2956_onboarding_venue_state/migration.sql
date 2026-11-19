-- SHA-2956: onboarding wizard state + venue parts, all add-only.
--
-- venueState/venueCountry are what the wizard collects; the composed line
-- lands in the existing `venue` column (the {venue} merge value, ported
-- shape from ShadowPSA sta9063). The two timestamps make the wizard
-- skippable and re-runnable: neither set -> first visit redirects to
-- /onboarding; completing clears the skip. No UPDATE of existing rows —
-- settings data an admin owns is never overwritten by a migration (the
-- sta9087 posture).

-- AlterTable
ALTER TABLE "MspIdentity" ADD COLUMN "onboardingCompletedAt" DATETIME;
ALTER TABLE "MspIdentity" ADD COLUMN "onboardingSkippedAt" DATETIME;
ALTER TABLE "MspIdentity" ADD COLUMN "venueCountry" TEXT;
ALTER TABLE "MspIdentity" ADD COLUMN "venueState" TEXT;
