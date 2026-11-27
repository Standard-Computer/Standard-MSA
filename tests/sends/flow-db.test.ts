// SHA-2959 acceptance criteria, end to end against a real database.
//
// Covers the card's criteria directly: a send produces a unique URL; opening,
// clicking and accepting each land a distinct timestamped event; an
// acceptance produces a retrievable evidence record. Plus the two guards
// that pure tests cannot reach — projection idempotency and the frozen
// merge variables.
//
// Runs against a freshly migrated throwaway SQLite file; node's test runner
// gives each file its own process, so the env set here never leaks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha3030-sends-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
// A configured provider whose host is never dialled: every test here writes
// outbound rows directly rather than going through sendEmail().
process.env.EMAIL_PROVIDER = "smtp";
process.env.EMAIL_FROM = "msa@mail.shadowpsa.com";
process.env.SMTP_HOST = "localhost";
process.env.APP_BASE_URL = "https://msa.mail.shadowpsa.com";
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let sends: typeof import("../../src/lib/sends/sends");
let evidence: typeof import("../../src/lib/sends/evidence");
let projection: typeof import("../../src/lib/sends/projection");
let render: typeof import("../../src/lib/sends/render");
let tokens: typeof import("../../src/lib/sends/tokens");

const BODY = [
  "## 1. Parties",
  "",
  "This agreement is between {{msp_name}} and {{client_name}} of {{client_company}},",
  "at {{client_address}}, signed by {{signer_name}} on {{accepted_date}}.",
].join("\n");

let versionId = 0;

/** Trail types as a sorted multiset — the trail is ordered by occurredAt
 *  (provider time for projected events, ours for app-side ones), so a fixed
 *  interleaving would assert this fixture's clock rather than the product. */
const sortedTypes = (events: readonly { type: string }[]) => events.map((e) => e.type).sort();

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  sends = await import("../../src/lib/sends/sends");
  evidence = await import("../../src/lib/sends/evidence");
  projection = await import("../../src/lib/sends/projection");
  render = await import("../../src/lib/sends/render");
  tokens = await import("../../src/lib/sends/tokens");

  await prisma.mspIdentity.create({
    data: { name: "Standard Computer", legalName: "Standard Computer LLC", venue: "Nebraska" },
  });
  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Services Agreement", kind: "msa" },
  });
  const version = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: BODY,
      variablesJson: "{}",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
  versionId = version.id;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

/** An outbound row + delivery events, as SHA-2958's channel would leave them. */
async function fakeOutbound(sendId: number, to: string, events: { type: string; source: string; at: Date }[]) {
  return prisma.emailOutbound.create({
    data: {
      toAddress: to,
      subject: "Your MSA",
      bodyText: "body",
      kind: "send",
      refJson: JSON.stringify({ sendId }),
      linksJson: "[]",
      status: "sent",
      events: {
        create: events.map((e) => ({ type: e.type, source: e.source, occurredAt: e.at })),
      },
    },
  });
}

test("a send to one address produces a unique URL and freezes its merge variables", async () => {
  const first = await sends.createSend(versionId, { email: "dana@mail.shadowpsa.com" });
  const second = await sends.createSend(versionId, {
    email: "Dana@Mail.ShadowPSA.com", // same person, different case
    fullName: "Dana Reyes",
    companyName: "Reyes Dental",
  });

  assert.notEqual(first.send.token, second.send.token, "each send gets its own token");
  assert.ok(tokens.isSendTokenShape(first.send.token));
  assert.ok(
    tokens.sendUrl("https://msa.mail.shadowpsa.com", first.send.token).endsWith(first.send.token),
  );
  assert.equal(
    first.send.recipientId,
    second.send.recipientId,
    "case-different addresses are ONE recipient, not two divergent trails",
  );

  // The second send enriched the recipient row...
  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: first.send.recipientId } });
  assert.equal(recipient.fullName, "Dana Reyes");

  // ...but the FIRST send's frozen variables are untouched by that.
  const firstAfter = await sends.sendByToken(first.send.token);
  assert.deepEqual(JSON.parse(firstAfter!.mergedVarsJson), {
    client_email: "dana@mail.shadowpsa.com",
  });
  const rendered = await render.renderSendDocument(firstAfter!);
  assert.ok(
    !rendered.markdown.includes("Dana Reyes"),
    "a later send must not rewrite what an earlier agreement says",
  );
  assert.match(rendered.markdown, /the Client/);

  // The second send's copy does name her, and carries no raw tokens.
  const secondRendered = await render.renderSendDocument(second.send);
  assert.match(secondRendered.markdown, /Dana Reyes/);
  assert.match(secondRendered.markdown, /Reyes Dental/);
  assert.ok(!secondRendered.markdown.includes("{{"));
  assert.equal(secondRendered.bodyHash.length, 64);

  // A `created` event exists from the start.
  assert.deepEqual(sortedTypes(first.send.events), ["created"]);
});

