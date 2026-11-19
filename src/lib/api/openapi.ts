// OpenAPI 3.1 document for /api/v1 (SHA-2960). PURE.
//
// Generated FROM the zod schemas the handlers validate with (z.toJSONSchema
// targets draft 2020-12, which OpenAPI 3.1 adopts natively), so the spec is
// derived from code, never hand-maintained JSON. The paths table below is
// the one hand-written layer; tests/api/openapi.test.ts pins it to the
// route files on disk so a new route cannot land unspecified.

import { z, type ZodType } from "zod";
import { API_SCOPES } from "./keys";
import {
  ContactCreateSchema,
  ContactSchema,
  DocumentSchema,
  DocumentVersionSchema,
  ErrorSchema,
  PublishSchema,
  SendCreatedSchema,
  SendCreateSchema,
  SendEventSchema,
  SendSchema,
  VisitStatsSchema,
  WebhookCreatedSchema,
  WebhookCreateSchema,
  WebhookDeliverySchema,
  WebhookSchema,
} from "./schemas";
import { WEBHOOK_EVENT_TYPES } from "./webhooks";

const SCHEMAS: Record<string, ZodType> = {
  ContactCreate: ContactCreateSchema,
  Contact: ContactSchema,
  SendCreate: SendCreateSchema,
  Send: SendSchema,
  SendCreated: SendCreatedSchema,
  SendEvent: SendEventSchema,
  Document: DocumentSchema,
  DocumentVersion: DocumentVersionSchema,
  Publish: PublishSchema,
  WebhookCreate: WebhookCreateSchema,
  Webhook: WebhookSchema,
  WebhookCreated: WebhookCreatedSchema,
  WebhookDelivery: WebhookDeliverySchema,
  VisitStats: VisitStatsSchema,
  Error: ErrorSchema,
};

const ref = (name: keyof typeof SCHEMAS) => ({ $ref: `#/components/schemas/${String(name)}` });
const jsonBody = (schema: object, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const arrayOf = (name: keyof typeof SCHEMAS) => ({ type: "array", items: ref(name) });

const ERROR_RESPONSES = {
  "401": jsonBody(ref("Error"), "Missing, malformed, or revoked API key."),
  "403": jsonBody(ref("Error"), "The key lacks the required scope."),
  "422": jsonBody(ref("Error"), "Validation failed; see error.details."),
  "429": jsonBody(ref("Error"), "Rate limit exceeded; honour Retry-After."),
};

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 200 },
  description:
    "Retry-safe creates: the same key replays the first response instead of creating twice; the same key with a different body is a 409.",
};

const pageParams = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
];

function op(input: {
  summary: string;
  scope: string;
  parameters?: object[];
  requestBody?: { schema: object; required?: boolean };
  responses: Record<string, object>;
  idempotent?: boolean;
}) {
  return {
    summary: input.summary,
    description: `Requires scope \`${input.scope}\`.`,
    parameters: [...(input.idempotent ? [IDEMPOTENCY_HEADER] : []), ...(input.parameters ?? [])],
    ...(input.requestBody
      ? {
          requestBody: {
            required: input.requestBody.required ?? true,
            content: { "application/json": { schema: input.requestBody.schema } },
          },
        }
      : {}),
    responses: { ...ERROR_RESPONSES, ...input.responses },
    security: [{ apiKey: [] }],
  };
}

const idParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});

