import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MIN_PASSWORD_LENGTH } from "@/lib/auth/config";
import { operatorGate, SETUP_PATH } from "@/lib/auth/gate";
import { hasOperatorSessionCookie } from "@/lib/auth/page";
import { safeRedirectTarget } from "@/lib/auth/surfaces";
import { loginAction, logoutAction, type LoginError } from "./actions";

// Operator sign-in (SHA-3047). Public by design — it is the one screen a
// stranger is allowed to reach, and it renders no operator data: no send, no
// recipient, no token, and no hint about whether this instance has any.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · Standard-MSA",
  robots: { index: false, follow: false },
};

const ERRORS: Record<LoginError, string> = {
  // Deliberately identical for a wrong password and a missing one: the form
  // is not a place to learn what this instance expects.
  invalid: "That password is not correct.",
  missing: "That password is not correct.",
  throttled: "Too many attempts. Wait a few minutes and try again.",
  unconfigured: "This instance has no operator password set.",
  "already-claimed":
    "This instance already has an operator password — someone completed first-boot " +
    "setup before you did. Sign in with it, or redeploy if that was not you.",
};

function isLoginError(value: unknown): value is LoginError {
  return typeof value === "string" && value in ERRORS;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeRedirectTarget(next, "/");
  const gate = await operatorGate();
  // An unclaimed instance has no password to type yet (SHA-4455).
  if (gate.kind === "setup") redirect(SETUP_PATH);
  const signedIn = await hasOperatorSessionCookie();

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Standard-MSA</h1>

      {gate.kind === "closed" ? (
        <>
          <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {gate.reason}
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Until it is fixed, every operator screen stays closed. A long random value of at
            least {MIN_PASSWORD_LENGTH} characters is what this expects; the recipients&apos;
            own agreement links are unaffected.
          </p>
        </>
      ) : signedIn ? (
        <>
          <p className="mt-4 text-slate-600">You are signed in.</p>
          <div className="mt-6 flex items-center gap-3">
            <a href={target} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
              Continue
            </a>
            <form action={logoutAction}>
              <button type="submit" className="rounded border border-slate-300 px-3 py-2 text-sm">
                Sign out
              </button>
            </form>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-slate-600">Operator sign-in.</p>
          {isLoginError(error) ? (
            <p className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              {ERRORS[error]}
            </p>
          ) : null}
          <form action={loginAction} className="mt-6 space-y-4">
            <input type="hidden" name="next" value={target} />
            <div>
              <label htmlFor="password" className="block text-sm font-medium">
                Operator password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                className="mt-1 w-full rounded border border-slate-300 p-2"
              />
            </div>
            <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
              Sign in
            </button>
          </form>
        </>
      )}
    </main>
  );
}