test("a non-destructive re-send does not blank details an earlier send captured", async () => {
  const email = "quiet@mail.shadowpsa.com";
  await sends.createSend(versionId, { email, fullName: "Quiet Person", phone: "+1 555 010 0100" });
  const sparse = await sends.createSend(versionId, { email }); // operator retyped nothing

  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: sparse.send.recipientId },
  });
  assert.equal(recipient.fullName, "Quiet Person", "an empty field declines to retype, not to forget");
  assert.equal(recipient.phone, "+1 555 010 0100");
});

test("opening, clicking and accepting each land a distinct timestamped event", async () => {
  const { send } = await sends.createSend(versionId, {
    email: "funnel@mail.shadowpsa.com",
    fullName: "Funnel Tester",
  });

  await fakeOutbound(send.id, "funnel@mail.shadowpsa.com", [
    { type: "sent", source: "app", at: new Date("2026-11-18T10:00:00Z") },
    { type: "delivered", source: "webhook", at: new Date("2026-11-18T10:00:30Z") },
    { type: "opened", source: "pixel", at: new Date("2026-11-18T10:05:00Z") },
    { type: "clicked", source: "click", at: new Date("2026-11-18T10:06:00Z") },
    // Channel-level only: must NOT appear in the send's lifecycle.
    { type: "complained", source: "webhook", at: new Date("2026-11-18T10:07:00Z") },
    { type: "queued", source: "app", at: new Date("2026-11-18T09:59:00Z") },
  ]);

  await projection.projectDeliverySignals(send);
  const afterProjection = await sends.sendByToken(send.token);
  assert.deepEqual(sortedTypes(afterProjection!.events), [
    "clicked",
    "created",
    "delivered",
    "opened",
    "sent",
  ]);
  assert.equal(afterProjection!.status, "opened", "clicked folds onto opened");
  // The two channel-level signals stay out of the agreement's lifecycle.
  for (const channelOnly of ["complained", "queued"]) {
    assert.equal(
      afterProjection!.events.filter((e) => e.type === channelOnly).length,
      0,
      `${channelOnly} describes the email, not the agreement`,
    );
  }

  // Provider timestamps are preserved, not replaced with "now".
  const opened = afterProjection!.events.find((e) => e.type === "opened");
  assert.equal(opened!.occurredAt.toISOString(), "2026-11-18T10:05:00.000Z");
  assert.equal(
    afterProjection!.sentAt?.toISOString(),
    "2026-11-18T10:00:00.000Z",
    "sentAt is when it really went, not when we noticed",
  );

  // A read ping, then the signature.
  await sends.appendSendEvent(send.id, { type: "viewed", meta: { seconds: 20 }, ip: "203.0.113.7" });
  const accepted = await evidence.acceptSend(afterProjection!.token, {
    acceptorName: "  Funnel Tester  ",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0 (probe)",
  });
  assert.ok(accepted.ok);
  assert.equal(accepted.alreadyAccepted, false);
  assert.equal(accepted.send.status, "accepted");

  const final = await sends.sendByToken(afterProjection!.token);
  assert.deepEqual(sortedTypes(final!.events), [
    "accepted",
    "clicked",
    "created",
    "delivered",
    "opened",
    "sent",
    "viewed",
  ]);
  const acceptEvent = final!.events.find((e) => e.type === "accepted");
  assert.equal(acceptEvent!.ip, "203.0.113.7", "IP is kept as acceptance evidence");
  assert.equal(acceptEvent!.userAgent, "Mozilla/5.0 (probe)");
  assert.ok(final!.acceptedAt, "acceptedAt is stamped");
});

test("projection is idempotent — safe to run on every page load", async () => {
  const { send } = await sends.createSend(versionId, { email: "idem@mail.shadowpsa.com" });
  await fakeOutbound(send.id, "idem@mail.shadowpsa.com", [
    { type: "sent", source: "app", at: new Date("2026-11-18T11:00:00Z") },
    // Three genuine opens at the same second: distinct events, all kept.
    { type: "opened", source: "pixel", at: new Date("2026-11-18T11:01:00Z") },
    { type: "opened", source: "pixel", at: new Date("2026-11-18T11:01:00Z") },
    { type: "opened", source: "pixel", at: new Date("2026-11-18T11:01:00Z") },
  ]);

  const firstPass = await projection.projectDeliverySignals(send);
  assert.equal(firstPass, 4);

  const reloaded = await sends.sendByToken(send.token);
  const secondPass = await projection.projectDeliverySignals(reloaded!);
  assert.equal(secondPass, 0, "a second load must project nothing new");

  const thirdPass = await projection.projectDeliverySignals((await sends.sendByToken(send.token))!);
  assert.equal(thirdPass, 0);

  const final = await sends.sendByToken(send.token);
  assert.equal(
    final!.events.filter((e) => e.type === "opened").length,
    3,
    "three real opens stay three events — dedup is per delivery event, not per timestamp",
  );
  assert.equal(final!.events.length, 5);
});

