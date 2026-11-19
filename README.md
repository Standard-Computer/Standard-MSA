# Standard-MSA

Stand-alone, self-hosted legal document platform for MSPs: publish and
version your MSA, HIPAA BAA and other client-facing legal documents; put them
on your website; send unique per-client copies by email; and keep
court-ready records of who visited, opened, and accepted what, when.

Built by [Standard Computer](https://standardcomputer.com). The document
engine is ported from the legal/compliance module of our in-house PSA, where
it runs in production.

## What it does

- **Document library** — markdown documents with merge variables, drafts,
  published versions, effective dates, diffs between versions, PDF export.
  Document types are data: v1 ships the MSA and the HIPAA BAA; your custom
  agreement needs no code change.
- **Authoring built in** — the `/documents` screen creates, drafts,
  previews and publishes your documents, with MSA and HIPAA BAA starter
  templates so a fresh install is never empty. **The templates are
  examples, not legal advice** — have your own counsel review anything
  before you publish or send it.
- **Onboarding wizard** — enter MSP identity once (name, legal name, address,
  owner/CEO, website, venue for governing law); preview the contract header;
  re-run any time. Skippable.
- **Your website's `/legal`** — a copy-paste embed snippet serves your
  published documents on your own site, with a liveness monitor that emails
  you if the embed stops working, and a visitor log (timestamp, IP, region)
  for every view.
- **Unique sends** — send a document to a client from as little as an email
  address. Each send gets its own link, frozen at the version the client
  actually read, with a full lifecycle trail: sent, opened, clicked,
  accepted — kept as acceptance evidence.
- **Update notices** — publish a new version, notify recipients, keep proof
  of who was told.
- **Email, your way** — SMTP2GO, SendGrid, or plain SMTP. Configured at
  runtime; keys live in your environment, never in this repo or the database.
- **API** — PSA and AI tools can create sends and read acceptance status via
  a token-authenticated REST surface.

## Quick start

```sh
git clone https://github.com/Standard-Computer/Standard-MSA.git
cd Standard-MSA
echo "OPERATOR_PASSWORD=$(openssl rand -base64 24)" >> .env
docker compose up
```

Open http://localhost:3000, sign in with that password, and the onboarding
wizard takes it from there. Data lives in a SQLite file on a Docker volume;
back up by copying the file.

The full operator guide — email providers, scheduled jobs, upgrades,
backups, visitor-data retention and your privacy obligations — is
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

### Development

```sh
cp .env.example .env     # then set OPERATOR_PASSWORD; the rest is fine for dev
npm install
npx prisma migrate dev
npm run dev
```

Gates (all run in CI): `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`.

`npm test` runs node's test runner under `--conditions=react-server`, which is
how Next resolves modules on the server. Without it `import "server-only"`
resolves to that marker package's throwing entry point, so a DB-backed test of
any module transitively importing a `server-only` one fails on import instead
of on something it asserts.

## Project layout

```
prisma/           schema + migrations (SQLite default; add-only changes)
src/app/          Next.js App Router — public /legal, signing pages, operator UI, API
src/lib/          domain modules: identity, legal, email, sends, visits, api
docs/             ARCHITECTURE.md (data model, module boundaries),
                  PORT-ASSESSMENT.md (what was ported from where),
                  SELF-HOSTING.md (operator guide), API.md (integration API)
tests/            node:test suites, one directory per module
```

Module boundaries and lane ownership: `docs/ARCHITECTURE.md`.

## The /legal embed

Settings → **Legal embed** (`/embed`) generates the code to paste on your
website's `/legal` page. Two variants, one renderer:

```html
<div id="sm-legal"></div>
<script src="https://YOUR-INSTALL/legal/embed.js" async></script>
```

or, for site builders that strip scripts, the same frame as a plain iframe:

```html
<iframe src="https://YOUR-INSTALL/legal/embed/frame" title="Legal agreements"
        style="width:100%;border:0;height:1200px" loading="lazy"></iframe>
```

The script variant auto-sizes, inherits your site's fonts, and keeps deep
links (`#msa`, `#msa-v2`) working. Content updates automatically when you
publish a new version — the snippet never changes. The embed serves **all**
published documents (MSA, HIPAA BAA, anything you add). Optional: restrict
which websites may frame it (empty = any; the content is public either way,
the restriction only prevents other sites passing your agreements off as
theirs), and a `?theme=dark|auto` / `data-theme` toggle.

## Visitor log

Every view of the public `/legal` pages and of the embed frame is recorded
in the local `LegalVisit` table (screen: `/visits`, with document/date
filters and CSV export). **Exactly what is stored per visit:**

- timestamp, path, document slug/version viewed (the embed records the list
  of documents shown)
- visitor IP address (**or** a salted SHA-256 hash when *hash visitor IPs*
  is on — default off; set `VISIT_IP_HASH_SALT`), user agent, referrer
  (for the embed this is the page your snippet is on)
- country/region — derived **only** from proxy geo headers you control
  (`CF-IPCountry`, `X-Vercel-IP-Country(-Region)`, `X-Geo-*`). No external
  geo lookup is ever made; with no proxy geo headers these stay empty
- a random per-page-load visit id and accumulated visible time-on-page from
  the read timer (server-clamped). **No cookies, no localStorage, no
  cross-visit identifier** — the embed frame sets no cookie at all

**Retention is yours to configure** (`/embed` → visit retention, default
365 days); the scheduled job purges older rows. You self-host this data, so
GDPR/CCPA obligations for visitor IPs rest with you — if that concerns you,
turn on IP hashing and shorten retention.

## Liveness monitor

The monitor fetches your website's `/legal` page on a schedule and asserts
the embed is actually present — not just HTTP 200: it checks the snippet
markers on your page *and* that this install's frame renders. After **two
consecutive failures** it emails your MSP notification address once per
outage, with one recovery notice when the page is healthy again (nothing in
between; delivery uses the configured email provider — until one is set up,
outages are still recorded and shown on `/embed`).

Wire the schedule with any cron (every 5–15 minutes):

```
*/10 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-INSTALL/api/cron/liveness
```

Set `CRON_SECRET` in the environment. The same tick runs the visitor-log
retention purge. (`?secret=` is accepted too, but the header form keeps the
secret out of proxy logs.)

## The API

PSA and AI tools integrate through `/api/v1`: create contacts, create MSA
sends (an email address alone is enough; the response carries the unique
per-recipient `documentUrl`), follow each send's lifecycle, author and
publish document versions, read `/legal` visit stats, and subscribe
HMAC-signed webhooks for
opened/accepted without polling. API keys are created in Settings → API —
none ship with the product — scoped per integration, hashed at rest, and
logged per request. The OpenAPI 3.1 spec is served at
`/api/v1/openapi.json`; conventions and the webhook contract are in
[`docs/API.md`](docs/API.md).

## Status

Scaffold stage. The build is green and the architecture is set; capability
modules land as independent lanes (onboarding, /legal + embed, email
delivery, sends & acceptance, public API).

## License

[Business Source License 1.1](LICENSE) (source-available). You may self-host
and run Standard-MSA for your own business free of charge — including as an
MSP publishing, sending and tracking legal documents for your own clients.
What the licence does not permit is offering Standard-MSA itself as a
competing hosted or embedded product. On the Change Date (2030-11-18) the
licence converts to Apache License 2.0. For other arrangements, contact
sean@standardcomputer.com.

## Security

### Who can reach what

Three kinds of request surface, listed in full in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and encoded in
`src/lib/auth/surfaces.ts`:

- **Public** — your `/legal` site, the embed, and each recipient's own
  `/msa/<token>` agreement link. The token is 256 bits of CSPRNG and is the
  whole authorisation: there is deliberately no recipient login, because
  asking a prospect to create an account is how an MSA does not get signed.
- **Operator** — everything else: the console, `/sends`, `/settings`, the
  visitor log, the evidence downloads. Gated server-side on a session cookie
  minted from `OPERATOR_PASSWORD`.
- **Machine** — `/api/cron/*` (`CRON_SECRET`), `/api/v1/*` (API key), the
  webhook and tracking endpoints (provider secret or unguessable uuid).

`OPERATOR_PASSWORD` is **required**. Unset, too short, and the operator
screens refuse everyone and say what to set — they do not open. It is one
shared password for the single-operator v0 model, read only from the
environment (there is no password column), so changing it and restarting
signs out every open session. Failed sign-ins are throttled per client IP.

If you expose an instance to the internet, put it behind TLS: set
`APP_BASE_URL` to its `https://` URL and the session cookie is issued
`Secure` (it is always `HttpOnly` and `SameSite=Lax`).

### Reporting

No credentials belong in this repo, ever. `.env.example` carries placeholders
only and CI runs a secret scan on every push. If you find a security issue,
email security@standardcomputer.com rather than opening a public issue.
