# Self-hosting Standard-MSA

This guide takes an MSP from a fresh host to a working, maintained
Standard-MSA instance without asking Standard Computer anything. It covers
install, email provider configuration, scheduled jobs, the API, upgrades,
backups, and the data-protection obligations you take on as the operator.

Standard-MSA is a single-node application with a local SQLite database.
There is no external service dependency: no hosted database, no third-party
tracker, no phone-home.

## Requirements

- A Linux host with Docker and the compose plugin (`docker compose version`).
- A public hostname with TLS if recipients will open MSA links from the
  internet (any reverse proxy works — Caddy, nginx, Traefik).
- An email provider account (SMTP2GO, SendGrid, or any SMTP server) if you
  want the app to send mail. The app runs without one; sends then surface
  their unique links for you to deliver yourself.

## Install

```sh
git clone https://github.com/Standard-Computer/Standard-MSA.git
cd Standard-MSA
cp .env.example .env    # fill in values — see below
docker compose up -d --build
```

That is the whole install. On boot the container runs
`prisma migrate deploy` (so the database file is created and migrated
before the server starts) and then serves the app on the port `PORT` names,
falling back to **3000** when it is unset — which is the case here, and is
what `docker-compose.yml` publishes. The `msa-data` volume holds the SQLite
file across restarts and upgrades.

On a platform that injects `PORT` the app listens on that value instead; the
3000 in this section is the compose default, not a fixed port. Railway injects
`8080`, and there the public domain's target port must be `8080` too — see
[`docs/RAILWAY-TEMPLATE.md`](RAILWAY-TEMPLATE.md) §2.1.

First visit: open `http://your-host:3000`. If you set `OPERATOR_PASSWORD` in
`.env`, sign in with it; if you left it blank, you get a one-time setup
screen that asks you to choose one (see below). Either way you land in the
onboarding wizard (MSP identity, venue, contract header). It is skippable
and re-runnable from Settings → Identity.

### Signing in: the operator password

One password opens every operator screen. There are two ways to set it and
**no default** — nothing ships with a password already in it.

1. **`OPERATOR_PASSWORD` in the environment.** The original way and still the
   recommended one for an install you own the shell of: the secret never
   touches the database, and rotating it is an edit plus a restart.
2. **The first-boot `/setup` screen.** Leave `OPERATOR_PASSWORD` unset and the
   first visit to any operator screen redirects to `/setup`, which takes a
   password of at least 12 characters, stores it hashed (PBKDF2-SHA256,
   600 000 iterations, per-row salt), signs you in, and then closes
   itself for good. This is what the one-click Railway deploy uses, where
   there is no shell in which to set a variable.

Things worth knowing about option 2:

- **Whoever opens the instance first sets the password.** On a URL that is
  already reachable from the internet, open it the moment the deploy is
  green. Until it is claimed nobody can sign in — but nor is the claim
  reserved for you.
- It can only happen **once per instance**. A second submission, a second
  person or a second replica is refused twice over: the claim re-checks that
  this instance is unclaimed before it writes anything, and the write itself
  is a single row on a fixed primary key, so even a claim that loses the
  check-then-write race loses it harmlessly rather than overwriting.
- `OPERATOR_PASSWORD` **always wins** if it is set, which is also the
  recovery route if the stored password is lost: set the variable, restart,
  sign in.
- A value that is present but **shorter than 12 characters** closes the
  operator screens and does *not* reopen `/setup`. That instance has an owner
  who misconfigured it; reopening first boot would hand it to a stranger.
  Fix the variable.
- The same applies to a database the app cannot read: it fails closed rather
  than looking unclaimed.

Changing the password — by either route — invalidates every open session.
The `/legal` site and recipients' own `/msa/<token>` links are unaffected by
any of this; they are public by design.

### Put your MSA (and HIPAA BAA) into it

A fresh install has **zero documents** — `/legal` is empty and there is
nothing to send until you author one. From the home page, open
**Documents**:

1. **Import a starter template** (Master Service Agreement, HIPAA Business
   Associate Agreement) or create a blank document and paste your own
   text. Templates arrive as *your* draft — the body is Markdown with
   `{{variable}}` placeholders that fill from your MSP identity and, on
   each send, the recipient's details.
2. **Edit the draft** and watch the live preview — it renders through the
   exact pipeline the public `/legal` page and the website embed use.
   Drafts are invisible publicly.
3. **Publish.** The version becomes public at `/legal/<slug>`, immutable,
   and sendable from Sends → New. Publishing never emails anybody; telling
   prior recipients about an update is a separate, explicit choice on
   Sends → Update notices.

> **The starter templates are examples, not legal advice.** They exist so
> the product works out of the box; have your own counsel review anything
> before you publish or send it.

The same authoring is available over the API (`POST /api/v1/documents`,
`POST /api/v1/documents/{slug}/versions` — see [API.md](API.md)).

### Environment

Every setting ships as a placeholder in `.env.example`; nothing real is in
the repo. The ones that matter:

| Variable | What it does |
| --- | --- |
| `APP_BASE_URL` | The public URL of this install. Baked into MSA links, the embed, and tracking URLs — set it before sending anything. On an `https://` value the operator session cookie is marked `Secure`, so set it on any install reachable over TLS. |
| `OPERATOR_PASSWORD` | Operator sign-in, 12+ characters. Optional: leave it unset and set the password on the first-boot `/setup` screen instead (above). |
| `DATABASE_URL` | Leave as the compose default (`file:/app/data/standard-msa.db`). Required — the container refuses to start without it. |
| `EMAIL_PROVIDER` / `EMAIL_FROM` + provider keys | Mail delivery; see below. |
| `CRON_SECRET` | Long random string guarding the scheduled-job endpoints. |
| `EMAIL_WEBHOOK_SECRET` | Long random string in your provider's webhook URL. |
| `VISIT_IP_HASH_SALT` | Optional salt for the "hash visitor IPs" option. |
| `API_RATE_LIMIT_PER_MINUTE` | Per-API-key request budget (default 120). |

