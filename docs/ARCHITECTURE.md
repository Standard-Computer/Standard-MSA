# Standard-MSA architecture

Single-tenant, self-hosted legal document platform for one MSP. Next.js (App
Router) + TypeScript + Prisma, SQLite by default. Ported from ShadowPSA's
legal/compliance modules — see `docs/PORT-ASSESSMENT.md` for what comes from
where and why.

## v1 scope (board ruling, 2026-11-18)

**v1 ships the MSA and the HIPAA BAA together**, matching what the upstream
module already does in production. This is a scope statement, not a design
change: the engine is type-agnostic (principle 1), so the BAA is a second
`LegalDocument` row, not a second code path. Concretely:

- Both document types are seeded/importable in v1; the document import and
  public `/legal` surface (SHA-2957) list and serve **all** published
  documents, never a hard-coded MSA.
- Sends, acceptance evidence and update notices (SHA-2959) operate on *a
  document version*, whichever document it belongs to — one engine, both
  types, and any custom type an MSP adds.
- The public API (SHA-2960) takes a document slug/ID on send creation;
  nothing in the contract is MSA-specific.
- Anything genuinely BAA-specific (e.g. BAA-only merge variables) must land
  as data — rows and variable definitions — not as `kind === "baa"` branches.

## Principles

1. **Type-agnostic documents.** MSA and HIPAA BAA both ship in v1 (see scope
   above); a third type must need zero code changes. Document types are rows
   (`LegalDocument`), never enums or `slug === "msa"` branches.
2. **Single tenant.** One install serves one MSP. Settings are singletons;
   there is no org/tenant column anywhere.
3. **No secrets in the repo or the database.** Provider keys come from env.
   DB rows store which env var *name* to read, never a value. `.env.example`
   ships placeholders only; CI runs a secret scan.
4. **Evidence is append-only and frozen at the moment it matters.** Sends
   snapshot the document version, consent text and expiry at send time;
   acceptance rows denormalise version + hash + rendered body; event trails
   are append-only.
5. **Email failures are data, not exceptions.** The transport returns
   `{ok} | {ok:false, error}`; callers store a skip/failure reason and the
   sweep classifies recipient-attributable (terminal) vs infra (retry).

## Data model

All models live in `prisma/schema.prisma` (already scaffolded; changes are
add-only). The shape, by area:

- **MSP identity/brand** — `MspIdentity`: trading name, legal name, address,
  owner/CEO, notification email, website, venue (governing-law line), logo.
  Written by the onboarding wizard, read by the contract-header renderer,
  footers and email templates. Single row.
- **Documents & versions** — `LegalDocument` (slug, title, kind) ↔
  `LegalDocumentVersion` (per-document integer version, markdown body with
  `{variable}` placeholders, variable defaults, changelog, `publishedAt`).
  "Current" = highest published version in force; drafts are invisible to the
  public surface. One draft per document (partial unique index), published
  versions immutable (trigger).
- **Variables** — the 19-key merge vocabulary (MSP-, recipient- and
  acceptance-sourced) with three render modes: `blanks` (labelled blanks),
  `public` (MSP values filled, recipient values generic — the only mode the
  public site uses, so client data can never leak there), `filled` (per-send).
- **Recipients/contacts** — `Recipient`: email, full name, company, legal
  name, address, phone. Deliberately flat — no sites, CRM stages or quote
  links. API and ad-hoc sends create these on the fly from as little as an
  email address.
- **Sends** — `Send`: one outbound document to one recipient; unguessable
  token, FK to the exact `LegalDocumentVersion`, merged variables frozen at
  send time, status (`created|sent|delivered|opened|accepted|declined|
  bounced`). `SendEvent`: append-only lifecycle trail (sent, opened, clicked,
  viewed, accepted…) with IP/UA/meta — this is the acceptance evidence.
  `AcceptanceRecord`: 1:1 with an accepted send — timestamp, name, IP, UA,
  signature payload, frozen evidence snapshot.
- **Visit log** — `LegalVisit`: every public `/legal` page and embed-frame
  view; timestamp, path, document/version, IP, UA, referer, region (derived
  from edge headers / local GeoIP when available; never a paid lookup).
  `SiteCheck`: liveness probes of the MSP-site embed with alert state.
- **Update notices** — `UpdateNotice`: which new version, audience
  (all/accepted/selected), per-recipient fan-out and send state.
- **Email provider config** — `EmailProviderConfig`: provider choice
  (smtp2go|sendgrid|smtp), from-address, non-secret settings JSON. Secrets
  stay in env.
- **API** — `ApiKey`: name + SHA-256 hash; plaintext shown once at creation.

### Datastore

SQLite is the shipped default (`datasource db { provider = "sqlite" }`,
`DATABASE_URL="file:..."`). Rationale in `docs/PORT-ASSESSMENT.md` § Stack
decision. Rules that keep Postgres reachable later:

