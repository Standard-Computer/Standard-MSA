-- CreateTable
CREATE TABLE "EmailOutbound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'transactional',
    "refJson" TEXT NOT NULL DEFAULT '{}',
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "linksJson" TEXT NOT NULL DEFAULT '[]',
    "openedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmailDeliveryEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "outboundId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'app',
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "EmailDeliveryEvent_outboundId_fkey" FOREIGN KEY ("outboundId") REFERENCES "EmailOutbound" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EmailOutbound_status_nextAttemptAt_idx" ON "EmailOutbound"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailOutbound_providerMessageId_idx" ON "EmailOutbound"("providerMessageId");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_outboundId_occurredAt_idx" ON "EmailDeliveryEvent"("outboundId", "occurredAt");
