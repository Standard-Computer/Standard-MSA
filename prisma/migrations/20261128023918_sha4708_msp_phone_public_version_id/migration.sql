-- SHA-4708 / GH #33: {{msp_phone}} identity field, and citable public
-- version IDs for published agreement versions.
--
-- Add-only: two nullable columns and one unique index. Nothing is dropped,
-- renamed or retyped, so a rollback is "ignore the new columns".

-- AlterTable
ALTER TABLE "LegalDocumentVersion" ADD COLUMN "publicId" TEXT;

-- AlterTable
ALTER TABLE "MspIdentity" ADD COLUMN "phone" TEXT;

-- Backfill every ALREADY-PUBLISHED version with the same formula the
-- application uses (publicVersionId() in src/lib/legal/publicVersionId.ts):
-- "{slug}-v{version}-{YYYYMMDD}" from the UTC date of publishedAt.
-- tests/legal/publicVersionId.test.ts pins this SQL and that helper to the
-- same answers on the same fixture inputs, because two formulas that are
-- supposed to agree will only stay agreed if something checks.
--
-- Drafts (publishedAt IS NULL) are deliberately left NULL: a draft has no
-- public existence to cite, and SQLite treats NULLs as distinct in a unique
-- index, so any number of them coexist.
--
-- WHY THE typeof() BRANCH IS NOT OPTIONAL. Prisma's SQLite connector writes
-- DateTime as INTEGER milliseconds, so the published rows this install wrote
-- need publishedAt/1000 through 'unixepoch'. But both DateTime columns here
-- also carry a CURRENT_TIMESTAMP-shaped default, which SQLite stores as TEXT
-- ('YYYY-MM-DD HH:MM:SS'), so a row inserted by anything other than Prisma
-- can be TEXT in the very same column. Measured on a real database built
-- from these migrations: on a TEXT value the integer formula does not error,
-- it returns '19700101' — it would silently backfill every such row with a
-- 1970 date, and the unique index would then happily accept the wrong ID.
-- The CASE is what makes the format explicit instead of assumed. Verified to
-- return 20261101 for all of: INTEGER ms, REAL ms, 'YYYY-MM-DD HH:MM:SS',
-- 'YYYY-MM-DDTHH:MM:SS', the same with 'Z', with '.000Z', and a bare
-- 'YYYY-MM-DD'.
--
-- COALESCE(publishedAt, createdAt) is a backfill-only fallback for a
-- published row whose publishedAt is somehow absent; the application path
-- always has publishedAt, because it assigns the ID in the same UPDATE that
-- stamps it.
UPDATE "LegalDocumentVersion"
SET "publicId" =
  (SELECT d."slug" FROM "LegalDocument" d WHERE d."id" = "LegalDocumentVersion"."documentId")
  || '-v' || "version" || '-'
  || CASE typeof(COALESCE("publishedAt", "createdAt"))
       WHEN 'integer' THEN strftime('%Y%m%d', COALESCE("publishedAt", "createdAt") / 1000, 'unixepoch')
       WHEN 'real'    THEN strftime('%Y%m%d', COALESCE("publishedAt", "createdAt") / 1000, 'unixepoch')
       ELSE                strftime('%Y%m%d', COALESCE("publishedAt", "createdAt"))
     END
WHERE "publishedAt" IS NOT NULL AND "publicId" IS NULL;

-- CreateIndex
--
-- AFTER the backfill, on purpose. A duplicate ID then fails the migration
-- loudly, which is the required behaviour (AC10: a backfill collision must
-- never overwrite an existing ID). Creating the index first would let the
-- UPDATE above be the thing that errors, mid-statement, with some rows
-- already rewritten.
CREATE UNIQUE INDEX "LegalDocumentVersion_publicId_key" ON "LegalDocumentVersion"("publicId");
