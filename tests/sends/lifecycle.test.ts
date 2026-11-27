// Lifecycle status roll-up and the funnel (SHA-2959).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FUNNEL_STAGES,
  RECIPIENT_COLUMNS,
  SEND_EVENT_TYPES,
  advanceStatus,
  firstEventTimes,
  funnelFor,
  isSendEventType,
  readSeconds,
  rollUpStatus,
  statusForEvent,
  statusRank,
} from "../../src/lib/sends/lifecycle";

const trail = (...types: string[]) => types.map((type) => ({ type }));

test("status only ever moves forward", () => {
  assert.equal(advanceStatus("created", "sent"), "sent");
  assert.equal(advanceStatus("opened", "delivered"), "opened", "a late delivered must not regress");
  assert.equal(advanceStatus("accepted", "sent"), "accepted");
  assert.equal(advanceStatus("accepted", "opened"), "accepted");
});

test("a late bounce webhook cannot un-accept a signed agreement", () => {
  // The exact data-loss bug monotonic ranks exist to prevent: the recipient
  // signs, then a provider retries a bounce signal for the same message.
  assert.equal(rollUpStatus(trail("created", "sent", "opened", "accepted", "bounced")), "accepted");
  assert.equal(advanceStatus("accepted", "bounced"), "accepted");
});

test("accepting after a decline wins; declining does not outrank a bounce backwards", () => {
  assert.equal(rollUpStatus(trail("created", "sent", "declined", "accepted")), "accepted");
  assert.equal(rollUpStatus(trail("created", "sent", "bounced")), "bounced");
  assert.equal(advanceStatus("bounced", "declined"), "declined");
});

test("clicked and viewed fold onto opened — the status column has no rung for them", () => {
  assert.equal(statusForEvent("clicked"), "opened");
  assert.equal(statusForEvent("viewed"), "opened");
  assert.equal(rollUpStatus(trail("created", "sent", "viewed")), "opened");
});

test("an unrecognised stored status heals on the next event instead of freezing", () => {
  assert.equal(statusRank("nonsense"), -1);
  assert.equal(advanceStatus("nonsense", "sent"), "sent");
});

test("unknown event types are ignored by the roll-up, never crash it", () => {
  assert.equal(isSendEventType("teleported"), false);
  assert.equal(rollUpStatus(trail("created", "teleported", "sent")), "sent");
});

test("the funnel counts each stage once per send, from the trail not the status", () => {
  const sends = [
    // Opened three times then accepted: counts once for opened AND for accepted,
    // which a status tally could not express since a row holds one status.
    { events: trail("created", "sent", "delivered", "opened", "opened", "opened", "accepted") },
    { events: trail("created", "sent", "bounced") },
    { events: trail("created") },
  ];
  const funnel = funnelFor(sends);
  assert.equal(funnel.total, 3);
  assert.equal(funnel.sent, 2);
  assert.equal(funnel.delivered, 1);
  assert.equal(funnel.opened, 1, "three opens of one send is one opened send");
  assert.equal(funnel.accepted, 1);
  assert.equal(funnel.bounced, 1);
  assert.equal(funnel.declined, 0);
  assert.equal(funnel.clicked, 0);

  const empty = funnelFor([]);
  assert.equal(empty.total, 0);
  for (const stage of FUNNEL_STAGES) assert.equal(empty[stage], 0);
});

// ── Per-recipient trail columns (SHA-4504 / GH #21) ─────────────────────────

const at = (iso: string) => new Date(iso);
const timed = (...pairs: [string, string][]) =>
  pairs.map(([type, iso]) => ({ type, occurredAt: at(iso) }));

