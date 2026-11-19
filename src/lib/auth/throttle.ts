// Login throttle (SHA-3047).
//
// One shared password on a reachable instance is a guessing target, and the
// login form is the only place in this app where an attacker gets an oracle.
// Failures are counted per client IP in memory: a single-container self-host
// (docker-compose.yml) is one process, so a table would buy durability across
// restarts and nothing else — and a restart-to-reset is a far smaller hole
// than an unlimited guess rate.
//
// The decisions are pure functions so they can be tested without a clock.

/** Failures tolerated in a window before the lockout starts. */
export const MAX_FAILURES = 5;
/** How long a locked-out client waits. */
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Failures older than this are forgotten, so an honest typo never accumulates. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Ceiling on tracked clients, so the map cannot be grown without bound. */
export const MAX_TRACKED_CLIENTS = 1024;

export interface AttemptState {
  readonly failures: number;
  /** When the current window started. */
  readonly windowStartedAt: number;
  /** Epoch ms until which this client is refused; 0 when not locked. */
  readonly lockedUntil: number;
}

export const FRESH: AttemptState = { failures: 0, windowStartedAt: 0, lockedUntil: 0 };

/** Milliseconds a client must still wait, or 0 when it may try. */
export function lockoutRemainingMs(state: AttemptState, nowMs: number): number {
  return Math.max(0, state.lockedUntil - nowMs);
}

/** Fold one failed attempt into a client's state. */
export function recordFailure(state: AttemptState, nowMs: number): AttemptState {
  // A lapsed window (or a lapsed lockout) starts the count over rather than
  // adding to a stale total, so the lockout tracks a burst and not a year.
  const stale = state.windowStartedAt === 0 || nowMs - state.windowStartedAt >= FAILURE_WINDOW_MS;
  const base: AttemptState = stale
    ? { failures: 0, windowStartedAt: nowMs, lockedUntil: 0 }
    : state;
  const failures = base.failures + 1;
  return {
    failures,
    windowStartedAt: base.windowStartedAt,
    lockedUntil: failures >= MAX_FAILURES ? nowMs + LOCKOUT_MS : 0,
  };
}

/** True once a state is old enough to drop entirely. */
export function isExpired(state: AttemptState, nowMs: number): boolean {
  return (
    lockoutRemainingMs(state, nowMs) === 0 && nowMs - state.windowStartedAt >= FAILURE_WINDOW_MS
  );
}

// ── Process-local store ─────────────────────────────────────────────────────

const attempts = new Map<string, AttemptState>();

/** A missing IP shares one bucket: unattributable attempts still get counted. */
function key(ip: string | null): string {
  return ip ?? "unknown";
}

function prune(nowMs: number): void {
  for (const [id, state] of attempts) {
    if (isExpired(state, nowMs)) attempts.delete(id);
  }
}

/** How long this client must wait before another attempt is accepted. */
export function throttleRemainingMs(ip: string | null, nowMs: number = Date.now()): number {
  const state = attempts.get(key(ip));
  return state ? lockoutRemainingMs(state, nowMs) : 0;
}

/** Count a failed sign-in, returning the wait it earned (0 if none yet). */
export function noteFailedLogin(ip: string | null, nowMs: number = Date.now()): number {
  prune(nowMs);
  const id = key(ip);
  // Only refuse a NEW client once there is room; an attacker cycling source
  // addresses must never be able to evict a real operator's lockout.
  if (!attempts.has(id) && attempts.size >= MAX_TRACKED_CLIENTS) return 0;
  const next = recordFailure(attempts.get(id) ?? FRESH, nowMs);
  attempts.set(id, next);
  return lockoutRemainingMs(next, nowMs);
}

/** Forget a client's failures — called on a successful sign-in. */
export function clearFailedLogins(ip: string | null): void {
  attempts.delete(key(ip));
}

/** Test seam: drop all tracked state. */
export function resetThrottleForTests(): void {
  attempts.clear();
}
