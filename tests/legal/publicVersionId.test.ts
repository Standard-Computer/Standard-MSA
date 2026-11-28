// Public version IDs and the history surfaces (SHA-4708, GH #33 §6;
// AC10–AC13), against a REAL database built by the real migrations.
//
// Three things here can only be checked this way:
//
//   · THE MIGRATION'S SQL AND THE TYPESCRIPT HELPER AGREE. They are two
//     implementations of one format, in two languages, and nothing but a
//     test can keep them in step. The SQL is READ OUT OF THE SHIPPED
//     migration.sql rather than retyped here — a copy in this file would
//     pass while the migration that actually runs on Sean's database said
//     something else. It is exercised against both storage shapes the column
//     really holds (Prisma's INTEGER milliseconds, and the TEXT that a
//     CURRENT_TIMESTAMP default writes), because the integer formula does
//     not fail on TEXT — it silently returns 1970.
//   · WRITE-ONCE SURVIVES THE THINGS THAT WOULD RECOMPUTE IT: a slug
//     rename, an edited publishedAt, a republish.
//   · THE PAGES RENDER IT. The index's history link and the #history
//     anchor it points at are a matched pair; asserting the href without
//     asserting the anchor is how a link that goes nowhere ships.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { publicVersionId, publicVersionIdDate } from "../../src/lib/legal/publicVersionId";

const dbDir = mkdtempSync(join(tmpdir(), "sha4708-public-id-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// next/link reaches for the client router context, which cannot initialise
// under --conditions=react-server (the condition npm test runs with). The
// pages use it only to emit an href, so a stand-in that records exactly that
// is enough to assert on, and keeps these page assertions in the unit suite
// instead of needing a browser.
const req = createRequire(import.meta.url);
const linkPath = req.resolve("next/link");
req.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  loaded: true,
  exports: {
    __esModule: true,
    default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) => ({
      type: "a",
      props: { href, className, children },
    }),
  },
} as unknown as NodeModule;

// next/navigation reaches for the same client context. The per-agreement
// pages import it for notFound(), which these tests never trigger — they ask
// for documents that exist — so the stand-in throws rather than returning,
// which is what notFound() does and keeps a mis-pathed test from passing
// quietly.
const navPath = req.resolve("next/navigation");
req.cache[navPath] = {
  id: navPath,
  filename: navPath,
  loaded: true,
  exports: {
    __esModule: true,
    notFound: () => {
      throw new Error("notFound() — the fixture asked for a document that is not published");
    },
  },
} as unknown as NodeModule;

let prisma: typeof import("../../src/lib/db").prisma;
let authoring: typeof import("../../src/lib/legal/authoring");

before(async () => {
  ({ prisma } = await import("../../src/lib/db"));
  authoring = await import("../../src/lib/legal/authoring");
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

/** The backfill UPDATE, read out of the migration this repo ships. */
function shippedBackfillSql(): string {
  const root = join(import.meta.dirname, "..", "..", "prisma", "migrations");
  const dir = readdirSync(root).find((d) => d.includes("sha4708"));
  assert.ok(dir, "the SHA-4708 migration must exist");
  // The path is built from this repo's own migrations directory listing, not
  // from input — the point of reading it is that the SHIPPED file is what
  // gets exercised.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const sql = readFileSync(join(root, dir, "migration.sql"), "utf8");
  // Strip the comments BEFORE splitting on ";" — a prose semicolon inside a
  // "--" comment would otherwise cut a statement in half.
  const statement = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk.startsWith('UPDATE "LegalDocumentVersion"'));
  assert.ok(statement, "the migration must carry the publicId backfill UPDATE");
  return statement;
}

/** Walk a server component's returned tree for text, hrefs and anchor ids. */
function walkTree(node: unknown): { text: string; hrefs: string[]; ids: string[] } {
  const texts: string[] = [];
  const hrefs: string[] = [];
  const ids: string[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      texts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== "object") return;
    if (seen.has(n)) return;
    seen.add(n);
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    const props = el.props ?? {};
    if (typeof props.href === "string") hrefs.push(props.href);
    if (typeof props.id === "string") ids.push(props.id);
    // The next/link stand-in is a function component: call it so its href is
    // seen exactly once, rather than also descending into its raw children.
    if (typeof el.type === "function") {
      walk((el.type as (p: Record<string, unknown>) => unknown)(props));
      return;
    }
    walk(props.children);
  };
  walk(node);
  return { text: texts.join(" ").replace(/\s+/g, " "), hrefs, ids };
}

