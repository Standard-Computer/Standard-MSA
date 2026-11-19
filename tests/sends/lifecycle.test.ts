// Lifecycle status roll-up and the funnel (SHA-2959).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FUNNEL_STAGES,
  advanceStatus,
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
