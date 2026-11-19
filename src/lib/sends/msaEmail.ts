// Composing and sending the per-recipient MSA email (SHA-2959).
//
// Goes through `sendEmail()` — the single send path SHA-2958 established —
// so this lane inherits the queue, the backoff, the open pixel, the click
// wrapper and the provider webhooks without reimplementing any of them.
//
// Two fields do the lane's work: `ref: { sendId }` is the join the lifecycle
// projection reads, and `trackLinks: [url]` makes the one link in the email
// a tracked click. Nothing records a `sent` SendEvent here — the projection
// owns every email-derived event, so a message the queue delivers on its
// third attempt lands in the trail exactly once, at the time it really went.

import { getEmailConfig } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/send";
import type { SendEmailResult } from "@/lib/email/types";
import { escapeHtml } from "@/lib/legal/html";
import { SEND_EMAIL_KIND } from "./constants";
import { projectDeliverySignals } from "./projection";
import type { SendWithTrail } from "./sends";
import { sendById } from "./sends";
import { sendUrl } from "./tokens";

/** The MSP's own name for the email's voice, falling back to the product. */
function senderName(mspName: string | null): string {
  return mspName?.trim() || "your IT provider";
}

export type MsaEmailContent = { subject: string; text: string; html: string };

/**
 * The message body. PURE so the wording is reviewable and testable without
 * a provider: the one link is the unique per-recipient URL, and it appears
 * verbatim in both parts so the click wrapper can rewrite it.
 */
export function composeMsaEmail(input: {
  documentTitle: string;
  mspName: string | null;
  recipientName: string | null;
  url: string;
}): MsaEmailContent {
  const from = senderName(input.mspName);
  const greeting = input.recipientName?.trim() ? `Hello ${input.recipientName.trim()},` : "Hello,";
  const subject = `${input.documentTitle} from ${from}`;

  const text = [
    greeting,
    "",
    `${from} has sent you a ${input.documentTitle} to review and accept.`,
    "",
    "Your personal copy is here:",
    input.url,
    "",
    "The link is unique to you. Please do not forward it — anyone holding it",
    "can read and accept this agreement on your behalf.",
    "",
    `— ${from}`,
  ].join("\n");

  const html = [
    "<html><body>",
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(from)} has sent you a <strong>${escapeHtml(input.documentTitle)}</strong> to review and accept.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Review and accept your ${escapeHtml(input.documentTitle)}</a></p>`,
    "<p>The link is unique to you. Please do not forward it — anyone holding it can read and accept this agreement on your behalf.</p>",
    `<p>— ${escapeHtml(from)}</p>`,
    "</body></html>",
  ].join("");

  return { subject, text, html };
}

export type DispatchResult =
  | { ok: true; send: SendWithTrail; outboundId: string }
  | { ok: false; error: string };

/**
 * Mail one send's unique URL to its recipient.
 *
 * A delivery failure is DATA, not an exception (architecture principle 5):
 * the operator gets the reason, the send stays at `created`, and the queue
 * keeps retrying a retryable failure in the background — at which point the
 * projection picks the `sent` signal up on the next page load.
 */
export async function dispatchSend(send: SendWithTrail, mspName: string | null): Promise<DispatchResult> {
  const state = await getEmailConfig();
  if (!state.configured) return { ok: false, error: state.reason };

  const url = sendUrl(state.config.baseUrl, send.token);
  const content = composeMsaEmail({
    documentTitle: send.documentVersion.document.title,
    mspName,
    recipientName: send.recipient.fullName,
    url,
  });

  const result: SendEmailResult = await sendEmail({
    to: send.recipient.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
    kind: SEND_EMAIL_KIND,
    ref: { sendId: send.id },
    trackLinks: [url],
  });

  if (!result.ok) return { ok: false, error: result.error };

  // Pull the `sent` signal straight through so the operator sees the send as
  // sent on the redirect, rather than on whenever the next load happens.
  await projectDeliverySignals(send);
  const refreshed = (await sendById(send.id)) ?? send;
  return { ok: true, send: refreshed, outboundId: result.outboundId };
}
