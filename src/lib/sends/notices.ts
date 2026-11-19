// Update notifications (SHA-2959).
//
// Sean's rule: when a document is updated, the option to notify prior
// recipients is PRESENTED — never automatic. The shape of this file is that
// rule. `listNoticeCandidates` and `noticeContext` are reads an operator
// screen runs; `sendUpdateNotice` is the only thing that mails anybody, it
// takes an explicit audience decision, and nothing but a form action calls
// it. There is no cron, no publish hook and no "notify on save" path.

import type { LegalDocumentVersion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEmailConfig } from "@/lib/email/config";
import { refNumber } from "@/lib/email/ref";
import { sendEmail } from "@/lib/email/send";
import { serializeByKey } from "@/lib/serialize";
import { diffHunks, diffLines, summarizeDiff, type DiffSummary } from "@/lib/legal/diff";
import { publishedDocuments } from "@/lib/legal/documents";
import { escapeHtml } from "@/lib/legal/html";
import {
  noticeCandidates,
  resolveAudience,
  type DocumentHead,
  type NoticeAudience,
  type NoticeCandidate,
  type SendRow,
} from "./audience";
import { NOTICE_EMAIL_KIND } from "./constants";

/** Documents where prior recipients hold an older version than the current one. */
export async function listNoticeCandidates(): Promise<NoticeCandidate[]> {
  const published = await publishedDocuments();
  const heads: DocumentHead[] = published.map((p) => ({
    documentId: p.doc.id,
    slug: p.doc.slug,
    title: p.doc.title,
    currentVersionId: p.current.id,
    currentVersion: p.current.version,
  }));
  if (heads.length === 0) return [];

  const sends = await prisma.send.findMany({
    select: {
      recipientId: true,
      status: true,
      documentVersion: { select: { documentId: true, version: true } },
    },
  });
  const rows: SendRow[] = sends.map((s) => ({
    recipientId: s.recipientId,
    status: s.status,
    documentId: s.documentVersion.documentId,
    version: s.documentVersion.version,
  }));
  return noticeCandidates(heads, rows);
}

export type NoticeRecipientRow = {
  recipientId: number;
  email: string;
  name: string | null;
  /** Highest version this recipient already holds. */
  heldVersion: number;
  accepted: boolean;
};

export type NoticeContext = {
  candidate: NoticeCandidate;
  version: LegalDocumentVersion;
  /** The published version immediately before the current one, if any. */
  previous: LegalDocumentVersion | null;
  diff: ReturnType<typeof diffHunks>;
  summary: DiffSummary;
  recipients: NoticeRecipientRow[];
};

/**
 * Everything the notice screen shows for one document: the diff against the
 * previous published version, and the people who could be told about it.
 */
export async function noticeContext(documentId: number): Promise<NoticeContext | null> {
  const candidates = await listNoticeCandidates();
  const candidate = candidates.find((c) => c.documentId === documentId);
  if (!candidate) return null;

  const versions = await prisma.legalDocumentVersion.findMany({
    where: { documentId, publishedAt: { not: null } },
    orderBy: { version: "desc" },
  });
  const version = versions.find((v) => v.id === candidate.currentVersionId);
  if (!version) return null;
  const previous = versions.find((v) => v.version < version.version) ?? null;

  const lines = diffLines(previous?.bodyMarkdown ?? "", version.bodyMarkdown);

  const recipientRows = await prisma.recipient.findMany({
    where: { id: { in: candidate.staleRecipients } },
    orderBy: { id: "asc" },
  });
  const recipients: NoticeRecipientRow[] = recipientRows.map((r) => {
    const theirs = candidate.pool.filter((s) => s.recipientId === r.id);
    return {
      recipientId: r.id,
      email: r.email,
      name: r.fullName ?? r.companyName ?? r.legalName,
      heldVersion: Math.max(...theirs.map((s) => s.version)),
      accepted: candidate.acceptedRecipients.includes(r.id),
    };
  });

  return {
    candidate,
    version,
    previous,
    diff: diffHunks(lines),
    summary: summarizeDiff(lines),
    recipients,
  };
}

