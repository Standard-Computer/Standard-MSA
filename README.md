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
  Document types are data: MSA ships first, HIPAA BAA next, your custom
  agreement needs no code change.
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
docker compose up
```

Open http://localhost:3000 — the onboarding wizard takes it from there. Data
lives in a SQLite file on a Docker volume; back up by copying the file.

### Development

```sh
cp .env.example .env     # defaults are fine for dev
npm install
npx prisma migrate dev
npm run dev
```

Gates (all run in CI): `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`.

## Project layout

```
prisma/           schema + migrations (SQLite default; add-only changes)
src/app/          Next.js App Router — public /legal, signing pages, operator UI, API
src/lib/          domain modules: identity, legal, email, sends, visits, api
docs/             ARCHITECTURE.md (data model, module boundaries),
                  PORT-ASSESSMENT.md (what was ported from where)
tests/            node:test suites, one directory per module
```

Module boundaries and lane ownership: `docs/ARCHITECTURE.md`.

## Status

Scaffold stage. The build is green and the architecture is set; capability
modules land as independent lanes (onboarding, /legal + embed, email
delivery, sends & acceptance, public API).

## License

Not yet licensed — all rights reserved for now while licensing is decided.
The repo is public for transparency; a LICENSE file will follow.

## Security

No credentials belong in this repo, ever. `.env.example` carries placeholders
only and CI runs a secret scan on every push. If you find a security issue,
email security@standardcomputer.com rather than opening a public issue.
