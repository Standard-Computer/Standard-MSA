// Per-recipient stage cells on the MSA sends list (SHA-4500).
//
// These hold the column mapping the operator list renders: which stage each
// cell asks about, what fills it, and — the point of the whole lane — that a
// click is visible as its own cell even though `Send.status` has no rung for
// it and stays `opened`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECIPIENT_STAGES,
  recipientStages,
  rollUpStatus,
  stageTimes,
  visibleStages,
} from "../../src/lib/sends/lifecycle";

const at = (iso: string) => new Date(iso);

/** A trail of `[type, iso]` pairs, in the order the events landed. */
const trail = (...events: [string, string][]) =>
  events.map(([type, iso]) => ({ type, occurredAt: at(iso) }));

/** The stage cells by label, which is what the table header shows. */
const byLabel = (cells: ReturnType<typeof recipientStages>) =>
  new Map<string, Date | null>(cells.map((cell) => [cell.label, cell.at]));

test("Sean's four questions have cells, labelled in his words", () => {
  const labels: string[] = RECIPIENT_STAGES.map((stage) => stage.label);
  for (const wanted of ["Received", "Opened", "Clicked", "Signed"]) {
    assert.ok(labels.includes(wanted), `no cell asks about ${wanted}`);
  }
  // The labels are the operator's words; the stored event names are not
  // renamed, because the evidence trail and the API speak those.
  const types = new Map(RECIPIENT_STAGES.map((s) => [s.label, s.type]));
  assert.equal(types.get("Received"), "delivered");
  assert.equal(types.get("Signed"), "accepted");
  assert.equal(types.get("Clicked"), "clicked");
  assert.equal(types.get("Viewed"), "viewed");
});

test("delivered + opened + clicked + accepted all read as present, with first-event times", () => {
  const events = trail(
    ["created", "2026-11-27T10:00:00.000Z"],
    ["sent", "2026-11-27T10:00:05.000Z"],
    ["delivered", "2026-11-27T10:00:30.000Z"],
    ["opened", "2026-11-27T10:04:00.000Z"],
    ["clicked", "2026-11-27T10:04:20.000Z"],
    ["viewed", "2026-11-27T10:04:25.000Z"],
    ["accepted", "2026-11-27T10:09:00.000Z"],
  );
  const cells = byLabel(recipientStages(events));

  assert.deepEqual(cells.get("Sent"), at("2026-11-27T10:00:05.000Z"));
  assert.deepEqual(cells.get("Received"), at("2026-11-27T10:00:30.000Z"));
  assert.deepEqual(cells.get("Opened"), at("2026-11-27T10:04:00.000Z"));
  assert.deepEqual(cells.get("Clicked"), at("2026-11-27T10:04:20.000Z"));
  assert.deepEqual(cells.get("Viewed"), at("2026-11-27T10:04:25.000Z"));
  assert.deepEqual(cells.get("Signed"), at("2026-11-27T10:09:00.000Z"));
  assert.equal(cells.get("Declined"), null);
  assert.equal(cells.get("Bounced"), null);
});

test("a send with only `sent` leaves every later cell empty", () => {
  const cells = byLabel(recipientStages(trail(
    ["created", "2026-11-27T10:00:00.000Z"],
    ["sent", "2026-11-27T10:00:05.000Z"],
  )));

  assert.deepEqual(cells.get("Sent"), at("2026-11-27T10:00:05.000Z"));
  for (const label of ["Received", "Opened", "Clicked", "Viewed", "Signed", "Declined", "Bounced"]) {
    assert.equal(cells.get(label), null, `${label} must be empty, not guessed`);
  }
});

test("a click is visible as its own cell while the status column stays `opened`", () => {
  // The exact gap this lane exists to close: `clicked` folds onto `opened`
  // in the status roll-up, so no value of Send.status can ever report a
  // click. The cell reads it off the trail instead.
  const events = trail(
    ["created", "2026-11-27T10:00:00.000Z"],
    ["sent", "2026-11-27T10:00:05.000Z"],
    ["delivered", "2026-11-27T10:00:30.000Z"],
    ["clicked", "2026-11-27T10:04:20.000Z"],
  );
  assert.equal(rollUpStatus(events), "opened", "the status roll-up is unchanged");
  const cells = byLabel(recipientStages(events));
  assert.deepEqual(cells.get("Clicked"), at("2026-11-27T10:04:20.000Z"));
  assert.equal(cells.get("Opened"), null, "a click is not an open the pixel never recorded");
});