test("a delivered+opened+clicked+accepted trail shows all four columns with first-event times", () => {
  // AC 6's first fixture: the row Sean asked for — received, opened, clicked
  // and signed all visible per recipient, each with its first-event time.
  const first = firstEventTimes(
    timed(
      ["created", "2026-11-27T10:00:00Z"],
      ["sent", "2026-11-27T10:01:00Z"],
      ["delivered", "2026-11-27T10:02:00Z"],
      ["opened", "2026-11-27T10:05:00Z"],
      ["clicked", "2026-11-27T10:06:00Z"],
      ["accepted", "2026-11-27T10:10:00Z"],
    ),
  );
  assert.deepEqual(first.delivered, at("2026-11-27T10:02:00Z"));
  assert.deepEqual(first.opened, at("2026-11-27T10:05:00Z"));
  assert.deepEqual(first.clicked, at("2026-11-27T10:06:00Z"));
  assert.deepEqual(first.accepted, at("2026-11-27T10:10:00Z"));
  assert.equal(first.declined, null);
  assert.equal(first.bounced, null);
});

test("a send with only `sent` shows every other column empty", () => {
  const first = firstEventTimes(timed(["sent", "2026-11-27T10:01:00Z"]));
  assert.deepEqual(first.sent, at("2026-11-27T10:01:00Z"));
  for (const type of SEND_EVENT_TYPES) {
    if (type !== "sent") assert.equal(first[type], null, `${type} must be empty`);
  }
});

test("clicked is visible per recipient even though the status stays opened", () => {
  // The whole point of the column: status folds clicked onto opened, so only
  // the trail can show it.
  const trail = timed(
    ["created", "2026-11-27T10:00:00Z"],
    ["sent", "2026-11-27T10:01:00Z"],
    ["opened", "2026-11-27T10:05:00Z"],
    ["clicked", "2026-11-27T10:06:00Z"],
  );
  assert.equal(rollUpStatus(trail), "opened");
  assert.deepEqual(firstEventTimes(trail).clicked, at("2026-11-27T10:06:00Z"));
});

test("the FIRST occurrence wins, even when a late projection lands out of order", () => {
  const first = firstEventTimes(
    timed(
      ["opened", "2026-11-27T10:05:00Z"],
      ["opened", "2026-11-27T11:00:00Z"],
      // A provider webhook projected after the opens, carrying an earlier time.
      ["delivered", "2026-11-27T10:02:00Z"],
      ["delivered", "2026-11-27T10:30:00Z"],
    ),
  );
  assert.deepEqual(first.opened, at("2026-11-27T10:05:00Z"));
  assert.deepEqual(first.delivered, at("2026-11-27T10:02:00Z"));
});

test("unknown event types never crash the column derivation", () => {
  const first = firstEventTimes(timed(["teleported", "2026-11-27T10:00:00Z"]));
  for (const type of SEND_EVENT_TYPES) assert.equal(first[type], null);
});

test("the column labels carry Sean's vocabulary onto the schema's events", () => {
  // "Received" is the UI word for the `delivered` event and "Signed" for
  // `accepted` — renaming either column or remapping its event is a spec
  // break (GH #21 AC 2), so the mapping is pinned exactly.
  const byLabel = Object.fromEntries(RECIPIENT_COLUMNS.map((c) => [c.label, c.event]));
  assert.deepEqual(byLabel, {
    Sent: "sent",
    Received: "delivered",
    Opened: "opened",
    Clicked: "clicked",
    Viewed: "viewed",
    Signed: "accepted",
  });
  // Opened and Clicked are distinct columns, in funnel order.
  assert.deepEqual(
    RECIPIENT_COLUMNS.map((c) => c.event),
    ["sent", "delivered", "opened", "clicked", "viewed", "accepted"],
  );
});

test("read seconds sum across viewed pings and ignore junk meta", () => {
  const events = [
    { type: "viewed", metaJson: '{"seconds":15}' },
    { type: "viewed", metaJson: '{"seconds":12}' },
    { type: "viewed", metaJson: "not json" },
    { type: "viewed", metaJson: '{"seconds":-5}' },
    { type: "viewed", metaJson: '{"seconds":"ten"}' },
    { type: "opened", metaJson: '{"seconds":999}' },
  ];
  assert.equal(readSeconds(events), 27, "only well-formed positive viewed pings count");
});
