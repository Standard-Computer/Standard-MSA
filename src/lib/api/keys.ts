// API keys (SHA-2960): generation, verification, scopes.
//
// The key is the WHOLE credential: `smsa_` + 43 chars of base64url (32 CSPRNG
// bytes, same strength as a send token). Lookup is by SHA-256 of the full
// string — the plaintext exists only in the create response and is never
// stored, logged, or reconstructible. There is no shipped or default key:
// zero rows means the API answers 401 to everything, which is the secure
// state a fresh install boots into.
//
// No `server-only` marker, matching the other DB modules in this repo — the
// DB-backed tests import this under plain node.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKey } from "@prisma/client";
import { prisma } from "@/lib/db";
import { API_SCOPES, isApiScope, type ApiScope } from "./scopes";

export const API_KEY_PREFIX = "smsa_";

export { API_SCOPES, isApiScope, type ApiScope };

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Shape gate so garbage never costs a hash + query. */
export function isApiKeyShape(raw: unknown): raw is string {
  return typeof raw === "string" && /^smsa_[A-Za-z0-9_-]{40,60}$/.test(raw);
}

export type CreatedApiKey = {
  /** Shown ONCE. Never stored. */
  plaintext: string;
  record: ApiKey;
};

export async function createApiKey(name: string, scopes: ApiScope[]): Promise<CreatedApiKey> {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record = await prisma.apiKey.create({
    data: {
      name: name.trim() || "Unnamed integration",
      keyHash: hashApiKey(plaintext),
      prefix: `${plaintext.slice(0, 13)}…`,
      scopesJson: JSON.stringify(scopes),
    },
  });
  return { plaintext, record };
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const row = await prisma.apiKey.findUnique({ where: { id } });
  if (!row || row.revokedAt) return false;
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  return true;
}

/** The scopes a key row grants. Empty stored list = every scope. */
export function keyScopes(row: Pick<ApiKey, "scopesJson">): ApiScope[] {
  try {
    const parsed: unknown = JSON.parse(row.scopesJson);
    if (Array.isArray(parsed)) {
      const scopes = parsed.filter(isApiScope);
      if (scopes.length > 0) return scopes;
    }
  } catch {
    // Fall through: an unreadable scope list grants everything rather than
    // bricking the key — the column ships "[]" (= all) by default.
  }
  return [...API_SCOPES];
}

export function keyHasScope(row: Pick<ApiKey, "scopesJson">, scope: ApiScope): boolean {
  return keyScopes(row).includes(scope);
}

/**
 * Resolve a Bearer credential to a live key row, or null.
 *
 * The hash lookup is already non-equal-length-safe, but compare hashes
 * timing-safely anyway: it costs nothing and removes the question.
 */
export async function authenticateApiKey(authorization: string | null): Promise<ApiKey | null> {
  const supplied = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!isApiKeyShape(supplied)) return null;
  const suppliedHash = hashApiKey(supplied);
  const row = await prisma.apiKey.findUnique({ where: { keyHash: suppliedHash } });
  if (!row || row.revokedAt) return null;
  const a = Buffer.from(suppliedHash, "hex");
  const b = Buffer.from(row.keyHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}
