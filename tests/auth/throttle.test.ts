// Login throttle (SHA-3047). One shared password means the login form is a
// guessing target, so the counting rules get asserted rather than assumed.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  clearFailedLogins,
  FAILURE_WINDOW_MS,
  FRESH,
  isExpired,
  LOCKOUT_MS,
  lockoutRemainingMs,
  MAX_FAILURES,
  MAX_TRACKED_CLIENTS,
  noteFailedLogin,
  recordFailure,
  resetThrottleForTests,
  throttleRemainingMs,
} from "../../src/lib/auth/throttle";

const NOW = 1_763_500_000_000;

beforeEach(() => resetThrottleForTests());

test("a client is locked out on the MAX_FAILURES-th failure, not before", () => {
  let state = FRESH;
  for (let i = 1; i < MAX_FAILURES; i++) {
    state = recordFailure(state, NOW);
    assert.equal(lockoutRemainingMs(state, NOW), 0, `failure ${i} must not lock`);
  }
  state = recordFailure(state, NOW);
  assert.equal(lockoutRemainingMs(state, NOW), LOCKOUT_MS);
});

test("the lockout runs out, and the wait shrinks as it does", () => {
  let state = FRESH;
  for (let i = 0; i < MAX_FAILURES; i++) state = recordFailure(state, NOW);
  assert.equal(lockoutRemainingMs(state, NOW + LOCKOUT_MS / 2), LOCKOUT_MS / 2);
  assert.equal(lockoutRemainingMs(state, NOW + LOCKOUT_MS), 0);
  assert.equal(lockoutRemainingMs(state, NOW + LOCKOUT_MS + 1), 0);
});

test("failures spread beyond the window never accumulate into a lockout", () => {
  // An honest operator mistyping once a day must never lock themselves out.
  let state = FRESH;
  for (let day = 0; day < 10; day++) {
    state = recordFailure(state, NOW + day * 24 * 60 * 60 * 1000);
    assert.equal(state.failures, 1);
    assert.equal(lockoutRemainingMs(state, NOW + day * 24 * 60 * 60 * 1000), 0);
  }
});

test("the window restarts exactly at FAILURE_WINDOW_MS", () => {
  let state = recordFailure(FRESH, NOW);
  state = recordFailure(state, NOW + FAILURE_WINDOW_MS - 1);
  assert.equal(state.failures, 2, "inside the window the count grows");
  state = recordFailure(state, NOW + FAILURE_WINDOW_MS);
  assert.equal(state.failures, 1, "at the boundary the window restarts");
});

test("state is only droppable once BOTH the lockout and the window have lapsed", () => {
  let state = FRESH;
  for (let i = 0; i < MAX_FAILURES; i++) state = recordFailure(state, NOW);
  assert.equal(isExpired(state, NOW), false, "locked right now");
  // Written against the constants rather than today's values, which happen to
  // be equal: the invariant is "the later of the two", not a number.
  const bothLapsed = Math.max(LOCKOUT_MS, FAILURE_WINDOW_MS);
  assert.equal(isExpired(state, NOW + bothLapsed - 1), false, "one of the two still runs");
  assert.equal(isExpired(state, NOW + bothLapsed), true);
});

test("a lockout earned late in the window is not dropped when the window lapses", () => {
  // The window starts at the FIRST failure, so a burst finishing just before
  // it lapses earns a lockout that outlives it. Pruning on the window alone
  // would hand the attacker their attempts back.
  let state = recordFailure(FRESH, NOW);
  const last = NOW + FAILURE_WINDOW_MS - 1;
  for (let i = 1; i < MAX_FAILURES; i++) state = recordFailure(state, last);
  assert.equal(lockoutRemainingMs(state, last), LOCKOUT_MS, "the burst locked out");
  assert.equal(isExpired(state, NOW + FAILURE_WINDOW_MS), false, "still locked, so still tracked");
  assert.equal(isExpired(state, last + LOCKOUT_MS), true);
});

test("the store locks one client without touching another", () => {
  for (let i = 0; i < MAX_FAILURES; i++) noteFailedLogin("10.0.0.1", NOW);
  assert.equal(throttleRemainingMs("10.0.0.1", NOW), LOCKOUT_MS);
  assert.equal(throttleRemainingMs("10.0.0.2", NOW), 0);
  assert.equal(throttleRemainingMs(null, NOW), 0);
});

test("a successful sign-in forgets the failures before it", () => {
  for (let i = 0; i < MAX_FAILURES - 1; i++) noteFailedLogin("10.0.0.1", NOW);
  clearFailedLogins("10.0.0.1");
  assert.equal(noteFailedLogin("10.0.0.1", NOW), 0, "count restarted from zero");
});

test("attempts with no attributable IP are still counted, in one shared bucket", () => {
  for (let i = 0; i < MAX_FAILURES; i++) noteFailedLogin(null, NOW);
  assert.equal(throttleRemainingMs(null, NOW), LOCKOUT_MS);
});

test("a flood of fresh clients cannot evict a real operator's lockout", () => {
  for (let i = 0; i < MAX_FAILURES; i++) noteFailedLogin("10.0.0.1", NOW);
  assert.equal(throttleRemainingMs("10.0.0.1", NOW), LOCKOUT_MS);
  // Cycle far more source addresses than the map will hold.
  for (let i = 0; i < MAX_TRACKED_CLIENTS + 100; i++) noteFailedLogin(`192.0.2.${i}`, NOW);
  assert.equal(
    throttleRemainingMs("10.0.0.1", NOW),
    LOCKOUT_MS,
    "the tracked lockout survived the flood",
  );
});

test("lapsed entries are pruned, so the map does not grow without bound", () => {
  for (let i = 0; i < 50; i++) noteFailedLogin(`198.51.100.${i}`, NOW);
  // Well past both the lockout and the window: the next call prunes them.
  const later = NOW + LOCKOUT_MS + FAILURE_WINDOW_MS + 1;
  noteFailedLogin("203.0.113.1", later);
  assert.equal(throttleRemainingMs("198.51.100.0", later), 0);
  // And a brand-new client is accepted rather than refused as "full".
  for (let i = 0; i < MAX_FAILURES; i++) noteFailedLogin("203.0.113.2", later);
  assert.equal(throttleRemainingMs("203.0.113.2", later), LOCKOUT_MS);
});
