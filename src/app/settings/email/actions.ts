"use server";

// Settings → Email server actions (SHA-2958). Only non-secret settings are
// ever written here; key values exist solely in the environment. Feedback
// travels as a ?msg= redirect so the page stays a plain server component.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { providerSlugs } from "@/lib/email/registry";
import { sendTestEmail } from "@/lib/email/verify";
import { requireOperator } from "@/lib/auth/page";

// AUTH (SHA-3047): every action here calls requireOperator() first. A server
// action is a POST endpoint on its page's path, so gating the screen alone
// would leave the write reachable by anyone who can derive an action id —
// and this repo is public, so that build is reproducible.

function finish(ok: boolean, message: string): never {
  redirect(`/settings/email?ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(message)}`);
}

export async function saveEmailSettings(formData: FormData): Promise<void> {
  await requireOperator("/settings/email");
  const provider = String(formData.get("provider") ?? "");
  const fromAddress = String(formData.get("fromAddress") ?? "").trim();
  if (!providerSlugs().includes(provider)) {
    finish(false, `Unknown provider "${provider}".`);
  }
  if (!fromAddress) {
    finish(false, "From address is required.");
  }
  const smtpPortRaw = String(formData.get("smtpPort") ?? "").trim();
  const smtpPort = smtpPortRaw ? Number(smtpPortRaw) : undefined;
  if (smtpPortRaw && (!Number.isInteger(smtpPort) || smtpPort! <= 0 || smtpPort! > 65535)) {
    finish(false, `"${smtpPortRaw}" is not a valid port.`);
  }
  const settings = {
    smtpHost: String(formData.get("smtpHost") ?? "").trim() || undefined,
    smtpPort,
    smtpUsername: String(formData.get("smtpUsername") ?? "").trim() || undefined,
    smtpSecure: formData.get("smtpSecure") === "on",
  };

  await prisma.$transaction([
    prisma.emailProviderConfig.updateMany({ data: { active: false } }),
    prisma.emailProviderConfig.create({
      data: {
        provider,
        fromAddress,
        settingsJson: JSON.stringify(settings),
        active: true,
      },
    }),
  ]);
  finish(true, "Email settings saved.");
}

export async function sendTestEmailAction(formData: FormData): Promise<void> {
  await requireOperator("/settings/email");
  const to = String(formData.get("to") ?? "").trim();
  const result = await sendTestEmail(to);
  if (result.ok) {
    finish(true, `Test email handed to the provider (outbound ${result.outboundId}). Check the inbox.`);
  }
  finish(false, result.error);
}
