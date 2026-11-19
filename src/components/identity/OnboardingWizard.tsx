"use client";

// The onboarding wizard (SHA-2956): three short steps of fields, a LIVE
// contract-header preview that re-renders on every keystroke, and an
// explicit confirm step that shows what will change before anything is
// saved. Pure rendering/validation comes from src/lib/identity so this
// component, the server action and the tests cannot disagree.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  IDENTITY_FIELD_LABELS,
  validateIdentityInput,
  type IdentityFieldErrors,
  type MspIdentityInput,
} from "@/lib/identity/fields";
import { renderContractHeader } from "@/lib/identity/headerPreview";
import { identityChanges } from "@/lib/identity/diff";
import type { SaveIdentityResult } from "@/app/onboarding/actions";

type Props = {
  /** Saved values (all "" on a fresh install) — also the diff baseline. */
  initial: MspIdentityInput;
  /** True when the wizard was completed before (settings re-run). */
  rerun: boolean;
  saveAction: (
    input: MspIdentityInput,
    options: { acceptUnreachableWebsite?: boolean },
  ) => Promise<SaveIdentityResult>;
  skipAction: () => Promise<{ ok: true }>;
};

const STEPS = [
  { title: "Who you are", fields: ["name", "legalName", "ownerName"] as const },
  { title: "How to reach you", fields: ["address", "email", "website"] as const },
  { title: "Governing law", fields: ["venueState", "venueCountry"] as const },
  { title: "Preview & confirm", fields: [] as const },
];

const FIELD_HINTS: Partial<Record<keyof MspIdentityInput, string>> = {
  name: "Trading name — what customers call you.",
  legalName: "The legal entity the contract names as the Provider.",
  ownerName: "Signs the agreement for the Provider.",
  address: "Street address for the parties and signature blocks.",
  email: "Where this tool sends you alerts (embed down, acceptances…).",
  website: "Your public site — also where the /legal embed will live.",
  venueState: "State or province your jurisdiction clause names. Yours, not the customer's.",
  venueCountry: "Country for the governing-law line.",
};