async function publishNew(slug: string, title: string, version: number, when: Date) {
  const doc =
    (await prisma.legalDocument.findUnique({ where: { slug } })) ??
    (await prisma.legalDocument.create({ data: { slug, title } }));
  const ver = await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version, bodyMarkdown: `# ${title} v${version}` },
  });
  // Pin the clock markPublished will stamp, so the expected ID is knowable.
  const result = await authoring.markPublished(doc, ver);
  await prisma.legalDocumentVersion.update({ where: { id: ver.id }, data: { publishedAt: when } });
  return { doc, ver, result };
}

// ── The helper itself ──────────────────────────────────────────────────────

test("AC10: the ID is {slug}-v{version}-{YYYYMMDD} from the UTC date", () => {
  assert.equal(publicVersionId("msa", 2, new Date("2026-11-01T00:00:00Z")), "msa-v2-20261101");
  assert.equal(publicVersionId("hipaa-baa", 11, new Date("2027-01-09T13:45:00Z")), "hipaa-baa-v11-20270109");
  // UTC, not local: both edges of the same UTC day land on that day, and a
  // moment that is "yesterday evening" in US/Central is still today in UTC.
  assert.equal(publicVersionIdDate(new Date("2026-11-01T00:00:00.000Z")), "20261101");
  assert.equal(publicVersionIdDate(new Date("2026-11-01T23:59:59.999Z")), "20261101");
  assert.equal(publicVersionIdDate(new Date("2026-11-01T00:00:00Z")), "20261101");
  // Deterministic: same inputs, same answer, every time.
  const a = publicVersionId("msa", 3, new Date("2026-02-28T06:00:00Z"));
  assert.equal(a, publicVersionId("msa", 3, new Date("2026-02-28T06:00:00Z")));
  assert.equal(a, "msa-v3-20260228");
});

