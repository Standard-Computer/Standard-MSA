# Railway one-click template

The deploy-in-one-click configuration for Standard-MSA: what the template
contains, why, and the exact Railway-side settings to apply. Lane SHA-4455.

Goal: someone clicks **Deploy on Railway**, waits, opens the URL they are
given, sets a password, and has a working MSA tool. No shell, no environment
variables to invent, no default credentials.

## 1. There is no database service, and that is not an omission

**Confirmed from the schema, not assumed.** `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

The datasource is **SQLite**. A Railway Postgres service in this template
would be billed, empty and unused — Prisma would never connect to it, and
pointing `DATABASE_URL` at it would make every migration fail, because the
migrations in `prisma/migrations/` are SQLite DDL.

So the template's persistence is **a volume, not a database service**:

| | Value |
|---|---|
| Mount path | `/app/data` |
| Size | 1 GB |
| `DATABASE_URL` | `file:/app/data/standard-msa.db` |

This is the same layout `docker-compose.yml` uses for self-hosting, which is
deliberate: one supported persistence story, exercised by both paths.

**The volume is not optional.** Without it the SQLite file is written inside
the container and dies with the replica — every redeploy silently starts from
an empty database. For a tool whose entire value is court-ready acceptance
evidence, an instance that quietly forgets is worse than one that fails, so
`docker-entrypoint.sh` logs a named warning when `/app/data` is not a mount.

**One replica only.** A SQLite file on one volume cannot be shared by two
containers. `railway.json` pins `numReplicas: 1`; raising it corrupts the
database rather than scaling the app. Scaling this product means Postgres,
which is a schema change and a different lane.

If Postgres is wanted later the schema is already written to be portable (no
SQLite-only constructs) — but it is a real migration, not a template setting.

## 2. Railway-side settings

Everything below is applied in Sean's Railway account; none of it can live in
the repo. `railway.json` carries what Railway reads from the repo (builder,
healthcheck, replica count, restart policy) and nothing else.

### Service: Standard-MSA

| Setting | Value | Why |
|---|---|---|
| Source | `Standard-Computer/Standard-MSA`, branch `main` | — |
| Builder | Dockerfile (from `railway.json`) | The repo's own image; Nixpacks would miss the Prisma CLI staging |
| Volume | 1 GB mounted at `/app/data` | §1 |
| Public domain | **Generate a domain** | Without it the service is Unexposed and there is no front end to reach — this is why nothing was visible on the first attempt |
| Healthcheck | `/api/health` (from `railway.json`) | The one path that answers `200` in every state; `/` and `/login` redirect on an unclaimed instance |
| Replicas | 1 (from `railway.json`) | §1 |

### Variables

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | `file:/app/data/standard-msa.db` | **Yes** — the entrypoint refuses to start without it, by design |
| `APP_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | **Yes** — see below |
| `PORT` | *(leave unset)* | Railway injects it; `server.js` honours it |

`APP_BASE_URL` matters more than it looks. It is the base for the links in
sent agreements and the `/legal` embed, and it is what decides whether the
operator session cookie carries `Secure` (`secureCookies()` keys off the
configured base URL rather than `NODE_ENV`, so a self-hoster on plain http is
not locked out of their own tool). On a public https Railway domain with
`APP_BASE_URL` unset, the session cookie would ship without `Secure`. Use
Railway's reference variable so it tracks the generated domain.

Everything else in `.env.example` is optional and belongs in the app's own
Settings screens or in variables the operator adds later: email provider keys,
`CRON_SECRET`, `EMAIL_WEBHOOK_SECRET`, `VISIT_IP_HASH_SALT`,
`API_RATE_LIMIT_PER_MINUTE`.

**`OPERATOR_PASSWORD` is deliberately NOT in the template.** See §3.

### Publishing

1. Railway → the configured project → **Settings → Publish as template**.
2. Confirm the template carries: the service, the 1 GB `/app/data` volume, the
   two variables above, and a generated domain.
3. The kickback is attached to the publishing account (Sean's), and the
   referral code goes in the button URL below.
4. Deploy the published template once into a fresh project and run the
   acceptance check in §5 against *that* deploy. A template is only proven by
   a deploy that came from it — the project it was published from had its
   settings applied by hand.

## 3. First boot: no default credentials

A template cannot ship an operator password. A fixed one in the template is a
published credential for every instance ever deployed from it, and that is not
a trade worth making for a tool that holds signed agreements.

So an instance with no `OPERATOR_PASSWORD` is **unclaimed**, and the first
person to open it sets the password:

- `/` and every operator screen redirect to **`/setup`**.
- `/setup` takes a password of at least 12 characters, stores it as a
  PBKDF2-SHA256 derivation (600k iterations, per-row salt), signs the operator
  in, and lands them on the MSP onboarding wizard.
- It then closes permanently. The claim is a single INSERT on a fixed primary
  key, so a second submission — or a second person, or a second replica — is
  refused by the database rather than by a check that could race.
- Downloads and API-shaped surfaces answer `503`, never a redirect to a form.
  An unclaimed instance serves no evidence, no send and no token.

**Whoever reaches `/setup` first owns the instance.** This is how first-boot
setup works in every tool that has one, and it is why the deployer should open
the URL as soon as the deploy is green, before sharing it. The screen says so.

**`OPERATOR_PASSWORD` still wins wherever it is set**, so the self-hosted
story is unchanged and an operator who loses the stored password recovers by
setting the variable and restarting. A *present but too short* value fails
closed and does **not** reopen `/setup`: that instance has an owner who
misconfigured it, and reopening first boot there would hand it to a stranger.

## 4. The Deploy button, for seankubin.com

Markdown:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/TEMPLATE_CODE?referralCode=REFERRAL_CODE)
```

HTML:

```html
<a href="https://railway.com/template/TEMPLATE_CODE?referralCode=REFERRAL_CODE">
  <img src="https://railway.com/button.svg" alt="Deploy on Railway" />
</a>
```

`TEMPLATE_CODE` comes from the published template's URL; `REFERRAL_CODE` is
the publishing account's referral code. Both are Railway-side values — they
are not in this repo, and the README link is a placeholder until they exist.

## 5. Acceptance check for a template deploy

Run against a **fresh** deploy of the published template:

1. **Build and boot.** Deploy log reaches
   `All migrations have been successfully applied` (or
   `No pending migrations to apply`) and then Next.js `✓ Ready`. No
   `DATABASE_URL is not set`, no `NOTE this path is not a mounted volume`.
2. **Health.** `curl -i https://<domain>/api/health` → `200`, `{"ok":true}`.
3. **Front end.** `GET https://<domain>/` → `303` to `/setup`; `/setup` serves
   the form. (Before this lane, `/` served nothing: the service had no domain.)
4. **Setup.** Submit a 12+ character password → redirected to `/onboarding`,
   signed in.
5. **Setup closes.** Reopen `/setup` → redirected to `/login`.
6. **Persistence.** Complete onboarding, then redeploy. The MSP identity is
   still there and `/login` accepts the same password — proving the volume is
   mounted and the credential outlived the container.
7. **Public surfaces.** `/legal` loads without a session.

Record the deployment id and the first lines of the deploy log on the lane
card. Steps 3–6 are the ones that fail if the volume or the domain is missing,
which is exactly what went wrong before this template existed.
