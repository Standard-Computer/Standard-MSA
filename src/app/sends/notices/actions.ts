"use server";

// Update-notice action (SHA-2959).
//
// This is the ONLY code path in the app that mails an update notice, and it
// is reachable only from a form an operator submits after seeing the diff
// and choosing an audience. That is Sean's rule — the option is presented,
// never automatic — expressed as the absence of any other caller.

import { redirect } from "next/navigation";

import { isNoticeAudience, parseSelectedRecipientIds } from "@/lib/sends/audience";
import { sendUpdateNotice } from "@/lib/sends/notices";

function finish(documentId: number, ok: boolean, message: string): never {
  redirect(
    `/sends/notices?documentId=${documentId}&ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(message)}`,
  );
}

export async function sendNoticeAction(formData: FormData): Promise<void> {
  const documentId = Number(String(formData.get("documentId") ?? ""));
  if (!Number.isInteger(documentId) || documentId <= 0) {
    redirect("/sends/notices?ok=0&msg=Unknown%20document.");
  }

  const audience = String(formData.get("audience") ?? "");
  if (!isNoticeAudience(audience)) {
    finish(documentId, false, "Pick an audience.");
  }

  const selectedRecipientIds = parseSelectedRecipientIds(
    formData.getAll("recipientIds").filter((v): v is string => typeof v === "string"),
  );

  const result = await sendUpdateNotice({ documentId, audience, selectedRecipientIds });
  if (!result.ok) {
    finish(documentId, false, result.error);
  }

  const failed = result.failures.length;
  if (failed > 0) {
    finish(
      documentId,
      false,
      `Notified ${result.notified}; ${failed} could not be delivered: ${result.failures
        .map((f) => `${f.email} (${f.error})`)
        .join("; ")}`,
    );
  }
  finish(
    documentId,
    true,
    `Update notice sent to ${result.notified} recipient${result.notified === 1 ? "" : "s"}.`,
  );
}