test("AC10: the date is UTC even when the server's clock is not", () => {
  // THIS TEST ONLY MEANS SOMETHING OFF UTC. CI runs with TZ unset (UTC),
  // where a local-time implementation is indistinguishable from a correct
  // one — so the zone is forced here. Without this, "use UTC" is an
  // untested comment: a local-getter implementation passes every other
  // assertion in this file.
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/Chicago"; // UTC-5/-6, so it is a day behind late UTC
    // 02:30 UTC on 1 Nov is still 31 Oct locally in Chicago.
    const lateNight = new Date("2026-11-01T02:30:00Z");
    assert.equal(lateNight.getDate(), 31, "the zone override must actually apply");
    assert.equal(publicVersionIdDate(lateNight), "20261101", "the ID uses the UTC day");
    assert.equal(publicVersionId("msa", 2, lateNight), "msa-v2-20261101");

    // And the other direction: 23:00 UTC is still the same UTC day.
    const evening = new Date("2026-11-01T23:00:00Z");
    assert.equal(publicVersionIdDate(evening), "20261101");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("AC8/AC10: prisma/schema.prisma and the migrations agree — no drift", () => {
  // The unique index on publicId is declared in BOTH places and they have
  // to match: the migration is what runs on Sean's database, the schema is
  // what the client is generated from and what a future `migrate dev`
  // diffs against. Dropping @unique from the schema alone leaves the index
  // in place today and silently plans to DROP it on the next migration.
  const diff = execSync(
    "npx prisma migrate diff --from-migrations prisma/migrations" +
      " --to-schema-datamodel prisma/schema.prisma" +
      ` --shadow-database-url "file:${join(dbDir, "drift.db")}" --script`,
    { encoding: "utf8", env: process.env },
  ).trim();
  const statements = diff
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("--"))
    .join("\n");
  assert.equal(statements, "", `schema/migration drift:\n${diff}`);
  // And the index really is declared on the model, not only in SQL.
  const schema = readFileSync(join(import.meta.dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /publicId\s+String\?\s+@unique/, "publicId must be @unique on the model");
  assert.match(schema, /phone\s+String\?/, "MspIdentity.phone must be optional");
});

// ── The migration SQL vs the helper ────────────────────────────────────────

test("AC10/AC13: the shipped backfill SQL and the TS helper agree, on BOTH storage shapes", async () => {
  const doc = await prisma.legalDocument.create({ data: { slug: "agree", title: "Agreement" } });

  // Rows as they exist BEFORE this migration's backfill: published, no
  // publicId. Written with raw SQL so the stored types are what a real
  // pre-existing database holds.
  const fixtures = [
    // Prisma's own shape: INTEGER milliseconds.
    { version: 1, publishedSql: String(Date.parse("2026-11-19T04:00:00Z")), expectDate: "20261119" },
    // Late-UTC, to catch a formula that drops the time and rounds wrong.
    { version: 2, publishedSql: String(Date.parse("2026-11-19T23:59:59Z")), expectDate: "20261119" },
    // The TEXT shape a CURRENT_TIMESTAMP default writes. The bare integer
    // formula returns '19700101' here — this row is the whole reason the
    // migration branches on typeof().
    { version: 3, publishedSql: "'2026-11-19 23:30:00'", expectDate: "20261119" },
  ];
  for (const f of fixtures) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LegalDocumentVersion"
         ("documentId","version","bodyMarkdown","variablesJson","publishedAt","createdAt","publicId")
       VALUES (?, ${f.version}, 'x', '{}', ${f.publishedSql}, ${f.publishedSql}, NULL)`,
      doc.id,
    );
  }
  // A DRAFT, which must stay NULL.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "LegalDocumentVersion"
       ("documentId","version","bodyMarkdown","variablesJson","publishedAt","createdAt","publicId")
     VALUES (?, 4, 'x', '{}', NULL, ${fixtures[0].publishedSql}, NULL)`,
    doc.id,
  );

  // Run the migration's OWN statement.
  await prisma.$executeRawUnsafe(shippedBackfillSql());

  for (const f of fixtures) {
    const row = await prisma.legalDocumentVersion.findFirst({
      where: { documentId: doc.id, version: f.version },
    });
    assert.ok(row);
    const expected = `agree-v${f.version}-${f.expectDate}`;
    assert.equal(row.publicId, expected, `v${f.version} backfilled wrong`);
    // THE POINT: the SQL produced exactly what the TypeScript helper would.
    assert.equal(
      row.publicId,
      publicVersionId("agree", f.version, new Date(Date.parse("2026-11-19T04:00:00Z"))),
      `v${f.version}: SQL and helper disagree`,
    );
    assert.ok(!row.publicId.includes("1970"), "a TEXT timestamp must not backfill as 1970");
  }

  const draft = await prisma.legalDocumentVersion.findFirst({
    where: { documentId: doc.id, version: 4 },
  });
  assert.equal(draft?.publicId, null, "a draft gets no public ID until it is published");
});

test("AC10: re-running the backfill is a no-op — it never overwrites an existing ID", async () => {
  const before = await prisma.legalDocumentVersion.findMany({
    where: { publicId: { not: null } },
    select: { id: true, publicId: true },
    orderBy: { id: "asc" },
  });
  assert.ok(before.length > 0, "there must be backfilled rows to protect");
  await prisma.$executeRawUnsafe(shippedBackfillSql());
  const after = await prisma.legalDocumentVersion.findMany({
    where: { publicId: { not: null } },
    select: { id: true, publicId: true },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(after, before);
});

// ── Assignment at first publish ────────────────────────────────────────────

test("AC10: markPublished assigns the ID in the same write that publishes", async () => {
  const doc = await prisma.legalDocument.create({ data: { slug: "msa", title: "Master Agreement" } });
  const ver = await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version: 1, bodyMarkdown: "# MSA" },
  });
  assert.equal(ver.publicId, null, "a draft starts with no ID");

  const { version: published, alreadyPublished } = await authoring.markPublished(doc, ver);
  assert.equal(alreadyPublished, false);
  assert.ok(published.publishedAt, "it published");
  // The ID matches the timestamp it was derived from — one clock read, not
  // two, so these can never be a day apart.
  assert.equal(published.publicId, publicVersionId("msa", 1, published.publishedAt));
  // There is NO window where a published row has no ID.
  const reread = await prisma.legalDocumentVersion.findUnique({ where: { id: ver.id } });
  assert.equal(reread?.publicId, published.publicId);
  assert.match(reread!.publicId!, /^msa-v1-\d{8}$/);
});

