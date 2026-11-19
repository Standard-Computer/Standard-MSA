"use server";

// Recipient-side actions (SHA-2959): accept and decline.
//
// IP and user agent are read from the request headers here, not posted by
// the client — they are acceptance evidence, so a value the signer could
// choose would be worthless.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { acceptSend, declineSend } from "@/lib/sends/evidence";
import { isSendTokenShape } from "@/lib/sends/tokens";
import { clientIpFrom } from "@/lib/visits/visits";

async function requestIdentity(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return {
    ip: clientIpFrom((name) => h.get(name)),
    userAgent: h.get("user-agent"),
  };
}

function finish(token: string, ok: boolean, message: string): never {
  redirect(`/msa/${token}?ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(message)}`);
}

export async function acceptAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!isSendTokenShape(token)) redirect("/msa/invalid");

  const acceptorName = String(formData.get("acceptorName") ?? "");
  const { ip, userAgent } = await requestIdentity();
  const result = await acceptSend(token, { acceptorName, ip, userAgent });

  if (!result.ok) {
    finish(token, false, result.error);
  }
  finish(
    token,
    true,
    result.alreadyAccepted
      ? "This agreement was already accepted. Your original acceptance stands."
      : "Accepted. A copy of this page is your record; we have logged the signature.",
  );
}

export async function declineAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!isSendTokenShape(token)) redirect("/msa/invalid");

  const reason = String(formData.get("reason") ?? "");
  const { ip, userAgent } = await requestIdentity();
  const result = await declineSend(token, { reason, ip, userAgent });

  if (!result.ok) {
    finish(token, false, result.error);
  }
  finish(token, true, "Declined. Nothing has been agreed to, and we have let the sender know.");
}