export type NoticeEmailContent = { subject: string; text: string; html: string };

/** The notice wording. PURE, so it is reviewable without a provider. */
export function composeNoticeEmail(input: {
  documentTitle: string;
  mspName: string | null;
  newVersion: number;
  heldVersion: number;
  changelog: string | null;
  url: string;
}): NoticeEmailContent {
  const from = input.mspName?.trim() || "your IT provider";
  const subject = `Updated: ${input.documentTitle} (v${input.newVersion})`;
  const changelogLine = input.changelog?.trim();

  const text = [
    "Hello,",
    "",
    `${from} has published an updated ${input.documentTitle}.`,
    `You were previously sent version ${input.heldVersion}; the current version is ${input.newVersion}.`,
    ...(changelogLine ? ["", `What changed: ${changelogLine}`] : []),
    "",
    "You can read the current version here:",
    input.url,
    "",
    "This is a notification only. It does not change an agreement you have",
    "already accepted — your accepted copy stays exactly as you accepted it.",
    "",
    `— ${from}`,
  ].join("\n");

  const html = [
    "<html><body>",
    "<p>Hello,</p>",
    `<p>${escapeHtml(from)} has published an updated <strong>${escapeHtml(input.documentTitle)}</strong>.</p>`,
    `<p>You were previously sent version ${input.heldVersion}; the current version is ${input.newVersion}.</p>`,
    ...(changelogLine ? [`<p><strong>What changed:</strong> ${escapeHtml(changelogLine)}</p>`] : []),
    `<p><a href="${escapeHtml(input.url)}">Read the current ${escapeHtml(input.documentTitle)}</a></p>`,
    "<p>This is a notification only. It does not change an agreement you have already accepted — your accepted copy stays exactly as you accepted it.</p>",
    `<p>— ${escapeHtml(from)}</p>`,
    "</body></html>",
  ].join("");

  return { subject, text, html };
}

// ── Who has already been told ───────────────────────────────────────────────

/**
 * Recipients already mailed a notice about this exact document version.
 *
 * Read from the DELIVERY LOG rather than from `UpdateNotice.recipientIdsJson`.
 * The notice row records what an operator DECIDED, and it is written before
 * the fan-out starts — so a crash halfway through would leave never-mailed
 * recipients listed there and exclude them permanently. An EmailOutbound row
 * means the mail exists: either it went, or it is in the queue with its own
 * retries and backoff. In both cases mailing again is a duplicate, not a
 * repair.
 */
export async function noticedRecipientIds(documentVersionId: number): Promise<Set<number>> {
  const priorNotices = await prisma.updateNotice.findMany({
    where: { documentVersionId },
    select: { id: true },
  });
  const notified = new Set<number>();
  if (priorNotices.length === 0) return notified;
  const noticeIds = new Set(priorNotices.map((n) => n.id));

  const outbounds = await prisma.emailOutbound.findMany({
    where: { kind: NOTICE_EMAIL_KIND },
    select: { refJson: true },
  });
  for (const outbound of outbounds) {
    const noticeId = refNumber(outbound.refJson, "updateNoticeId");
    if (noticeId === null || !noticeIds.has(noticeId)) continue;
    const recipientId = refNumber(outbound.refJson, "recipientId");
    if (recipientId !== null) notified.add(recipientId);
  }
  return notified;
}

export type NoticeSendResult =
  | {
      ok: true;
      noticeId: number;
      notified: number;
      /** Chosen, but already notified about this version, so not mailed again. */
      skipped: number;
      failures: { email: string; error: string }[];
    }
  | { ok: false; error: string };

