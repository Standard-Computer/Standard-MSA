// DB-backed tests (SHA-2958 review follow-up): the queue reaper, the click
// route's scheme guard, and webhook replay dedup — the paths pure-function
// tests cannot reach. Runs against a freshly migrated throwaway SQLite file;
// node's test runner gives each file its own process, so the env set here
// never leaks into other test files.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha2958-queue-db-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
// Configured SMTP provider; no test here ever opens a connection (every
// outbound row is kept out of the due window), so the host is never dialled.
process.env.EMAIL_PROVIDER = "smtp";
process.env.EMAIL_FROM = "msa@mail.shadowpsa.com";
process.env.SMTP_HOST = "localhost";
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// Imported dynamically so the modules initialise after DATABASE_URL is set.
let prisma: typeof import("../../src/lib/db").prisma;
let queue: typeof import("../../src/lib/email/queue");
let webhooks: typeof import("../../src/lib/email/webhooks");
let clickGET: typeof import("../../src/app/api/email/click/[id]/[index]/route").GET;
let config: import("../../src/lib/email/types").ResolvedEmailConfig;

before(async () => {
  prisma = (await import("../../src/lib/db")).prisma;
  queue = await import("../../src/lib/email/queue");
  webhooks = await import("../../src/lib/email/webhooks");
  clickGET = (await import("../../src/app/api/email/click/[id]/[index]/route")).GET;
  const state = await (await import("../../src/lib/email/config")).getEmailConfig();
  assert.ok(state.configured, "test env must resolve as configured");
  config = state.config;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

function futureDate(ms = 60 * 60 * 1000): Date {
  return new Date(Date.now() + ms);
}

async function createOutbound(data: Partial<Parameters<typeof prisma.emailOutbound.create>[0]["data"]> = {}) {
  return prisma.emailOutbound.create({
    data: {
      toAddress: "rcpt@mail.shadowpsa.com",
      subject: "Subject",
      bodyText: "text",
      kind: "test",
      refJson: "{}",
      linksJson: "[]",
      status: "queued",
      nextAttemptAt: futureDate(),
      ...data,
    },
  });
}

test("reaper re-queues a row stranded in sending; fresh sending rows are left alone", async () => {
  const stranded = await createOutbound({ status: "sending" });
  // Backdate updatedAt past the stuck threshold (raw SQL: Prisma's @updatedAt
  // would overwrite it on any client update).
  const past = new Date(Date.now() - queue.STUCK_SENDING_AFTER_MS - 1000);
  await prisma.$executeRaw`UPDATE "EmailOutbound" SET "updatedAt" = ${past} WHERE "id" = ${stranded.id}`;
  const fresh = await createOutbound({ status: "sending" });

  const result = await queue.processEmailQueue();

  const strandedAfter = await prisma.emailOutbound.findUniqueOrThrow({ where: { id: stranded.id } });
  assert.equal(strandedAfter.status, "queued", "stranded row must be reclaimed");
  const freshAfter = await prisma.emailOutbound.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.equal(freshAfter.status, "sending", "an in-flight attempt must not be stolen");
  // nextAttemptAt is in the future for both, so the sweep attempted nothing.
  assert.deepEqual(result, { attempted: 0, sent: 0 });
});

test("click route 404s on non-http(s) and relative targets, redirects real ones", async () => {
  const outbound = await createOutbound({
    linksJson: JSON.stringify(["javascript:alert(document.domain)", "/dashboard", "https://ob.standardcomputer.com/msa"]),
  });
  const click = (index: string) =>
    clickGET(new Request(`http://localhost/api/email/click/${outbound.id}/${index}`), {
      params: Promise.resolve({ id: outbound.id, index }),
    });

  const js = await click("0");
  assert.equal(js.status, 404, "javascript: scheme must never reach a Location header");
  const relative = await click("1");
  assert.equal(relative.status, 404, "relative target must 404, not throw a 500");
  const real = await click("2");
  assert.equal(real.status, 302);
  assert.equal(real.headers.get("location"), "https://ob.standardcomputer.com/msa");

  // Only the real click was logged.
  const events = await prisma.emailDeliveryEvent.findMany({
    where: { outboundId: outbound.id, type: "clicked" },
  });
  assert.equal(events.length, 1);
});

test("webhook replay of the same provider event is acknowledged but not re-recorded", async () => {
  const outbound = await createOutbound({ status: "sent" });
  const body = JSON.stringify([
    { event: "bounce", outbound_id: outbound.id, timestamp: 1700000000, reason: "mailbox full" },
  ]);
  // No SENDGRID_WEBHOOK_PUBLIC_KEY in this env, so parseWebhook skips the
  // signature; authenticity is the route's shared-secret gate, not under test.
  const first = await webhooks.ingestWebhook("sendgrid", body, {}, config);
  assert.deepEqual(first, { ok: true, ingested: 1 });
  const replay = await webhooks.ingestWebhook("sendgrid", body, {}, config);
  assert.deepEqual(replay, { ok: true, ingested: 0 }, "exact replay must not re-record");

  const bounces = await prisma.emailDeliveryEvent.findMany({
    where: { outboundId: outbound.id, type: "bounced" },
  });
  assert.equal(bounces.length, 1);

  // A replayed bounce must not flip a row that was legitimately re-sent.
  await prisma.emailOutbound.update({ where: { id: outbound.id }, data: { status: "sent" } });
  await webhooks.ingestWebhook("sendgrid", body, {}, config);
  const rowAfter = await prisma.emailOutbound.findUniqueOrThrow({ where: { id: outbound.id } });
  assert.equal(rowAfter.status, "sent");
});