export default function OnboardingWizard({ initial, rerun, saveAction, skipAction }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<MspIdentityInput>(initial);
  const [errors, setErrors] = useState<IdentityFieldErrors>({});
  const [websiteWarning, setWebsiteWarning] = useState<string | null>(null);
  const [acceptUnreachable, setAcceptUnreachable] = useState(false);
  const [saved, setSaved] = useState<null | { changes: ReturnType<typeof identityChanges> }>(null);
  const [pending, startTransition] = useTransition();

  const preview = useMemo(() => renderContractHeader(input), [input]);
  const pendingChanges = useMemo(() => identityChanges(initial, input), [initial, input]);

  const set = (field: keyof MspIdentityInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput((prev) => ({ ...prev, [field]: e.target.value }));
    setWebsiteWarning(null);
    setAcceptUnreachable(false);
  };

  function goNext() {
    const all = validateIdentityInput(input);
    const stepErrors: IdentityFieldErrors = {};
    for (const f of STEPS[step].fields) if (all[f]) stepErrors[f] = all[f];
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length === 0) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function confirmSave() {
    const all = validateIdentityInput(input);
    setErrors(all);
    if (Object.keys(all).length > 0) {
      // Jump back to the first step that still has a problem.
      const bad = STEPS.findIndex((s) => s.fields.some((f) => all[f]));
      if (bad >= 0) setStep(bad);
      return;
    }
    startTransition(async () => {
      const result = await saveAction(input, { acceptUnreachableWebsite: acceptUnreachable });
      if (result.ok) {
        setSaved({ changes: result.changes });
        return;
      }
      if (result.websiteWarning) {
        setWebsiteWarning(result.websiteWarning);
        return;
      }
      setErrors(result.errors);
      const bad = STEPS.findIndex((s) => s.fields.some((f) => result.errors[f]));
      if (bad >= 0) setStep(bad);
    });
  }

  function skip() {
    startTransition(async () => {
      await skipAction();
      router.push("/");
      router.refresh();
    });
  }

  if (saved) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-6">
        <h2 className="text-lg font-semibold text-emerald-900">Identity saved</h2>
        {saved.changes.length === 0 ? (
          <p className="mt-2 text-sm text-emerald-800">Nothing changed — the saved values were confirmed as-is.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-emerald-800">What changed:</p>
            <ul className="mt-2 space-y-1 text-sm text-emerald-900">
              {saved.changes.map((c) => (
                <li key={c.field}>
                  <span className="font-medium">{c.label}:</span>{" "}
                  <span className="line-through opacity-60">{c.before || "(blank)"}</span> →{" "}
                  <span>{c.after || "(blank)"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-3 text-sm text-emerald-800">
          Already-published documents are unaffected: identity values merge into documents when they
          are rendered or sent, so future renders use these values and nothing is orphaned.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => {
              router.push("/");
              router.refresh();
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Go to the app
          </button>
          <button
            onClick={() => {
              router.push("/settings/identity");
              router.refresh();
            }}
            className="rounded-md border border-emerald-700 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
          >
            View identity settings
          </button>
        </div>
      </div>
    );
  }

  const isConfirmStep = step === STEPS.length - 1;

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div>
        <ol className="mb-6 flex gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className={`rounded-full px-3 py-1 ${
                i === step ? "bg-slate-900 text-white" : i < step ? "bg-slate-200 text-slate-700" : "bg-slate-100 text-slate-400"
              }`}
            >
              {i + 1}. {s.title}
            </li>
          ))}
        </ol>

        {!isConfirmStep && (
          <div className="space-y-4">
            {STEPS[step].fields.map((field) => (
              <label key={field} className="block">
                <span className="text-sm font-medium">{IDENTITY_FIELD_LABELS[field]}</span>
                <input
                  type="text"
                  value={input[field]}
                  onChange={set(field)}
                  placeholder={FIELD_HINTS[field]}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                />
                {FIELD_HINTS[field] && <span className="mt-1 block text-xs text-slate-500">{FIELD_HINTS[field]}</span>}
                {errors[field] && <span className="mt-1 block text-xs text-red-600">{errors[field]}</span>}
              </label>
            ))}
          </div>
        )}

        {isConfirmStep && (
          <div className="space-y-4">
            {rerun && (
              <div className="rounded-md border border-slate-200 p-4">
                <h3 className="text-sm font-semibold">What will change</h3>
                {pendingChanges.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-600">Nothing — saving confirms the current values.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {pendingChanges.map((c) => (
                      <li key={c.field}>
                        <span className="font-medium">{c.label}:</span>{" "}
                        <span className="line-through opacity-60">{c.before || "(blank)"}</span> →{" "}
                        <span>{c.after || "(blank)"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {preview.missing.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                Still blank (the header shows a labeled blank until filled):{" "}
                {preview.missing.join(", ")}.
              </div>
            )}

            {websiteWarning && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                <p>Website check: {websiteWarning}</p>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={acceptUnreachable}
                    onChange={(e) => setAcceptUnreachable(e.target.checked)}
                  />
                  Save anyway — the URL is right, the site is just not answering.
                </label>
              </div>
            )}

            <button
              onClick={confirmSave}
              disabled={pending || (websiteWarning !== null && !acceptUnreachable)}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Confirm & save"}
            </button>
          </div>
        )}

        <div className="mt-6 flex items-center gap-3">
          {step > 0 && (
            <button onClick={() => setStep((s) => s - 1)} className="text-sm text-slate-600 hover:underline" disabled={pending}>
              ← Back
            </button>
          )}
          {!isConfirmStep && (
            <button
              onClick={goNext}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Next
            </button>
          )}
          {!rerun && (
            <button onClick={skip} disabled={pending} className="ml-auto text-sm text-slate-500 hover:underline">
              Skip for now
            </button>
          )}
        </div>
      </div>

      <aside className="rounded-lg border border-slate-200 bg-slate-50 p-5">
        <h3 className="text-sm font-semibold text-slate-700">Contract header preview</h3>
        <p className="mt-1 text-xs text-slate-500">
          Live — exactly what the header of a generated document will say. Customer details fill in
          per recipient; the effective date is set when a recipient accepts.
        </p>
        <div className="mt-4 space-y-3 font-serif text-sm leading-relaxed text-slate-800">
          <p>{preview.partiesBlock}</p>
          <p>{preview.venueLine}</p>
          <p>{preview.effectiveDateLine}</p>
          <p>{preview.signatureLine}</p>
        </div>
      </aside>
    </div>
  );
}
