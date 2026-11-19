// Update-notice audience resolution and candidate detection (SHA-2959).
//
// The load-bearing test here is the intersection guard: a posted recipient
// id is request input, and without the intersection a crafted or stale form
// could mail an agreement update to somebody who never received it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isNoticeAudience,
  noticeCandidates,
  parseSelectedRecipientIds,
  resolveAudience,
  type DocumentHead,
  type SendRow,
} from "../../src/lib/sends/audience";

const PRIOR = [
  { recipientId: 1, status: "accepted" },
  { recipientId: 2, status: "opened" },
  { recipientId: 2, status: "accepted" }, // same person, two sends
  { recipientId: 3, status: "bounced" },
];

test("all prior recipients, de-duplicated", () => {
  assert.deepEqual(resolveAudience("all", PRIOR), [1, 2, 3]);
});

test("accepted-only selects just the signers", () => {
  assert.deepEqual(resolveAudience("accepted", PRIOR), [1, 2]);
});

test("selected is INTERSECTED with prior recipients — a stranger can never be notified", () => {
  // 999 never received this document; 3 did.
  assert.deepEqual(resolveAudience("selected", PRIOR, [3, 999]), [3]);
  assert.deepEqual(resolveAudience("selected", PRIOR, [999]), [], "nobody eligible, nobody mailed");
  assert.deepEqual(resolveAudience("selected", PRIOR, []), []);
});

test("an empty prior-send pool selects nobody for every audience", () => {
  for (const audience of ["all", "accepted", "selected"] as const) {
    assert.deepEqual(resolveAudience(audience, [], [1, 2, 3]), []);
  }
});

test("audience values off a form are validated, and ids are sanitised", () => {
  assert.equal(isNoticeAudience("all"), true);
  assert.equal(isNoticeAudience("everyone"), false);
  assert.equal(isNoticeAudience(null), false);

  assert.deepEqual(parseSelectedRecipientIds(["3", "1", "1", "nope", "-2", "0", "2.5"]), [1, 3]);
});

const HEADS: DocumentHead[] = [
  { documentId: 10, slug: "msa", title: "MSA", currentVersionId: 102, currentVersion: 2 },
  { documentId: 20, slug: "baa", title: "HIPAA BAA", currentVersionId: 201, currentVersion: 1 },
];

test("a document is a candidate only when somebody is actually behind", () => {
  const sends: SendRow[] = [
    { recipientId: 1, status: "accepted", documentId: 10, version: 1 },
    { recipientId: 2, status: "opened", documentId: 20, version: 1 }, // already current
  ];
  const candidates = noticeCandidates(HEADS, sends);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].documentId, 10);
  assert.deepEqual(candidates[0].staleRecipients, [1]);
  assert.deepEqual(candidates[0].acceptedRecipients, [1]);
});

test("a recipient who ALSO holds the current version is excluded", () => {
  // Telling somebody who already has the new terms that the terms changed is
  // wrong, not merely noisy.
  const sends: SendRow[] = [
    { recipientId: 1, status: "accepted", documentId: 10, version: 1 },
    { recipientId: 1, status: "sent", documentId: 10, version: 2 },
    { recipientId: 5, status: "opened", documentId: 10, version: 1 },
  ];
  const candidates = noticeCandidates(HEADS, sends);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].staleRecipients, [5], "recipient 1 is already current");
  assert.ok(
    candidates[0].pool.every((s) => s.recipientId === 5),
    "the pool handed to resolveAudience excludes them too",
  );
  // The pool and the audience agree — the two cannot drift apart.
  assert.deepEqual(resolveAudience("all", candidates[0].pool), [5]);
});

test("no sends at all means no candidates", () => {
  assert.deepEqual(noticeCandidates(HEADS, []), []);
  assert.deepEqual(noticeCandidates([], [{ recipientId: 1, status: "sent", documentId: 10, version: 1 }]), []);
});