test("two concurrent page loads project each delivery signal exactly once", async () => {
  const { send } = await sends.createSend(versionId, { email: "concurrent@mail.shadowpsa.com" });
  await fakeOutbound(send.id, "concurrent@mail.shadowpsa.com", [
    { type: "sent", source: "app", at: new Date("2026-11-18T13:00:00Z") },
    { type: "delivered", source: "webhook", at: new Date("2026-11-18T13:00:30Z") },
    { type: "opened", source: "pixel", at: new Date("2026-11-18T13:02:00Z") },
  ]);

  // Both callers hold the SAME pre-projection snapshot, which is exactly what
  // two operator tabs loading the send at the same moment produce.
  const snapshot = (await sends.sendByToken(send.token))!;
  const [first, second] = await Promise.all([
    projection.projectDeliverySignals(snapshot),
    projection.projectDeliverySignals(snapshot),
  ]);

  assert.equal(first + second, 3, "three signals, three appends, no matter who got there first");

  const final = await sends.sendByToken(send.token);
  assert.deepEqual(sortedTypes(final!.events), ["created", "delivered", "opened", "sent"]);
  // Duplicates here would be frozen into the next acceptance's evidence.
  const sources = final!.events
    .map((e) => projection.projectedFrom(e.metaJson))
    .filter((id): id is number => id !== null);
  assert.equal(new Set(sources).size, sources.length, "no delivery event projected twice");
});

test("an acceptance produces a retrievable, self-contained evidence record", async () => {
  const { send } = await sends.createSend(versionId, {
    email: "evidence@mail.shadowpsa.com",
    fullName: "Eve Idence",
    companyName: "Idence Dental",
    address: "100 Main St, Springfield IL",
  });
  await sends.appendSendEvent(send.id, { type: "viewed", meta: { seconds: 45 } });

  const result = await evidence.acceptSend(send.token, {
    acceptorName: "Eve Idence",
    ip: "198.51.100.4",
    userAgent: "Mozilla/5.0 (evidence)",
  });
  assert.ok(result.ok);

  // Pinned against a re-render of the ACCEPTED send, not of the send as it
  // was before signing: the two differ (the signed copy names the effective
  // date), so pinning the earlier one would pass while the stored evidence
  // described a document nobody can reproduce.
  const rendered = await render.renderSendDocument((await sends.sendByToken(send.token))!);

  const blob = (await evidence.evidenceFor(send.id)) as Record<string, unknown>;
  assert.equal(blob.schema, evidence.EVIDENCE_SCHEMA);
  assert.equal(blob.bodyHash, rendered.bodyHash, "the hash pins the exact words");
  assert.equal(blob.bodyMarkdown, rendered.markdown);
  assert.ok(typeof blob.bodyMarkdown === "string" && (blob.bodyMarkdown as string).includes("Eve Idence"));
  assert.ok(
    !(blob.bodyMarkdown as string).includes("{{"),
    "the frozen body is the merged text, not the template",
  );

  const recipient = blob.recipient as Record<string, unknown>;
  assert.equal(recipient.email, "evidence@mail.shadowpsa.com");
  assert.equal(recipient.address, "100 Main St, Springfield IL");

  const document = blob.document as Record<string, unknown>;
  assert.equal(document.slug, "msa");
  assert.equal(document.version, 1);

  // The frozen trail must INCLUDE the signature itself.
  const trail = blob.trail as { type: string; ip: string | null }[];
  assert.deepEqual(sortedTypes(trail), ["accepted", "created", "viewed"]);
  const signature = trail.find((e) => e.type === "accepted");
  assert.ok(signature, "evidence that stops short of the signature proves everything except it");
  assert.equal(signature.ip, "198.51.100.4");

  const acceptance = blob.acceptance as Record<string, unknown>;
  assert.equal(acceptance.acceptorName, "Eve Idence");
  assert.equal(acceptance.ip, "198.51.100.4");
});

