// Request-level operator gate (SHA-3047).
//
// Takes a Request and answers with a refusal or nothing, so a route handler
// guards itself in one line and a test can prove the refusal by calling the
// real handler with a real Request. Nothing here imports next/headers, and
// Prisma only arrives through ./gate.ts's dynamic import on an instance that
// has no OPERATOR_PASSWORD: the gate must be callable from anywhere a
// Request exists.
//
// The companion for server components and server actions — which have no
// Request to hand — is ./page.ts.

import { gateSessionSecret, operatorGate, SETUP_PATH, type OperatorGate } from "./gate";
import { OPERATOR_COOKIE, readCookie, verifySession } from "./session";
import { classifyPath } from "./surfaces";

/** Where an unauthenticated browser is sent. */
export const LOGIN_PATH = "/login";

/** Headers on every refusal: never cached, never framed, never indexed. */
const REFUSAL_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex",
};

/** The login URL to send someone to, preserving where they were going. */
export function loginUrlFor(pathname: string): string {
  // The target is re-validated on the way back out (safeRedirectTarget), so a
  // crafted `next` cannot turn the login form into an open redirect.
  return `${LOGIN_PATH}?next=${encodeURIComponent(pathname)}`;
}

/** Does this cookie header carry a session this instance issued? */
export async function hasOperatorSession(
  cookieHeader: string | null | undefined,
  gate?: OperatorGate,
): Promise<boolean> {
  const secret = gateSessionSecret(gate ?? (await operatorGate()));
  // Not a secret comparison — it is "can anyone sign in on this instance at
  // all", a null check on a value whose contents are never inspected here.
  // The timing rule applies to the signature check below, which goes through
  // crypto.subtle.verify (src/lib/auth/session.ts).
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (secret === null) return false;
  return verifySession(readCookie(cookieHeader, OPERATOR_COOKIE), secret);
}

/**
 * Guard a route handler.
 *
 * Returns the Response to send back, or null when the caller may proceed.
 * Public and machine surfaces return null — they carry their own credential,
 * or deliberately need none (see ./surfaces.ts) — so this is safe to call
 * from anywhere without re-deciding the classification.
 *
 * The refusal bodies are a fixed sentence each. No part of the request, the
 * send, the recipient or the token appears in them: an enumerating caller
 * must not be able to tell a real id from a fabricated one by the refusal.
 */
export async function guardOperatorRequest(req: Request): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const surface = classifyPath(pathname);
  if (surface.kind !== "operator") return null;

  const gate = await operatorGate();

  if (gate.kind === "closed") {
    // Fails closed, and says what to fix. The reason names the env var, never
    // a value (src/lib/auth/config.ts).
    return new Response(`${gate.reason}\n`, {
      status: 503,
      headers: { ...REFUSAL_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (gate.kind === "setup") {
    // Nobody has claimed this instance. A browser is sent to the first-boot
    // screen; a download or API-shaped surface gets a 503, because a 303 to
    // an HTML form is not an answer a non-browser caller can use.
    if (surface.refusal === "redirect") {
      return new Response(null, {
        status: 303,
        headers: { ...REFUSAL_HEADERS, Location: SETUP_PATH },
      });
    }
    return new Response(
      "This instance has no operator password yet. Open it in a browser to set one.\n",
      {
        status: 503,
        headers: { ...REFUSAL_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  if (await hasOperatorSession(req.headers.get("cookie"), gate)) return null;

  if (surface.refusal === "redirect") {
    return new Response(null, {
      status: 303,
      headers: { ...REFUSAL_HEADERS, Location: loginUrlFor(pathname) },
    });
  }
  return new Response("Operator sign-in required.\n", {
    status: 401,
    headers: { ...REFUSAL_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}
