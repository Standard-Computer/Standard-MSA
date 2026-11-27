// The resolved operator gate (SHA-4455).
//
// One question — "what stands between this request and the operator screens?"
// — answered from two sources, in a fixed order:
//
//   OPERATOR_PASSWORD set and long enough   -> env      (sign in with it)
//   OPERATOR_PASSWORD set but too short     -> closed   (say so; do NOT fall
//                                                        back, see below)
//   unset, a stored credential exists       -> stored   (sign in with it)
//   unset, no stored credential              -> setup   (first boot)
//   unset, the database cannot be read      -> closed   (fail closed)
//
// The second line is the one worth stating out loud. A too-short
// OPERATOR_PASSWORD means someone deliberately configured this instance and
// got it wrong; reopening the first-boot screen on that instance would let
// the next passer-by claim it. An explicit misconfiguration fails closed.
//
// The fifth line is the same decision for the database: an unreadable
// database is not an unclaimed one (src/lib/auth/credential.ts).
//
// resolveGate() is pure so every line above is a unit test. operatorGate()
// is the live reader.

import { operatorAuth, type OperatorAuthState } from "./config";
import {
  readStoredCredential,
  sessionSecretFor,
  verifyPassword,
  type CredentialRead,
  type StoredCredential,
} from "./credential";

export type OperatorGate =
  /** Env-configured: the classic self-host path. */
  | { kind: "env"; sessionSecret: string; password: string }
  /** A password set through the first-boot screen. */
  | { kind: "stored"; sessionSecret: string; credential: StoredCredential }
  /** Nothing configured anywhere: /setup is open and this instance is unclaimed. */
  | { kind: "setup" }
  /** Configured wrongly, or unknowable. Refuses everyone and says what to fix. */
  | { kind: "closed"; reason: string };

/** Where an unclaimed instance sends a browser. */
export const SETUP_PATH = "/setup";

/**
 * Compose the gate from an env resolution and a credential read.
 *
 * `read` is only consulted when env left the gate unconfigured, so a caller
 * that already knows env is set may pass any read.
 */
export function resolveGate(env: OperatorAuthState, read: CredentialRead): OperatorGate {
  if (env.configured) {
    return { kind: "env", sessionSecret: env.password, password: env.password };
  }
  // An env var that is PRESENT but rejected is a misconfiguration, not an
  // unclaimed instance. config.ts distinguishes the two for us: `provided`.
  if (env.provided) return { kind: "closed", reason: env.reason };
  if (!read.ok) return { kind: "closed", reason: read.reason };
  if (read.credential === null) return { kind: "setup" };
  return {
    kind: "stored",
    sessionSecret: sessionSecretFor(read.credential),
    credential: read.credential,
  };
}

/** The live gate for this request. */
export async function operatorGate(): Promise<OperatorGate> {
  const env = operatorAuth();
  // Short-circuit so an env-configured instance never touches the database,
  // and never needs one to serve its own login screen.
  if (env.configured || env.provided) return resolveGate(env, { ok: true, credential: null });
  return resolveGate(env, await readStoredCredential());
}

/** The secret that signs this instance's sessions, or null when nobody can sign in. */
export function gateSessionSecret(gate: OperatorGate): string | null {
  return gate.kind === "env" || gate.kind === "stored" ? gate.sessionSecret : null;
}

/** Can anyone sign in on this instance right now? */
export function gateAcceptsSignIn(gate: OperatorGate): boolean {
  return gateSessionSecret(gate) !== null;
}

/**
 * May a first-boot claim proceed on this instance right now?
 *
 * True only for `setup` — a claimed, env-configured or unreadable instance all
 * answer false, which is the fail-closed order resolveGate() already fixes.
 *
 * This exists as a NAMED helper rather than an inline `kind !== "setup"` for
 * two reasons, both from the independent review of this lane (SHA-4458):
 *
 *   1. `/setup` is a `public` surface, so it has no requireOperator() call for
 *      tests/auth/coverage.test.ts to match on. This is the thing that plays
 *      that part, and the guardrail matches on this name.
 *   2. It gives the invariant one spelling, so the screen (src/app/setup),
 *      the action and claimOperatorPassword() (./credential.ts) are provably
 *      asking the same question rather than three similar ones.
 */
export async function requireUnclaimed(): Promise<boolean> {
  return (await operatorGate()).kind === "setup";
}

/**
 * Is `submitted` this instance's operator password?
 *
 * False on a gate nobody can sign in through, so a caller cannot accidentally
 * authenticate against an unclaimed or closed instance.
 */
export async function verifyOperatorPassword(
  gate: OperatorGate,
  submitted: string,
): Promise<boolean> {
  if (submitted === "") return false;
  if (gate.kind === "stored") return verifyPassword(submitted, gate.credential);
  if (gate.kind !== "env") return false;
  // Constant-time, and the same comparison the env-only model has always
  // used — imported here rather than reimplemented (src/lib/auth/session.ts).
  const { equalSecrets } = await import("./session");
  return equalSecrets(submitted, gate.password);
}
