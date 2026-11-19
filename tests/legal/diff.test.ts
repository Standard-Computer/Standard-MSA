// Version-to-version body diff for the update-notice preview (SHA-2959).

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_DIFF_LINES, diffHunks, diffLines, summarizeDiff } from "../../src/lib/legal/diff";

const kinds = (before: string, after: string) => diffLines(before, after).map((l) => l.kind);

test("an unchanged body produces no changes and no hunks", () => {
  const body = "## 1. Services\n\nThe Provider will do the work.\n";
  const lines = diffLines(body, body);
  assert.ok(lines.every((l) => l.kind === "same"));
  assert.deepEqual(summarizeDiff(lines), { added: 0, removed: 0, changed: false });
  assert.deepEqual(diffHunks(lines), [], "nothing to preview");
});

test("a replaced line reads as removed-then-added at that position", () => {
  const before = "A\nB\nC";
  const after = "A\nB2\nC";
  assert.deepEqual(kinds(before, after), ["same", "removed", "added", "same"]);
  assert.deepEqual(summarizeDiff(diffLines(before, after)), { added: 1, removed: 1, changed: true });
});

test("insertions and deletions keep the surrounding lines intact", () => {
  assert.deepEqual(kinds("A\nC", "A\nB\nC"), ["same", "added", "same"]);
  assert.deepEqual(kinds("A\nB\nC", "A\nC"), ["same", "removed", "same"]);
});

test("line numbers point into the body they came from", () => {
  const lines = diffLines("A\nB\nC", "A\nB2\nC");
  const removed = lines.find((l) => l.kind === "removed");
  const added = lines.find((l) => l.kind === "added");
  assert.deepEqual([removed?.beforeLine, removed?.afterLine], [2, null]);
  assert.deepEqual([added?.beforeLine, added?.afterLine], [null, 2]);
});

test("CRLF bodies diff identically to LF ones — a pasted body is not a rewrite", () => {
  const lines = diffLines("A\r\nB\r\nC", "A\nB\nC");
  assert.ok(lines.every((l) => l.kind === "same"), "line endings alone are not a change");
});

test("hunks carry context and merge when their context overlaps", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
  const after = ["1", "2", "X", "4", "5", "6", "7", "8", "9"].join("\n");
  const hunks = diffHunks(diffLines(before, after), 2);
  assert.equal(hunks.length, 1);
  // Two lines of context either side of the change, which here clips at the start.
  assert.deepEqual(
    hunks[0].lines.map((l) => l.text),
    ["1", "2", "3", "X", "4", "5"],
  );

  // Two far-apart changes stay two hunks; the whole body is not dumped.
  const farBefore = Array.from({ length: 30 }, (_, i) => String(i)).join("\n");
  const farAfter = farBefore.replace("\n1\n", "\nONE\n").replace("\n25\n", "\nTWENTYFIVE\n");
  const farHunks = diffHunks(diffLines(farBefore, farAfter), 2);
  assert.equal(farHunks.length, 2);
  assert.ok(
    farHunks.every((h) => h.lines.length <= 7),
    "a hunk is the change plus context, not the document",
  );
});

test("an only-added body (no previous version) is all additions", () => {
  const lines = diffLines("", "A\nB");
  assert.deepEqual(summarizeDiff(lines), { added: 2, removed: 1, changed: true });
});

test("a pathologically long body degrades the preview, not the process", () => {
  // Past the cap the O(n*m) table is skipped for a coarse whole-body
  // replacement — the screen still renders instead of allocating 64 MB.
  const huge = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
  const lines = diffLines(huge, `${huge}\nextra`);
  const summary = summarizeDiff(lines);
  assert.equal(summary.changed, true);
  assert.equal(summary.removed, MAX_DIFF_LINES + 10);
  assert.equal(summary.added, MAX_DIFF_LINES + 11);
  assert.ok(lines.every((l) => l.kind !== "same"), "the coarse path marks everything changed");
});
