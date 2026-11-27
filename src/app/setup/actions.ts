"use server";

// First boot: claim this instance (SHA-4455).
//
// Like the login screen, feedback travels as a FIXED `?error=` code rather
// than free text — this page is reachable by anyone and is a page where
// typing a password is the expected thing to do, so a message an attacker can
// put in the URL is a phishing lure (src/app/login/actions.ts).
//
// The gate is re-resolved HERE rather than trusted from the render: a server
// action is a POST endpoint on its page's path, so "the form was shown"
// proves nothing about the state of the instance when the POST lands.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { secureCookies } from "@/lib/auth/config";
import {
  checkProposedPassword,
  claimOperatorPassword,
  sessionSecretFor,
} from "@/lib/auth/credential";
import { operatorGate } from "@/lib/auth/gate";
import { mintSession, OPERATOR_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

/** The error codes the setup screen knows how to render. */
export type SetupError =
  /** No password typed. */
  | "missing"
  /** Shorter than MIN_PASSWORD_LENGTH. */
  | "too-short"
  /** The confirmation did not match. */
  | "mismatch"
  /** Someone claimed this instance first — including a second replica. */
  | "already-set"
  /** The write failed, or this instance is env-configured / closed. */
  | "unavailable";

/** Where a freshly claimed instance lands: the MSP identity wizard. */
const AFTER_SETUP = "/onboarding";

function back(error: SetupError): never {
  redirect(`/setup?error=${error}`);
}

export async function setupAction(formData: FormData): Promise<void> {
  // No requireOperator() here, deliberately, and tests/auth/coverage.test.ts
  // does not ask for one: /setup is a `public` surface because it is where
  // the first operator session is issued. Its gate is the clause below —
  // this action does nothing at all unless the instance is unclaimed.
  if ((await operatorGate()).kind !== "setup") back("already-set");

  const password = formData.get("password");
  const rejection = checkProposedPassword(password, formData.get("confirmation"));
  if (rejection !== null) back(rejection);
  // Narrowed by checkProposedPassword, which returns "missing" for a non-string.
  const accepted = password as string;

  const outcome = await claimOperatorPassword(accepted);
  if (!outcome.claimed) back(outcome.reason === "already-set" ? "already-set" : "unavailable");

  // Sign the new operator in straight away: they just proved they hold the
  // password by choosing it, and bouncing them to /login to retype it is a
  // step that teaches nothing and loses people on a first run.
  const jar = await cookies();
  jar.set(OPERATOR_COOKIE, await mintSession(sessionSecretFor(outcome.credential)), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(AFTER_SETUP);
}
