// Request/response schemas for /api/v1 (SHA-2960). PURE.
//
// zod is the single source: routes validate requests with these, and
// openapi.ts turns the same objects into the published OpenAPI document —
// so the spec cannot drift from what the handlers actually enforce.
//
// Requests are TOLERANT (unknown keys stripped, not rejected): the stated
// ergonomic bar is that an AI caller posting `{"email": "x@y.com"}` — and
// nothing else — gets an MSA out the door.

import { z } from "zod";
import { API_SCOPES } from "./keys";
import { WEBHOOK_EVENT_TYPES } from "./webhooks";

export const CONTACT_FIELDS = {
  email: z.email().max(320).describe("Contact email address."),
  name: z.string().max(200).describe("Contact full name.").optional(),
  company: z.string().max(200).describe("Trading/company name.").optional(),
  legalName: z.string().max(200).describe("Legal entity name used in the contract.").optional(),
  address: z.string().max(500).describe("Postal address.").optional(),
  phone: z.string().max(60).describe("Phone number.").optional(),
};

export const ContactCreateSchema = z
  .object(CONTACT_FIELDS)
  .describe("Create (or enrich, matched by email) a contact.");

export const SendCreateSchema = z
  .object({
    ...CONTACT_FIELDS,
    email: CONTACT_FIELDS.email.optional(),
    contactId: z.int().positive().describe("Send to an existing contact instead of (or as well as) `email`.").optional(),
    documentSlug: z
      .string()
      .max(80)
      .describe('Which document to send, e.g. "msa". Optional when the instance has exactly one published document (or one with the slug "msa").')
      .optional(),
    deliver: z
      .boolean()
      .describe("Email the unique link to the contact (default true). With false, the send and its URL are created for the caller to deliver.")
      .optional(),
  })
  .describe("Create one MSA send. `email` alone is enough; everything else is optional.");

export const PublishSchema = z
  .object({
    sendUpdateNotices: z
      .boolean()
      .describe("Also email an update notice to prior recipients who hold an older version (default false — notices are never automatic).")
      .optional(),
    audience: z
      .enum(["all", "accepted"])
      .describe('Audience for the update notices (default "all" stale recipients).')
      .optional(),
  })
  .describe("Publish a draft document version.");

export const WebhookCreateSchema = z
  .object({
    url: z.url().max(1000).describe("HTTPS endpoint to receive signed event POSTs."),
    events: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .max(WEBHOOK_EVENT_TYPES.length)
      .describe("Event types to deliver. Omit (or send []) for all events.")
      .optional(),
  })
  .describe("Subscribe a URL to lifecycle events.");

// ── Response shapes (OpenAPI only; serializers.ts produces them) ────────────

export const ContactSchema = z.object({
  id: z.int(),
  email: z.string(),
  name: z.string().nullable(),
  company: z.string().nullable(),
  legalName: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const SendStatusSchema = z
  .enum(["created", "sent", "delivered", "opened", "bounced", "declined", "accepted"])
  .describe("Furthest point this send has reached; never moves backwards.");

export const SendSchema = z.object({
  id: z.int(),
  status: SendStatusSchema,
  documentUrl: z.url().describe("The unique per-recipient URL for this agreement."),
  document: z.object({ slug: z.string(), title: z.string(), version: z.int() }),
  contact: ContactSchema,
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  acceptance: z
    .object({ acceptedAt: z.iso.datetime(), acceptorName: z.string().nullable() })
    .nullable(),
});

export const DeliveryInfoSchema = z.object({
  attempted: z.boolean(),
  ok: z.boolean(),
  error: z.string().nullable().describe("Why the email could not be sent (the send and its URL still exist)."),
});

export const SendCreatedSchema = SendSchema.extend({ delivery: DeliveryInfoSchema });

export const SendEventSchema = z.object({
  type: z.string(),
  occurredAt: z.iso.datetime(),
  meta: z.record(z.string(), z.unknown()),
});

export const DocumentVersionSchema = z.object({
  version: z.int(),
  changelog: z.string().nullable(),
  published: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const DocumentSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.string(),
  currentVersion: z.int().nullable().describe("Highest published version, or null while all versions are drafts."),
});

export const WebhookSchema = z.object({
  id: z.int(),
  url: z.string(),
  events: z.array(z.string()).describe("[] means all events."),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const WebhookCreatedSchema = WebhookSchema.extend({
  secret: z.string().describe("HMAC-SHA256 signing secret. Shown ONCE; store it to verify deliveries."),
});

export const WebhookDeliverySchema = z.object({
  id: z.int(),
  event: z.string(),
  status: z.enum(["pending", "delivered", "exhausted"]),
  attempts: z.int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastStatusCode: z.int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const VisitStatsSchema = z.object({
  total: z.int().describe("Visits in range."),
  totalSeconds: z.int().describe("Accrued read-time seconds across those visits."),
  embedded: z.int().describe("Visits arriving through the MSP-site embed."),
  groups: z
    .array(z.object({ key: z.string(), visits: z.int(), seconds: z.int() }))
    .describe("Per-day (YYYY-MM-DD) or per-region buckets, depending on groupBy."),
});

export const ErrorSchema = z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable code — branch on this, not the message."),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export { API_SCOPES };