- No SQLite-only tricks in the schema; keep types/indexes provider-portable.
- JSON payloads are `String` columns with `Json` suffix naming; parse at the
  boundary (works identically on both providers).
- Enforcement that ShadowPSA does with Postgres triggers (append-only
  acceptance/events, immutable published versions) lands as SQLite triggers
  in the C5 migration plus app-level checks as the backstop.

## Module boundaries (= delivery lanes)

Each lane owns disjoint files. Shared foundation (scaffold, schema, this doc)
is already landed; lanes extend without editing each other's files.

| Lane | Issue | Owns (new files only) |
|---|---|---|
| Onboarding / identity | SHA-2956 | `src/lib/identity/**`, `src/app/onboarding/**`, `src/app/settings/identity/**`, `src/components/identity/**`, `tests/identity/**` |
| Public /legal + embed + visits + liveness | SHA-2957 | `src/lib/legal/**` (documents, versions, variables, embed, footer, intro, diff, import, pdf), `src/lib/visits/**`, `src/lib/liveness/**`, `src/app/legal/**`, `src/app/api/legal/**`, `src/app/api/cron/liveness/**`, `src/app/embed/**` (snippet generator), `src/app/visits/**` (visit log UI + CSV), `src/components/legal/**`, `tests/legal/**` |
| Email delivery | SHA-2958 | `src/lib/email/**` (contract, gates, failure classification, smtp2go/sendgrid/smtp transports), `src/app/settings/email/**`, `tests/email/**` |
| Sends & acceptance | SHA-2959 | `src/lib/sends/**` (engine, evidence, signature, consent, verify, pdf), `src/lib/notices/**`, `src/app/a/[token]/**` (public signing), `src/app/sends/**` (operator UI), `src/app/api/cron/sweep/**`, `src/components/sends/**`, `tests/sends/**` |
| Public API + packaging | SHA-2960 | `src/app/api/v1/**`, `src/lib/api/**`, `docs/API.md`, `tests/api/**` |
| Operator shell + navigation | SHA-4496 | `src/lib/nav/**`, `src/components/nav/**`, `tests/nav/**`, and the shared `src/app/layout.tsx` + `src/app/page.tsx` (see the navigation note below) |

Cross-lane contracts (who calls whom):

- 2957's `src/lib/legal` is the foundation library; 2959 imports it (render,
  current-version, variables). 2957 lands first among the two.
- 2958's `sendEmail()` contract is the only way any lane sends mail.
- 2956's `MspIdentity` reader is the only source of brand/venue values.
- 2960 is a thin wrapper over 2959's engine; it adds no business logic.

Shared-file rules: `prisma/schema.prisma` is pre-seeded with the full v0
model — lanes only touch it for genuinely new columns, add-only, one lane at
a time. `package.json` dep additions are fine (JSON merges cleanly); note
them in the PR description.

