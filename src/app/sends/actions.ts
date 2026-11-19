"use server";

// Send server actions (SHA-2959). Feedback travels as an ?ok=/&msg= redirect
// so every screen in this lane stays a plain server component, matching
// Settings → Email (SHA-2958).

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { validateRecipientInput, type RecipientInput } from "@/lib/sends/fields";
import { dispatchSend } from "@/lib/sends/msaEmail";
import { createSend, sendById } from "@/lib/sends/sends";

function finish(path: string, ok: boolean, message: string): never {
  redirect(`${path}?ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(message)}`);
}

function recipientFrom(formData: FormData): Partial<RecipientInput> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    email: text("email"),
    fullName: text("fullName"),
    companyName: text("companyName"),
    legalName: text("legalName"),
    address: text("address"),
    phone: text("phone"),
  };
}

/**
 * Create a unique send and mail it.
 *
 * A delivery failure still leaves the send created with its own URL, and
 * says so — the operator can copy the link to the recipient by hand, or fix
 * the provider and re-send. Throwing the send away because the mailer was
 * misconfigured would lose the captured details for no reason.
 */
export async function createAndSendAction(formData: FormData): Promise<void> {
  const versionIdRaw = String(formData.get("documentVersionId") ?? "");
  const documentVersionId = Number(versionIdRaw);
  if (!Number.isInteger(documentVersionId) || documentVersionId <= 0) {
    finish("/sends/new", false, "Pick a document to send.");
  }
  const version = await prisma.legalDocumentVersion.findUnique({
    where: { id: documentVersionId },
  });
  if (!version || version.publishedAt === null) {
    // Only published versions may be sent: a draft is not an offer.
    finish("/sends/new", false, "That document version is not published.");
  }

  const validation = validateRecipientInput(recipientFrom(formData));
  if (!validation.ok) {
    finish("/sends/new", false, validation.error);
  }

  const { send } = await createSend(documentVersionId, validation.input);
  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const dispatched = await dispatchSend(send, identity?.name ?? null);

  if (!dispatched.ok) {
    finish(
      `/sends/${send.id}`,
      false,
      `Send created, but the email could not be delivered: ${dispatched.error} The unique link is on this page.`,
    );
  }
  finish(`/sends/${send.id}`, true, `Sent to ${send.recipient.email}.`);
}

/** Re-send the same unique URL to the same recipient. */
export async function resendAction(formData: FormData): Promise<void> {
  const sendId = Number(String(formData.get("sendId") ?? ""));
  if (!Number.isInteger(sendId) || sendId <= 0) {
    finish("/sends", false, "Unknown send.");
  }
  const send = await sendById(sendId);
  if (!send) {
    finish("/sends", false, "Unknown send.");
  }
  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const dispatched = await dispatchSend(send, identity?.name ?? null);
  if (!dispatched.ok) {
    finish(`/sends/${sendId}`, false, `Could not re-send: ${dispatched.error}`);
  }
  finish(`/sends/${sendId}`, true, `Re-sent to ${send.recipient.email}.`);
}
