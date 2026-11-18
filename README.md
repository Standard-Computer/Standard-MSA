# Standard-MSA

Stand-alone, self-hosted MSA/compliance tool for MSPs. Publish your legal
documents (MSA, HIPAA BAA, …) at `/legal` on your own site, send each customer
a **unique** MSA link, and keep a complete, timestamped evidence trail — sent,
opened, clicked, viewed, accepted — for every send.

Extracted from the compliance module of [ShadowPSA](https://ob.standardcomputer.com)
and packaged so any MSP can run it themselves.

## What it does

- **Onboarding wizard** — capture MSP identity (name, legal name, address,
  owner/CEO, website), preview the contract header, pick the governing-law
  venue. Skippable, re-runnable any time.
- **`/legal` on your website** — generates the embed code for your site,
  verifies the embed is live, and emails you if it is unreachable. Every visit
  is logged locally (timestamp, IP, region, user agent).
- **Unique MSA sends** — send from as little as a customer email address; each
  send gets its own unguessable URL with the recipient's details merged into
  the contract. Lifecycle events (sent, delivered, opened, clicked, viewed,
  accepted, declined, bounced) are recorded with timestamp, IP and user agent
  and kept as acceptance evidence.
- **Update notifications** — when a document is republished you are *offered*
  the option to notify prior recipients (never automatic), with audience
  selection and a diff of what changed.
- **API surface** — PSA and AI tools can create MSA sends through the HTTP API.
- **Pluggable email** — SMTP2GO, SendGrid or plain SMTP. Configured at
  runtime; **keys live in your environment, never in this repo or the
  database.**

## Running it

```bash
cp .env.example .env   # fill in locally; see comments in the file
npm ci
npx prisma migrate deploy
npm run build
npm start
```

Data is kept in a local SQLite file (`DATABASE_URL`, default
`file:./data/standard-msa.db`). Back that file up and you have backed up the
tool, including your acceptance evidence.

## Development

```bash
npm run dev        # dev server
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # node --test
```

Architecture and module boundaries: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
What was ported from ShadowPSA and how: [`docs/PORT-ASSESSMENT.md`](docs/PORT-ASSESSMENT.md).

## License

No license file yet — all rights reserved while licensing is decided.
