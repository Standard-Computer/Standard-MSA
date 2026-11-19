// /onboarding (SHA-2956): first-run wizard, also the settings "re-run" target.

import OnboardingWizard from "@/components/identity/OnboardingWizard";
import { mspIdentity, toInput } from "@/lib/identity/identity";
import { saveIdentityAction, skipOnboardingAction } from "./actions";

// Reads the database on every request; must never be prerendered at build.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const row = await mspIdentity();
  const rerun = !!row?.onboardingCompletedAt;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-2xl font-semibold">{rerun ? "Update your MSP identity" : "Welcome — set up your MSP identity"}</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        {rerun
          ? "Re-running onboarding updates the saved values. You will see exactly what changes before anything is saved, and already-published documents are unaffected."
          : "These values fill the header of every contract this tool generates: the parties block, the governing-law line, and the signature block. You can skip for now and re-run this any time from Settings."}
      </p>
      <div className="mt-8">
        <OnboardingWizard
          initial={toInput(row)}
          rerun={rerun}
          saveAction={saveIdentityAction}
          skipAction={skipOnboardingAction}
        />
      </div>
    </main>
  );
}