test("a late bounce cannot erase the Signed cell, just as it cannot un-accept", () => {
  const events = trail(
    ["created", "2026-11-27T10:00:00.000Z"],
    ["sent", "2026-11-27T10:00:05.000Z"],
    ["accepted", "2026-11-27T10:09:00.000Z"],
    ["bounced", "2026-11-27T11:00:00.000Z"],
  );
  assert.equal(rollUpStatus(events), "accepted");
  const cells = byLabel(recipientStages(events));
  assert.deepEqual(cells.get("Signed"), at("2026-11-27T10:09:00.000Z"));
  // Both facts stay visible — the trail is append-only and so is the table.
  assert.deepEqual(cells.get("Bounced"), at("2026-11-27T11:00:00.000Z"));
});

test("repeat events report the FIRST occurrence, in any input order", () => {
  const times = stageTimes([
    { type: "opened", occurredAt: at("2026-11-27T12:00:00.000Z") },
    { type: "opened", occurredAt: at("2026-11-27T10:00:00.000Z") },
    { type: "opened", occurredAt: at("2026-11-27T11:00:00.000Z") },
  ]);
  assert.deepEqual(times.get("opened"), at("2026-11-27T10:00:00.000Z"));
});

test("an unknown event type never becomes a cell", () => {
  const times = stageTimes([{ type: "teleported", occurredAt: at("2026-11-27T10:00:00.000Z") }]);
  assert.equal(times.size, 0);
  const cells = recipientStages([{ type: "teleported", occurredAt: at("2026-11-27T10:00:00.000Z") }]);
  assert.equal(cells.length, RECIPIENT_STAGES.length);
  assert.ok(cells.every((cell) => cell.at === null));
});

test("the acceptance record fills Signed if the trail somehow lost its event", () => {
  const events = trail(["created", "2026-11-27T10:00:00.000Z"], ["sent", "2026-11-27T10:00:05.000Z"]);
  const acceptedAt = at("2026-11-27T10:09:00.000Z");
  assert.deepEqual(byLabel(recipientStages(events, acceptedAt)).get("Signed"), acceptedAt);
  // And the event wins when both exist, since that is the trail's own answer.
  const withEvent = trail(
    ["created", "2026-11-27T10:00:00.000Z"],
    ["accepted", "2026-11-27T10:05:00.000Z"],
  );
  assert.deepEqual(
    byLabel(recipientStages(withEvent, acceptedAt)).get("Signed"),
    at("2026-11-27T10:05:00.000Z"),
  );
  // An acceptance record does not conjure any other cell.
  assert.equal(byLabel(recipientStages(events, acceptedAt)).get("Received"), null);
});

test("headline columns always show; optional ones only when a group reached them", () => {
  const quiet = visibleStages([{ events: [{ type: "created" }, { type: "sent" }] }]);
  assert.deepEqual(
    quiet.map((s) => s.label),
    ["Sent", "Received", "Opened", "Clicked", "Signed"],
    "the four Sean asked for, plus Sent, hold their place even when empty",
  );

  const messy = visibleStages([
    { events: [{ type: "created" }, { type: "sent" }, { type: "bounced" }] },
    { events: [{ type: "created" }, { type: "sent" }, { type: "viewed" }] },
  ]);
  assert.deepEqual(
    messy.map((s) => s.label),
    ["Sent", "Received", "Opened", "Clicked", "Viewed", "Signed", "Bounced"],
    "a bounce in one send surfaces the column for the whole group",
  );
  assert.ok(
    !messy.some((s) => s.label === "Declined"),
    "nobody declined, so no empty Declined column",
  );

  const declined = visibleStages([
    { events: [{ type: "created" }, { type: "sent" }, { type: "declined" }] },
  ]);
  assert.deepEqual(
    declined.map((s) => s.label),
    ["Sent", "Received", "Opened", "Clicked", "Signed", "Declined"],
  );

  assert.deepEqual(
    visibleStages([]).map((s) => s.label),
    ["Sent", "Received", "Opened", "Clicked", "Signed"],
  );
});

test("stage cells come back in lifecycle order, not event order", () => {
  // The header is built from this order, so a trail that arrived out of
  // order must not reshuffle anyone's columns.
  const cells = recipientStages(trail(
    ["accepted", "2026-11-27T10:09:00.000Z"],
    ["sent", "2026-11-27T10:00:05.000Z"],
  ));
  assert.deepEqual(
    cells.map((cell) => cell.type),
    RECIPIENT_STAGES.map((stage) => stage.type),
  );
});
