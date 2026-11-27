// The stored operator credential, set once at first boot (SHA-4455).
//
// Until this lane the operator password was env-only (src/lib/auth/config.ts),
// which is the right default for a self-hoster who owns the shell: the secret
// never touches the database and a restart is the rotation mechanism. It does
// not survive one-click deployment. A template deploy hands the operator a URL
// and nothing else, so an env-only gate gives them an instance that refuses
// them and a 503 telling them to go set a variable they have no reason to
// expect — and the obvious shortcut, shipping a default password in the
// template, is exactly the thing a public legal-document tool must never do.
//
// So: a password set through a first-boot screen, hashed, in the database.
// Three properties keep it from weakening the env-only model:
//
//   1. Env WINS. With OPERATOR_PASSWORD set, nothing here is consulted — the
//      self-hoster's install behaves exactly as before, and an operator who
//      loses the stored password recovers by setting the env var.
//   2. The setup screen is only open while there is NO credential at all, and
//      the claim is a single INSERT on a fixed primary key, so "first boot"
//      is enforced by the database rather than by a check-then-write race.
//   3. The plaintext is never stored and never signs a session. What is
//      stored is a PBKDF2-SHA256 derivation; the session signing secret is
//      derived from the stored record, so changing the password invalidates
//      every outstanding session for free — the same property the env model
//      gets from restarting (src/lib/auth/session.ts).
//
// Web Crypto throughout, like session.ts, so the same code runs in a route
// handler, a server action and a server component with no runtime branch.
// Prisma is imported DYNAMICALLY, inside the functions that need it: the gate
// runs on every operator request, and an env-configured instance must not
// drag the client (or a DATABASE_URL requirement) into that path at all.

import { MIN_PASSWORD_LENGTH } from "./config";

/** The only derivation this app writes. Stored per-row so a future bump can read old rows. */
export const PBKDF2_ALGORITHM = "pbkdf2-sha256";

/**
 * OWASP's PBKDF2-SHA256 floor (600k, 2023). Deliberately slow: this runs once
 * per sign-in, on a single-operator tool, behind a 5-attempt lockout
 * (./throttle.ts) — so the cost lands on an attacker's dictionary and is
 * invisible to the one human who signs in twice a day.
 */
export const PBKDF2_ITERATIONS = 600_000;

/** 128-bit salt, per record. */
const SALT_BYTES = 16;
/** 256-bit derived key, matching the SHA-256 hash it is built from. */
const DERIVED_BITS = 256;

/** A credential as it is stored. No plaintext, by construction. */
export interface StoredCredential {
  readonly algorithm: string;
  readonly iterations: number;
  /** base64url. */
  readonly salt: string;
  /** base64url of the derived bits. */
  readonly hash: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveBits(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

/** Hash a password into a storable record. */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<StoredCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const bits = await deriveBits(password, salt, iterations);
  return {
    algorithm: PBKDF2_ALGORITHM,
    iterations,
    salt: toBase64Url(salt),
    hash: toBase64Url(bits),
  };
}

/**
 * Does `password` match this stored credential?
 *
 * Both sides are fixed-width derived keys, so the comparison loop leaks
 * neither a length nor the position of the first differing byte. An
 * unreadable or unknown record is false, never a throw: this is the refusal
 * path for a sign-in attempt.
 */
export async function verifyPassword(
  password: string,
  stored: StoredCredential,
): Promise<boolean> {
  if (stored.algorithm !== PBKDF2_ALGORITHM) return false;
  if (!Number.isInteger(stored.iterations) || stored.iterations < 1) return false;
  const salt = fromBase64Url(stored.salt);
  const expected = fromBase64Url(stored.hash);
  if (salt === null || expected === null) return false;
  if (expected.length !== DERIVED_BITS / 8) return false;

  const actual = await deriveBits(password, salt, stored.iterations);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/**
 * The session signing secret for a stored credential.
 *
 * Built from the whole record rather than the hash alone so that re-deriving
 * the same password under a new salt — which is what any future password
 * change does — produces a different secret and invalidates outstanding
 * sessions. Never the plaintext: the plaintext is not available here, which
 * is the point.
 */
export function sessionSecretFor(stored: StoredCredential): string {
  return `${stored.algorithm}.${stored.iterations}.${stored.salt}.${stored.hash}`;
}

/** Why a proposed first-boot password was refused, in words for the screen. */
export type PasswordRejection = "too-short" | "mismatch" | "missing";

/** Validate a proposed password. Pure; the screen and the action share it. */
export function checkProposedPassword(
  password: unknown,
  confirmation: unknown,
): PasswordRejection | null {
  if (typeof password !== "string" || password === "") return "missing";
  // Untrimmed, like resolveOperatorAuth(): a password is compared verbatim,
  // and trimming one here would store a value nobody typed.
  if (password.length < MIN_PASSWORD_LENGTH) return "too-short";
  if (typeof confirmation !== "string" || confirmation !== password) return "mismatch";
  return null;
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * The single row's primary key.
 *
 * One operator per instance (docs/PORT-ASSESSMENT.md § Auth), so the table
 * holds at most one row and its key is a constant. That is what makes the
 * first-boot claim atomic: the second INSERT violates the primary key instead
 * of racing a SELECT.
 */
export const CREDENTIAL_ROW_ID = 1;

/** Prisma's unique-constraint code. */
const UNIQUE_VIOLATION = "P2002";

async function client() {
  // Dynamic: see the header note. An env-configured instance never gets here.
  const { prisma } = await import("@/lib/db");
  return prisma;
}

/** What a read of the stored credential can tell us. */
export type CredentialRead =
  | { ok: true; credential: StoredCredential | null }
  /** The database could not be consulted — treated as closed, never as "no credential". */
  | { ok: false; reason: string };

/**
 * Read the stored credential, if any.
 *
 * A failed read is reported as a failure rather than as absence. The
 * difference matters: absence opens the first-boot screen, so a database that
 * is merely unreachable must not be able to reopen it on an instance that is
 * already claimed.
 */
export async function readStoredCredential(): Promise<CredentialRead> {
  try {
    const prisma = await client();
    const row = await prisma.operatorCredential.findUnique({
      where: { id: CREDENTIAL_ROW_ID },
    });
    if (row === null) return { ok: true, credential: null };
    return {
      ok: true,
      credential: {
        algorithm: row.algorithm,
        iterations: row.iterations,
        salt: row.salt,
        hash: row.hash,
      },
    };
  } catch {
    // No detail: this value reaches a 503 body on a public URL.
    return {
      ok: false,
      reason:
        "This instance cannot read its own database, so the operator screens " +
        "stay closed. Check DATABASE_URL and that migrations have been applied.",
    };
  }
}

/** The outcome of a first-boot claim. */
export type ClaimOutcome =
  | { claimed: true; credential: StoredCredential }
  /** Someone (or some other replica) got there first. */
  | { claimed: false; reason: "already-set" }
  | { claimed: false; reason: "write-failed" };

/**
 * Claim this instance by storing the first operator password.
 *
 * Succeeds at most once per database. The caller must still have validated
 * the password (checkProposedPassword) — this function enforces the
 * once-only property, not the policy.
 */
export async function claimOperatorPassword(password: string): Promise<ClaimOutcome> {
  const credential = await hashPassword(password);
  try {
    const prisma = await client();
    await prisma.operatorCredential.create({
      data: { id: CREDENTIAL_ROW_ID, ...credential },
    });
    return { claimed: true, credential };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === UNIQUE_VIOLATION) return { claimed: false, reason: "already-set" };
    return { claimed: false, reason: "write-failed" };
  }
}
