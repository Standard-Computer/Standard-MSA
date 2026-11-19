// Update notices against a real database (SHA-3030 review follow-up).
//
// The card's promise has two halves. "Presented, never automatic" is held
// structurally — nothing but the operator action calls `sendUpdateNotice` —
// and `audience.test.ts` covers who a choice resolves to. This file covers
// the half that needed a database: asking for a notice sends it EXACTLY
// ONCE per recipient per version, however many times the button is pressed.
//
// Delivery deliberately fails here: SMTP points at a port with nothing
// listening, so every attempt is refused. That is the harder case to get
// right, not a weaker one — a refused attempt still leaves an outbound row
// that the queue will retry, so a second submit must not re-mail it either.
//
// Runs against a freshly migrated throwaway SQLite file; node's test runner
// gives each file its own process, so the env set here never leaks.
//
// Needs `--conditions=react-server` (set in the `test` script): notices.ts
// reaches `@/lib/legal/documents`, which carries the `server-only` marker,
// and that package only resolves to a no-op under the condition Next's
// server uses. See the gates note in README.md.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha3030-notices-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.EMAIL_PROVIDER = "smtp";
process.env.EMAIL_FROM = "msa@mail.shadowpsa.com";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1"; // refused immediately; never a hanging dial
process.env.APP_BASE_URL = "https://msa.mail.shadowpsa.com";
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let sends: typeof import("../../src/lib/sends/sends");
let notices: typeof import("../../src/lib/sends/notices");

let documentId = 0;
let v1Id = 0;
let v2Id = 0;

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  sends = await import("../../src/lib/sends/sends");
  notices = await import("../../src/lib/sends/notices");

  await prisma.mspIdentity.create({ data: { name: "Standard Computer" } });
  const doc = await prisma.legalDocument.create({
    data: { slug: "msa", title: "Master Services Agreement", kind: "msa" },
  });
  documentId = doc.id;
  const v1 = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: "## 1. Term\n\nOne year.",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  v1Id = v1.id;
  const v2 = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 2,
      bodyMarkdown: "## 1. Term\n\nTwo years.",
      changelog: "Term extended to two years.",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
  v2Id = v2.id;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

/** Notice outbound rows for one recipient — the per-person mail ledger. */
async function noticeMailFor(recipientId: number): Promise<number> {
  const rows = await prisma.emailOutbound.findMany({
    where: { kind: "notice" },
    select: { refJson: true },
  });
  return rows.filter((r) => JSON.parse(r.refJson).recipientId === recipientId).length;
}

test("the notice goes to everyone behind the current version, once", async () => {
  const dana = await sends.createSend(v1Id, { email: "dana@mail.shadowpsa.com" });
  const sam = await sends.createSend(v1Id, { email: "sam@mail.shadowpsa.com" });

  const candidates = await notices.listNoticeCandidates();
  assert.equal(candidates.length, 1, "v1 recipients are behind v2");
  assert.deepEqual(candidates[0].staleRecipients.length, 2);

  const first = await notices.sendUpdateNotice({ documentId, audience: "all" });
  assert.ok(first.ok);
  assert.equal(first.skipped, 0);
  // Delivery is refused in this env, so the attempts are failures — but the
  // mail exists and the queue owns it from here.
  assert.equal(first.failures.length, 2, "two recipients attempted");
  assert.equal(await noticeMailFor(dana.send.recipientId), 1);
  assert.equal(await noticeMailFor(sam.send.recipientId), 1);
  assert.equal(await prisma.updateNotice.count({ where: { documentVersionId: v2Id } }), 1);

  const notice = await prisma.updateNotice.findUniqueOrThrow({ where: { id: first.noticeId } });
  assert.ok(notice.sentAt, "sentAt is stamped once the fan-out finishes");
  assert.deepEqual(
    (JSON.parse(notice.recipientIdsJson) as number[]).sort((a, b) => a - b),
    [dana.send.recipientId, sam.send.recipientId].sort((a, b) => a - b),
  );
});

test("pressing send again mails nobody and writes no second notice", async () => {
  const before = await prisma.emailOutbound.count({ where: { kind: "notice" } });
  const noticesBefore = await prisma.updateNotice.count({ where: { documentVersionId: v2Id } });

  const again = await notices.sendUpdateNotice({ documentId, audience: "all" });
  assert.equal(again.ok, false, "a repeat of a completed notice is refused");
  assert.match(
    again.ok === false ? again.error : "",
    /already been notified about v2/,
    "and says why, naming the version",
  );

  assert.equal(
    await prisma.emailOutbound.count({ where: { kind: "notice" } }),
    before,
    "nobody is told twice that their terms changed",
  );
  assert.equal(
    await prisma.updateNotice.count({ where: { documentVersionId: v2Id } }),
    noticesBefore,
    "and no empty notice row is left behind by the refusal",
  );
});

test("a recipient added after the notice is reached, and the earlier ones are not re-mailed", async () => {
  const late = await sends.createSend(v1Id, { email: "late@mail.shadowpsa.com" });

  const result = await notices.sendUpdateNotice({ documentId, audience: "all" });
  assert.ok(result.ok, "there is somebody new to tell, so the notice is not refused");
  assert.equal(result.failures.length, 1, "exactly one person attempted");
  assert.equal(result.skipped, 2, "the two already told are reported, not silently dropped");
  assert.equal(await noticeMailFor(late.send.recipientId), 1);

  const everyone = await prisma.emailOutbound.count({ where: { kind: "notice" } });
  assert.equal(everyone, 3, "three recipients, three notice emails, ever");
});

