// In-process serialisation by key (SHA-3030 review follow-up). PURE.
//
// Two requests can land on the same row in the same instant — two tabs
// reloading a send, a double-clicked submit — and several paths in this app
// are check-then-write sequences that cannot be made atomic in the database
// without a schema change. So the check and the write run inside one
// critical section per key, and concurrent callers for that key queue.
//
// Honest about what this is: a single-process guard, which is the whole of a
// self-hosted single-node deploy and nothing beyond it. It is the SECOND
// line of defence, never the only one — every caller here also re-reads its
// dedup set inside the section and keeps a durable record of what it did, so
// correctness survives a restart mid-flight and this only removes the race.

/** The tail of each key's queue. Absent means nothing is in flight. */
const chains = new Map<string, Promise<void>>();

/**
 * Run `work` after any work already queued under `key` has settled.
 *
 * Rejections propagate to the caller that asked for the work and to nobody
 * else: the queue's own copy of the promise is neutralised, so one caller
 * throwing never cancels or rejects the callers queued behind it.
 */
export function serializeByKey<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    // Drop the key once this is the last entry, so the map does not grow one
    // permanent entry per send id for the life of the process.
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}

/** How many keys currently have work queued. Test + leak guard. */
export function pendingSerializeKeys(): number {
  return chains.size;
}
