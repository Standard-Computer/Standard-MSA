"use server";

// Onboarding server actions (SHA-2956). The client wizard validates for UX;
// THIS is the authoritative gate — same pure functions, re-run server-side,
// plus the reachability probe the browser cannot do cross-origin.

import {
  normalizeIdentityInput,
  validateIdentityInput,
  type IdentityFieldErrors,
  type MspIdentityInput,
} from "@/lib/identity/fields";
import { saveIdentity, skipOnboarding } from "@/lib/identity/identity";
import type { IdentityChange } from "@/lib/identity/diff";
import { probeWebsite } from "@/lib/identity/reachability";
import { requireOperator } from "@/lib/auth/page";

// AUTH (SHA-3047): every action here calls requireOperator() first. A server
// action is a POST endpoint on its page's path, so gating the screen alone
// would leave the write reachable by anyone who can derive an action id —
// and this repo is public, so that build is reproducible.

export type SaveIdentityResult =
  | { ok: true; changes: IdentityChange[] }
  | {
      ok: false;
      errors: IdentityFieldErrors;
      /**
       * Set when the ONLY thing wrong is that the website did not answer the
       * probe. The wizard shows it and re-submits with `acceptUnreachable`
       * once the operator explicitly accepts — a site that is down today is a
       * warning to override, not a wall (reachability.ts).
       */
      websiteWarning?: string;
    };

export async function saveIdentityAction(
  input: MspIdentityInput,
  options: { acceptUnreachableWebsite?: boolean } = {},
): Promise<SaveIdentityResult> {
  await requireOperator("/onboarding");
  const next = normalizeIdentityInput(input);

  const errors = validateIdentityInput(next);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (!options.acceptUnreachableWebsite) {
    const probe = await probeWebsite(next.website);
    if (!probe.ok) {
      return {
        ok: false,
        errors: {},
        websiteWarning: `${next.website} ${probe.reason}.`,
      };
    }
  }

  const { changes } = await saveIdentity(next);
  return { ok: true, changes };
}

export async function skipOnboardingAction(): Promise<{ ok: true }> {
  await requireOperator("/onboarding");
  await skipOnboarding();
  return { ok: true };
}
