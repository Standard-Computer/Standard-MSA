// Operator session cookie (SHA-3047).
//
// A session is a signed expiry and nothing else — there is one operator, so
// there is no subject to name and no server-side session table to keep. The
// cookie is `v1.<unix expiry>.<HMAC-SHA256>`; the signing key is derived from
// OPERATOR_PASSWORD, which means changing the password invalidates every
// outstanding session for free.
//
// Web Crypto rather than node:crypto throughout, so the same code verifies a
// session in a route handler, a server action and a server component without
// a runtime-specific branch.

/**
 * Cookie name. Host-neutral and boring on purpose: it is also what
 * tests/auth/* assert on and what a self-hoster sees in devtools.
 */
export const OPERATOR_COOKIE = "msa_operator_session";

/** Long enough for a working day, short enough that a borrowed laptop expires. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const VERSION = "v1";
/** Domain separation: the signing key is never the password itself. */
const KEY_INFO = "standard-msa/operator-session/v1";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  // Backed by an explicit ArrayBuffer so the result is a BufferSource
  // crypto.subtle.verify() accepts without a cast.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * HMAC key derived from the password, so the password never signs directly.
 *
 * Callers must have rejected an empty password first: Web Crypto throws
 * DataError on a zero-length HMAC key, and this runs on the refusal path for
 * every operator request, where a throw would be a 500 instead of a 401.
 */
async function signingKey(password: string): Promise<CryptoKey> {
  const fromPassword = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", fromPassword, encoder.encode(KEY_INFO));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Mint a session cookie value valid for `ttlSeconds` from `nowMs`. */
export async function mintSession(
  password: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  // A caller reaching here without a password has a bug: a cookie signed
  // under no key could never be verified, so say so rather than hand back a
  // session that silently never works.
  //
  // Not a secret comparison — it is an emptiness check on a value that has
  // no secret to leak, so the timing rule does not apply. Secrets are
  // compared in equalSecrets() below.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (password === "") throw new TypeError("Cannot mint an operator session with no password.");
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${VERSION}.${expiresAt}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(password),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Is this cookie value a session this instance issued and still honours?
 *
 * The signature is checked BEFORE the expiry, so a caller learns nothing
 * about whether an unsigned guess happened to encode a live timestamp. Any
 * malformed shape is simply false — never a throw, because this runs on the
 * refusal path for every operator request.
 */
export async function verifySession(
  cookieValue: string | null | undefined,
  password: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (typeof cookieValue !== "string" || password === "") return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [version, expiresRaw, signatureRaw] = parts;
  if (version !== VERSION) return false;
  // Bounded digits only: keeps Number() away from "1e999" and "0x10".
  if (!/^[0-9]{1,15}$/.test(expiresRaw)) return false;
  const signature = fromBase64Url(signatureRaw);
  if (signature === null) return false;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(password),
    signature,
    encoder.encode(`${version}.${expiresRaw}`),
  );
  if (!valid) return false;
  return Number(expiresRaw) * 1000 > nowMs;
}

/**
 * Constant-time string equality for secrets.
 *
 * Both sides are hashed under a per-call random salt and the fixed-width
 * digests compared, so the loop length leaks neither the password's length
 * nor the position of the first differing byte — and the digests cannot be
 * precomputed. Used for the login password; session signatures go through
 * `crypto.subtle.verify`, which is constant-time already.
 */
export async function equalSecrets(a: string, b: string): Promise<boolean> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = async (value: string): Promise<Uint8Array> => {
    const bytes = encoder.encode(value);
    const salted = new Uint8Array(salt.length + bytes.length);
    salted.set(salt, 0);
    salted.set(bytes, salt.length);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", salted));
  };
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** One cookie value out of a raw `Cookie:` header. Null when absent. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== "string" || header === "") return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1).trim();
  }
  return null;
}
