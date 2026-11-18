# Standard-MSA — Architecture

Stand-alone, self-hosted port of the ShadowPSA compliance/legal module.
One MSP per install; no multi-tenancy, no client/ticket/billing coupling.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router, standalone output) | Matches ShadowPSA, so ported code moves with minimal rewrites; `output: "standalone"` gives a single-process self-host story. |
| Data | Prisma 6 on **SQLite** | Sean's requirement is a *local* database; SQLite makes install = `npm ci && prisma migrate deploy`. Fields stay portable so Postgres can be offered later. |
| Validation | Zod 4 | Same as ShadowPSA; request input is validated at the boundary. |
| Styling | Tailwind 3 | Ported components from ShadowPSA use Tailwind classes. |
| Email | Runtime-configured adapter (SMTP2GO / SendGrid / SMTP) | Keys from env only — never in the repo, never in the DB. The DB stores provider choice and env var *names*. |

## Module boundaries

Each module is one delivery lane; they touch disjoint files and can land PRs
independently. Shared surface is `prisma/schema.prisma` (add-only) and
`src/lib/db.ts`.

| Lane | Module | Owns |
|---|---|---|
| SHA-2956 | **Onboarding** | `src/app/(setup)/**`, `src/lib/identity/*` — MSP identity (name, legal name, address, owner/CEO, website), contract-header preview, venue selection. Skippable, re-runnable from inside the app. Writes `MspIdentity`. |
| SHA-2957 | **/legal site** | `src/app/legal/**`, `src/lib/legal/*`, `src/lib/visits/*` — public document pages (`/legal`, `/legal/[slug]`, `/legal/[slug]/[version]`, history, compare, pdf), the website **embed generator** (`embed.js`, iframe frame route), the **visitor log** (`LegalVisit`: timestamp, IP, region, UA), and the **liveness monitor** (`SiteCheck` + alert email to the MSP when their site stops serving the embed). |
| SHA-2958 | **Email delivery** | `src/lib/email/*`, `src/app/(modules)/settings/email/**` — provider abstraction with SMTP2GO, SendGrid and plain-SMTP adapters, runtime settings screen, test-send. Reads secrets from env by *name*; `.env.example` ships placeholders only. |
| SHA-2959 | **MSA sends** | `src/lib/sends/*`, `src/app/(modules)/sends/**`, `src/app/msa/[token]/**`, `src/app/t/**` — ad-hoc progressive send form (email required, everything else optional), per-send unique token/URL, variable merge, lifecycle events (`SendEvent`), acceptance + evidence (`AcceptanceRecord`), operator funnel screen, and **update notifications** (offered on republish, never automatic; audience choice + diff preview). |
| SHA-2960 | **API** | `src/app/api/v1/**`, `src/lib/api/*` — API keys (`ApiKey`, hash-at-rest), endpoints for PSA/AI tools to create sends and read lifecycle status, OpenAPI doc, packaging (Dockerfile). |

## Data model

See `prisma/schema.prisma` — it is the contract between lanes. Highlights:

- **`Send`** is the pivot: one row per recipient per MSA, with its own
  unguessable `token`. `mergedVarsJson` freezes the variables as merged at
  send time, so later identity/document edits never change what someone saw.
- **`SendEvent`** is append-only and doubles as acceptance evidence:
  `created | sent | delivered | opened | clicked | viewed | accepted |
  declined | bounced`, each with timestamp, IP, user agent and a meta payload
  (clicked URL, read-time, provider signal).
- **`AcceptanceRecord`** freezes the full event trail at acceptance into
  `evidenceJson` — the retrievable evidence artifact.
- **`LegalVisit`** is the /legal visitor log (Sean: "timestamp record of each
  visitor, IP, region, etc").
- **Schema changes are add-only** (company standing bar). Lanes add models or
  nullable columns via `prisma migrate`; nothing renames or drops.

## Security posture

- **No secrets in repo or DB.** Provider keys come from env; the settings
  screen stores which env var to read, never a value. CI runs gitleaks
  (pinned binary, `--redact=100`) on every PR.
- **Public repo on self-hosted runners**: repo Actions settings require
  approval for all outside-collaborator PRs before workflows run;
  `persist-credentials: false` on every checkout.
- Send tokens are unguessable (crypto-random, ≥128 bits), never sequential.
- The tracking endpoints (`/t/**`, pixel + click redirect) write events but
  authenticate nothing; they must never leak document content — content is
  only behind the tokened `/msa/[token]` URL.

## Porting rules

- Source of truth is `Standard-Computer/ShadowPSA`; `docs/PORT-ASSESSMENT.md`
  maps every capability to its source files and port mode (lift-and-shift /
  adapt / greenfield).
- ShadowPSA couplings to strip on the way in: client/site/ticket models,
  billing, multi-brand, packet mail-merge pieces that assume a PSA database.
  "Recipient" here is a bare contact (email + optional details), not a PSA
  client.
- Keep ported file names close to the originals (`packetMerge.ts` →
  `src/lib/sends/merge.ts` etc.) and note the mapping in the PR description,
  so diffs against upstream stay reviewable.

## CI

`.github/workflows/ci.yml`: Lint, Typecheck, Tests, Build (includes
`prisma validate`), Secret scan — all on `runs-on: [self-hosted, ci]`
(STANDING-RULE-SHA-1853: no paid GitHub-hosted minutes). These five checks are
the required contexts on `main`.
