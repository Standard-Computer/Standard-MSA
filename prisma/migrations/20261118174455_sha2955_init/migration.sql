-- CreateTable
CREATE TABLE "MspIdentity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "address" TEXT,
    "ownerName" TEXT,
    "email" TEXT,
    "website" TEXT,
    "venue" TEXT,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LegalDocument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'msa',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LegalDocumentVersion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "documentId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "variablesJson" TEXT NOT NULL DEFAULT '{}',
    "changelog" TEXT,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegalDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LegalDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LegalVisit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL,
    "slug" TEXT,
    "version" INTEGER,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "referer" TEXT,
    "region" TEXT
);

-- CreateTable
CREATE TABLE "SiteCheck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "targetUrl" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "statusCode" INTEGER,
    "detail" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alerted" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Recipient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "companyName" TEXT,
    "legalName" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Send" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "documentVersionId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "mergedVarsJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'created',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "acceptedAt" DATETIME,
    CONSTRAINT "Send_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "LegalDocumentVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Send_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SendEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sendId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "SendEvent_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "Send" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AcceptanceRecord" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sendId" INTEGER NOT NULL,
    "acceptedAt" DATETIME NOT NULL,
    "acceptorName" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "signatureJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "AcceptanceRecord_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "Send" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UpdateNotice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "documentVersionId" INTEGER NOT NULL,
    "audience" TEXT NOT NULL,
    "recipientIdsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);

-- CreateTable
CREATE TABLE "EmailProviderConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "provider" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "settingsJson" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_slug_key" ON "LegalDocument"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocumentVersion_documentId_version_key" ON "LegalDocumentVersion"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Send_token_key" ON "Send"("token");

-- CreateIndex
CREATE INDEX "SendEvent_sendId_occurredAt_idx" ON "SendEvent"("sendId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptanceRecord_sendId_key" ON "AcceptanceRecord"("sendId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