**Navigation — superseded 2026-11-27 (SHA-4496, GH #17).** This paragraph
used to end: *"`src/app/layout.tsx` and the home page belong to SHA-2956;
other lanes add routes, not nav edits."* That was a v0 scaffolding rule to
stop five lanes editing one file at once, and it worked — at the cost of
`/embed` and `/settings/email` shipping complete and then sitting unreachable
from the console, because no lane was allowed to link them and no rule said
anybody had to. Sean filed GH #17 on it. There is now a shared operator
shell, so **the nav is not a file any more**:

- Add a module to **`src/lib/nav/operatorNav.ts`** (`NAV_LINKS` for the left
  rail, `MODULE_CARDS` for the home dashboard). That is the whole edit; no
  lane touches the layout or the home page to get linked.
- `src/app/layout.tsx`, `src/app/page.tsx` and
  `src/components/nav/OperatorShell.tsx` render *from* that table. They stay
  shared files — one lane at a time, as before.
- `tests/nav/links.test.ts` walks `src/app` and **fails when an operator
  screen is neither in the nav nor a sub-screen of something that is.** A
  screen that is only ever reached from inside another one goes in
  `NAV_EXEMPT_SCREENS` with the reason. So "add a route, not nav edits" is
  now exactly backwards: adding an operator screen means claiming a nav
  destination for it, the same bargain `surfaces.ts` already strikes for auth.

## Request surfaces

- **Public, no auth:** `/legal`, `/legal/[slug]` (+version/history/compare/
  pdf), `/legal/embed.js`, `/legal/embed/frame`, `/msa/[token]` signing
  pages, `/login`, and `/setup` (first boot, SHA-4455 — see below). Public
  pages render variables in `public` mode only.
- **Liveness:** `GET /api/health` returns a fixed `{"ok":true}` to anyone.
  It is the only path that answers `200` in every state of the app, which is
  what a platform healthcheck needs; it deliberately reports no version, no
  migration state and no data (SHA-4455).
- **Operator UI:** everything else — single-operator model at v0 (the MSP),
  gated server-side on a session cookie derived from the operator password
  (`src/lib/auth/**`, SHA-3047). Every operator page, route handler and
  server action calls the guard as its first statement.
  Nothing in the gate is a client-side redirect: a redirect that has already
  shipped the HTML has already shipped the send token.

  The operator chrome reads the same registry (SHA-4496):
  `shouldRenderOperatorNav()` in `src/lib/nav/operatorNav.ts` asks
  `classifyPath()` whether a path is an operator *screen*, so the left nav
  appears exactly where the gate applies and nowhere else. The public legal
  site, `/msa/[token]`, `/login` and `/setup` render as they always did. The
  nav itself enforces nothing and renders no data — it is a fixed list of
  links, identical for every request, and the page's own `requireOperator()`
  still runs first.

  This supersedes the earlier note here that the auth story was "kept
  minimal; hardening is explicitly on the roadmap, not blocking lanes". It
  contradicted `PORT-ASSESSMENT.md` § Auth ("before the operator screens
  ship"), and PORT-ASSESSMENT was right — the screens had already shipped:
  `/sends/[id]` rendered the accept token and `/sends/[id]/evidence`
  returned recipient email, address, phone, IP and user agent, both off a
  sequential integer id on an unauthenticated path. Sean ordered the fix on
  2026-11-18 (SHA-3047), which settles the question: **this split is
  load-bearing, not aspirational.** `src/lib/auth/surfaces.ts` is the
  machine-readable copy of the list, and `tests/auth/coverage.test.ts` fails
  the build when a route under `src/app` is unclassified or an operator
  route forgets the guard. Adding a route means classifying it there.

  **Where the password comes from (SHA-4455).** `OPERATOR_PASSWORD` is still
  the first source and still wins wherever it is set. It is no longer the
  only one: a one-click deploy has no shell in which to set a variable, and
  the alternative — shipping a default password in a public template — is a
  published credential for every instance ever deployed from it. So an
  instance with no `OPERATOR_PASSWORD` is *unclaimed*: operator screens
  redirect to `/setup`, the first visitor sets a password, and it is stored
  as a PBKDF2-SHA256 derivation in `OperatorCredential`
  (`src/lib/auth/credential.ts`). Three properties keep this from widening
  the gate: the claim is a single INSERT on a fixed primary key, so it can
  happen exactly once and cannot be raced; the plaintext is never stored and
  never signs a session; and an instance that is *misconfigured* rather than
  unclaimed — `OPERATOR_PASSWORD` set but too short, or a database that
  cannot be read — fails closed instead of reopening `/setup`.
  `src/lib/auth/gate.ts` is that decision table, and `tests/auth/gate.test.ts`
  is one test per row.

  This is the one qualification on "secrets stay in env" below: a secret the
  operator *chooses in the product* has to be stored by the product, so it is
  stored the way a password is — hashed, salted, per row. No provider key, no
  API key and no cron secret moved.
- **Cron:** `GET /api/cron/*` guarded by `CRON_SECRET` (liveness checks,
  send sweeps, notice sweeps). Self-host scheduling via container cron or
  host crontab; compose ships a sensible default.
- **API:** `/api/v1/*` with `Authorization: Bearer <api key>`; create
  recipient+send, read status/events, list documents.

## Embed

Three parts, ported intact from ShadowPSA: a copy-paste `<script>` snippet
that loads `/legal/embed.js`; the ES5 loader that injects an iframe of
`/legal/embed/frame` (height handshake via postMessage, 3-second failsafe,
origin checks); the frame route serving self-contained HTML with
`frame-ancestors` from the configured origin allow-list. Frame views write
`LegalVisit` rows — that plus the liveness checker is how the MSP knows the
embed is alive and being read.

## Self-host story

`docker compose up` → one container, standalone Next server, SQLite on a
named volume, migrations applied on start (`docker-entrypoint.sh`). The
standalone bundle traces only what the *server* imports, so the Prisma CLI
that applies those migrations ships beside it in its own self-contained tree
at `/app/prisma-cli/node_modules`, staged by
`scripts/collect-prisma-cli.ts`. Copying a CLI out of a dev install means
copying its whole dependency closure — npm hoists transitive dependencies to
the top level, so picking packages by hand omits them and the container
crash-loops on MODULE_NOT_FOUND before the server ever starts (SHA-4378).
`tests/docker/prisma-cli-closure.test.ts` is the guard. First
visit redirects to onboarding until `MspIdentity` exists. Upgrades:
`docker compose pull && up -d` — migrations are additive. Backup = copy the
volume's SQLite file. No external services required; email is optional until
a provider is configured (the app degrades to link-sharing mode with every
send gate storing "emails not configured" as the skip reason).

Worked by: Viper CTO (SF2 / SHA).