/** The whole document. `baseUrl` becomes the server entry. */
export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  const components = {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description:
          `An API key created in Settings → API, sent as \`Authorization: Bearer smsa_…\`. ` +
          `Keys carry scopes: ${API_SCOPES.join(", ")}.`,
      },
    },
    schemas: Object.fromEntries(
      Object.entries(SCHEMAS).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { io: "input", reused: "inline" }),
      ]),
    ),
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Standard-MSA API",
      version: "1",
      description:
        "Integration surface for PSA and AI tools: create contacts, send MSAs, follow each send's lifecycle, publish document versions, read /legal visit stats, and subscribe webhooks. " +
        `Webhook deliveries are signed (X-StandardMSA-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<body>">); event types: ${WEBHOOK_EVENT_TYPES.join(", ")}.`,
    },
    servers: [{ url: `${baseUrl.replace(/\/+$/, "")}/api/v1` }],
    paths: {
      "/contacts": {
        get: op({
          summary: "List contacts",
          scope: "contacts:read",
          parameters: [
            { name: "email", in: "query", schema: { type: "string" }, description: "Exact-match filter." },
            ...pageParams,
          ],
          responses: { "200": jsonBody({ type: "object", properties: { contacts: arrayOf("Contact") }, required: ["contacts"] }, "Contacts, newest first.") },
        }),
        post: op({
          summary: "Create or enrich a contact",
          scope: "contacts:write",
          idempotent: true,
          requestBody: { schema: ref("ContactCreate") },
          responses: { "201": jsonBody(ref("Contact"), "The contact (merged non-destructively when the email already existed).") },
        }),
      },
      "/contacts/{id}": {
        get: op({
          summary: "Fetch one contact",
          scope: "contacts:read",
          parameters: [idParam("id", "Contact id.")],
          responses: {
            "200": jsonBody(ref("Contact"), "The contact."),
            "404": jsonBody(ref("Error"), "No such contact."),
          },
        }),
      },
      "/sends": {
        get: op({
          summary: "List sends",
          scope: "sends:read",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "contactId", in: "query", schema: { type: "integer" } },
            { name: "documentSlug", in: "query", schema: { type: "string" } },
            ...pageParams,
          ],
          responses: { "200": jsonBody({ type: "object", properties: { sends: arrayOf("Send") }, required: ["sends"] }, "Sends, newest first.") },
        }),
        post: op({
          summary: "Create an MSA send (the core call)",
          scope: "sends:write",
          idempotent: true,
          requestBody: { schema: ref("SendCreate") },
          responses: {
            "201": jsonBody(ref("SendCreated"), "The send, including its unique documentUrl. Email delivery failure is reported in `delivery`, not as an error — the URL still works."),
            "404": jsonBody(ref("Error"), "Unknown contactId or documentSlug."),
          },
        }),
      },
      "/sends/{id}": {
        get: op({
          summary: "Fetch a send's status",
          scope: "sends:read",
          parameters: [idParam("id", "Send id.")],
          responses: {
            "200": jsonBody(ref("Send"), "The send."),
            "404": jsonBody(ref("Error"), "No such send."),
          },
        }),
      },
      "/sends/{id}/events": {
        get: op({
          summary: "Fetch a send's full lifecycle log",
          scope: "sends:read",
          parameters: [idParam("id", "Send id.")],
          responses: {
            "200": jsonBody(
              { type: "object", properties: { sendId: { type: "integer" }, events: arrayOf("SendEvent") }, required: ["sendId", "events"] },
              "Append-only event trail, oldest first.",
            ),
            "404": jsonBody(ref("Error"), "No such send."),
          },
        }),
      },
      "/documents": {
        get: op({
          summary: "List documents",
          scope: "documents:read",
          responses: { "200": jsonBody({ type: "object", properties: { documents: arrayOf("Document") }, required: ["documents"] }, "Every document, drafts included.") },
        }),
      },
      "/documents/{slug}/versions": {
        get: op({
          summary: "List a document's versions",
          scope: "documents:read",
          parameters: [idParam("slug", "Document slug.")],
          responses: {
            "200": jsonBody({ type: "object", properties: { versions: arrayOf("DocumentVersion") }, required: ["versions"] }, "All versions, newest first, drafts flagged."),
            "404": jsonBody(ref("Error"), "No such document."),
          },
        }),
      },
      "/documents/{slug}/versions/{version}/publish": {
        post: op({
          summary: "Publish a version (optionally emailing update notices)",
          scope: "documents:publish",
          parameters: [idParam("slug", "Document slug."), idParam("version", "Version number.")],
          requestBody: { schema: ref("Publish"), required: false },
          responses: {
            "200": jsonBody(
              {
                type: "object",
                properties: {
                  document: ref("Document"),
                  version: ref("DocumentVersion"),
                  alreadyPublished: { type: "boolean" },
                  notices: {
                    type: ["object", "null"],
                    properties: { ok: { type: "boolean" }, notified: { type: "integer" }, skipped: { type: "integer" }, error: { type: ["string", "null"] } },
                  },
                },
                required: ["document", "version", "alreadyPublished"],
              },
              "Published (idempotent: publishing a published version is a no-op).",
            ),
            "404": jsonBody(ref("Error"), "No such document or version."),
          },
        }),
      },
      "/stats/legal-visits": {
        get: op({
          summary: "Read /legal visit stats",
          scope: "stats:read",
          parameters: [
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            { name: "slug", in: "query", schema: { type: "string" } },
            { name: "groupBy", in: "query", schema: { type: "string", enum: ["day", "region"] } },
          ],
          responses: { "200": jsonBody(ref("VisitStats"), "Visit totals and buckets for the range.") },
        }),
      },
      "/webhooks": {
        get: op({
          summary: "List webhook subscriptions",
          scope: "webhooks:manage",
          responses: { "200": jsonBody({ type: "object", properties: { webhooks: arrayOf("Webhook") }, required: ["webhooks"] }, "Active and revoked subscriptions (secrets never shown).") },
        }),
        post: op({
          summary: "Subscribe a URL to events",
          scope: "webhooks:manage",
          idempotent: true,
          requestBody: { schema: ref("WebhookCreate") },
          responses: { "201": jsonBody(ref("WebhookCreated"), "The subscription, including its one-time signing secret.") },
        }),
      },
      "/webhooks/{id}": {
        delete: op({
          summary: "Revoke a webhook",
          scope: "webhooks:manage",
          parameters: [idParam("id", "Webhook id.")],
          responses: {
            "200": jsonBody(ref("Webhook"), "Revoked; queued deliveries are voided."),
            "404": jsonBody(ref("Error"), "No such webhook."),
          },
        }),
      },
      "/webhooks/{id}/deliveries": {
        get: op({
          summary: "List a webhook's recent deliveries",
          scope: "webhooks:manage",
          parameters: [idParam("id", "Webhook id.")],
          responses: {
            "200": jsonBody({ type: "object", properties: { deliveries: arrayOf("WebhookDelivery") }, required: ["deliveries"] }, "Most recent 100 deliveries."),
            "404": jsonBody(ref("Error"), "No such webhook."),
          },
        }),
      },
    },
    components,
  };
}
