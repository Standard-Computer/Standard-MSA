// Idempotency keys on POST creates (SHA-2960).
//
// The contract AI callers need: retrying a create with the same
// `Idempotency-Key` returns the FIRST response verbatim instead of a second
// row; reusing a key with a DIFFERENT body is a 409, because silently
// answering with a response to some other request is worse than failing.
//
// Durable (a table, not a map) so a replay works across a restart, plus
// serializeByKey so two simultaneous retries cannot both miss the check and
// both create — the same two-level pattern sendUpdateNotice uses.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { serializeByKey } from "@/lib/serialize";
import { ApiError } from "./errors";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "./schemas";

export { IDEMPOTENCY_KEY_MAX_LENGTH };

export const IDEMPOTENCY_WINDOW_HOURS = 24;

export type StoredResponse = { status: number; body: unknown; replayed: boolean };

export function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null), "utf8").digest("hex");
}

/**
 * Valid Idempotency-Key header value, or null when absent.
 *
 * An oversized key is a typed rejection, not a silent downgrade to "no
 * key": on POST /sends — the call that mails a real recipient — a caller
 * who believes they are replay-protected must never double-send because
 * we quietly dropped their key. The spec pins maxLength 200.
 */
export function idempotencyKeyFrom(headers: Headers): string | null {
  const raw = headers.get("idempotency-key")?.trim() ?? "";
  if (raw === "") return null;
  if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ApiError(
      "validation_failed",
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
      {
        details: [
          {
            path: "Idempotency-Key",
            message: `header is ${raw.length} characters; the maximum is ${IDEMPOTENCY_KEY_MAX_LENGTH}`,
          },
        ],
      },
    );
  }
  return raw;
}

/**
 * Run `execute` under the idempotency contract.
 *
 * No key → just run. With a key: a stored response for (key, endpoint)
 * replays if the body hash matches and 409s if it does not; otherwise
 * `execute` runs and its response is stored for IDEMPOTENCY_WINDOW_HOURS.
 * Only 2xx responses are stored — an error is not an outcome worth pinning
 * a key to, and retrying after a validation fix should re-execute.
 */
export async function withIdempotency(
  apiKeyId: number,
  endpoint: string,
  key: string | null,
  body: unknown,
  execute: () => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  if (!key) {
    const fresh = await execute();
    return { ...fresh, replayed: false };
  }

  return serializeByKey(`idem:${apiKeyId}:${endpoint}:${key}`, async () => {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 3600_000);
    const hash = requestHash(body);
    const stored = await prisma.apiIdempotencyKey.findUnique({
      where: { apiKeyId_endpoint_key: { apiKeyId, endpoint, key } },
    });

    if (stored && stored.createdAt >= cutoff) {
      // Not secret material: both hashes derive from request bodies the
      // caller chose, so comparison timing teaches them nothing.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (stored.requestHash !== hash) {
        throw new ApiError(
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request body.",
        );
      }
      return {
        status: stored.responseStatus,
        body: JSON.parse(stored.responseBody) as unknown,
        replayed: true,
      };
    }
    if (stored) {
      // Expired: the key is reusable; drop the stale row first.
      await prisma.apiIdempotencyKey.delete({ where: { id: stored.id } });
    }

    const fresh = await execute();
    if (fresh.status >= 200 && fresh.status < 300) {
      await prisma.apiIdempotencyKey.create({
        data: {
          apiKeyId,
          endpoint,
          key,
          requestHash: hash,
          responseStatus: fresh.status,
          responseBody: JSON.stringify(fresh.body),
        },
      });
    }
    return { ...fresh, replayed: false };
  });
}
