import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MIN_PASSWORD_LENGTH } from "@/lib/auth/config";
import { operatorGate } from "@/lib/auth/gate";
import { setupAction, type SetupError } from "./actions";

// First boot (SHA-4455). The one screen that exists so a one-click deploy can
// be claimed by the person who deployed it: no default password ships, so
// there is nothing to leave unchanged.
//
// It shows itself only while this instance is unclaimed. Once a credential
// exists — or OPERATOR_PASSWORD is set — this redirects to /login, and the
// action behind it refuses regardless of what the browser was shown.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up · Standard-MSA",
  robots: { index: false, follow: false },
};

const ERRORS: Record<SetupError, string> = {
  missing: "Type a password.",
  "too-short": `That password is shorter than ${MIN_PASSWORD_LENGTH} characters.`,
  mismatch: "The two passwords do not match.",
  "already-set": "This instance already has an operator password. Sign in instead.",
  unavailable: "This instance could not save the password. Check its logs and try again.",
};

function isSetupError(value: unknown): value is SetupError {
  return typeof value === "string" && value in ERRORS;
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const gate = await operatorGate();
  // Claimed, env-configured or closed: there is no first boot to do. Sending
  // them to /login tells them nothing they could not learn by visiting it.
  if (gate.kind !== "setup") redirect("/login");

  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Standard-MSA</h1>
      <p className="mt-2 text-slate-600">
        Set the operator password for this instance. This is the first and only time this
        screen appears.
      </p>

      {isSetupError(error) ? (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {ERRORS[error]}
        </p>
      ) : null}

      <form action={setupAction} className="mt-6 space-y-4">
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Operator password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={MIN_PASSWORD_LENGTH}
            className="mt-1 w-full rounded border border-slate-300 p-2"
          />
          <p className="mt-1 text-xs text-slate-500">
            At least {MIN_PASSWORD_LENGTH} characters. Use a long random value from a password
            manager — this one password opens every operator screen on this instance.
          </p>
        </div>
        <div>
          <label htmlFor="confirmation" className="block text-sm font-medium">
            Confirm password
          </label>
          <input
            id="confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            className="mt-1 w-full rounded border border-slate-300 p-2"
          />
        </div>
        <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          Set password and continue
        </button>
      </form>

      <p className="mt-8 text-xs text-slate-500">
        Nobody can sign in to this instance until this is done, and whoever reaches this screen
        first sets the password — so do it now, before sharing the URL. Recipients&apos; own
        agreement links and the public <code>/legal</code> site are unaffected either way.
      </p>
      <p className="mt-3 text-xs text-slate-500">
        Prefer to keep the secret out of the database? Set <code>OPERATOR_PASSWORD</code> in this
        instance&apos;s environment instead and restart; an environment value always wins over a
        password set here.
      </p>
    </main>
  );
}
