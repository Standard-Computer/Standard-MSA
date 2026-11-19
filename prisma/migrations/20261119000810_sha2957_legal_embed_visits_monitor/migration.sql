-- CreateTable
CREATE TABLE "LegalSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "embedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "embedOriginsJson" TEXT NOT NULL DEFAULT '[]',
    "introText" TEXT,
    "footerText" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#1d4ed8',
    "visitRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "hashVisitorIps" BOOLEAN NOT NULL DEFAULT false,
    "monitorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monitorUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MonitorState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "downSince" DATETIME,
    "lastAlertAt" DATETIME,
    "lastRecoveryAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "lastDetail" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LegalVisit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL,
    "slug" TEXT,
    "version" INTEGER,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "referer" TEXT,
    "region" TEXT,
    "country" TEXT,
    "visitId" TEXT,
    "theme" TEXT,
    "embedded" BOOLEAN NOT NULL DEFAULT false,
    "secondsOnPage" INTEGER NOT NULL DEFAULT 0,
    "docsJson" TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO "new_LegalVisit" ("id", "ip", "occurredAt", "path", "referer", "region", "slug", "userAgent", "version") SELECT "id", "ip", "occurredAt", "path", "referer", "region", "slug", "userAgent", "version" FROM "LegalVisit";
DROP TABLE "LegalVisit";
ALTER TABLE "new_LegalVisit" RENAME TO "LegalVisit";
CREATE UNIQUE INDEX "LegalVisit_visitId_key" ON "LegalVisit"("visitId");
CREATE INDEX "LegalVisit_occurredAt_idx" ON "LegalVisit"("occurredAt");
CREATE INDEX "LegalVisit_slug_occurredAt_idx" ON "LegalVisit"("slug", "occurredAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
