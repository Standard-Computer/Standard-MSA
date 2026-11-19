// serializeByKey — the critical section the notice fan-out and the delivery
// projection both run inside. Pure; no database.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pendingSerializeKeys, serializeByKey } from "../src/lib/serialize";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("work under one key never interleaves, however many callers pile on", async () => {
  const log: string[] = [];
  const critical = (name: string) => async () => {
    log.push(`${name}:enter`);
    await tick();
    await tick();
    log.push(`${name}:exit`);
  };

  // All three started before any of them finished — the real double-click.
  await Promise.all([
    serializeByKey("doc:1", critical("a")),
    serializeByKey("doc:1", critical("b")),
    serializeByKey("doc:1", critical("c")),
  ]);

  assert.deepEqual(log, [
    "a:enter",
    "a:exit",
    "b:enter",
    "b:exit",
    "c:enter",
    "c:exit",
  ]);
});

test("different keys do not block each other", async () => {
  const log: string[] = [];
  const slow = async () => {
    log.push("slow:enter");
    await tick();
    await tick();
    await tick();
    log.push("slow:exit");
  };
  const quick = async () => {
    log.push("quick:enter");
    log.push("quick:exit");
  };

  await Promise.all([serializeByKey("doc:1", slow), serializeByKey("doc:2", quick)]);
  assert.deepEqual(log, ["slow:enter", "quick:enter", "quick:exit", "slow:exit"]);
});

test("a thrower is reported to its own caller and does not poison the queue", async () => {
  const boom = serializeByKey("doc:3", async () => {
    throw new Error("boom");
  });
  const after = serializeByKey("doc:3", async () => "ran anyway");

  await assert.rejects(boom, /boom/);
  assert.equal(await after, "ran anyway", "the next caller must still run");
});

test("the result is the work's own value, and the key is released when idle", async () => {
  assert.equal(pendingSerializeKeys(), 0, "no leftovers from the tests above");

  const inFlight = serializeByKey("doc:4", async () => {
    await tick();
    return 42;
  });
  assert.equal(pendingSerializeKeys(), 1, "an in-flight key is tracked");

  assert.equal(await inFlight, 42);
  await tick();
  assert.equal(pendingSerializeKeys(), 0, "a settled key is dropped, not retained forever");
});
