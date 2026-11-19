// API JSON shapes (SHA-2960). PURE.
//
// One place turns Prisma rows into wire objects, so the REST responses, the
// webhook payloads and the OpenAPI schemas describe the SAME shapes. Inputs
// are structural (just the fields each serializer reads) so this module
// never imports the persistence layer.

import { sendUrl } from "@/lib/sends/tokens";

export function apiBaseUrl(req?: Request): string {
  const env = process.env.APP_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:3000";
}

// ── Contacts ────────────────────────────────────────────────────────────────

export type ContactRow = {
  id: number;
  email: string;
  fullName: string | null;
  companyName: string | null;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  createdAt: Date;
};

export function serializeContact(row: ContactRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.fullName,
    company: row.companyName,
    legalName: row.legalName,
    address: row.address,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Sends ───────────────────────────────────────────────────────────────────

export type SendEventRow = {
  type: string;
  occurredAt: Date;
  metaJson: string;
};

export type SendRow = {
  id: number;
  token: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  acceptedAt: Date | null;
  recipient: ContactRow;
  documentVersion: { version: number; document: { slug: string; title: string } };
  acceptance: { acceptedAt: Date; acceptorName: string | null } | null;
};

export function serializeSend(send: SendRow, baseUrl: string) {
  return {
    id: send.id,
    status: send.status,
    /** The unique per-recipient URL — the reason a calling tool exists. */
    documentUrl: sendUrl(baseUrl, send.token),
    document: {
      slug: send.documentVersion.document.slug,
      title: send.documentVersion.document.title,
      version: send.documentVersion.version,
    },
    contact: serializeContact(send.recipient),
    createdAt: send.createdAt.toISOString(),
    sentAt: send.sentAt?.toISOString() ?? null,
    acceptedAt: send.acceptedAt?.toISOString() ?? null,
    acceptance: send.acceptance
      ? {
          acceptedAt: send.acceptance.acceptedAt.toISOString(),
          acceptorName: send.acceptance.acceptorName,
        }
      : null,
  };
}

export function serializeSendEvent(event: SendEventRow) {
  let meta: unknown = {};
  try {
    meta = JSON.parse(event.metaJson);
  } catch {
    // A malformed blob loses its meta, not the event.
  }
  return { type: event.type, occurredAt: event.occurredAt.toISOString(), meta };
}

// ── Documents ───────────────────────────────────────────────────────────────

export type DocumentVersionRow = {
  version: number;
  changelog: string | null;
  publishedAt: Date | null;
  createdAt: Date;
};

export function serializeDocumentVersion(row: DocumentVersionRow) {
  return {
    version: row.version,
    changelog: row.changelog,
    published: row.publishedAt !== null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type DocumentRow = {
  slug: string;
  title: string;
  kind: string;
};

export function serializeDocument(
  doc: DocumentRow,
  currentVersion: number | null,
  versions?: DocumentVersionRow[],
) {
  return {
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    currentVersion,
    ...(versions ? { versions: versions.map(serializeDocumentVersion) } : {}),
  };
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export type WebhookRow = {
  id: number;
  url: string;
  eventsJson: string;
  active: boolean;
  createdAt: Date;
  revokedAt: Date | null;
};

export function webhookEvents(row: Pick<WebhookRow, "eventsJson">): string[] {
  try {
    const parsed: unknown = JSON.parse(row.eventsJson);
    if (Array.isArray(parsed)) return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    // Treated as [] = all events.
  }
  return [];
}

export function serializeWebhook(row: WebhookRow) {
  return {
    id: row.id,
    url: row.url,
    /** [] means "all events". */
    events: webhookEvents(row),
    active: row.active && row.revokedAt === null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type WebhookDeliveryRow = {
  id: number;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
};

export function serializeWebhookDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    event: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === "pending" ? row.nextAttemptAt.toISOString() : null,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