test("a simultaneous double-click sends one notice, not two", async () => {
  // A second document so this starts from a clean ledger.
  const doc = await prisma.legalDocument.create({
    data: { slug: "hipaa-baa", title: "HIPAA BAA", kind: "baa" },
  });
  const old = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: "## 1. PHI\n\nOld.",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  const current = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 2,
      bodyMarkdown: "## 1. PHI\n\nNew.",
      publishedAt: new Date("2026-11-02T00:00:00Z"),
    },
  });
  const rae = await sends.createSend(old.id, { email: "rae@mail.shadowpsa.com" });

  // Both requests in flight before either has written anything.
  const [a, b] = await Promise.all([
    notices.sendUpdateNotice({ documentId: doc.id, audience: "all" }),
    notices.sendUpdateNotice({ documentId: doc.id, audience: "all" }),
  ]);

  const accepted = [a, b].filter((r) => r.ok);
  assert.equal(accepted.length, 1, "exactly one of the two clicks is the notice");
  assert.equal(
    await prisma.updateNotice.count({ where: { documentVersionId: current.id } }),
    1,
    "one decision recorded, not two",
  );
  assert.equal(await noticeMailFor(rae.send.recipientId), 1, "Rae is told once");
});

test("noticedRecipientIds reads the delivery log, and is empty before anything is sent", async () => {
  assert.deepEqual([...(await notices.noticedRecipientIds(v1Id))], [], "v1 was never notified about");

  const notified = await notices.noticedRecipientIds(v2Id);
  assert.equal(notified.size, 3, "the three people mailed about v2");

  const recipients = await prisma.recipient.findMany({
    where: { id: { in: [...notified] } },
    select: { email: true },
  });
  assert.deepEqual(
    recipients.map((r) => r.email).sort(),
    ["dana@mail.shadowpsa.com", "late@mail.shadowpsa.com", "sam@mail.shadowpsa.com"],
  );
});

test("a notice that crashed mid-fan-out re-reaches only the recipient it never mailed", async () => {
  // The case `noticedRecipientIds` chose the delivery log FOR: the notice row
  // records the operator's decision and is written before any mail goes out,
  // so a crash halfway through leaves a row naming people who were never
  // mailed. Reading `recipientIdsJson` would treat those people as told and
  // exclude them forever; reading the log tells the truth about what exists.
  //
  // Reconstructed by hand rather than by killing a process: one notice row
  // naming two recipients, `sentAt` still null, and an outbound row for only
  // the first of them — exactly the rows a crash between the two sends leaves.
  const doc = await prisma.legalDocument.create({
    data: { slug: "dpa", title: "Data Processing Addendum", kind: "dpa" },
  });
  const old = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      bodyMarkdown: "## 1. Processing\n\nOld.",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  const current = await prisma.legalDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 2,
      bodyMarkdown: "## 1. Processing\n\nNew.",
      publishedAt: new Date("2026-11-03T00:00:00Z"),
    },
  });
  const mailed = await sends.createSend(old.id, { email: "mailed@mail.shadowpsa.com" });
  const stranded = await sends.createSend(old.id, { email: "stranded@mail.shadowpsa.com" });

  const interrupted = await prisma.updateNotice.create({
    data: {
      documentVersionId: current.id,
      audience: "all",
      recipientIdsJson: JSON.stringify([mailed.send.recipientId, stranded.send.recipientId]),
      // sentAt deliberately left null: the fan-out never finished.
    },
  });
  await prisma.emailOutbound.create({
    data: {
      toAddress: "mailed@mail.shadowpsa.com",
      subject: "Data Processing Addendum has been updated",
      bodyText: "...",
      kind: "notice",
      refJson: JSON.stringify({
        updateNoticeId: interrupted.id,
        recipientId: mailed.send.recipientId,
      }),
      status: "sent",
    },
  });

  // The decision named two people; only one of them has mail that exists.
  const notified = await notices.noticedRecipientIds(current.id);
  assert.deepEqual(
    [...notified],
    [mailed.send.recipientId],
    "only the recipient with an outbound row counts as told",
  );
  assert.equal(
    notified.has(stranded.send.recipientId),
    false,
    "the recipient the crash skipped is not written off as notified",
  );

  // And the repair actually happens: re-sending reaches exactly that person.
  const repair = await notices.sendUpdateNotice({ documentId: doc.id, audience: "all" });
  assert.ok(repair.ok, "the stranded recipient makes this a real notice, not a refused repeat");
  assert.equal(repair.skipped, 1, "the already-mailed recipient is reported as skipped");
  assert.deepEqual(
    repair.failures.map((f) => f.email),
    ["stranded@mail.shadowpsa.com"],
    "exactly one person attempted, and it is the one the crash missed",
  );
  assert.equal(await noticeMailFor(stranded.send.recipientId), 1, "reached once");
  assert.equal(
    await noticeMailFor(mailed.send.recipientId),
    1,
    "and the one already mailed is not told twice",
  );
});

test("an audience that selects nobody is refused without writing a notice", async () => {
  const before = await prisma.updateNotice.count();
  const result = await notices.sendUpdateNotice({
    documentId,
    audience: "selected",
    selectedRecipientIds: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /selects nobody/);
  assert.equal(await prisma.updateNotice.count(), before);
});
