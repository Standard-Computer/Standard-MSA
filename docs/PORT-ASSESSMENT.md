# Port assessment — ShadowPSA compliance/legal module → Standard-MSA

Assessed against `Standard-Computer/ShadowPSA` @ `01590062` (2026-11-18).
Verdicts: **lift-and-shift** (moves with import-path edits), **adapt** (logic
ports, ShadowPSA couplings swapped out), **greenfield** (new build; upstream
has nothing stand-alone to take).

Two facts decide most verdicts:

1. `src/lib/legal/*` is largely **pure and DB-free** (variables, diff, embed,
   markdown, footers, presets, acceptance line, PDF blocks) — it lifts.
2. `src/lib/compliance/*` is where ShadowPSA bleeds in: packets and update
   notices reach into `Client`, `Contact`, `Quote`, `Ticket`, `Invoice`,
   NextAuth users, the module registry and MS Graph mail — those seams get
   replaced with Standard-MSA's `Recipient`/`Send` model and the pluggable
   email adapter (SHA-2958).

## Capability map

| Capability | ShadowPSA source | Verdict | What to strip/replace |
|---|---|---|---|
| Document/version CRUD, publish, retire, event log | `src/lib/legal/documents.ts`, `import.ts`; models `LegalDocument`, `LegalDocumentVersion`, `LegalEvent` (migration `sta8856`) | **Lift-and-shift** | `User` FKs → local operator id. **Hand-carry the SQL guarantees** (see risk 1). |
| Merge-variable engine (20-key closed union, public/filled render modes) | `src/lib/legal/variables.ts`, `acceptanceLine.ts`, `intro.ts`, `footer.ts`, `blocks.ts` | **Lift-and-shift** | drop `quote_number` + quote-sourced keys; `BUSINESS_TZ` default |
| Version diff / compare | `src/lib/legal/diff.ts`, compare pages, `LegalDiffView` | **Lift-and-shift** | none |
| Public /legal pages (index, current, version, history) + PDF | `src/app/legal/**`, `src/lib/legal/pdf.tsx`, `pdfResponse.ts` | **Lift-and-shift** | `legalBrand()` reads `QuoteConfig` → our `MspIdentity`; keep the pdf `lineHeight`-needs-`fontSize` invariant |
| Website embed (loader JS, frame, origins, snippet) | `embed.ts`, `embedLoader.ts`, `embedDocument.ts`, `embedMarkdown.ts`, `embedData.ts`, `embedRoutes.ts`, `/legal/embed.js` + `/legal/embed/frame` routes | **Lift-and-shift** (routes adapt) | module-enabled gates; re-create the `next.config.ts`/middleware header exemption + its consistency validator; decide on renaming the `ob-legal` namespace |
| Brand seam | `src/lib/legal/brand.ts` (+ `QuoteConfig` brand columns, `sta9087`/`sta9323`) | **Adapt** | collapse the two ShadowPSA singletons into `MspIdentity` — `brand.ts` is explicitly designed as the one-file edit for this move |
| Publish permission | `src/lib/legal/publishers.ts` | **Adapt** | NextAuth session, `ADMIN` role enum, hard-coded `sean@standardcomputer.com` default |
| Acceptance records (evidence rows) | `src/lib/legal/acceptance.ts` → `recordLegalAcceptances`, `acceptanceCoversCurrentVersion`, `legalVariableValues`; model `LegalAcceptance` | **Adapt** | `Client`/`Quote` FKs → `Send`/`Recipient`; denormalised `version`/`contentHash`/`renderedBody` pattern is the keeper |
| Quote-coupled acceptance planner/timelines | `acceptance.ts` `quote*` exports | **Greenfield** (send-first planner instead) | entire quote transaction coupling |
| Packet compose/send/sign flow | `src/lib/compliance/packets.ts` (82 KB) + `packetSettings`, `packetAnswers`, `packetVerify`, `/agreements/[token]/**` | **Adapt** | `Client`-vs-ad-hoc branching → always `Recipient`; token mint (`mintPacketToken`, 32 random bytes hex), frozen-at-send cover/info, CAS submit all port |
| Signature validation + stroke evidence | `packetSignature.ts`, `packetStrokes.ts` | **Lift-and-shift** | none |
| ESIGN/UETA consent freezing | `packetConsent.ts` | **Lift-and-shift** | none (keep it *total* — the STA-9516 fix) |
| Evidence capture + reproducible digest | `packetEvidence.ts` (`readOrigin`, `readGeo`, `parseDevice`, `evidenceManifest`/`evidenceDigest`) | **Lift-and-shift** | rename manifest namespace `orangeboard-agreement-packet-evidence/1` → `standard-msa-evidence/1` deliberately |
| Append-only packet audit trail | `packetEvents.ts` (24 event kinds), `deliveryState.ts`; model `AgreementPacketEvent` | **Lift-and-shift** | drop the 4 `post_*` postal kinds; hand-carry the append-only trigger |
| View/read-time telemetry | `packets.ts` `recordPacketView` / `recordDocumentView` / `recordDocumentRead` (120 s ping clamp, heartbeat not beacon, no writes to sealed rows) | **Lift-and-shift** | none — preserve both subtleties |
| Signed-PDF + evidence certificate + storage | `packetComplete.ts`, `packetPdf.tsx`; model `ClientLegalFile` | **Adapt** | Graph attachment path → email adapter; `clientId` → `sendId`; revisit Bytes-in-DB (fine for SQLite self-host) |
| Packet email (invite/reminder/confirmation/verify) | `packetEmail.ts`, `packetSweep.ts` | **Adapt** | MS Graph → SHA-2958 adapter; keep gate-returns-a-reason-sentence, `{sentAt, skipReason}` outcomes, forbidden-recipient set (re-pointed at our own system mailboxes) |
| Update notice: record, render, freeze | `updateNotice.ts` (`noticeableVersions`, `renderNotice`, `createUpdateNotice`), `updateNoticeMerge.ts`, `updateNoticeSettings.ts`, `updateNoticeStatus.ts` | **Adapt** | module gates, `createdById` |
| Update-notice audience selection | `updateNotice.ts` `resolveNoticeRecipients` | **Greenfield** | upstream selects by CRM flags (`isCustomer`, `doNotContact`, billing-role contacts) that don't exist here; ours selects over prior `Send`s (all / only accepted / selected) per SHA-2959 |
| Update-notice sweep (cron drain) | `updateNoticeSweep.ts` | **Adapt** | transport + cron wiring; keep the `queued→sending` claim-CAS, stuck-claim recovery, batch 25, terminal-failure classification verbatim |
| Settings singleton + admin UI | `settings.ts`, `/settings/compliance/**`; model `ComplianceConfig` (`sta9321`, `sta9753`, `sta9781`, `sta9936`) | **Adapt** | resolve-NULL-on-read pattern ports; quote/ticket/invoice footer trio and `baaDefaultOn` stay behind |
| Acceptance footers on quotes/tickets/invoices | `footers.ts`, `invoiceFooter.ts`, `billing.ts` | **Greenfield later, if ever** | Standard-MSA has no quote/ticket/invoice artifacts to footer |
| Postal mail channel | `mailPiece.ts`, `postalAdapter*.ts` | **Drop** | entire provider integration |
| CRM recipient browsing | `recipientViews.ts`, `recipientSearch.ts`, `clientOverview.ts`, `clientShadowOperations.ts` | **Drop** | pure ShadowPSA CRM |