test("AC10: an ID that already exists is KEPT, not overwritten, at publish time", async () => {
  // The defensive `?? ` branch in markPublished. Nothing in the app sets a
  // publicId before publishing today, so without this test the branch is
  // unreachable and "write-once" is only enforced by the early return —
  // which a later caller that stamps publishedAt itself would walk around.
  const doc = await prisma.legalDocument.create({ data: { slug: "kept", title: "Kept" } });
  const ver = await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version: 1, bodyMarkdown: "x", publicId: "kept-v1-19990101" },
  });
  const { version: published, alreadyPublished } = await authoring.markPublished(doc, ver);
  assert.equal(alreadyPublished, false, "it was a draft, so it really published");
  assert.ok(published.publishedAt);
  assert.equal(published.publicId, "kept-v1-19990101", "the pre-existing ID survived the publish");
});

test("AC10: republishing does not recompute the ID", async () => {
  const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { slug: "msa" } });
  const ver = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { documentId: doc.id, version: 1 },
  });
  const original = ver.publicId;
  const again = await authoring.markPublished(doc, ver);
  assert.equal(again.alreadyPublished, true);
  assert.equal(again.version.publicId, original);
});

test("AC10: the ID survives a slug rename and an edited publishedAt", async () => {
  const doc = await prisma.legalDocument.create({ data: { slug: "baa", title: "BAA" } });
  const ver = await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version: 1, bodyMarkdown: "# BAA" },
  });
  const { version: published } = await authoring.markPublished(doc, ver);
  const original = published.publicId;
  assert.ok(original?.startsWith("baa-v1-"));

  // The slug moves. The ID is what a client already cited, so it stays.
  await prisma.legalDocument.update({ where: { id: doc.id }, data: { slug: "hipaa-baa" } });
  // And the effective date is corrected by an operator.
  await prisma.legalDocumentVersion.update({
    where: { id: ver.id },
    data: { publishedAt: new Date("2030-01-01T00:00:00Z") },
  });

  const reread = await prisma.legalDocumentVersion.findUnique({ where: { id: ver.id } });
  assert.equal(reread?.publicId, original, "a renamed slug must not rewrite a cited ID");
  assert.ok(!reread?.publicId?.includes("2030"), "an edited publishedAt must not rewrite it either");
  // The backfill cannot reclaim it either, now that the slug disagrees.
  await prisma.$executeRawUnsafe(shippedBackfillSql());
  const afterBackfill = await prisma.legalDocumentVersion.findUnique({ where: { id: ver.id } });
  assert.equal(afterBackfill?.publicId, original);
});

test("AC10: the unique index makes reuse impossible", async () => {
  const taken = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { publicId: { not: null } },
  });
  const doc = await prisma.legalDocument.create({ data: { slug: "dup", title: "Dup" } });
  await assert.rejects(
    () =>
      prisma.legalDocumentVersion.create({
        data: { documentId: doc.id, version: 1, bodyMarkdown: "x", publicId: taken.publicId },
      }),
    /Unique constraint|UNIQUE/i,
    "a duplicate publicId must be refused by the database, not merely avoided in code",
  );
  // Many NULLs coexist, so unpublished drafts are unaffected by the index.
  await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version: 2, bodyMarkdown: "x" },
  });
  await prisma.legalDocumentVersion.create({
    data: { documentId: doc.id, version: 3, bodyMarkdown: "x" },
  });
  assert.equal(
    await prisma.legalDocumentVersion.count({ where: { documentId: doc.id, publicId: null } }),
    2,
  );
});

