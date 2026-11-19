// /settings/identity (SHA-2956): the in-app entry point Sean asked for —
// see the saved identity, the header it produces, and re-run the wizard.

import Link from "next/link";

import { IDENTITY_FIELD_LABELS, type MspIdentityInput } from "@/lib/identity/fields";
import { renderContractHeader } from "@/lib/identity/headerPreview";
import { mspIdentity, needsOnboarding, toInput } from "@/lib/identity/identity";
import { requireOperator } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function IdentitySettingsPage() {
  await requireOperator("/settings/identity");
  const row = await mspIdentity();
  const input = toInput(row);
  const preview = renderContractHeader(input);

  const status = row?.onboardingCompletedAt
    ? `Completed ${row.onboardingCompletedAt.toISOString().slice(0, 10)}`
    : row?.onboardingSkippedAt
      ? "Skipped — the wizard has not been completed"
      : "Not run yet";

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">MSP identity</h1>
        <Link
          href="/onboarding"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {needsOnboarding(row) ? "Run onboarding" : "Re-run onboarding"}
        </Link>
      </div>
      <p className="mt-1 text-sm text-slate-500">Onboarding: {status}</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <dl className="space-y-3">
          {(Object.keys(IDENTITY_FIELD_LABELS) as (keyof MspIdentityInput)[]).map((field) => (
            <div key={field} className="rounded-md border border-slate-200 p-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {IDENTITY_FIELD_LABELS[field]}
              </dt>
              <dd className="mt-1 text-sm">{input[field] || <span className="text-slate-400">(blank)</span>}</dd>
            </div>
          ))}
        </dl>

        <aside className="rounded-lg border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-sm font-semibold text-slate-700">Contract header with these values</h2>
          <div className="mt-4 space-y-3 font-serif text-sm leading-relaxed text-slate-800">
            <p>{preview.partiesBlock}</p>
            <p>{preview.venueLine}</p>
            <p>{preview.effectiveDateLine}</p>
            <p>{preview.signatureLine}</p>
          </div>
          {preview.missing.length > 0 && (
            <p className="mt-4 text-xs text-amber-700">
              Still blank: {preview.missing.join(", ")}. Re-run onboarding to fill them.
            </p>
          )}
        </aside>
      </div>

      <p className="mt-8 max-w-2xl text-xs text-slate-500">
        Changing these values never alters a document that has already been published or sent:
        identity merges into documents at render/send time, so updates apply to future renders only.
      </p>
    </main>
  );
}
