"use server";

// Sign in / sign out (SHA-3047).
//
// Feedback travels as a FIXED `?error=` code rather than this lane's usual
// `?ok=&msg=` free text: everything else in the app reflects a message the
// server composed, but the login screen is reachable by anyone, and a
// message an attacker can put in the URL is a phishing lure on the one page
// where typing a password is the expected thing to do.

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { operatorAuth, secureCookies } from "@/lib/auth/config";
import { equalSecrets, mintSession, OPERATOR_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { safeRedirectTarget } from "@/lib/auth/surfaces";
import { clearFailedLogins, noteFailedLogin, throttleRemainingMs } from "@/lib/auth/throttle";
import { clientIpFrom } from "@/lib/visits/visits";

/** The error codes the login screen knows how to render. */
export type LoginError = "unconfigured" | "invalid" | "throttled" | "missing";

function back(target: string, error: LoginError): never {
  redirect(`/login?next=${encodeURIComponent(target)}&error=${error}`);
}

export async function loginAction(formData: FormData): Promise<void> {
  const target = safeRedirectTarget(formData.get("next"), "/");
  const state = operatorAuth();
  if (!state.configured) back(target, "unconfigured");

  const password = formData.get("password");
  if (typeof password !== "string" || password === "") back(target, "missing");

  const requestHeaders = await headers();
  const ip = clientIpFrom((name) => requestHeaders.get(name));

  // Checked before the comparison, so a locked-out client gets no further
  // signal — and costs no further work — per attempt.
  if (throttleRemainingMs(ip) > 0) back(target, "throttled");

  if (!(await equalSecrets(password, state.password))) {
    noteFailedLogin(ip);
    back(target, "invalid");
  }

  clearFailedLogins(ip);
  const jar = await cookies();
  jar.set(OPERATOR_COOKIE, await mintSession(state.password), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(OPERATOR_COOKIE);
  redirect("/login");
}