// ── The public surfaces ────────────────────────────────────────────────────

test("AC11: the /legal index shows the ID and links to the agreement's history", async () => {
  await publishNew("terms", "Website Terms", 1, new Date("2026-10-01T12:00:00Z"));
  await publishNew("terms", "Website Terms", 2, new Date("2026-11-01T12:00:00Z"));

  const page = await import("../../src/app/legal/page");
  const { text, hrefs } = walkTree(await page.default());

  const current = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { document: { slug: "terms" }, version: 2 },
  });
  assert.ok(current.publicId);
  // version in force, effective date, unique ID, history link — all four.
  assert.ok(text.includes("v2"), "the version in force");
  assert.ok(text.includes("effective "), "the effective date");
  assert.ok(text.includes(`ID ${current.publicId}`), `the ID (${current.publicId}) in ${text}`);
  assert.ok(hrefs.includes("/legal/terms#history"), `a history link, got ${JSON.stringify(hrefs)}`);
  assert.ok(text.includes("Version history"), "and it is labelled");
});

test("AC1: the index renders the intro ABOVE the agreements list", async () => {
  const page = await import("../../src/app/legal/page");
  const { text } = walkTree(await page.default());
  const introAt = text.indexOf("means you accept these agreements");
  const listAt = text.indexOf("Website Terms");
  assert.ok(introAt > -1, "the default intro is on the page");
  assert.ok(listAt > -1, "so is the list");
  assert.ok(introAt < listAt, "and the intro comes first");
});

test("AC11/AC12: the history link's target anchor actually exists on the agreement page", async () => {
  const page = await import("../../src/app/legal/[slug]/page");
  const { text, hrefs, ids } = walkTree(await page.default({ params: Promise.resolve({ slug: "terms" }) }));

  // The #history fragment the index links to is a real anchor here.
  assert.ok(ids.includes("history"), `expected an id="history" anchor, got ${JSON.stringify(ids)}`);

  const versions = await prisma.legalDocumentVersion.findMany({
    where: { document: { slug: "terms" } },
    orderBy: { version: "asc" },
  });
  // Every published version is listed with its ID and effective date, and
  // every EARLIER one links to its own page.
  for (const v of versions) {
    assert.ok(v.publicId);
    assert.ok(text.includes(v.publicId), `v${v.version}'s ID must be listed`);
    if (v.version !== 2) {
      assert.ok(
        hrefs.includes(`/legal/terms/${v.version}`),
        `v${v.version} must link to its own page, got ${JSON.stringify(hrefs)}`,
      );
    }
  }
  assert.ok(text.includes("in force today"), "the current version is marked as current");
});

test("AC12: an old version still renders, and shows its OWN id", async () => {
  const page = await import("../../src/app/legal/[slug]/[version]/page");
  const { text } = walkTree(
    await page.default({ params: Promise.resolve({ slug: "terms", version: "1" }) }),
  );
  const v1 = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { document: { slug: "terms" }, version: 1 },
  });
  const v2 = await prisma.legalDocumentVersion.findFirstOrThrow({
    where: { document: { slug: "terms" }, version: 2 },
  });
  assert.ok(text.includes("historical version"), "it is marked historical");
  assert.ok(text.includes(v1.publicId!), "it shows its own ID");
  assert.ok(!text.includes(v2.publicId!), "and not the current version's");
});

test("AC11: an agreement with only one version still offers a working history link", async () => {
  // The link is unconditional, so this is the case where it used to point at
  // a section that was not rendered at all.
  await publishNew("solo", "Solo Agreement", 1, new Date("2026-11-20T12:00:00Z"));
  const index = await import("../../src/app/legal/page");
  assert.ok(walkTree(await index.default()).hrefs.includes("/legal/solo#history"));

  const page = await import("../../src/app/legal/[slug]/page");
  const { ids, text } = walkTree(await page.default({ params: Promise.resolve({ slug: "solo" }) }));
  assert.ok(ids.includes("history"), "the anchor exists even with no earlier versions");
  assert.ok(text.includes("in force today"));
});