Secrets live in the environment only — never in the database, never in the
repo, never shown by the UI. The one exception is a password you choose in
the product itself at `/setup`, which the product therefore has to store; it
is stored the way a password is, hashed and salted, and never as plaintext.

### Running it on a platform (Railway, Fly, Render, a VPS)

The same image runs anywhere. Railway is the intended one-click path, and the
template is not published yet —
see [`RAILWAY-TEMPLATE.md`](RAILWAY-TEMPLATE.md), which also documents the
settings any other platform needs: a persistent volume at `/app/data`, a
`DATABASE_URL` pointing into it, `APP_BASE_URL` set to the public domain,
**one replica** (a SQLite file cannot be shared by two containers), and
`/api/health` as the healthcheck path — the only route that answers `200`
in every state, since `/` redirects on an unclaimed instance.

### Running it somewhere other than compose

The same image runs on any container platform, with two things to get right
because compose does them for you:

- **Set `DATABASE_URL`.** There is no default. The container exits with
  `entrypoint: DATABASE_URL is not set` rather than starting on a database
  it guessed at.
- **Attach a persistent volume at the directory the database lives in**
  (`/app/data` for the value above). Without one the entrypoint creates the
  directory, says so in the log, and the database — every document, send and
  acceptance record — is destroyed the next time the container is replaced.

### Email provider

Pick ONE provider and set its variables (`EMAIL_PROVIDER=smtp2go`,
`sendgrid`, or `smtp`), or configure provider and from-address at runtime in
Settings → Email; the environment wins when both are set. Settings → Email
shows key *presence*, capability honesty for the chosen provider, and a
send-test-email action — use it to verify before real sends.

For bounce/complaint tracking, point your provider's event webhook at
`https://YOUR-INSTALL/api/email/webhooks/<provider>?key=<EMAIL_WEBHOOK_SECRET>`.

### Scheduled jobs

Three endpoints need an external scheduler (any cron works). All take
`Authorization: Bearer $CRON_SECRET`:

```cron
*/5  * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-INSTALL/api/cron/email     # outbound mail queue + retries
*/5  * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-INSTALL/api/cron/webhooks  # signed webhook deliveries + retries
*/10 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-INSTALL/api/cron/liveness  # /legal embed liveness monitor
```

Without these, mail and webhooks still queue durably; they just only move
when the endpoint is hit.

## The API

The integration surface for PSA/AI tools is `/api/v1`:

- Create your first API key in **Settings → API**. No key ships with the
  product; until you create one, the API refuses everything.
- The OpenAPI 3.1 spec for your install is served at
  `/api/v1/openapi.json`; usage notes are in [`docs/API.md`](API.md).
- Webhook subscriptions (`POST /api/v1/webhooks`) let a PSA react to
  opened/accepted events without polling; deliveries are HMAC-signed.

## Upgrades

```sh
cd Standard-MSA
git pull
docker compose up -d --build
```

Migrations are **add-only** by project policy and run automatically on boot,
so an upgrade never rewrites or destroys existing rows. Rolling back the
code is safe for the same reason; the database never needs a downgrade step.
Take a backup before upgrading anyway (below) — it costs one file copy.

## Backups

Everything that matters is one SQLite file in the `msa-data` volume:

```sh
docker compose stop app
docker compose cp app:/app/data/standard-msa.db ./backups/standard-msa-$(date +%F).db
docker compose start app
```

The stop/start makes the copy consistent and costs seconds; a copy taken
while running is usually fine for this write-light app but can catch a
transaction mid-flight. Test restores by pointing a scratch instance's
`DATABASE_URL` at a backup copy. Your backup contains everything the
privacy section below describes — protect it accordingly.

## Visitor data, retention, and your obligations

You are the data controller for what this install records. What it records:

- **/legal visitor log** — timestamp, path/document, IP (or a salted hash if
  you enable "hash visitor IPs" in /legal settings), user agent, referrer,
  coarse region from proxy geo headers, and read-time seconds. Retention is
  an operator knob (`visitRetentionDays`, default 365); expired rows are
  purged on schedule.
- **Send lifecycle** — per-recipient events (sent, delivered, opened,
  clicked, viewed, accepted/declined) with IP and user agent. These are
  acceptance **evidence** for the contracts you send and are kept
  indefinitely by design.
- **Email delivery log** — outbound messages and provider signals.
- **API request log** — per-key method/path/status/IP, visible in
  Settings → API.

What you take on:

- **Tell your visitors and clients.** The /legal visitor log and email
  open/click tracking are your processing activities; disclose them in your
  own privacy notice, and configure IP hashing and retention to match it.
- **Honour deletion requests** for visitor-log data (contract acceptance
  evidence generally has its own legal basis — that is between you and your
  counsel).
- **Protect the database file and backups**; they hold everything above.
- **Keys are yours**: API keys and webhook secrets are created on your
  install, shown once, and stored hashed (keys) or locally (webhook signing
  secrets). Standard Computer never has them and cannot recover them.

## Troubleshooting

- **App up, no mail**: Settings → Email shows why (missing key, unverified
  sender). A failed send keeps its unique link — copy it by hand.
- **Webhooks not arriving**: check `GET /api/v1/webhooks/{id}/deliveries`
  for per-attempt status codes, and confirm the cron sweep is wired.
  Deliveries refuse private/internal destination addresses by design.
- **Migration failure on boot**: the container exits with the Prisma error
  in `docker compose logs app`. Restore the pre-upgrade backup and report
  the error.
