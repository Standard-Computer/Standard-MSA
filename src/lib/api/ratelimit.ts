// Per-key rate limiting (SHA-2960). PURE core, in-process state.
//
// Token bucket per API key: capacity = one minute's allowance, refilled
// continuously, so a burst up to the per-minute limit is fine and sustained
// load levels out at the limit. In-process state is the honest scope here —
// a self-hosted instance is one node (see serialize.ts for the same
// argument) — and the limiter fails OPEN on restart, which costs one
// bucket's worth of burst, not correctness.

export type RateLimitConfig = {
  /** Sustained requests per minute per key. */
  perMinute: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** Whole tokens left after this request (never negative). */
  remaining: number;
  limit: number;
  /** Seconds until a denied caller should retry. 0 when allowed. */
  retryAfterSeconds: number;
};

type Bucket = { tokens: number; updatedAtMs: number };

const DEFAULT_PER_MINUTE = 120;

export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const raw = Number(env.API_RATE_LIMIT_PER_MINUTE ?? "");
  const perMinute =
    Number.isFinite(raw) && raw >= 1 && raw <= 100_000 ? Math.floor(raw) : DEFAULT_PER_MINUTE;
  return { perMinute };
}

/** PURE decision over one bucket; returns the mutated bucket alongside. */
export function takeToken(
  bucket: Bucket | undefined,
  config: RateLimitConfig,
  nowMs: number,
): { bucket: Bucket; decision: RateLimitDecision } {
  const capacity = config.perMinute;
  const refillPerMs = capacity / 60_000;
  const prev = bucket ?? { tokens: capacity, updatedAtMs: nowMs };
  const elapsed = Math.max(0, nowMs - prev.updatedAtMs);
  const tokens = Math.min(capacity, prev.tokens + elapsed * refillPerMs);

  if (tokens >= 1) {
    const next = { tokens: tokens - 1, updatedAtMs: nowMs };
    return {
      bucket: next,
      decision: {
        allowed: true,
        remaining: Math.floor(next.tokens),
        limit: capacity,
        retryAfterSeconds: 0,
      },
    };
  }
  const deficitMs = (1 - tokens) / refillPerMs;
  return {
    bucket: { tokens, updatedAtMs: nowMs },
    decision: {
      allowed: false,
      remaining: 0,
      limit: capacity,
      retryAfterSeconds: Math.max(1, Math.ceil(deficitMs / 1000)),
    },
  };
}

const buckets = new Map<number, Bucket>();

/** The app-facing check: one token off `apiKeyId`'s bucket. */
export function checkRateLimit(
  apiKeyId: number,
  config: RateLimitConfig = rateLimitConfigFromEnv(),
  nowMs: number = Date.now(),
): RateLimitDecision {
  const { bucket, decision } = takeToken(buckets.get(apiKeyId), config, nowMs);
  buckets.set(apiKeyId, bucket);
  return decision;
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
  };
  if (!decision.allowed) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}

/** Test hook: forget all buckets. */
export function resetRateLimiter(): void {
  buckets.clear();
}