test("the frozen evidence body names the acceptance date, and matches a later re-read", async () => {
  const { send } = await sends.createSend(versionId, {
    email: "dated@mail.shadowpsa.com",
    fullName: "Dee Ated",
  });

  // Control: an unaccepted agreement genuinely has no effective date, so the
  // body says so in prose. This is the wording the frozen copy must NOT keep.
  const unaccepted = await render.renderSendDocument(send);
  assert.match(unaccepted.markdown, /on the date of acceptance\./);

  const result = await evidence.acceptSend(send.token, {
    acceptorName: "Dee Ated",
    ip: "198.51.100.9",
    userAgent: "ua",
  });
  assert.ok(result.ok);

  const accepted = await sends.sendByToken(send.token);
  const day = accepted!.acceptedAt!.toISOString().slice(0, 10);

  const blob = (await evidence.evidenceFor(send.id)) as Record<string, unknown>;
  const frozen = blob.bodyMarkdown as string;
  assert.ok(
    frozen.includes(`on ${day}.`),
    `the frozen agreement must name the day it took effect; tail was: ${frozen.slice(-120)}`,
  );
  assert.ok(
    !frozen.includes("the date of acceptance"),
    'a signed agreement that still reads "the date of acceptance" names no date at all',
  );

  // One agreement, one hash. A later reader re-rendering the accepted send
  // must get the same document the evidence froze — otherwise there are two
  // copies with two hashes and no record of which one is authoritative.
  const reread = await render.renderSendDocument(accepted!);
  assert.equal(reread.markdown, frozen, "the live re-read and the frozen copy must be one document");
  assert.equal(reread.bodyHash, blob.bodyHash, "...and therefore one hash");
  assert.notEqual(
    unaccepted.bodyHash,
    blob.bodyHash,
    "the pre-acceptance render is a different document and must not be what got frozen",
  );
});

test("a double-submitted acceptance keeps the first signature, and writes no second one", async () => {
  const { send } = await sends.createSend(versionId, { email: "double@mail.shadowpsa.com" });
  const first = await evidence.acceptSend(send.token, {
    acceptorName: "First Signer",
    ip: "203.0.113.1",
    userAgent: "ua",
  });
  assert.ok(first.ok && first.alreadyAccepted === false);

  const second = await evidence.acceptSend(send.token, {
    acceptorName: "Someone Else",
    ip: "203.0.113.2",
    userAgent: "ua",
  });
  assert.ok(second.ok);
  assert.equal(second.alreadyAccepted, true);

  const record = await prisma.acceptanceRecord.findUniqueOrThrow({ where: { sendId: send.id } });
  assert.equal(record.acceptorName, "First Signer", "the first acceptance stands");
  assert.equal(record.ip, "203.0.113.1");

  const accepts = await prisma.sendEvent.findMany({ where: { sendId: send.id, type: "accepted" } });
  assert.equal(accepts.length, 1, "no second signature event");
});

test("an unsigned acceptance is refused, and a decline records no evidence", async () => {
  const { send } = await sends.createSend(versionId, { email: "blank@mail.shadowpsa.com" });
  const blank = await evidence.acceptSend(send.token, { acceptorName: "   ", ip: null, userAgent: null });
  assert.equal(blank.ok, false, "a typed signature is the signature");
  assert.equal(await prisma.acceptanceRecord.findUnique({ where: { sendId: send.id } }), null);

  const declined = await evidence.declineSend(send.token, {
    reason: "Not proceeding",
    ip: "203.0.113.9",
    userAgent: "ua",
  });
  assert.ok(declined.ok);
  const afterDecline = await sends.sendByToken(send.token);
  assert.equal(afterDecline!.status, "declined");
  assert.equal(afterDecline!.acceptance, null);

  // Changing their mind still works, and the trail keeps both acts.
  const accepted = await evidence.acceptSend(send.token, {
    acceptorName: "Blank Person",
    ip: "203.0.113.9",
    userAgent: "ua",
  });
  assert.ok(accepted.ok);
  const final = await sends.sendByToken(send.token);
  assert.equal(final!.status, "accepted", "accepted outranks declined");
  assert.deepEqual(sortedTypes(final!.events), ["accepted", "created", "declined"]);

  // And an accepted agreement can no longer be declined away.
  const lateDecline = await evidence.declineSend(send.token, { reason: "", ip: null, userAgent: null });
  assert.equal(lateDecline.ok, false);
});