/**
 * Mail an update notice to a chosen audience.
 *
 * EXACTLY ONCE per recipient per version. Sean's rule makes this a human
 * decision, and a human decision arrives by double-clicked submit as often
 * as not — so "never automatic" is only half the promise. The other half is
 * that asking twice does not tell forty people twice that their terms
 * changed, which is a mail nobody can un-send.
 *
 * Nothing in the schema enforces that (UpdateNotice has no unique key to
 * add without a migration), so it is enforced here on two levels:
 *
 *  - Durably, against the delivery log: already-notified recipients are
 *    dropped from the audience, and a notice whose audience is entirely
 *    already-notified writes NO row and sends no mail. That is what makes a
 *    second submit a no-op minutes or days later, and across a restart.
 *  - Against the simultaneous double-click, which would otherwise have both
 *    requests pass that check before either wrote: one critical section per
 *    document version, so the second request reads the first one's rows.
 *
 * The UpdateNotice row is written BEFORE any mail goes out and `sentAt` is
 * stamped after, so a crash mid-fan-out leaves a record of what was decided
 * and that it did not finish — rather than no trace of a half-sent notice.
 *
 * Per-recipient failures are collected and reported, not thrown: one dead
 * mailbox in an audience of forty must not silently abort the other
 * thirty-nine.
 */
export async function sendUpdateNotice(input: {
  documentId: number;
  audience: NoticeAudience;
  selectedRecipientIds?: number[];
}): Promise<NoticeSendResult> {
  const state = await getEmailConfig();
  if (!state.configured) return { ok: false, error: state.reason };

  const context = await noticeContext(input.documentId);
  if (!context) {
    return { ok: false, error: "No prior recipients hold an older version of this document." };
  }

  const chosen = resolveAudience(
    input.audience,
    context.candidate.pool,
    input.selectedRecipientIds ?? [],
  );
  if (chosen.length === 0) {
    return { ok: false, error: "That audience selects nobody. Nothing was sent." };
  }

  return serializeByKey(`update-notice:${context.version.id}`, () =>
    fanOut(input.audience, context, chosen, state.config.baseUrl),
  );
}

async function fanOut(
  audience: NoticeAudience,
  context: NoticeContext,
  chosen: readonly number[],
  baseUrl: string,
): Promise<NoticeSendResult> {
  const already = await noticedRecipientIds(context.version.id);
  const recipientIds = chosen.filter((id) => !already.has(id));
  const skipped = chosen.length - recipientIds.length;
  if (recipientIds.length === 0) {
    // No row either: a notice that mails nobody is not a notice, and writing
    // one per rejected double-click would make the ledger unreadable.
    return {
      ok: false,
      error:
        `Everyone in that audience has already been notified about v${context.version.version}. ` +
        "Nothing was sent.",
    };
  }

  const notice = await prisma.updateNotice.create({
    data: {
      documentVersionId: context.version.id,
      audience,
      recipientIdsJson: JSON.stringify(recipientIds),
    },
  });

  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const url = `${baseUrl}/legal/${context.candidate.slug}`;
  const failures: { email: string; error: string }[] = [];
  let notified = 0;

  for (const recipientId of recipientIds) {
    const row = context.recipients.find((r) => r.recipientId === recipientId);
    if (!row) continue;
    const content = composeNoticeEmail({
      documentTitle: context.candidate.title,
      mspName: identity?.name ?? null,
      newVersion: context.version.version,
      heldVersion: row.heldVersion,
      changelog: context.version.changelog,
      url,
    });
    const result = await sendEmail({
      to: row.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      kind: NOTICE_EMAIL_KIND,
      ref: { updateNoticeId: notice.id, recipientId },
      trackLinks: [url],
    });
    if (result.ok) notified += 1;
    else failures.push({ email: row.email, error: result.error });
  }

  await prisma.updateNotice.update({ where: { id: notice.id }, data: { sentAt: new Date() } });
  return { ok: true, noticeId: notice.id, notified, skipped, failures };
}