## What Sean asked for that upstream deliberately does NOT have

Upstream has **no open pixel, no click tracking, and no delivery-feedback
webhook — as a documented design commitment**, with reserved columns
(`emailOpenedAt`, `openedAt`, `bouncedAt`) that exist only so surfaces can
print "not tracked". SHA-2959's spec (opened via pixel + provider signal,
per-link clicks, bounces) is therefore **greenfield here**, not a port:

- open pixel + click-redirect routes (`/t/**`) writing `SendEvent`;
- provider delivery/bounce signals via the SHA-2958 adapter's webhook surface;
- and the e-sign certificate wording must say tracking **is** on — we must
  not copy upstream's "not tracked" certificate text.

Also greenfield: the `/legal` **visitor log** (upstream's public pages log
nothing at all — `LegalVisit` is new), and the **liveness monitor**
(`SiteCheck`) for the embed on the MSP's site.

## Stack decision

Same stack as upstream (Next.js App Router + TypeScript + Prisma) so ported
code moves with import-path edits instead of rewrites. The one deliberate
divergence is the datastore: **SQLite instead of Postgres**, because the brief
is a *local* database and a one-container self-host story — install is
`docker compose up`, backup is copying one file. Costs accepted with that:

- ShadowPSA's raw-SQL guarantees (triggers, partial unique indexes) must be
  re-written in SQLite dialect, not copied (risk 1 below);
- `String[]`/`Json` columns become JSON-in-`String` columns parsed at the
  boundary; the schema stays provider-portable so Postgres can be offered
  later behind the same Prisma models.

## Port risks

1. **The guarantees are in Postgres, not Prisma.** Published-version
   immutability, acceptance immutability, packet-event append-only, packet
   seal write-once, and the one-draft partial unique index are raw SQL in
   ShadowPSA's migrations. Copying `schema.prisma` reproduces none of them.
   Standard-MSA is SQLite, so these are re-implemented as SQLite triggers /
   partial indexes in hand-written migration SQL — or the "the record is the
   evidence" claim becomes a convention instead of a rule.
2. **`next.config.ts` headers silently replace route-handler headers**
   (upstream STA-9551: the embed's `frame-ancestors` CSP was neutered for
   months). Port `embedRoutes.ts` *and* a consistency check; verify with
   `curl -sI` against a running instance.
3. **Email transport.** Upstream sends via Microsoft Graph with tenant
   credentials — wrong default for self-hosted. Everything around the
   transport (gates, outcomes, escaped-HTML builders, failure classification)
   ports; the transport itself is SHA-2958's SMTP2GO/SendGrid/SMTP adapter
   behind the same `sendEmail(input) → {ok} | {ok:false, error}` shape.
4. **Auth.** Upstream gates on NextAuth + `ADMIN` role. Standard-MSA needs
   its own (single-operator, at first) auth before the operator screens ship;
   public token routes (`/msa/[token]`, `/legal/**`, `/t/**`) stay auth-free
   by design.
