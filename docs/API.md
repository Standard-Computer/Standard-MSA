# Standard-MSA API

The integration surface for PSA and AI tools: create contacts, send MSAs,
follow each send's lifecycle, publish document versions, read `/legal`
visit stats, and subscribe webhooks.

The machine-readable truth is the OpenAPI 3.1 spec your install serves at
`GET /api/v1/openapi.json` — generated from the same zod schemas the
handlers validate with, so it cannot drift from behaviour. This page is the
human companion: conventions, the core flow, and the webhook contract.

## Auth

Create a key in **Settings → API** (no key ships with the product) and send
it on every request:

```
Authorization: Bearer smsa_…
```

Keys are stored as SHA-256 hashes and shown once. Each key carries scopes
(`contacts:read`, `contacts:write`, `sends:read`, `sends:write`,
`documents:read`, `documents:publish`, `stats:read`, `webhooks:manage`); a
key created with no scopes ticked has all of them. Revocation is immediate.
Every authenticated request is logged per key (method, path, status, IP) —
visible in Settings → API.

## Conventions

- **Errors** are one shape with a stable machine code — branch on
  `error.code`, never on the message:

  ```json
  { "error": { "code": "validation_failed", "message": "…", "details": [{ "path": "email", "message": "…" }] } }
  ```

  Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404,
  `validation_failed` 422, `conflict`/`idempotency_key_reused`/
  `email_not_configured` 409, `rate_limited` 429, `internal_error` 500.

- **Idempotency**: POST creates accept an `Idempotency-Key` header
  (≤200 chars, any unique string). Retrying with the same key within 24 h
  returns the first response verbatim with `Idempotency-Replayed: true`;
  the same key with a different body is a 409. Always send one from
  automation.

- **Rate limiting**: token bucket per key, default 120 requests/minute
  (operator-tunable via `API_RATE_LIMIT_PER_MINUTE`). Every response
  carries `X-RateLimit-Limit` / `X-RateLimit-Remaining`; a 429 carries
  `Retry-After` seconds.

- **Tolerant creates**: unknown body keys are ignored, and the minimum
  viable payload is genuinely minimal — `POST /sends` with
  `{"email":"client@example.com"}` is a complete request.

## The core flow

```sh
BASE=https://YOUR-INSTALL/api/v1
AUTH="Authorization: Bearer $SMSA_KEY"

# 1. Create the send — contact is created/enriched from the email.
curl -s -X POST -H "$AUTH" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"email":"client@example.com","name":"Dana Reyes","company":"Reyes Dental"}' \
  "$BASE/sends"
# -> 201 { "id": 12, "status": "created",
#          "documentUrl": "https://YOUR-INSTALL/msa/<unique-token>",
#          "delivery": { "attempted": true, "ok": true, "error": null }, … }

# 2. Poll status (or skip polling — subscribe a webhook below).
curl -s -H "$AUTH" "$BASE/sends/12"

# 3. Read the full lifecycle log — acceptance evidence included.
curl -s -H "$AUTH" "$BASE/sends/12/events"
```

Notes on `POST /sends`:

- `documentUrl` is the unique per-recipient link — surface it in your tool;
  it is the thing the recipient reads and accepts.
- Email delivery failure does **not** fail the call: the send and its URL
  exist; `delivery.error` says why mail didn't go (e.g. provider not
  configured) so your tool can deliver the link itself. Pass
  `"deliver": false` to skip the app's email on purpose.
- `documentSlug` picks the document; omit it and the instance's `msa`
  document (or its only published document) is used.
- A draft version is never sent — publishing is explicit
  (`POST /documents/{slug}/versions/{version}/publish`, optionally with
  `{"sendUpdateNotices": true}` to notify holders of older versions —
  notices are opt-in per request, never automatic).

## Webhooks

Subscribe once and react to lifecycle events instead of polling:

```sh
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://your-psa.example.com/hooks/msa","events":["send.opened","send.accepted"]}' \
  "$BASE/webhooks"
# -> 201 { "id": 3, "secret": "whsec_…", … }   # secret shown ONCE
```

Event types mirror the send trail — `send.created`, `send.sent`,
`send.delivered`, `send.opened`, `send.clicked`, `send.viewed`,
`send.accepted`, `send.declined`, `send.bounced` — plus
`document.published`. Omit `events` to receive everything.

Each delivery is a POST with the JSON payload
`{ "event": "send.accepted", "occurredAt": "…", "send": { … } }` and
headers:

```
X-StandardMSA-Event:     send.accepted
X-StandardMSA-Delivery:  41
X-StandardMSA-Signature: t=1763500000,v1=<hex>
```

Verify: compute HMAC-SHA256 over `"<t>.<raw body>"` with your `whsec_`
secret and compare to `v1` (constant-time); reject stale `t` to taste.
Answer 2xx fast. Failures retry at 1 m, 5 m, 15 m, 1 h, 4 h, 12 h, 24 h,
then the delivery is marked exhausted —
`GET /webhooks/{id}/deliveries` shows every attempt's outcome. Deliveries
are dispatched by the `/api/cron/webhooks` sweep (see
[SELF-HOSTING.md](SELF-HOSTING.md) § Scheduled jobs).

Destination URLs must be public: anything resolving to loopback, RFC1918,
link-local or similar is refused at creation and again at every delivery.

## Changelog discipline

Error codes, event types, and response field names are a compatibility
surface: additions are fair game, renames/removals get a changelog entry
here and a version note in the OpenAPI `info.version`.
