// Operator gate for server components and server actions (SHA-3047).
//
// Same decision as ./guard.ts, reached through next/headers because a server
// component has no Request to inspect. Kept in its own file so ./guard.ts
// stays importable outside a request scope — which is what lets the route
// tests call the real handlers.
//
// Every operator page, and every server action behind one, calls
// requireOperator() as its FIRST statement. A server action is a POST
// endpoint on its page's path: gating only the page would leave
// createAndSendAction reachable by anyone who can derive an action id, and
// this repo is public, so the build that fixes those ids is reproducible.

import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { operatorAuth } from "./config";
import { loginUrlFor } from "./guard";
import { OPERATOR_COOKIE, verifySession } from "./session";
import { safeRedirectTarget } from "./surfaces";

/** Is the current request carrying a valid operator session? */
export async function hasOperatorSessionCookie(): Promise<boolean> {
  const state = operatorAuth();
  if (!state.configured) return false;
  const jar = await cookies();
  return verifySession(jar.get(OPERATOR_COOKIE)?.value, state.password);
}

/**
 * Refuse the render unless an operator is signed in.
 *
 * Never returns on the refusal path: `redirect()` throws, so nothing after
 * the call runs and no operator data — above all no send token — reaches the
 * response. `returnTo` is where to come back to after signing in; it is
 * validated, so passing a wrong value can only lose the return trip.
 */
export async function requireOperator(returnTo = "/"): Promise<void> {
  if (await hasOperatorSessionCookie()) return;
  redirect(loginUrlFor(safeRedirectTarget(returnTo, "/")));
}