test("a bad token is refused everywhere, without revealing whether it exists", async () => {
  assert.equal(await sends.sendByToken("not-a-real-token-value-aaaaaaaa"), null);
  const accept = await evidence.acceptSend("not-a-real-token-value-aaaaaaaa", {
    acceptorName: "Nobody",
    ip: null,
    userAgent: null,
  });
  assert.equal(accept.ok, false);
  assert.equal(tokens.isSendTokenShape("short"), false);
  assert.equal(tokens.isSendTokenShape("has spaces in it aaaaaaaaaaaaaaa"), false);
  assert.equal(tokens.isSendTokenShape(tokens.newSendToken()), true);
});

test("a delivery signal for someone else's send is never projected onto this one", async () => {
  const mine = await sends.createSend(versionId, { email: "mine@mail.shadowpsa.com" });
  const theirs = await sends.createSend(versionId, { email: "mine@mail.shadowpsa.com" });

  // Same address, different send: the join is refJson.sendId, not the address.
  await fakeOutbound(theirs.send.id, "mine@mail.shadowpsa.com", [
    { type: "opened", source: "pixel", at: new Date("2026-11-18T12:00:00Z") },
  ]);

  await projection.projectDeliverySignals(mine.send);
  const mineAfter = await sends.sendByToken(mine.send.token);
  assert.deepEqual(sortedTypes(mineAfter!.events), ["created"], "no cross-talk");

  await projection.projectDeliverySignals(theirs.send);
  const theirsAfter = await sends.sendByToken(theirs.send.token);
  assert.deepEqual(sortedTypes(theirsAfter!.events), ["created", "opened"]);
});

test("refSendId and projectedFrom reject junk rather than guessing", () => {
  assert.equal(projection.refSendId('{"sendId":12}'), 12);
  assert.equal(projection.refSendId('{"sendId":"12"}'), null);
  assert.equal(projection.refSendId('{"sendId":1.5}'), null);
  assert.equal(projection.refSendId("not json"), null);
  assert.equal(projection.refSendId("[1]"), null);
  assert.equal(projection.refSendId("{}"), null);

  assert.equal(projection.projectedFrom('{"deliveryEventId":7}'), 7);
  assert.equal(projection.projectedFrom("{}"), null);
  assert.equal(projection.projectedFrom("nope"), null);
});

test("the operator LIST projects every send's signals, not just the one being viewed (SHA-4500)", async () => {
  // The /sends table shows Received / Opened / Clicked per recipient, read
  // off each send's own trail. Before SHA-4500 only the detail page
  // projected, so a recipient nobody had clicked into showed "—" in those
  // cells while the delivery log held the signals all along.
  const quiet = await sends.createSend(versionId, { email: "list-quiet@mail.shadowpsa.com" });
  const busy = await sends.createSend(versionId, { email: "list-busy@mail.shadowpsa.com" });

  await fakeOutbound(busy.send.id, "list-busy@mail.shadowpsa.com", [
    { type: "sent", source: "app", at: new Date("2026-11-27T10:00:00Z") },
    { type: "delivered", source: "webhook", at: new Date("2026-11-27T10:00:30Z") },
    { type: "clicked", source: "click", at: new Date("2026-11-27T10:04:20Z") },
  ]);

  const list = (await sends.allSends()).filter((s) =>
    [quiet.send.id, busy.send.id].includes(s.id),
  );
  const projected = await projection.projectDeliverySignalsForSends(list);
  assert.equal(projected, 3, "all three of the busy send's signals land from the list screen");

  const busyAfter = await sends.sendByToken(busy.send.token);
  assert.deepEqual(sortedTypes(busyAfter!.events), ["clicked", "created", "delivered", "sent"]);
  // The facts the per-recipient columns read, now on the trail with the
  // provider's own times — the list screen is what put them there.
  const first = (type: string) =>
    busyAfter!.events.find((e) => e.type === type)?.occurredAt.toISOString() ?? null;
  assert.equal(first("delivered"), "2026-11-27T10:00:30.000Z", "the Received column has a time");
  assert.equal(first("clicked"), "2026-11-27T10:04:20.000Z", "the Clicked column has a time");
  assert.equal(first("opened"), null, "the pixel never fired; nothing is invented");
  assert.equal(busyAfter!.status, "opened", "status still has no rung for a click");

  // A send with no outbound at all is untouched and costs no projection pass.
  const quietAfter = await sends.sendByToken(quiet.send.token);
  assert.deepEqual(sortedTypes(quietAfter!.events), ["created"]);

  // Idempotent on the list path too: a second page load appends nothing.
  const again = await projection.projectDeliverySignalsForSends(await sends.allSends());
  assert.equal(again, 0, "re-rendering the list must not duplicate the trail");
  assert.equal(await prisma.sendEvent.count({ where: { sendId: busy.send.id } }), 4);

  assert.equal(await projection.projectDeliverySignalsForSends([]), 0);
});
