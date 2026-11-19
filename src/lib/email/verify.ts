// "Send test email" / verify-configuration (SHA-2958): proves the configured
// provider actually works before the MSP relies on it.

import { getEmailConfig } from "./config";
import { getProvider } from "./registry";
import { sendEmail } from "./send";
import type { SendEmailResult } from "./types";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendTestEmail(to: string): Promise<SendEmailResult> {
  if (!EMAIL_SHAPE.test(to)) {
    return { ok: false, error: `"${to}" is not a valid email address.` };
  }
  const state = await getEmailConfig();
  if (!state.configured) {
    return { ok: false, error: state.reason };
  }
  const provider = getProvider(state.config.provider);
  return sendEmail({
    to,
    subject: "Standard-MSA test email",
    text:
      `This is a test email from your Standard-MSA instance.\n\n` +
      `Provider: ${provider?.label ?? state.config.provider}\n` +
      `From address: ${state.config.fromAddress}\n\n` +
      `If you received this, email delivery is configured correctly.`,
    html:
      `<p>This is a <strong>test email</strong> from your Standard-MSA instance.</p>` +
      `<p>Provider: ${provider?.label ?? state.config.provider}<br/>` +
      `From address: ${state.config.fromAddress}</p>` +
      `<p>If you received this, email delivery is configured correctly.</p>`,
    kind: "test",
  });
}
