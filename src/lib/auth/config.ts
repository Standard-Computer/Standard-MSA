// Operator auth configuration (SHA-3047).
//
// Single-operator model at v0 — one MSP, one shared password, as
// docs/PORT-ASSESSMENT.md § Auth specifies. Secrets are env-only
// (architecture principle 3): there is no password column and no settings
// screen that could store one, so the same shape as resolveEmailConfig()
// applies — an explicit unconfigured state carrying the fix in words.
//
// It FAILS CLOSED. No OPERATOR_PASSWORD means the operator surfaces refuse
// everyone, not that the gate quietly disappears: a security control whose
// absence is indistinguishable from a missing environment variable is the
// bug this lane exists to fix.

type Env = Record<string, string | undefined>;

/**
 * Long enough that the login throttle (./throttle.ts) is not the only thing
 * standing between a public instance and a dictionary. Short, memorable
 * passwords are what a self-hoster reaches for unless something says no.
 */
export const MIN_PASSWORD_LENGTH = 12;

export type OperatorAuthState =
  | { configured: true; password: string }
  | { configured: false; reason: string };

/** Pure resolution from env; unit-testable. */
export function resolveOperatorAuth(env: Env): OperatorAuthState {
  const password = env.OPERATOR_PASSWORD;
  if (password === undefined || password.trim() === "") {
    return {
      configured: false,
      reason:
        "No operator password is set, so the operator screens are closed. Set " +
        "OPERATOR_PASSWORD in this instance's environment to a long random " +
        `value (at least ${MIN_PASSWORD_LENGTH} characters) and restart.`,
    };
  }
  // Untrimmed on purpose: a password is compared verbatim, and silently
  // trimming one here would accept a value the operator never typed.
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      configured: false,
      reason:
        `OPERATOR_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters, so ` +
        "the operator screens stay closed. Set a longer value and restart.",
    };
  }
  return { configured: true, password };
}

/** The live state for this process. */
export function operatorAuth(): OperatorAuthState {
  return resolveOperatorAuth(process.env);
}

/**
 * Should the session cookie carry `Secure`?
 *
 * Keyed off the instance's own configured base URL rather than NODE_ENV: a
 * self-hoster running behind Caddy on https in "production" and a developer
 * on http://localhost both get the right answer, and a Secure cookie on a
 * plain-http install would lock the operator out of their own tool.
 */
export function secureCookies(env: Env = process.env): boolean {
  return (env.APP_BASE_URL ?? "").trim().toLowerCase().startsWith("https://");
}
