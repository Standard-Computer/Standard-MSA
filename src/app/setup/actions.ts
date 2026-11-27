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
import { requireUnclaimed } from "@/lib/auth/gate";
import { mintSession, OPERATOR_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

/** The error codes the setup screen knows how to render. */
export type SetupError =
  /** No password typed. */
  | "missing"
  /** Shorter than MIN_PASSWORD_LENGTH. */
  | "too-short"
  /** The confirmation did not match. */
  | "mismatch"
  /** The write failed. */
  | "unavailable";

/** Where a freshly claimed instance lands: the MSP identity wizard. */
const AFTER_SETUP = "/onboarding";

/**
 * Where a claim lands when this instance is already claimed.
 *
 * NOT back to `/setup`: that screen redirects a non-`setup` gate to `/login`
 * before it renders, so a `?error=` code for this case could never reach a
 * human — it was dead on arrival (SHA-4458 review, non-blocking 1). The real
 * owner of a lost race deserves to be told what happened, so the code travels
 * to the screen they actually land on.
 */
const ALREADY_CLAIMED = "/login?error=already-claimed";

function back(error: SetupError): never {
  redirect(`/setup?error=${error}`);
}

export async function setupAction(formData: FormData): Promise<void> {
  // No requireOperator() here, deliberately, and tests/auth/coverage.test.ts
  // does not ask for one: /setup is a `public` surface because it is where
  // the first operator session is issued. Its gate is requireUnclaimed() —
  // this action does nothing at all unless the instance is unclaimed, and
  // that is the name the guardrail matches on for this file.
  //
  // This is no longer the ONLY thing holding the invariant: since SHA-4458
  // claimOperatorPassword() refuses a claimed instance on its own. This line
  // stays because it is the right place to turn that refusal into a screen.
  if (!(await requireUnclaimed())) redirect(ALREADY_CLAIMED);

  const password = formData.get("password");
  const rejection = checkProposedPassword(password, formData.get("confirmation"));
  // Note the order: validation runs BEFORE the claim, so a mismatched
  // confirmation costs no PBKDF2 derivation. That is why /setup needs no
  // throttle — the only input that reaches the 105 ms hash is a valid
  // password, and a valid password claims the instance on its first use
  // (SHA-4458 review, non-blocking 5).
  if (rejection !== null) back(rejection);
  // Narrowed by checkProposedPassword, which returns "missing" for a non-string.
  const accepted = password as string;

  const outcome = await claimOperatorPassword(accepted);
  if (!outcome.claimed) {
    // "already-set" here means the instance was claimed between the check
    // above and this INSERT — the narrow race the primary key turns into a
    // clean loss rather than an overwrite.
    if (outcome.reason === "already-set") redirect(ALREADY_CLAIMED);
    back("unavailable");
  }

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
